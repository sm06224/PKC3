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
import { readLineDate } from '../../src/features/schedule/line-date';
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

/**
 * 🔴 **面から予定を動かす**(user 指示 2026-08-23
 * 「**なんで双方向にする発想がでねぇんだよ！**」)。
 *
 * ⚠ 1 稿目の設計は「予定は本文に書く。**面はそれを映すだけ**」だった ──
 *   **面から書けなくする理由がどこにも無かった**うえ、同じ面の**チェックの印は
 *   既に本文へ書いている**(`kind: 'task'`)。日付だけ読み取り専用にする理屈は無い。
 *
 * 🔑 ここが守るのは 3 つ:
 * ① **前後の字が 1 バイトも動かない**(記法の範囲だけ入れ替える)
 * ② **付ける / 外す / 差し替える**が全部通る(片道にしない)
 * ③ **当たらなければ `null`**(当てずっぽうで別の行を書き換えない)
 */
describe('行の日付を面から書き換える(双方向。2026-08-23)', () => {
  const move = (body: string, line: number, date: string | null, time?: string | null) =>
    applyBodyRewrite(body, { kind: 'line-date', line, date, time });

  it('🔴 日付を差し替える ── 前後の字は 1 バイトも動かない', () => {
    expect(move('- [ ]   見積を送る   @2026-08-25   ', 0, '2026-08-27')).toBe(
      '- [ ]   見積を送る   @2026-08-27   ',
    );
  });

  it('🔴 時刻ごと差し替える / 時刻だけ落とす', () => {
    expect(move('- [ ] 打合せ @2026-08-25', 0, '2026-08-25', '14:00')).toBe(
      '- [ ] 打合せ @2026-08-25 14:00',
    );
    expect(move('- [ ] 打合せ @2026-08-25 14:00', 0, '2026-08-26')).toBe(
      '- [ ] 打合せ @2026-08-26',
    );
  });

  it('🔴 日付の無い項目に、日付を付けられる', () => {
    expect(move('- [ ] 見積を送る', 0, '2026-08-25')).toBe('- [ ] 見積を送る @2026-08-25');
    // ⚠ 区切りの空白は 1 か所(`insertionForLineDate`)が決める ── 2 つ空かない
    expect(move('- [ ] 見積を送る ', 0, '2026-08-25')).toBe('- [ ] 見積を送る @2026-08-25');
  });

  /**
   * 🔴 **外せる**(「日付なし」へ落とす)。⚠ 片道にすると、間違えて置いた予定を
   *   本文まで開かないと戻せない ── それは動線を 1 つ失うのと同じである。
   */
  it.each([
    ['末尾', '- [ ] 見積を送る @2026-08-25', '- [ ] 見積を送る'],
    ['時刻つき', '- [ ] 打合せ @2026-08-25 14:00', '- [ ] 打合せ'],
    ['途中(空白が 2 つ空かない)', '- [ ] 見積 @2026-08-25 を送る', '- [ ] 見積 を送る'],
    ['先頭(印と中身がくっつかない)', '- [ ] @2026-08-25 見積', '- [ ] 見積'],
  ])('🔴 日付を外す: %s', (_name, before, after) => {
    expect(move(before, 0, null)).toBe(after);
  });

  it('⚠ 何も起きないときは null(呼び側が「変わらなかった」と言える)', () => {
    // 日付が無いのに外そうとした
    expect(move('- [ ] 見積を送る', 0, null)).toBeNull();
    // 同じ日付を置いた
    expect(move('- [ ] 見積を送る @2026-08-25', 0, '2026-08-25')).toBeNull();
    // 行番号がずれている(描いた後に本文が変わった)
    expect(move('- [ ] 見積を送る', 5, '2026-08-25')).toBeNull();
  });

  /**
   * 🔴 **チェック項目の行だけ**を書き換える。
   * ⚠ 盤面に出ているのはチェック項目だけなので、散文の行を触る道は無い ──
   *   触れると「見えていない行が黙って変わる」形になる。
   */
  it('🔴 散文の行には日付を挿さない', () => {
    expect(move('# 買い物\n\nふつうの段落', 2, '2026-08-25')).toBeNull();
  });

  /** ⚠ 引用の中のチェック項目も、数える側・押す側と同じく通す(§7)。 */
  it('引用の中のチェック項目も書き換えられる', () => {
    expect(move('> - [ ] 引用のやること', 0, '2026-08-25')).toBe(
      '> - [ ] 引用のやること @2026-08-25',
    );
  });

  /**
   * 🔴 **触った行以外は 1 バイトも変わらない。**
   * ⚠ これは上の each とは**別の観測**である ── あちらは「その行がこうなる」、
   *   こちらは「**他の行が変わっていない**」。片方だけ壊す誤りが在る。
   */
  it('🔴 触った行以外は 1 バイトも変わらない', () => {
    const body = ['# 買い物', '', '- [ ] 牛乳 @2026-08-25', '- [x] 卵 @2026-08-25', '', 'メモ'];
    const next = move(body.join('\n'), 2, '2026-08-27')!.split('\n');
    expect(next[2]).toBe('- [ ] 牛乳 @2026-08-27');
    expect(next.filter((_, i) => i !== 2)).toEqual(body.filter((_, i) => i !== 2));
  });

  /**
   * 🔴 **書き換えた結果を、読む側がそのまま読める。**
   * ⚠ 「別の綴り」ではなく**別の観測**で見る ── 書く側は splice、読む側は走査。
   */
  it('🔴 書き換えた行は、そのまま読み戻せる', () => {
    const next = move('- [ ] 見積を送る', 0, '2026-08-27', '09:30')!;
    expect(readLineDate(next)).toMatchObject({ date: '2026-08-27', time: '09:30' });
  });
});
