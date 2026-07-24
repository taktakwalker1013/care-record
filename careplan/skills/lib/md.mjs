// 無損失Markdownパーサ（決定論・LLMを通さない）
// アセスメント素材(01〜07)の「## 見出し」と「| key | value |」表を、
// 事実を一切改変せずに構造化する。マッピングできない内容も raw に保持し、脱落させない。

// Drive等でエスケープされた md（\#, \-, \> 等）も受けられるよう軽く正規化する。
export function normalize(src) {
  return String(src)
    .replace(/\r\n?/g, "\n")
    .replace(/^\\(#{1,6})/gm, "$1")   // \#\# -> ##
    .replace(/\\([\->|*_])/g, "$1")    // \- \> \| \* \_ -> そのまま
    .replace(/\\\\/g, "\\");
}

// 表を [{headers:[...], rows:[[...],...]}] に。区切り行(---)は捨てる。
function parseTable(lines) {
  const rows = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
    );
  if (!rows.length) return null;
  const isSep = (r) => r.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));
  const headers = rows[0];
  const body = rows.slice(1).filter((r) => !isSep(r));
  return { headers, rows: body };
}

// md -> { sections: [{ level, heading, text, tables:[...], kv:{...} }] }
export function parseSections(src) {
  const text = normalize(src);
  const lines = text.split("\n");
  const sections = [];
  let cur = { level: 0, heading: "(preamble)", lines: [] };
  const push = () => {
    const body = cur.lines;
    const tableBlocks = [];
    let buf = [];
    const flush = () => {
      if (buf.length) {
        const t = parseTable(buf);
        if (t) tableBlocks.push(t);
        buf = [];
      }
    };
    const prose = [];
    for (const l of body) {
      if (l.trim().startsWith("|")) buf.push(l);
      else {
        flush();
        if (l.trim()) prose.push(l.trim());
      }
    }
    flush();
    // 2列表は key->value 辞書として畳む（1列目=項目, 2列目=内容 が定型）
    const kv = {};
    for (const t of tableBlocks) {
      if (t.headers.length === 2) {
        for (const r of t.rows) if (r[0]) kv[r[0]] = r[1] ?? "";
      }
    }
    sections.push({
      level: cur.level,
      heading: cur.heading,
      text: prose.join("\n"),
      tables: tableBlocks,
      kv,
    });
  };
  for (const l of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) {
      push();
      cur = { level: m[1].length, heading: m[2].trim(), lines: [] };
    } else {
      cur.lines.push(l);
    }
  }
  push();
  return { sections };
}

// 見出しでセクションを引く。採番揺れに強く、かつ「課題」が「課題分析理由」に
// 誤マッチしないよう、完全一致 > 前方一致 > 部分一致 の順で最も具体的な節を返す。
export function findSection(parsed, needle) {
  const n = needle.replace(/\s/g, "");
  let best = null;
  let bestRank = 99;
  for (const s of parsed.sections) {
    const h = s.heading.replace(/\s/g, "");
    let rank = 99;
    if (h === n) rank = 0;
    else if (h.startsWith(n)) rank = 1;
    else if (h.includes(n)) rank = 2;
    if (rank < bestRank) {
      bestRank = rank;
      best = s;
      if (rank === 0) break;
    }
  }
  return best;
}
