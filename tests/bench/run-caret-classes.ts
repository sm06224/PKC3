/**
 * 🔴 **caret の写像がどれだけ効くかを実データで数える**(2026-08-05。ライブエディタ設計 §5.5)。
 *
 * user 質問「コードブロックのような複数行に対する caret 位置が変わってしまうということ?」
 * への答えの根拠。**複数行は難しさに関係しない** ── 難しいのは「1 行の中の装飾」で、
 * 描画テキストと原文が別の文字列になる(実測: 45 文字 → 16 文字)。
 *
 * ⚠ この計器の分類は **行の頭だけ**を見る粗いもの(箇条書き・表・引用の**中身**にも
 * 装飾は在りうる)。正確な数は range sidecar(S2)が入ってから出す ── ここで言えるのは
 * 「装飾を含む行は多数派ではないが、無視できる少数でもない」まで。
 * ⚠ user の実ノートではない(repo の doc 群 = 人間が書いた長い日本語 md の代理)。
 *
 * 使い方: `npx vite-node tests/bench/run-caret-classes.ts`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}
/** 1 行の中に「描画テキストが原文と食い違う装飾」が在るか */
const INLINE = [
  /\*\*[^*]+\*\*/, /(^|[^*])\*[^*\s][^*]*\*/, /__[^_]+__/, /~~[^~]+~~/,
  /`[^`]+`/, /\[[^\]]+\]\([^)]+\)/, /!\[[^\]]*\]\([^)]+\)/, /==[^=]+==/,
  /\{\{[^}]+\}\}/, /\[\^[^\]]+\]/, /&[a-z]+;|&#\d+;/, /\^\S+\^/, /~\S+~/,
];
const kinds: Record<string, number> = {};
let total = 0;
for (const p of walk('docs')) {
  const lines = readFileSync(p, 'utf-8').split(/\r?\n/);
  let fence: string | null = null;
  let cur: string[] | null = null;
  const flush = (): void => {
    if (!cur || cur.length === 0) { cur = null; return; }
    const head = cur[0]!;
    let kind: string;
    if (/^\s*(`{3,}|~{3,})/.test(head)) kind = 'コードブロック(fence)';
    else if (/^\s*\|/.test(head)) kind = '表';
    else if (/^\s*([-*+]|\d+\.)\s/.test(head)) kind = '箇条書き';
    else if (/^\s*>/.test(head)) kind = '引用';
    else if (/^\s*:::/.test(head)) kind = 'ディレクティブ(:::)';
    else if (/^\s*#{1,6}\s/.test(head)) kind = cur.some((l) => INLINE.some((r) => r.test(l))) ? '見出し(装飾あり)' : '見出し(装飾なし)';
    else kind = cur.some((l) => INLINE.some((r) => r.test(l))) ? '段落(装飾あり)' : '段落(装飾なし)';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    total += 1;
    cur = null;
  };
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) { cur!.push(line); if (f && line.trim().startsWith(fence)) { fence = null; flush(); } continue; }
    if (f) { flush(); cur = [line]; fence = f[1]!; continue; }
    if (line.trim() === '') { flush(); continue; }
    if (cur === null) cur = [line];
    else cur.push(line);
  }
  flush();
}
const EXACT = new Set(['コードブロック(fence)', '表', '箇条書き', '引用', '見出し(装飾なし)', '段落(装飾なし)', 'ディレクティブ(:::)']);
console.log(`\n# 実データ(repo の doc 群)の塊 ${total} 個の内訳\n`);
const rows = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
console.log('| 塊の種類 | 個数 | 割合 | caret |');
console.log('|---|---|---|---|');
for (const [k, n] of rows) {
  console.log(`| ${k} | ${n} | ${((n / total) * 100).toFixed(1)}% | ${EXACT.has(k) ? '正確に入れる' : '**近似が要る**'} |`);
}
const approx = rows.filter(([k]) => !EXACT.has(k)).reduce((a, [, n]) => a + n, 0);
console.log(`\n近似が要る塊: **${approx} / ${total} = ${((approx / total) * 100).toFixed(1)}%**`);
console.log(`正確に入れる塊: ${total - approx} / ${total} = ${(((total - approx) / total) * 100).toFixed(1)}%`);
