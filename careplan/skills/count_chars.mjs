#!/usr/bin/env node
// 文字数カウンタ（決定論）: 原案draftの各セルを cell_limits.json と突き合わせ、
// 上限超過を機械判定する。字数調整エージェントの「合否」はこのコードが下す（LLMに数えさせない）。
//
// 使い方:
//   node count_chars.mjs <draft.json> [cell_limits.json] > report.json
//   exit code: 超過が1つでもあれば 1、なければ 0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIMITS = join(HERE, "..", "schemas", "cell_limits.json");

// 全角も1文字として数える（Intl.Segmenterで書記素単位・絵文字結合も考慮）
export function len(s) {
  if (s == null) return 0;
  const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
  return [...seg.segment(String(s))].length;
}

export function checkChars(draft, limits) {
  const rows = [];
  const add = (path, value, limit) => {
    if (limit == null) return;
    const n = len(value);
    rows.push({ cell: path, chars: n, limit, over: n > limit, overflow: Math.max(0, n - limit) });
  };
  const t1 = draft.table1 || {};
  for (const k of Object.keys(limits.table1 || {})) add(`table1.${k}`, t1[k], limits.table1[k]);
  (draft.table2 || []).forEach((row, i) => {
    for (const k of Object.keys(limits.table2 || {})) add(`table2[${i}].${k}`, row[k], limits.table2[k]);
  });
  const overCount = rows.filter((r) => r.over).length;
  return { ok: overCount === 0, over_count: overCount, cells: rows };
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [draftPath, limitsPath = DEFAULT_LIMITS] = process.argv.slice(2);
  if (!draftPath) {
    console.error("usage: node count_chars.mjs <draft.json> [cell_limits.json]");
    process.exit(2);
  }
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  const limits = JSON.parse(readFileSync(limitsPath, "utf8"));
  const report = checkChars(draft, limits);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}
