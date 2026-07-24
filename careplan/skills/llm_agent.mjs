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

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = join(HERE, "..", "schemas");
const AGENTS = join(HERE, "..", "agents");
const KNOWLEDGE = join(HERE, "..", "knowledge");

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

// 型テンプレート（制度知識）を段に応じて選び、システムに同梱する参照ナレッジを返す。
//   01_classify_type : 3型のタイトル＋「適用対象」節（型を選ぶ判断材料）
//   02 / 03          : 選ばれた型（plan_type.code）の全文
//   04 / 05          : なし
export function knowledgeFor(name, input, knowledgeDir = KNOWLEDGE) {
  const load = (code) => {
    const p = join(knowledgeDir, `${code}.md`);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  // 「## 1. 適用対象」節を見出しから次の「## 」まで抜く
  const applicableSection = (md) => {
    const lines = md.split("\n");
    const start = lines.findIndex((l) => /^##\s*1\.\s*適用対象/.test(l));
    if (start < 0) return "";
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join("\n").trim();
  };

  if (name === "01_classify_type") {
    return ["type1A", "type1B", "type2A"]
      .map((code) => {
        const md = load(code);
        if (!md) return "";
        const title = md.split("\n").slice(0, 2).join("\n").replace(/^#+\s*/gm, "");
        return `### ${code}\n${title}\n\n${applicableSection(md)}`;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
  }
  if (name === "02_extract_needs" || name === "03_draft_plan") {
    const code = input && input.plan_type && input.plan_type.code;
    if (code && code !== "generic") return load(code);
  }
  return "";
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
export function buildRequest(name, input, { agentsDir = AGENTS, schemasDir = SCHEMAS, knowledgeDir = KNOWLEDGE, model = "claude-opus-4-8", maxTokens = 8000 } = {}) {
  let system = readFileSync(join(agentsDir, `${name}.md`), "utf8");
  const knowledge = knowledgeFor(name, input, knowledgeDir);
  if (knowledge) {
    system += "\n\n---\n\n# 参照ナレッジ（型テンプレート・制度知識）\n\nこの利用者に適用する型の知識です。サービス組合せ・役割分担・記載例・注意点はこれに整合させてください。\n\n" + knowledge;
  }
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
