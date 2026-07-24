#!/usr/bin/env node
// 読取スキル（決定論）: アセスメント素材(01_basic_info + 03_assessment 等)の markdown を
// assessment.schema.json 形式へ無損失パースする。LLMを通さないため、値の改変・要約は一切行わない。
// マッピングできなかった節は _raw に丸ごと残し、脱落させない。
//
// 使い方:
//   node parse_assessment.mjs <basic_info.md> [assessment.md ...] > assessment.json

import { readFileSync } from "node:fs";
import { parseSections, findSection } from "./lib/md.mjs";

function kvOf(parsed, headingNeedle) {
  const s = findSection(parsed, headingNeedle);
  return s ? s.kv : {};
}
function textOf(parsed, headingNeedle) {
  const s = findSection(parsed, headingNeedle);
  return s ? s.text : "";
}
// 「### 特記事項」など小見出しの本文を、親節の範囲から拾う簡易版
function listItems(parsed, headingNeedle) {
  const s = findSection(parsed, headingNeedle);
  if (!s) return [];
  return s.text
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
}

export function parseAssessment(sources) {
  // 全ソースを1つのセクション集合に連結（採番の重複は前方一致検索で吸収）
  const merged = { sections: [] };
  const rawByFile = {};
  for (const { name, content } of sources) {
    const p = parseSections(content);
    merged.sections.push(...p.sections);
    rawByFile[name] = p.sections.map((s) => s.heading);
  }

  const idInfo = kvOf(merged, "識別情報");
  const cert = kvOf(merged, "認定情報");
  const keyp = kvOf(merged, "キーパーソン");
  const meas = kvOf(merged, "身体測定");
  // 箇条書き（- 認定時：C2 / - 現在（CM判断）：C2）を1行に畳む。
  // 水平線（---, --）や空行は除く。
  const flat = (s) =>
    String(s || "")
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l && !/^-{1,}$/.test(l))
      .join(" / ") || undefined;
  const indep1 = flat(textOf(merged, "障害高齢者の日常生活自立度"));
  const indep2 = flat(textOf(merged, "認知症高齢者の日常生活自立度"));

  const out = {
    meta: {
      alias: idInfo["仮名"] || kvOf(merged, "アセスメント基本情報")["実施者"] ? (idInfo["仮名"] || "利用者") : "利用者",
      pseudonymized: /仮名化済み/.test(JSON.stringify(merged).slice(0, 400)) || undefined,
      assessed_on: kvOf(merged, "アセスメント基本情報")["実施日"] || undefined,
      assessor: kvOf(merged, "アセスメント基本情報")["実施者"] || undefined,
      reason: kvOf(merged, "アセスメント基本情報")["アセスメント理由"] || undefined,
      source_files: sources.map((s) => s.name),
    },
    basic: {
      age: idInfo["年齢"],
      sex: idInfo["性別"],
      care_level: idInfo["要介護度"],
      cert_period: idInfo["認定有効期間"] || cert["有効期間"],
      residence: kvOf(merged, "居住情報")["居住区分"],
      facility: kvOf(merged, "居住情報")["施設名"],
      household: textOf(merged, "世帯区分") || undefined,
      key_person: Object.keys(keyp).length
        ? {
            relation: keyp["続柄"],
            alias: keyp["仮名"],
            cohabit: keyp["同居/別居"],
            involvement: keyp["介護への関与度"],
            burden: keyp["現在の負担感"],
            willingness: keyp["支援への参加意思"],
          }
        : undefined,
      medical_dependency: kvOf(merged, "現病")["医療依存度"] || undefined,
    },
    independence: {
      disabled_elderly: indep1 || undefined,
      dementia_elderly: indep2 || undefined,
    },
    health: {
      diagnoses: (findSection(merged, "既往歴") || findSection(merged, "主病") || { tables: [] }).tables
        ?.flatMap((t) => (t.headers.length === 2 ? t.rows.map((r) => ({ name: r[0], onset: r[1] })) : []))
        .filter((d) => d.name && d.name !== "病名") || [],
      medication: textOf(merged, "服薬内容") || undefined,
      measurements: Object.keys(meas).length
        ? {
            height_cm: meas["身長"],
            weight_kg: meas["体重"],
            bmi: meas["BMI"],
            paralysis: meas["麻痺"],
            pressure_ulcer: meas["褥瘡"],
          }
        : undefined,
      notes: textOf(merged, "10.5") || textOf(merged, "健康状態") || undefined,
    },
    adl: kvOf(merged, "11. ADL") && Object.keys(kvOf(merged, "ADL")).length ? kvOf(merged, "ADL") : undefined,
    iadl: Object.keys(kvOf(merged, "IADL")).length ? kvOf(merged, "IADL") : undefined,
    cognition: Object.keys(kvOf(merged, "認知機能評価")).length ? kvOf(merged, "認知機能評価") : undefined,
    communication: Object.keys(kvOf(merged, "コミュニケーション")).length ? kvOf(merged, "コミュニケーション") : undefined,
    excretion: Object.keys(kvOf(merged, "排尿・排便")).length ? kvOf(merged, "排尿・排便") : undefined,
    skin: (() => {
      const kv = kvOf(merged, "褥瘡・皮膚");
      const notes = textOf(merged, "17.");
      if (!Object.keys(kv).length && !notes) return undefined;
      return { ...kv, notes: notes || undefined };
    })(),
    oral: Object.keys(kvOf(merged, "口腔衛生")).length ? kvOf(merged, "口腔衛生") : undefined,
    nutrition: Object.keys(kvOf(merged, "食事摂取")).length ? kvOf(merged, "食事摂取") : undefined,
    family_care: Object.keys(kvOf(merged, "家族等の状況")).length ? kvOf(merged, "家族等の状況") : undefined,
    environment: Object.keys(kvOf(merged, "居住環境")).length ? kvOf(merged, "居住環境") : undefined,
    special: Object.keys(kvOf(merged, "特別な状況")).length ? kvOf(merged, "特別な状況") : undefined,
    daily_rhythm: (() => {
      const s = findSection(merged, "生活リズム");
      if (!s || !s.tables.length) return undefined;
      const t = s.tables.find((x) => x.headers.length === 2);
      return t ? t.rows.map((r) => ({ time: r[0], activity: r[1] })) : undefined;
    })(),
    current_services: (() => {
      const s = findSection(merged, "現在利用しているサービス") || findSection(merged, "担当者情報");
      if (!s) return undefined;
      const t = s.tables.find((x) => x.headers.length === 2);
      return t ? t.rows.filter((r) => r[0] && !/サービス|役割/.test(r[0])).map((r) => ({ service: r[0], provider: r[1] })) : undefined;
    })(),
    voice: (() => {
      const clean = (s) =>
        String(s || "")
          .replace(/[*_]+/g, "")
          .replace(/^\s*>\s?/gm, "")
          .replace(/（[^）]*）\s*$/gm, "")
          .replace(/\s*\n\s*/g, " ")
          .trim() || undefined;
      // 見出し「主訴/主訔」の表記ゆれ（U+8A34/U+8A94）と本文の同ゆれに耐える
      const sec = merged.sections.find((s) => /主[訴訔]/.test(s.heading) && /^7[.\s]/.test(s.heading));
      const t = sec ? sec.text : "";
      const [selfPart, famPart] = t.split(/\*{0,2}ご?家族の主[訴訔]/);
      return {
        self: clean((selfPart || "").replace(/.*本人の主[訴訔]/s, "")),
        family: famPart != null ? clean(famPart) : undefined,
      };
    })(),
    assessment_summary: {
      // 総括の小見出しは「強み（ストレングス）」「課題（ニーズの源泉）」等。
      // 「課題」だけだと「課題分析理由」に誤マッチするため具体語で引く。
      overview: textOf(merged, "アセスメント総括") || textOf(merged, "全体のまとめ") || undefined,
      strengths: listItems(merged, "ストレングス"),
      issues: listItems(merged, "ニーズの源泉"),
      priority_domains: listItems(merged, "優先すべき支援領域"),
    },
    _raw: rawByFile,
  };
  return out;
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node parse_assessment.mjs <md...> > assessment.json");
    process.exit(1);
  }
  const sources = files.map((f) => ({ name: f.split("/").pop(), content: readFileSync(f, "utf8") }));
  process.stdout.write(JSON.stringify(parseAssessment(sources), null, 2) + "\n");
}
