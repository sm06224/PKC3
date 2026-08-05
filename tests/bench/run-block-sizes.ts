/**
 * 🔴 **S0: 実データで「最上位塊」の大きさを測る**(2026-08-05。ライブエディタ設計)。
 *
 * ## なぜ実装の前に測るのか
 * 設計の中心は「**塊を差し替え単位にする**」である。ところが PKC-Markdown は
 * `breaks: true`(単独改行が `<br>`)なので、**空行を打たない日本語の散文は丸ごと
 * 1 段落 = 1 塊**になる。`:::section` / `:::details` も中身全部で 1 塊、fence の
 * 上限は 64KB。つまり実データでは「編集中の塊 = 文書ほぼ全部」に潰れうる ──
 * そうなると機構は入るのに**見た目は今日と同じ**になる(最も静かな失敗)。
 * これは**着手前に分かる**ので、先に測る。
 *
 * ## ⚠ 何を測っていて、何を測っていないか
 * - 測っているのは **repo に在る実物の markdown**(この repo の doc 群 + マニュアル +
 *   golden 25 件)。⚠ **user の実ノートではない**(こちらからは見えない)。
 *   doc 群は「人間が書いた長い日本語 markdown」なので散文の癖の代理になるが、
 *   **代理である**ことを忘れて「実ノートで測った」と言わない。
 * - 塊の大きさは **描画後 HTML の文字数**と**原文の行数の推定**の 2 本で出す。
 *   行の対応(range sidecar)は**まだ無い**ので、行数は「塊の HTML に含まれる
 *   原文由来テキストの改行数」ではなく **空行区切りの原文チャンク**から数える近似。
 *   ⚠ 近似であることを出力に明記する。
 * - 集約(`:::toc` / 脚注 / 見出し番号 / link reference definition)の有無は
 *   **原文の正規表現**で数える(描画結果ではない)。
 *
 * 使い方: `npx vite-node tests/bench/run-block-sizes.ts`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { splitTopLevelBlocks } from '../../src/features/markdown/html-blocks';

interface Doc {
  name: string;
  text: string;
  origin: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

function collect(): Doc[] {
  const docs: Doc[] = [];
  for (const p of walk('docs')) {
    docs.push({ name: p, text: readFileSync(p, 'utf-8'), origin: 'repo-doc' });
  }
  const goldens = JSON.parse(
    readFileSync('tests/fixtures/markdown-goldens/goldens.json', 'utf-8'),
  ) as { cases: { name: string; input: string }[] };
  for (const c of goldens.cases) {
    docs.push({ name: `golden:${c.name}`, text: c.input, origin: 'golden' });
  }
  return docs;
}

/** 空行区切りの原文チャンク数(塊数の**原文側の**近似)。fence の中は数えない。 */
function sourceChunks(text: string): number {
  const lines = text.split(/\r?\n/);
  let chunks = 0;
  let inChunk = false;
  let fence: string | null = null;
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (f && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      if (!inChunk) {
        chunks += 1;
        inChunk = true;
      }
      continue;
    }
    if (line.trim() === '') {
      inChunk = false;
      continue;
    }
    if (!inChunk) {
      chunks += 1;
      inChunk = true;
    }
  }
  return chunks;
}

const AGGREGATES: readonly { key: string; re: RegExp }[] = [
  { key: ':::toc', re: /^:::toc/m },
  { key: '脚注', re: /^\[\^[^\]]+\]:/m },
  { key: '見出し番号(frontmatter)', re: /^heading-number:/m },
  { key: 'link reference definition', re: /^\[[^^\]]+\]:\s*\S+/m },
  { key: 'figure/table/equation の採番', re: /^:::(figure|table|equation)/m },
];

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i]!;
}

/**
 * 🔑 **最悪の場合の腕**(対照群は「測りたい違いだけが違うもの」)。
 *
 * 恐れている失敗は「**空行を打たない日本語の散文**が丸ごと 1 塊になる」こと。
 * それを直接測るために、同じ文書から**段落間の空行だけを取り除く**
 * (fence / 表 / `:::` の中は触らない ── 構文が壊れると測っているものが変わる)。
 */
function squashBlankLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  let inDirective = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      out.push(line);
      if (f && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push(line);
      continue;
    }
    if (/^\s*:::/.test(line)) {
      inDirective += /^\s*:::\s*$/.test(line) ? -1 : 1;
      if (inDirective < 0) inDirective = 0;
      out.push(line);
      continue;
    }
    // ⚠ 空行を落とすのは「構文の外」かつ「前後が普通の行」のときだけ。
    //    表 / 見出し / 箇条書きの隣は落とさない(`plain()` がそれを見る ──
    //    空行自体は `|` で始まらないので「表の中か」を別に持つ必要は無い)
    if (line.trim() === '' && fence === null && inDirective === 0) {
      const prev = out[out.length - 1] ?? '';
      const next = lines[i + 1] ?? '';
      const plain = (t: string): boolean =>
        t.trim() !== '' && !/^\s*(#|\||-|\*|\d+\.|>|:::|`{3,})/.test(t);
      if (plain(prev) && plain(next)) continue; // 落とす
    }
    out.push(line);
  }
  return out.join('\n');
}

const docs = collect();
const rows: {
  name: string;
  origin: string;
  chars: number;
  lines: number;
  blocks: number;
  chunks: number;
  maxShare: number;
  medianBlock: number;
  aggregates: string[];
}[] = [];

for (const d of docs) {
  let html: string;
  try {
    html = renderMarkdown(d.text, {});
  } catch (e) {
    console.log(`⚠ 描けなかった: ${d.name} — ${String(e).slice(0, 80)}`);
    continue;
  }
  const blocks = splitTopLevelBlocks(html);
  const sizes = blocks.map((b) => b.length).sort((a, b) => a - b);
  const total = sizes.reduce((a, b) => a + b, 0);
  rows.push({
    name: d.name,
    origin: d.origin,
    chars: d.text.length,
    lines: d.text.split(/\r?\n/).length,
    blocks: blocks.length,
    chunks: sourceChunks(d.text),
    maxShare: total === 0 ? 0 : (sizes[sizes.length - 1] ?? 0) / total,
    medianBlock: quantile(sizes, 0.5),
    aggregates: AGGREGATES.filter((a) => a.re.test(d.text)).map((a) => a.key),
  });
}

// ── 報告
console.log(`\n# S0: 最上位塊の分布(文書 ${rows.length} 件)`);
console.log('⚠ user の実ノートではない ── repo の doc 群(人間が書いた長い日本語 md)+ golden 25 件');
console.log('⚠ 塊の大きさは **描画後 HTML の文字数**。原文行との対応(range)はまだ無い\n');

for (const group of ['repo-doc', 'golden'] as const) {
  const g = rows.filter((r) => r.origin === group);
  if (g.length === 0) continue;
  const shares = g.map((r) => r.maxShare).sort((a, b) => a - b);
  const blocks = g.map((r) => r.blocks).sort((a, b) => a - b);
  console.log(`## ${group}(${g.length} 件)`);
  console.log(
    `  1 文書の塊数: 中央 ${quantile(blocks, 0.5)} / p90 ${quantile(blocks, 0.9)} / 最小 ${blocks[0]} / 最大 ${blocks[blocks.length - 1]}`,
  );
  console.log(
    `  最大の塊が文書に占める割合: 中央 ${(quantile(shares, 0.5) * 100).toFixed(1)}% / p90 ${(quantile(shares, 0.9) * 100).toFixed(1)}% / 最大 ${(shares[shares.length - 1]! * 100).toFixed(1)}%`,
  );
  // 🔴 「潰れている」= 最大の塊が文書の半分以上
  const collapsed = g.filter((r) => r.maxShare >= 0.5);
  console.log(
    `  🔴 潰れている文書(最大の塊が 50% 以上): ${collapsed.length} 件 / ${g.length}(${pct(collapsed.length, g.length)})`,
  );
  const tiny = g.filter((r) => r.blocks <= 2);
  console.log(`  塊が 2 個以下: ${tiny.length} 件(${pct(tiny.length, g.length)})`);
  for (const a of AGGREGATES) {
    const n = g.filter((r) => r.aggregates.includes(a.key)).length;
    console.log(`  集約「${a.key}」を持つ: ${n} 件(${pct(n, g.length)})`);
  }
  console.log('');
}

