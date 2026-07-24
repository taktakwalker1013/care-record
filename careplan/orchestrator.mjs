#!/usr/bin/env node
// オーケストレータ: 分業パイプラインを束ねる。
//
//   [読取:コード] parse → assessment.json
//        ├─ [型判定:エージェント] 01 → plan_type
//        ├─ [ニーズ抽出:エージェント] 02 → needs.json
//        ├─ [原案作成:エージェント] 03 → draft
//        ├─ [字数調整:エージェント⇄カウンタ:コード] 04 ↔ count_chars → fitted
//        ├─ [検証:エージェント] 05 → verify report
//        └─ [転記:コード] transcribe → careplan.md（超過は fail-closed）
//
// 判断の段（01〜05）は「エージェント実行器」に委譲する。実行器は差し替え可能:
//   - replayAgent(dir): 捕捉済みの出力JSONを読む（オフライン・再現可能なデモ／テスト用）
//   - （拡張）llmAgent:  エージェントのプロンプト+スキーマでLLMを呼ぶ実運用用
//
// 使い方:
//   node orchestrator.mjs --in a.md,b.md --captured fixtures/captured --out fixtures/out   # 再生（オフライン）
//   ANTHROPIC_API_KEY=sk-ant-... node orchestrator.mjs --llm --in a.md,b.md --out fixtures/out  # 実LLM

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseAssessment } from "./skills/parse_assessment.mjs";
import { checkChars } from "./skills/count_chars.mjs";
import { transcribe } from "./skills/transcribe.mjs";
import { llmAgent } from "./skills/llm_agent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIMITS = JSON.parse(readFileSync(join(HERE, "schemas", "cell_limits.json"), "utf8"));

// 捕捉済み出力を読むエージェント実行器（デモ／テスト用・オフライン）
export function replayAgent(dir) {
  return async (name /*, input */) => {
    const p = join(dir, `${name}.json`);
    if (!existsSync(p)) throw new Error(`captured output not found: ${p}（実運用ではLLM実行器に差し替える）`);
    return JSON.parse(readFileSync(p, "utf8"));
  };
}

export async function orchestrate({ sources, agent, outDir, maxFitIters = 5, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const write = (f, obj) => writeFileSync(join(outDir, f), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) + "\n");

  // 1. 読取（決定論）
  log("[1/6] 読取（コード）: assessment.json");
  const assessment = parseAssessment(sources);
  write("assessment.json", assessment);

  // 2. 型判定
  log("[2/6] 型判定（エージェント）");
  const typeOut = await agent("01_classify_type", { assessment });
  write("plan_type.json", typeOut);

  // 3. ニーズ抽出
  log("[3/6] ニーズ抽出（エージェント）");
  const needs = await agent("02_extract_needs", { assessment, plan_type: typeOut.plan_type });
  write("needs.json", needs);

  // 4. 原案作成
  log("[4/6] 原案作成（エージェント）");
  let draft = await agent("03_draft_plan", { assessment, needs });
  write("draft.raw.json", draft);

  // 5. 字数調整ループ（エージェント⇄カウンタ）
  log("[5/6] 字数調整（エージェント⇄カウンタ・コード）");
  let report = checkChars(draft, LIMITS);
  let iter = 0;
  while (!report.ok && iter < maxFitIters) {
    iter++;
    log(`   超過 ${report.over_count} セル → 圧縮 (iter ${iter})`);
    draft = await agent("04_fit_chars", { draft, over: report.cells.filter((c) => c.over) }, iter);
    report = checkChars(draft, LIMITS);
  }
  write("draft.fitted.json", draft);
  write("char_report.json", report);
  if (!report.ok) log(`   [warn] 未収束（${report.over_count} セル超過）。人手差し戻し対象。`);

  // 6. 検証（根拠照合）
  log("[6/6] 検証（エージェント）");
  const verify = await agent("05_verify", { assessment, needs, draft });
  write("verify.json", verify);

  // 転記（決定論・fail-closed）
  const forced = report.ok || false;
  const careplanMd = transcribe(draft);
  write("careplan.md", careplanMd);

  return { assessment, plan_type: typeOut, needs, draft, char_report: report, verify, careplanMd, chars_ok: report.ok };
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, arr) => {
      if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
      return acc;
    }, [])
  );
  const useLlm = process.argv.includes("--llm");
  const inFiles = (args.in || "").split(",").filter(Boolean);
  const capturedDir = args.captured;
  const outDir = args.out || join(HERE, "fixtures", "out");
  if (!inFiles.length || (!useLlm && !capturedDir)) {
    console.error("usage:\n  node orchestrator.mjs --in a.md,b.md --captured <dir> --out <dir>   # 再生\n  ANTHROPIC_API_KEY=... node orchestrator.mjs --llm --in a.md,b.md --out <dir>   # 実LLM");
    process.exit(1);
  }
  const sources = inFiles.map((f) => ({ name: f.split("/").pop(), content: readFileSync(f, "utf8") }));
  const runner = useLlm
    ? llmAgent({ model: args.model || "claude-opus-4-8", log: (m) => console.error(m) })
    : replayAgent(capturedDir);
  const res = await orchestrate({ sources, agent: runner, outDir, log: (m) => console.error(m) });
  console.error(`\n完了 → ${outDir}`);
  console.error(`  型: ${res.plan_type.plan_type?.code} / ニーズ: ${res.needs.needs.length}件 / 文字数OK: ${res.chars_ok} / 検証: ${res.verify.verdict}`);
}
