#!/usr/bin/env node
// 転記スキル（決定論・無損失）: careplan-draft.json を『ケアプラン原案_作成支援キット』の
// 第1表・第2表・第3表の書式へ機械的に流し込む。LLMを通さないため、確定した文言を
// 一字も書き換えない。転記前に文字数上限を検査し、超過があれば fail-closed で中断する
// （--force で警告付き続行）。
//
// 使い方:
//   node transcribe.mjs <draft.json> [cell_limits.json] [--force] > careplan.md

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkChars } from "./count_chars.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIMITS = join(HERE, "..", "schemas", "cell_limits.json");

const cell = (s) => String(s ?? "").replace(/\n+/g, " ").replace(/\|/g, "／");

export function transcribe(draft) {
  const t1 = draft.table1 || {};
  const t2 = draft.table2 || [];
  const t3 = draft.table3;
  const L = [];
  L.push("# 居宅サービス計画書（原案）\n");
  L.push("> 本書はケアプラン原案（たたき台）です。最終的な内容の確認・調整・交付はケアマネジャーが行ってください。\n");

  L.push("## 第1表\n");
  L.push("| 項目 | 記入内容 |");
  L.push("| :-- | :-- |");
  L.push(`| 利用者・家族の生活に対する意向 | 本人：${cell(t1.intent_self)}　家族：${cell(t1.intent_family)} |`);
  L.push(`| 総合的な援助の方針 | ${cell(t1.policy)} |`);
  if (t1.living_support_reason) L.push(`| 生活援助中心型の算定理由 | ${cell(t1.living_support_reason)} |`);
  L.push("");

  L.push("## 第2表\n");
  L.push("| 生活全般の解決すべき課題（ニーズ） | 長期目標 | 短期目標 | 期間（長期/短期） | サービス内容 | サービス種別／頻度 |");
  L.push("| :-- | :-- | :-- | :-- | :-- | :-- |");
  for (const r of t2) {
    const period = [r.period_long, r.period_short].filter(Boolean).join(" / ") || "";
    const kind = [r.service_kind, r.frequency].filter(Boolean).join(" ");
    L.push(`| ${cell(r.need)} | ${cell(r.long_goal)} | ${cell(r.short_goal)} | ${cell(period)} | ${cell(r.service_content)} | ${cell(kind)} |`);
  }
  L.push("");

  if (t3 && Array.isArray(t3.slots) && t3.slots.length) {
    L.push("## 第3表（週間サービス計画表）\n");
    L.push("|  | 月 | 火 | 水 | 木 | 金 | 土 | 日 |");
    L.push("| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |");
    for (const s of t3.slots) {
      L.push(`| ${cell(s.band)} | ${cell(s.mon)} | ${cell(s.tue)} | ${cell(s.wed)} | ${cell(s.thu)} | ${cell(s.fri)} | ${cell(s.sat)} | ${cell(s.sun)} |`);
    }
    L.push("");
  }
  return L.join("\n");
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const [draftPath, limitsPath = DEFAULT_LIMITS] = args.filter((a) => a !== "--force");
  if (!draftPath) {
    console.error("usage: node transcribe.mjs <draft.json> [cell_limits.json] [--force]");
    process.exit(2);
  }
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  const limits = JSON.parse(readFileSync(limitsPath, "utf8"));
  const chk = checkChars(draft, limits);
  if (!chk.ok && !force) {
    const bad = chk.cells.filter((c) => c.over).map((c) => `  - ${c.cell}: ${c.chars}/${c.limit} (+${c.overflow})`);
    console.error(`転記中断: ${chk.over_count}個のセルが文字数上限を超過。字数調整エージェントに差し戻してください。\n${bad.join("\n")}`);
    process.exit(1);
  }
  if (!chk.ok) console.error(`[warn] --force: ${chk.over_count}個の超過セルを含めて転記します。`);
  process.stdout.write(transcribe(draft) + "\n");
}
