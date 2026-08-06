/**
 * 計器: **生成された文字が混ざる行で caret がどこに落ちるか**(2026-08-05。S7)。
 *
 * 設計 §5.5 は「誤差の向きは後ろに固定される(前へ飛び越さない)」と書いた。
 * ここはその主張を**実際の描画結果で**確かめる ── 自動採番の見出し / 脚注の参照 /
 * 置換される変数は、描画テキストに**原文に無い文字**が入るので最悪の相手である。
 *
 * 使い方: npx tsx tests/bench/run-caret-generated.ts
 */
import { renderMarkdown } from '@features/markdown/markdown-render';
import { mapVisibleToSource } from '@features/markdown/source-ranges';

const cases: { name: string; source: string; opts?: Parameters<typeof renderMarkdown>[1] }[] = [
  { name: '見出し(自動採番 ON)', source: '## 節の題名です', opts: { headingNumber: { start: 1 } } },
  { name: '見出し(採番 OFF・対照)', source: '## 節の題名です' },
  { name: '脚注の参照を含む段落', source: '本文に脚注[^a]が在る行。' },
  { name: '置換される変数', source: '値は {{name}} です。' },
  { name: '素の段落(対照)', source: 'ふつうの段落です。' },
  { name: '装飾を含む段落(対照)', source: 'あいうえお**かきくけこ**さしすせそ' },
];

for (const c of cases) {
  const html = renderMarkdown(c.source, c.opts);
  const visible = html.replace(/<[^>]*>/g, '').trim();
  const source = c.source;
  const rows: string[] = [];
  for (const frac of [0.25, 0.5, 0.9]) {
    const target = Math.round(visible.length * frac);
    const r = mapVisibleToSource(source, visible, target);
    // 「飛び越していないか」= 描画の狙いより後ろの文字を指していないか
    const ahead = r.offset > source.length ? 'OUT' : 'ok';
    rows.push(
      `    狙い ${String(target).padStart(2)} → 原文 ${String(r.offset).padStart(2)}` +
        ` exact=${r.exact ? 'yes' : 'no '} ${ahead} 手前=${JSON.stringify(source.slice(0, r.offset))}`,
    );
  }
  console.log(`${c.name}\n  原文: ${JSON.stringify(source)}\n  描画: ${JSON.stringify(visible)}\n${rows.join('\n')}`);
}
