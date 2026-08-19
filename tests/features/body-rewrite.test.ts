/**
 * 🔴 **本文の構造化書換**(#276 / #277)。frontmatter の鍵も、チェックの印も、
 * **同じ 1 本**(`applyBodyRewrite`)を通る。
 *
 * 守る主張:
 * 1. **印の 1 文字だけを書き換える**(本文は byte 無傷 ── 空白の入れ方も保つ)
 * 2. 🔴 **当たらなかったら `null`**(当てずっぽうで別の行を書き換えない)
 * 3. 番号つきリストでも効く(記法を狭めない)
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite, isTaskLine } from '../../src/features/markdown/body-rewrite';

describe('チェックの印(#277)', () => {
  const DOC = ['# 題', '', '- [ ] やること', '- [x] 済んだこと', '', '本文'].join('\n');

  it('🔴 印を反転する(その行だけ)', () => {
    const on = applyBodyRewrite(DOC, { kind: 'task', line: 2 })!;
    expect(on.split('\n')[2]).toBe('- [x] やること');
    // ⚠ ほかの行は 1 文字も動いていない
    expect(on.split('\n').filter((_, i) => i !== 2)).toEqual(
      DOC.split('\n').filter((_, i) => i !== 2),
    );
    const off = applyBodyRewrite(DOC, { kind: 'task', line: 3 })!;
    expect(off.split('\n')[3]).toBe('- [ ] 済んだこと');
  });

  /**
   * 🔴 **空白の入れ方を保つ**(本文を byte 無傷で戻す規律)。
   * ⚠ 行を組み直す実装だと、ここが勝手に整形される。
   */
  it('🔴 余分な空白や字下げを整形しない', () => {
    const body = '  -   [ ]   ゆるい書き方';
    expect(applyBodyRewrite(body, { kind: 'task', line: 0 })).toBe('  -   [x]   ゆるい書き方');
  });

  it('番号つきリストでも効く(記法を狭めない)', () => {
    for (const src of ['1. [ ] あ', '1) [ ] あ', '* [ ] あ', '+ [ ] あ']) {
      expect(applyBodyRewrite(src, { kind: 'task', line: 0 }), src).toBe(src.replace('[ ]', '[x]'));
    }
    expect(applyBodyRewrite('- [X] 大文字', { kind: 'task', line: 0 })).toBe('- [ ] 大文字');
  });

  /**
   * 🔴 **当たらなかったら `null`**。⚠ 行番号は「描いた時の原文」のものなので、
   *   その後の書換でずれていることがある ── そこで近い行を探しに行くと、
   *   **user が押していない項目**が反転する(いちばん静かなデータ破壊)。
   */
  it('🔴 チェック項目でない行なら null(別の行を書き換えない)', () => {
    expect(applyBodyRewrite(DOC, { kind: 'task', line: 0 }), '見出しを書き換えた').toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'task', line: 5 }), '本文を書き換えた').toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'task', line: 99 }), '無い行で落ちた').toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'task', line: -1 })).toBeNull();
    // ⚠ ただの箇条書き(印が無い)も対象外
    expect(applyBodyRewrite('- ふつうの項目', { kind: 'task', line: 0 })).toBeNull();
  });

  it('isTaskLine が同じ判定を返す(規則は 1 つ)', () => {
    expect(isTaskLine(DOC, 2)).toBe(true);
    expect(isTaskLine(DOC, 0)).toBe(false);
  });
});

describe('frontmatter の鍵(#276)', () => {
  it('鍵を書く / 消す', () => {
    const body = '---\ndate: 2026-08-01\n---\n本文\n';
    expect(applyBodyRewrite(body, { kind: 'frontmatter', keys: { date: '2026-08-09' } })).toBe(
      '---\ndate: 2026-08-09\n---\n本文\n',
    );
    expect(applyBodyRewrite(body, { kind: 'frontmatter', keys: { date: undefined } })).toBe(
      '---\n---\n本文\n',
    );
  });

  /** ⚠ **変わらないなら `null`**(空の書込を投げない ── task 側と同じ意味論)。 */
  it('🔴 変わらないなら null(空の書込を投げない)', () => {
    const body = '---\ndate: 2026-08-01\n---\n本文\n';
    expect(applyBodyRewrite(body, { kind: 'frontmatter', keys: { date: '2026-08-01' } })).toBeNull();
    expect(applyBodyRewrite(body, { kind: 'frontmatter', keys: {} })).toBeNull();
  });
});