const docRows = rows.filter((r) => r.origin === 'repo-doc').sort((a, b) => b.chars - a.chars);
console.log('## 大きい doc の内訳(上位 8 件)');
console.log('| 文書 | 文字 | 行 | 塊 | 原文チャンク(近似) | 最大塊の割合 | 塊の中央値(HTML 文字) |');
console.log('|---|---|---|---|---|---|---|');
for (const r of docRows.slice(0, 8)) {
  console.log(
    `| ${r.name.replace('docs/development/', '…/')} | ${r.chars} | ${r.lines} | ${r.blocks} | ${r.chunks} | ${(r.maxShare * 100).toFixed(1)}% | ${r.medianBlock} |`,
  );
}

// 🔑 「1 塊 = 何行ぶんか」の代理: 原文行数 ÷ 塊数
const all = rows.filter((r) => r.origin === 'repo-doc');
const perBlock = all.map((r) => r.lines / Math.max(1, r.blocks)).sort((a, b) => a - b);
console.log(
  `\n## 1 塊あたりの原文行数(近似 = 行数 ÷ 塊数): 中央 ${quantile(perBlock, 0.5).toFixed(1)} 行 / p90 ${quantile(perBlock, 0.9).toFixed(1)} 行 / 最大 ${perBlock[perBlock.length - 1]!.toFixed(1)} 行`,
);
console.log(
  '⚠ これは平均であって「編集する塊」の大きさではない ── 見出し 1 行の塊と 40 行の表が平均で混ざる',
);

// ── 🔴 最悪の場合: 段落間の空行を取り除いた同じ文書(= 空行を打たない書き方)
console.log('\n## 🔴 最悪の場合(段落間の空行を落とした同じ文書)');
console.log('⚠ 対照群は「測りたい違いだけが違うもの」── 中身は同じで、空行だけを落とす');
console.log('| 文書 | 塊(元 → 空行なし) | 最大塊の割合(元 → 空行なし) |');
console.log('|---|---|---|');
let worstCollapsed = 0;
const worstShares: number[] = [];
for (const r of docRows.slice(0, 8)) {
  const original = docs.find((d) => d.name === r.name)!;
  const squashed = squashBlankLines(original.text);
  const bs = splitTopLevelBlocks(renderMarkdown(squashed, {}));
  const sizes = bs.map((b) => b.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const share = total === 0 ? 0 : Math.max(...sizes) / total;
  worstShares.push(share);
  if (share >= 0.5) worstCollapsed += 1;
  console.log(
    `| ${r.name.replace('docs/development/', '…/')} | ${r.blocks} → ${bs.length} | ${(r.maxShare * 100).toFixed(1)}% → **${(share * 100).toFixed(1)}%** |`,
  );
}
const sortedWorst = [...worstShares].sort((a, b) => a - b);
console.log(
  `\n  空行なしでも潰れない文書: ${worstShares.length - worstCollapsed} / ${worstShares.length}(最大塊の割合 中央 ${(quantile(sortedWorst, 0.5) * 100).toFixed(1)}% / 最大 ${(sortedWorst[sortedWorst.length - 1]! * 100).toFixed(1)}%)`,
);
console.log(
  '⚠ この腕は「見出し・箇条書き・表が残っている」文書での最悪値である ── **見出しも箇条書きも無い、\n' +
    '  空行も無い一枚の散文**は 1 塊に潰れる(それは原理であって測る必要が無い)。その形の\n' +
    '  ノートがどれだけ在るかは **user の実データでしか分からない**(未計測)',
);
