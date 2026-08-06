/** @vitest-environment happy-dom */
/**
 * 🔴 **本文由来の PUA sentinel が描画を壊さない**(2026-08-06。方向 doc §1 C5)。
 *
 * この描画器は `html: false`(生 HTML を通さない)を **PUA(U+E110〜)の sentinel で
 * 意図的に迂回**している。ところが **入力側で本文の PUA を落としている場所が 1 か所も
 * 無く、`tests/` に PUA を名指す assert も 0 件**だった ── 方言の是非と無関係な
 * XSS / データ破壊の境界が、誰にも守られていなかった。
 *
 * 実測(2026-08-06、直す前):
 * - 26 個の sentinel は**全部そのまま出力に漏れた**(不可視の私用領域文字として残る)
 * - タグは生えない(`:::section` の並びを真似ても block にならない)── ここは健全だった
 * - 🔴 **`:::format` の並びを真似ると、その行が丸ごと消えた**
 *   (`SENT0SEPOPENSENT` と書くと**その段落が出力から黙って消滅**)
 *
 * つまり XSS ではなく **「書いた行が描画から静かに消える」** 実害である。
 */
import { describe, expect, it } from 'vitest';
import {
  renderMarkdown,
  neutralizeSentinels,
} from '../../src/features/markdown/markdown-render';

/**
 * この描画器が使う sentinel の全部。
 * ⚠ **実装から機械的に取る**(手で写すと、sentinel を足したときにここが古くなる)。
 */
const SENTINELS: string[] = (() => {
  const src = readSource();
  const found = new Set<string>();
  for (const m of src.matchAll(/'\\u\{(E1[0-9A-F]{2})\}'/g)) {
    found.add(String.fromCodePoint(parseInt(m[1]!, 16)));
  }
  return [...found];
})();

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync('src/features/markdown/markdown-render.ts', 'utf8');
}

describe('PUA sentinel は本文から入れない', () => {
  it('⚠ fixture が空振りしていない(sentinel を 20 個以上見つけている)', () => {
    // ⚠ 実装から取り損ねると「0 個を検査して緑」になる ── 下限を置く
    expect(SENTINELS.length, 'sentinel を実装から拾えていない').toBeGreaterThanOrEqual(20);
  });

  it('🔴 本文に書いた sentinel は 1 つも出力に漏れない', () => {
    for (const s of SENTINELS) {
      const cp = s.codePointAt(0)!.toString(16).toUpperCase();
      const html = renderMarkdown(`本文${s}0${s}続き\n`, { silentHallucinationWarnings: true });
      expect(html.includes(s), `U+${cp} が出力に漏れている`).toBe(false);
    }
  });

  it('🔴 sentinel の並びを真似ても、その行が消えない(静かなデータ欠損)', () => {
    // `:::format` の open/sep を真似る ── 直す前はこの段落が出力から消えていた
    const fo = '\u{E16E}';
    const fs = '\u{E16F}';
    const html = renderMarkdown(`${fo}0${fs}OPEN${fo}\n\n本文\n`, {
      silentHallucinationWarnings: true,
    });
    expect(html, '本文が消えた').toContain('本文');
    // 1 行目も残っている(段落が 2 つ)
    expect((html.match(/<p[ >]/g) ?? []).length, '1 行目が丸ごと消えた').toBe(2);
  });

  it('🔴 sentinel の並びを真似てもブロックは生えない(構造の偽造)', () => {
    const o = '\u{E160}';
    const sep = '\u{E161}';
    const html = renderMarkdown(`${o}0${sep}note${o}\n\n本文\n`, {
      silentHallucinationWarnings: true,
    });
    expect(html, 'section が偽造された').not.toContain('pkc-section');
    expect(html, 'callout の role が偽造された').not.toContain('data-pkc-role');
  });

  it('⚠ 文字数を変えない(LineMap と列がずれない)', () => {
    const src = `a\u{E160}b\u{E16F}c`;
    expect(neutralizeSentinels(src)).toHaveLength(src.length);
    expect(neutralizeSentinels(src)).toBe('a\uFFFDb\uFFFDc');
  });

  it('⚠ 範囲の外は触らない(通常の私用領域や絵文字を壊さない)', () => {
    // U+E17F の外 / 絵文字 / 全角
    const keep = 'あ\u{E200}い\u{1F600}う';
    expect(neutralizeSentinels(keep)).toBe(keep);
  });

  it('⚠ 呼び出しが状態を持たない(`g` 付き正規表現の lastIndex 事故)', () => {
    const src = `x\u{E160}y`;
    expect(neutralizeSentinels(src)).toBe('x\uFFFDy');
    // 2 回目も同じ(lastIndex を持ち回っていたら 2 回目が素通りする)
    expect(neutralizeSentinels(src)).toBe('x\uFFFDy');
  });
});
