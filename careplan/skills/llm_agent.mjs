// LLM実行器: エージェント段（型判定/ニーズ抽出/原案/字数調整/検証）を実際に Claude で実行する。
// orchestrator の replayAgent（捕捉出力の再生）と差し替え可能な実行器。
//
// 各段は「システムプロンプト＝agents/<name>.md の契約」「ユーザーメッセージ＝入力JSON」で呼び、
// 出力は emit ツール（tool_choice で強制）＋各段の出力スキーマで構造化して受け取る。
// → モデルにスキーマ準拠のJSONを返させ、後段のコードがそのまま扱える。
//
// 認証（スキルのAuth Quick Referenceに準拠）:
//   - ANTHROPIC_API_KEY があれば x-api-key
//   - なければ ANTHROPIC_AUTH_TOKEN を Authorization: Bearer（＋ oauth ベータヘッダ）
//   - どちらも無ければ明示エラー（利用者にキー設定を促す）
//
// 使い方（orchestrator 経由）:
//   ANTHROPIC_API_KEY=sk-ant-... node careplan/orchestrator.mjs --llm --in a.md,b.md --out out

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = join(HERE, "..", "schemas");
const AGENTS = join(HERE, "..", "agents");

const API_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages";

// 検証エージェント(05)の出力スキーマ（agents/05_verify.md の契約に対応）
const VERIFY_SCHEMA = {
  type: "object",
  required: ["verdict", "findings"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["cell", "issue", "severity"],
        additionalProperties: false,
        properties: {
          cell: { type: "string" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          evidence_ref: { type: ["string", "null"] },
        },
      },
    },
    unfilled: { type: "array", items: { type: "string" } },
  },
};

function stripMeta(s) {
  const { $schema, $id, title, ...rest } = s;
  return rest;
}

// 段名 → emit ツールの入力スキーマ
export function outputSchemaFor(name, schemasDir = SCHEMAS) {
  const load = (f) => JSON.parse(readFileSync(join(schemasDir, f), "utf8"));
  switch (name) {
    case "01_classify_type": {
      const needs = load("needs.schema.json");
      return {
        type: "object",
        required: ["plan_type"],
        additionalProperties: false,
        properties: { plan_type: needs.properties.plan_type },
      };
    }
    case "02_extract_needs":
      return stripMeta(load("needs.schema.json"));
    case "03_draft_plan":
    case "04_fit_chars":
      return stripMeta(load("careplan-draft.schema.json"));
    case "05_verify":
      return VERIFY_SCHEMA;
    default:
      throw new Error(`未知のエージェント: ${name}`);
  }
}

function authHeaders() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return { "x-api-key": key };
  const tok = process.env.ANTHROPIC_AUTH_TOKEN;
  if (tok) return { authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20" };
  throw new Error(
    "APIキーがありません。実行前に環境変数を設定してください:\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "（または OAuth の場合 ANTHROPIC_AUTH_TOKEN）"
  );
}

// リクエストボディを組み立てる（送信はしない）。テスト・ドライラン用に公開。
export function buildRequest(name, input, { agentsDir = AGENTS, schemasDir = SCHEMAS, model = "claude-opus-4-8", maxTokens = 8000 } = {}) {
  const system = readFileSync(join(agentsDir, `${name}.md`), "utf8");
  const schema = outputSchemaFor(name, schemasDir);
  const userText =
    "次の入力を読み、システムプロンプトの契約に従って結果を emit ツールで返してください。" +
    "根拠のない記述を作らないこと。\n\n入力:\n```json\n" +
    JSON.stringify(input, null, 2) +
    "\n```";
  return {
    model,
    max_tokens: maxTokens,
    system,
    tools: [{ name: "emit", description: "契約に従った構造化結果を返す", input_schema: schema }],
    tool_choice: { type: "tool", name: "emit" },
    messages: [{ role: "user", content: userText }],
  };
}

// LLM実行器を返す。orchestrate({ agent: llmAgent(...) }) に渡す。
export function llmAgent(opts = {}) {
  const { model = "claude-opus-4-8", maxTokens = 8000, log = () => {}, maxRetries = 3 } = opts;
  return async (name, input /*, iter */) => {
    const body = buildRequest(name, input, { ...opts, model, maxTokens });
    const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...authHeaders() };

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`LLM ${res.status}`);
          const wait = Math.min(2000 * 2 ** attempt, 16000);
          log(`   [retry ${attempt + 1}] ${res.status} → ${wait}ms 待機`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`LLM ${res.status}: ${t.slice(0, 500)}`);
        }
        const data = await res.json();
        const tu = (data.content || []).find((b) => b.type === "tool_use" && b.name === "emit");
        if (!tu) throw new Error("応答に emit tool_use がありません: " + JSON.stringify(data).slice(0, 300));
        return tu.input;
      } catch (e) {
        lastErr = e;
        if (attempt === maxRetries) break;
      }
    }
    throw lastErr;
  };
}
