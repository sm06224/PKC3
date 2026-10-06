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
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';
import {
  applyBodyRewrite,
  applyTaskRun,
  isTaskLine,
  taskRunNotice,
} from '../../src/features/markdown/body-rewrite';
import { moveLinesWithInverse } from '../../src/features/markdown/line-move';

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
      '本文\n' /* #343: 最後の 1 つを外したら空の囲みごと畳む */,
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

/**
 * 🔴 **期間を本文へ書き戻す**(#344 段①)。
 *
 * ⚠ 書換は**記法の範囲だけ**を入れ替える ── 前後の字を 1 バイトも動かさない。
 *   期間は単日より長いので、範囲の取り違えは**行の意味を変える**形で出る。
 */
describe('期間の書き戻し(#344 段①)', () => {
  const rewriteRange = (
    body: string,
    over: { date: string | null; until?: string | null; time?: string | null },
  ): string | null => applyBodyRewrite(body, { kind: 'line-date', line: 0, ...over });

  it('単日 → 期間', () => {
    expect(rewriteRange('- [ ] 出張 @2026-08-25\n', { date: '2026-08-25', until: '2026-08-28' })).toBe(
      '- [ ] 出張 @2026-08-25..2026-08-28\n',
    );
  });

  it('期間 → ずらした期間(前後の字は動かない)', () => {
    expect(
      rewriteRange('- [ ] 前 @2026-08-25..2026-08-28 後\n', {
        date: '2026-08-28',
        until: '2026-08-31',
      }),
    ).toBe('- [ ] 前 @2026-08-28..2026-08-31 後\n');
  });

  it('期間 → 単日(`..` ごと消える)', () => {
    expect(rewriteRange('- [ ] 出張 @2026-08-25..2026-08-28\n', { date: '2026-08-26' })).toBe(
      '- [ ] 出張 @2026-08-26\n',
    );
  });

  it('🔴 期間を外すと、記法ごと剥がれる(`..2026-08-28` が残らない)', () => {
    expect(rewriteRange('- [ ] 出張 @2026-08-25..2026-08-28\n', { date: null })).toBe(
      '- [ ] 出張\n',
    );
  });

  /** ⚠ 対照群 ── 単日の書換はこれまでどおり(期間を足して壊していない)。 */
  it('⚠ 対照群 ── 単日と時刻の書換は今までどおり', () => {
    expect(rewriteRange('- [ ] 打合せ @2026-08-25 14:00\n', { date: '2026-08-27', time: '14:00' })).toBe(
      '- [ ] 打合せ @2026-08-27 14:00\n',
    );
  });

  /** 🔴 書いた形は、読み直すと同じものになる(往復)。 */
  it('書いた期間は読み直せる', () => {
    const next = rewriteRange('- [ ] 出張\n', { date: '2026-08-25', until: '2026-08-28' })!;
    expect(readLineDate(next)).toMatchObject({ date: '2026-08-25', until: '2026-08-28' });
  });
});

/**
 * 🔴 **繰り返しの「その回」を実体の行にする**(#344 段②)。
 *
 * ⚠ 規則の行の印を押してはいけない ── 押すと「この繰り返しは終わり」の意味になり、
 *   **以後の回が全部消える**。user が言いたかったのは「今日のぶんが済んだ」である。
 */
describe('繰り返しの回を済ませる(#344 段②)', () => {
  const done = (body: string, line: number, date: string): string | null =>
    applyBodyRewrite(body, { kind: 'repeat-done', line, date });

  it('🔴 規則の行はそのまま、その日ぶんの行が 1 本増える', () => {
    expect(done('- [ ] ゴミ出し @2026-08-31 毎週\n', 0, '2026-09-07')).toBe(
      '- [ ] ゴミ出し @2026-08-31 毎週\n- [x] ゴミ出し @2026-09-07\n',
    );
  });

  /**
   * 🔴 **規則の行の行番号が動かない** ── 動くと、画面に出ている他の札の行番号が
   * ずれ、次に押した 1 手が**別の行を書き換える**(いちばん静かな破壊)。
   */
  it('🔴 増えるのは規則の行の「すぐ下」(前の行は 1 つも動かない)', () => {
    const out = done('# 題\n\n- [ ] ゴミ出し @2026-08-31 毎週\n- [ ] 別件 @2026-09-01\n', 2, '2026-09-07');
    expect(out?.split('\n').slice(0, 3)).toEqual(['# 題', '', '- [ ] ゴミ出し @2026-08-31 毎週']);
    expect(out?.split('\n')[3]).toBe('- [x] ゴミ出し @2026-09-07');
  });

  it('🔴 刻みは落ちる(実体の行がまた繰り返したら、回が無限に増える)', () => {
    expect(readLineDate(done('- [ ] x @2026-08-31 毎週\n', 0, '2026-09-07')!.split('\n')[1]!)).toMatchObject({
      date: '2026-09-07',
      repeat: null,
    });
  });

  it('🔴 時刻は持ち越す(09:30 の回は 09:30 の予定である)', () => {
    expect(done('- [ ] 朝会 @2026-08-31 09:30 毎週\n', 0, '2026-09-07')?.split('\n')[1]).toBe(
      '- [x] 朝会 @2026-09-07 09:30',
    );
  });

  it('🔴 `..` の終わり(繰り返しの終わり)は実体の行に持ち込まない', () => {
    expect(done('- [ ] 朝会 @2026-08-31..2026-12-31 毎週\n', 0, '2026-09-07')?.split('\n')[1]).toBe(
      '- [x] 朝会 @2026-09-07',
    );
  });

  it('前置きと空白の入れ方はそのまま(印の位置を数え違えない)', () => {
    expect(done('>  -   [ ]   ゴミ出し   @2026-08-31 毎週\n', 0, '2026-09-07')?.split('\n')[1]).toBe(
      '>  -   [x]   ゴミ出し   @2026-09-07',
    );
  });

  it('⚠ 同じ行が既に在れば増やさない(二度押しの相打ち)', () => {
    const once = done('- [ ] ゴミ出し @2026-08-31 毎週\n', 0, '2026-09-07')!;
    expect(done(once, 0, '2026-09-07')).toBe(null);
  });

  it('⚠ 繰り返しでない行では何も起きない(普通の項目は `task` の仕事)', () => {
    expect(done('- [ ] ゴミ出し @2026-08-31\n', 0, '2026-09-07')).toBe(null);
    expect(done('- [ ] ゴミ出し\n', 0, '2026-09-07')).toBe(null);
  });

  it('⚠ チェック項目でない行・行番号がずれた回では何も起きない', () => {
    expect(done('ゴミ出し @2026-08-31 毎週\n', 0, '2026-09-07')).toBe(null);
    expect(done('- [ ] ゴミ出し @2026-08-31 毎週\n', 5, '2026-09-07')).toBe(null);
  });

  it('⚠ 読めない日は書かない(当てずっぽうの日付を本文へ残さない)', () => {
    expect(done('- [ ] ゴミ出し @2026-08-31 毎週\n', 0, 'あした')).toBe(null);
  });

  /**
   * 🔴 **置けるなら外せる**(片道の操作を作らない ── user 指示 2026-08-23)。
   * 増えた行は普通のチェック項目なので、もう一度押せば印が外れる。
   */
  it('🔴 増えた行は、押せば外れる(普通のチェック項目である)', () => {
    const once = done('- [ ] ゴミ出し @2026-08-31 毎週\n', 0, '2026-09-07')!;
    expect(applyBodyRewrite(once, { kind: 'task', line: 1 })).toBe(
      '- [ ] ゴミ出し @2026-08-31 毎週\n- [ ] ゴミ出し @2026-09-07\n',
    );
  });
});

/**
 * 🔴 **繰り返しの「その回だけ」を別の日へ動かす**(#855 決4。
 * user 裁定 2026-09-13「1 回か全部か選択する(Outlook 模倣で OK)」)。
 *
 * 🔑 すぐ上の「済ませる」と**兄弟**である ── どちらも規則の行は触らず、
 *   その回ぶんの行を 1 本増やす。違うのは**書く日**と**振替が付くこと**、
 *   そして**印を押さないこと**(済ませたのではなく、動かしただけ)。
 */
describe('繰り返しの回を、この回だけ動かす(#855 決4)', () => {
  const move = (body: string, line: number, from: string, to: string): string | null =>
    applyBodyRewrite(body, { kind: 'repeat-move', line, from, to });

  it('🔴 規則の行はそのまま、落とした日に「振替」つきの行が 1 本増える', () => {
    expect(move('- [ ] 定例会 @2026-09-13 毎週\n', 0, '2026-09-20', '2026-09-22')).toBe(
      '- [ ] 定例会 @2026-09-13 毎週\n- [ ] 定例会 @2026-09-22 振替2026-09-20\n',
    );
  });

  /**
   * 🔴 **印は押さない** ── 「済ませる」との違いはここである。
   * ⚠ 押すと、動かした先の予定が**最初から済んだ顔**で出る。
   */
  it('🔴 印は押さない(動かしただけで、済ませていない)', () => {
    const out = move('- [ ] 定例会 @2026-09-13 毎週\n', 0, '2026-09-20', '2026-09-22')!;
    expect(out.split('\n')[1], '動かしただけなのに印が付いている').toBe(
      '- [ ] 定例会 @2026-09-22 振替2026-09-20',
    );
  });

  it('🔴 刻みは落ちる(増えた行がまた繰り返したら、回が無限に増える)', () => {
    expect(
      readLineDate(move('- [ ] x @2026-09-13 毎週\n', 0, '2026-09-20', '2026-09-22')!.split('\n')[1]!),
    ).toMatchObject({ date: '2026-09-22', repeat: null, substitutes: '2026-09-20' });
  });

  it('🔴 時刻は持ち越す(14:00 の回は 14:00 の予定である)', () => {
    expect(
      move('- [ ] 朝会 @2026-09-13 09:30 毎週\n', 0, '2026-09-20', '2026-09-22')?.split('\n')[1],
    ).toBe('- [ ] 朝会 @2026-09-22 09:30 振替2026-09-20');
  });

  it('前置きと空白の入れ方はそのまま', () => {
    expect(
      move('>  -   [ ]   定例会   @2026-09-13 毎週\n', 0, '2026-09-20', '2026-09-22')?.split('\n')[1],
    ).toBe('>  -   [ ]   定例会   @2026-09-22 振替2026-09-20');
  });

  it('⚠ 同じ日へ落としたら何もしない(更新日時だけ動かさない)', () => {
    expect(move('- [ ] x @2026-09-13 毎週\n', 0, '2026-09-20', '2026-09-20')).toBe(null);
  });

  it('⚠ 同じ行が既に在れば増やさない(二度落としの相打ち)', () => {
    const once = move('- [ ] x @2026-09-13 毎週\n', 0, '2026-09-20', '2026-09-22')!;
    expect(move(once, 0, '2026-09-20', '2026-09-22')).toBe(null);
  });

  /**
   * ⚠ **繰り返しでない行には効かない** ── 普通の予定を動かすのは
   *   `kind: 'line-date'` の仕事である(同じことをする口を 2 つ作らない)。
   */
  it('⚠ 繰り返しでない行には効かない(別の口の仕事)', () => {
    expect(move('- [ ] x @2026-09-20\n', 0, '2026-09-20', '2026-09-22')).toBe(null);
  });

  it('⚠ 読めない日は書かない(当てずっぽうの日付を本文へ残さない)', () => {
    expect(move('- [ ] x @2026-09-13 毎週\n', 0, '2026-09-20', 'あした')).toBe(null);
  });
});

/**
 * 🔴 **日付を動かしても刻みは消えない**(#344 段②)。
 * ⚠ 消えると user は「勝手に消された」と読む(時刻を持ち越すのと同じ向き)。
 */
describe('日付の書換と刻み(#344 段②)', () => {
  it('🔴 渡さなければ元の刻みを保つ', () => {
    expect(
      applyBodyRewrite('- [ ] ゴミ出し @2026-08-31 毎週\n', {
        kind: 'line-date',
        line: 0,
        date: '2026-09-01',
      }),
    ).toBe('- [ ] ゴミ出し @2026-09-01 毎週\n');
  });

  it('はっきり `null` を渡したときだけ外れる', () => {
    expect(
      applyBodyRewrite('- [ ] ゴミ出し @2026-08-31 毎週\n', {
        kind: 'line-date',
        line: 0,
        date: '2026-09-01',
        repeat: null,
      }),
    ).toBe('- [ ] ゴミ出し @2026-09-01\n');
  });

  it('日付を外すと記法ごと剥がれる(刻みも一緒に消える)', () => {
    expect(
      applyBodyRewrite('- [ ] ゴミ出し @2026-08-31 毎週\n', {
        kind: 'line-date',
        line: 0,
        date: null,
      }),
    ).toBe('- [ ] ゴミ出し\n');
  });
});

describe('取り込んだ外部画像を当てる(#264 段①)', () => {
  const IMG = 'https://e.com/a.png';

  it('画像の宛先だけを差し替える', () => {
    expect(
      applyBodyRewrite(`# 題\n\n![ず](${IMG})\n`, {
        kind: 'adopt-images',
        adopted: { [IMG]: 'asset:k1' },
      }),
    ).toBe('# 題\n\n![ず](asset:k1)\n');
  });

  it('🔴 同じ URL の**リンク**は触らない(押していないのに導線が化けない)', () => {
    expect(
      applyBodyRewrite(`![ず](${IMG})\n[記事](${IMG})\n`, {
        kind: 'adopt-images',
        adopted: { [IMG]: 'asset:k1' },
      }),
    ).toBe(`![ず](asset:k1)\n[記事](${IMG})\n`);
  });

  /**
   * 🔴 **番号ではなく宛先で当てる**(取りに行っている間に別の窓が行を足しうる)。
   * ⚠ 行番号で当てる `kind: 'task'` と**作法が違う**理由がここに在る。
   */
  it('🔴 取りに行っている間に行が増えていても、宛先で当たる', () => {
    expect(
      applyBodyRewrite(`# 題\n\n別の窓が足した行\n\n![ず](${IMG})\n`, {
        kind: 'adopt-images',
        adopted: { [IMG]: 'asset:k1' },
      }),
    ).toBe('# 題\n\n別の窓が足した行\n\n![ず](asset:k1)\n');
  });

  it('🔴 その宛先がもう本文に無ければ `null` ── 当てずっぽうで別の所を書かない', () => {
    expect(
      applyBodyRewrite('# 題\n\n(別の窓が画像ごと消した)\n', {
        kind: 'adopt-images',
        adopted: { [IMG]: 'asset:k1' },
      }),
    ).toBeNull();
  });

  it('コードフェンスの中は書き換えない(あれは**書いてある字**である)', () => {
    expect(
      applyBodyRewrite('```\n![ず](https://e.com/a.png)\n```\n', {
        kind: 'adopt-images',
        adopted: { [IMG]: 'asset:k1' },
      }),
    ).toBeNull();
  });
});

/**
 * 🔴 **本文の塊を動かす / 差し込む**(#684 段① / 段②。規則は `line-move.ts`)。
 *
 * ## 守る主張
 *
 * 1. 🔴 **掴む種類 6 × 落とし先 6 = 36 通りを表で全数**当てる ── 結果は
 *    「動く / body そのまま(取りやめ)/ null(断る)」の 3 値
 * 2. 🔴 動いた回は**触らない行が 1 byte も変わらない**(空行の出し入れ以外)
 * 3. 🔴 **空行が 2 本並ばない**(元の所も入れた所も)
 * 4. 🔴 逆向きの指示(`inverse`)で**元の本文へ byte 一致で戻る**(「元に戻す」の材料)
 * 5. 🔴 掴んだ時点の行と byte 一致しなければ書かない(別の窓の書込で行がずれた形)
 * 6. 差し込み(`insert-lines`)は前後に空行を補い、fence / `:::` の中・frontmatter には入れない
 */
describe('本文の塊を動かす(#684 段① move-lines)', () => {
  const RAW = [
    '---', //          0
    'title: x', //     1
    '---', //          2
    '# 題', //          3
    '', //             4
    '段落 A', //        5
    '', //             6
    '## 章 B', //       7
    '', //             8
    '本文 B', //        9
    '', //             10
    '```js', //        11
    'code', //         12
    '```', //          13
    '', //             14
    ':::note', //      15
    '中身', //          16
    ':::', //          17
    '', //             18
    '- い', //          19
    '- ろ', //          20
    '', //             21  ← 箇条書きの刻印(-end)は直後の空行まで含む
    '| a | b |', //    22
    '|---|---|', //    23
    '| 1 | 2 |', //    24
    '', //             25
    '## 章 C', //       26
    '', //             27
    '本文 C', //        28
    '', //             29  ← 終端の改行
  ].join('\n');
  const L = RAW.split('\n');
  const range = (start: number, end: number) => ({ start, end, lines: L.slice(start, end + 1) });

  /** 掴む種類 6(範囲は掴む口 `block-grip.ts` が原文で決める形と同じ)。 */
  const GRABS = {
    段落: range(5, 5),
    '見出しの章(章 B ── 次の同段の見出しの直前まで)': range(7, 25),
    fence: range(11, 13),
    '::: の囲み': range(15, 17),
    '箇条書き(刻印が直後の空行を含む)': range(19, 21),
    表: range(22, 24),
  } as const;
  /** 落とし先 6。 */
  const TARGETS = {
    '本文の先頭(段落 A の前)': 5,
    '本文の末尾(終端の改行の前)': 29,
    自分の中: -1, // 掴んだ範囲から決める(下)
    'fence の中': 12,
    '::: の中': 16,
    'frontmatter の中': 1,
  } as const;
  type Outcome = '動く' | 'そのまま' | 'null';
  const selfOf = (g: { start: number; end: number }) => (g.end > g.start ? g.start + 1 : g.start);
  /** 期待値。⚠ 「fence の中」「::: の中」は、掴んだのがその塊自身なら自分の中 = そのまま。 */
  const expected = (g: { start: number; end: number }, to: number): Outcome => {
    if (to < 3) return 'null';
    if (to >= g.start && to <= g.end + 1) return 'そのまま';
    if (to === 12 || to === 16) return 'null';
    return '動く';
  };
  const nonBlank = (s: string) => s.split('\n').filter((l) => l !== '');
  /** 塊の実体(範囲の末尾の空行は数えない ── `line-move.ts` と同じ規則)。 */
  const chunkOf = (lines: readonly string[]): string[] => {
    let e = lines.length - 1;
    while (e > 0 && lines[e] === '') e -= 1;
    return lines.slice(0, e + 1);
  };

  /** 空振り防止 ── 表が 3 値を全部含んでいる(どれかが 0 件なら期待値の式が壊れている)。 */
  it('⚠ 表は 36 通りで、3 値がどれも 1 件以上ある', () => {
    const outcomes = Object.values(GRABS).flatMap((g) =>
      Object.values(TARGETS).map((t) => expected(g, t === -1 ? selfOf(g) : t)),
    );
    expect(outcomes).toHaveLength(36);
    expect(outcomes.filter((o) => o === '動く').length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === 'そのまま').length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === 'null').length).toBeGreaterThan(0);
  });

  for (const [gName, g] of Object.entries(GRABS)) {
    for (const [tName, tRaw] of Object.entries(TARGETS)) {
      const to = tRaw === -1 ? selfOf(g) : tRaw;
      const want = expected(g, to);
      it(`${gName} → ${tName}: ${want}`, () => {
        const move = { kind: 'move-lines' as const, ...g, toBefore: to };
        const out = applyBodyRewrite(RAW, move);
        if (want === 'null') {
          expect(out).toBeNull();
          return;
        }
        if (want === 'そのまま') {
          expect(out, '取りやめは body をそのまま返す(null = 競合の顔にしない)').toBe(RAW);
          return;
        }
        expect(out, '動くはずの組で断られた').not.toBeNull();
        expect(out, '動くはずの組で 1 byte も動いていない').not.toBe(RAW);
        const chunk = chunkOf(g.lines);
        const got = out!.split('\n');
        // 2. 触らない行は 1 byte も変わらない ── 空行を除いた並びは「塊を抜いて入れ直した」形に一致
        const rest = nonBlank(RAW).filter((l) => !chunk.includes(l));
        expect(nonBlank(out!).filter((l) => !chunk.includes(l)), '塊以外の行が変わった').toEqual(rest);
        // 塊はまとまって入っている(順序も保つ)
        const at = got.indexOf(chunk[0]!);
        expect(got.slice(at, at + chunk.length), '塊がまとまって入っていない').toEqual(chunk);
        // 3. 空行が 2 本並ばない(元に 1 つも無いので、出来たら規則の穴)
        expect(out!.includes('\n\n\n'), '空行が 2 本並んだ').toBe(false);
        // 終端の改行は失わない
        expect(out!.endsWith('\n'), '本文の末尾の改行が消えた').toBe(true);
        // 落とし先: 先頭なら本文の最初の非空行が塊の先頭、末尾なら最後の非空行が塊の末尾
        // (frontmatter 3 行 + `# 題` の次 = 非空行の 5 つ目)
        if (to === 5) expect(nonBlank(out!)[4], '先頭へ入っていない').toBe(chunk[0]);
        if (to === 29) expect(nonBlank(out!).at(-1), '末尾へ入っていない').toBe(chunk.at(-1));
        // 4. 逆向きの指示で元へ戻る(byte 一致)
        const moved = moveLinesWithInverse(RAW, move)!;
        expect(moved.body).toBe(out);
        expect(moved.inverse, '逆向きの指示が無い').not.toBeNull();
        expect(applyBodyRewrite(out!, { kind: 'move-lines', ...moved.inverse! }), '元に戻らない').toBe(RAW);
      });
    }
  }

  it('🔴 掴んだ時点の行と byte 一致しなければ書かない(別の窓の書き込みで行がずれた形)', () => {
    const shifted = RAW.replace('段落 A', '段落 A(別の窓が直した)');
    expect(applyBodyRewrite(shifted, { kind: 'move-lines', ...range(5, 5), toBefore: 29 })).toBeNull();
    // 対照群 ── 一致していれば動く
    expect(applyBodyRewrite(RAW, { kind: 'move-lines', ...range(5, 5), toBefore: 29 })).not.toBeNull();
    // 行数が合わない(範囲だけ広げた)荷物も断る
    expect(
      applyBodyRewrite(RAW, { kind: 'move-lines', start: 5, end: 6, toBefore: 29, lines: ['段落 A'] }),
    ).toBeNull();
  });

  it('🔴 掴んだ塊が(別の窓の書き込みで)囲いの中へ移っていたら書かない', () => {
    // 段落 A の上に閉じない fence が現れた ── 5 行目は同じ字だがコードの字である
    const swallowed = RAW.replace('# 題\n', '```\n');
    expect(applyBodyRewrite(swallowed, { kind: 'move-lines', ...range(5, 5), toBefore: 29 })).toBeNull();
  });

  it('範囲外・整数でない座標は null', () => {
    expect(
      applyBodyRewrite(RAW, { kind: 'move-lines', start: 5, end: 5, toBefore: 31, lines: ['段落 A'] }),
    ).toBeNull();
    expect(
      applyBodyRewrite(RAW, { kind: 'move-lines', start: 5, end: 5, toBefore: 7.5, lines: ['段落 A'] }),
    ).toBeNull();
    expect(
      applyBodyRewrite(RAW, { kind: 'move-lines', start: 40, end: 40, toBefore: 5, lines: [''] }),
    ).toBeNull();
  });

  /**
   * 🔴 **最後の塊を動かして戻しても、本文の末尾の改行が保たれる。**
   * ⚠ 上の表は最後の塊(章 C)を掴む組を持たないので、「終端の改行を隣の空行に数えない」
   *   規則をどの組も通らない ── 変異試験 M9 が SURVIVED で教えた(§2)。
   *   終端の空要素を消すと、戻したときに末尾の改行が 1 byte 消える。
   */
  it('🔴 最後の塊(章 C)を先頭へ動かして戻すと byte 一致で戻る(終端の改行を消さない)', () => {
    const move = { kind: 'move-lines' as const, ...range(26, 29), toBefore: 5 };
    const moved = moveLinesWithInverse(RAW, move)!;
    expect(moved.body.endsWith('\n'), '動かした本文の末尾の改行が消えた').toBe(true);
    expect(applyBodyRewrite(moved.body, { kind: 'move-lines', ...moved.inverse! }), '元に戻らない').toBe(RAW);
    const tiny = moveLinesWithInverse('A\n\nB\n', { start: 2, end: 2, toBefore: 0, lines: ['B'] })!;
    expect(tiny.body).toBe('B\n\nA\n');
    expect(applyBodyRewrite(tiny.body, { kind: 'move-lines', ...tiny.inverse! })).toBe('A\n\nB\n');
  });

  it('隣の空行が無い所から抜いても、入れた所には空行を補う(詰まらない)', () => {
    const tight = 'A\nB\nC\n';
    // B を末尾へ ── 抜いた所は A と C が隣り合う(元から詰まっている所は詰めたまま)
    expect(
      applyBodyRewrite(tight, { kind: 'move-lines', start: 1, end: 1, toBefore: 3, lines: ['B'] }),
    ).toBe('A\nC\n\nB\n');
  });
});

/**
 * 🔴 **切り取り**(#684 段③ `cut-lines`)── ここは**合流**の口である。
 *
 * ⚠ 段③ を始めるのは効果層の 1 か所だけ(必ず「入れてから切る」)だが、
 *   保存に失敗した状態から**基底へ書換を当て直す**経路がここを通る。
 *   🔴 捨てると基底に切り取りが反映されず、**再保存で塊が元へ戻って二重になる**
 *   (着地前レビュー 💭-2 / 変異 R5)。
 */
describe('本文の塊を切り取る(#684 段③ cut-lines)', () => {
  const DOC = ['# 題', '', '段落 A', '', '段落 B', ''].join('\n');

  it('掴んだ時点の行と合えば切る(隣の空行 1 本ごと ── 段① と同じ規則)', () => {
    expect(applyBodyRewrite(DOC, { kind: 'cut-lines', start: 2, end: 2, lines: ['段落 A'] })).toBe(
      ['# 題', '', '段落 B', ''].join('\n'),
    );
  });

  it('🔴 合わなければ切らない(当てずっぽうで別の所を消さない)', () => {
    expect(
      applyBodyRewrite(DOC, { kind: 'cut-lines', start: 2, end: 2, lines: ['別の字'] }),
      '掴んだ時点の行と違うのに切った',
    ).toBeNull();
    expect(
      applyBodyRewrite(DOC, { kind: 'cut-lines', start: 99, end: 99, lines: ['段落 A'] }),
      '範囲の外なのに切った',
    ).toBeNull();
  });
});

describe('本文へ行を差し込む(#684 段② insert-lines)', () => {
  const DOC = ['# 題', '', '段落', '', '```', 'code', '```', '', ':::note', '中', ':::', ''].join('\n');
  const LINK = ['[相手](entry:n2)'];

  it('先頭・塊の間・末尾に入り、前後に空行を補う', () => {
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 0, lines: LINK })).toBe(
      `[相手](entry:n2)\n\n${DOC}`,
    );
    // 段落の後(空行 3 の前)── 前は「段落」なので空行を補い、後は元の空行を使う
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 3, lines: LINK })).toBe(
      ['# 題', '', '段落', '', '[相手](entry:n2)', '', '```', 'code', '```', '', ':::note', '中', ':::', ''].join(
        '\n',
      ),
    );
    // 末尾(終端の改行の前)
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 11, lines: LINK })).toBe(
      `${DOC.slice(0, -1)}\n\n[相手](entry:n2)\n`,
    );
  });

  it('複数行は 1 塊で入る(改行区切りのまま)', () => {
    const two = ['[あ](entry:a)', '[い](entry:b)'];
    expect(applyBodyRewrite('段落\n', { kind: 'insert-lines', toBefore: 0, lines: two })).toBe(
      '[あ](entry:a)\n[い](entry:b)\n\n段落\n',
    );
  });

  it('🔴 fence の中・::: の中・frontmatter・範囲外には入れない(null)', () => {
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 5, lines: LINK }), 'fence の中').toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 6, lines: LINK }), 'fence の閉じの前').toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 9, lines: LINK }), '::: の中').toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 10, lines: LINK }), '::: の閉じの前').toBeNull();
    // 対照群 ── 閉じの次の行(11)は外なので入る / 開きの前(8)も外
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 11, lines: LINK })).not.toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 8, lines: LINK })).not.toBeNull();
    expect(
      applyBodyRewrite(`---\na: 1\n---\n${DOC}`, { kind: 'insert-lines', toBefore: 1, lines: LINK }),
    ).toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 13, lines: LINK }), '行数を超える').toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 0, lines: [] }), '空の並び').toBeNull();
  });

  it('閉じていない fence の後ろは全部「中」', () => {
    expect(applyBodyRewrite('```\ncode\n', { kind: 'insert-lines', toBefore: 2, lines: LINK })).toBeNull();
  });
});

/**
 * 🔴 **保存したスタックの中の 1 行を、隣のリンク行と入れ替える**(#633 段④)。
 *
 * 守る主張:①入れ替えた 2 行以外は 1 byte も動かない ②端では何もしない(同じ本文を返す ──
 * `null` は「断った」の意味なので使わない)③押した時点の行と食い違えば断る(`null`)
 * ④相手がリンク行でなければ動かさない ⑤fence の中の同じ字面は触らない。
 */
describe('保存したスタックの並べ替え(link-move、#633 段④)', () => {
  const DOC = [
    '---',
    'date: 2026-09-05',
    '---',
    '# 今週の束',
    '',
    '- [議事録](entry:a1)',
    '- [資料 B](entry:b2)',
    '- [去年の稟議](entry:c3)',
    '',
    '```',
    '- [偽物](entry:zz)',
    '```',
  ].join('\n');

  it('🔴 下へ: 隣と入れ替わり、ほかの行は 1 byte も動かない', () => {
    const out = applyBodyRewrite(DOC, { kind: 'link-move', line: 5, openLine: '- [議事録](entry:a1)', dir: 'down' })!;
    const before = DOC.split('\n');
    const after = out.split('\n');
    expect(after[5]).toBe('- [資料 B](entry:b2)');
    expect(after[6]).toBe('- [議事録](entry:a1)');
    expect(after.filter((_, i) => i !== 5 && i !== 6)).toEqual(before.filter((_, i) => i !== 5 && i !== 6));
  });

  it('🔴 上へ: 3 行目が 2 行目と入れ替わる', () => {
    const out = applyBodyRewrite(DOC, { kind: 'link-move', line: 7, openLine: '- [去年の稟議](entry:c3)', dir: 'up' })!;
    expect(out.split('\n').slice(5, 8)).toEqual(['- [議事録](entry:a1)', '- [去年の稟議](entry:c3)', '- [資料 B](entry:b2)']);
  });

  it('🔴 端では何もしない ── 同じ本文をそのまま返す(null にしない)', () => {
    // 一番上を上へ: 相手は空行(リンク行でない)
    expect(applyBodyRewrite(DOC, { kind: 'link-move', line: 5, openLine: '- [議事録](entry:a1)', dir: 'up' })).toBe(DOC);
    // 一番下を下へ: 相手は空行
    expect(applyBodyRewrite(DOC, { kind: 'link-move', line: 7, openLine: '- [去年の稟議](entry:c3)', dir: 'down' })).toBe(DOC);
    // 本文の末尾の行を下へ(相手が無い)
    const tail = '- [a](entry:a)\n- [b](entry:b)';
    expect(applyBodyRewrite(tail, { kind: 'link-move', line: 1, openLine: '- [b](entry:b)', dir: 'down' })).toBe(tail);
  });

  it('🔴 押した時点の行と食い違えば断る(別の窓が行を足していた形)', () => {
    expect(applyBodyRewrite(DOC, { kind: 'link-move', line: 6, openLine: '- [議事録](entry:a1)', dir: 'down' })).toBeNull();
    // frontmatter の中 / 範囲外も断る
    expect(applyBodyRewrite(DOC, { kind: 'link-move', line: 1, openLine: 'date: 2026-09-05', dir: 'down' })).toBeNull();
    expect(applyBodyRewrite(DOC, { kind: 'link-move', line: 99, openLine: 'x', dir: 'up' })).toBeNull();
  });

  it('🔴 fence の中の同じ字面は動かさない(対照群: 外の同じ行は動く)', () => {
    // fence の中の行を掴んだ形 ── 断る
    expect(applyBodyRewrite(DOC, { kind: 'link-move', line: 10, openLine: '- [偽物](entry:zz)', dir: 'up' })).toBeNull();
    // リンク行でない行を掴んだ形 ── 断る
    expect(applyBodyRewrite(DOC, { kind: 'link-move', line: 3, openLine: '# 今週の束', dir: 'down' })).toBeNull();
  });

  it('番号つきの箇条書きでも効く(記法を狭めない)', () => {
    const src = '1. [a](entry:a)\n2. [b](entry:b)';
    expect(applyBodyRewrite(src, { kind: 'link-move', line: 0, openLine: '1. [a](entry:a)', dir: 'down' })).toBe(
      '2. [b](entry:b)\n1. [a](entry:a)',
    );
  });
});

/**
 * 🔴 **刻みだけ付け替える**(#855 段 0 の 3 つ目。user 裁定 2026-09-13
 * 「札を右クリック →『繰り返す』」)。
 *
 * ⚠ 日付は**渡さない** ── 渡すと「日付も書き換える」意味になる。とくに
 *   繰り返しの回の札は**その回の日**を焼いているので、渡すと開始日がずれる。
 *
 * 🔴 守る主張:
 * 1. 日付・時刻・期間は**書かれているものがそのまま残る**
 * 2. `repeat: null` で**やめられる**(日付は残る)
 * 3. 日付の無い行では**何もしない**(繰り返しは開始日から曜日を取る)
 * 4. 前後の字は 1 バイトも動かない
 */
describe('刻みだけ付け替える(#855 段 0 の 3 つ目)', () => {
  const setRepeat = (body: string, repeat: 'day' | 'week' | 'month' | 'year' | null) =>
    applyBodyRewrite(body, { kind: 'line-date', line: 0, repeat });

  it('🔴 日付だけの行に、刻みを付けられる(日付はそのまま)', () => {
    expect(setRepeat('- [ ] ゴミ出し @2026-08-31', 'week')).toBe(
      '- [ ] ゴミ出し @2026-08-31 毎週',
    );
  });

  it('🔴 時刻を持つ行でも、時刻が消えない', () => {
    expect(setRepeat('- [ ] 朝会 @2026-08-31 09:30', 'day')).toBe(
      '- [ ] 朝会 @2026-08-31 09:30 毎日',
    );
  });

  it('🔴 期間を持つ行でも、終わりが消えない', () => {
    expect(setRepeat('- [ ] 講座 @2026-08-31..2026-12-31', 'week')).toBe(
      '- [ ] 講座 @2026-08-31..2026-12-31 毎週',
    );
  });

  it('🔴 刻みを付け替えられる(毎週 → 毎月)', () => {
    expect(setRepeat('- [ ] 家賃 @2026-08-31 毎週', 'month')).toBe(
      '- [ ] 家賃 @2026-08-31 毎月',
    );
  });

  it('🔴 やめられる ── 日付は残る', () => {
    expect(setRepeat('- [ ] ゴミ出し @2026-08-31 毎週', null)).toBe('- [ ] ゴミ出し @2026-08-31');
    // ⚠ 時刻も残る(刻みだけ外す)
    expect(setRepeat('- [ ] 朝会 @2026-08-31 09:30 毎日', null)).toBe(
      '- [ ] 朝会 @2026-08-31 09:30',
    );
  });

  it('⚠ 同じ刻みをもう一度指しても、何も書かない(no-op は null)', () => {
    expect(setRepeat('- [ ] ゴミ出し @2026-08-31 毎週', 'week')).toBeNull();
  });

  /**
   * 🔴 **`repeat` も省けば、何も変えない**(2026-09-13、変異試験 M3 が SURVIVED で教えた)。
   *
   * ⚠ `SET_TASK_REPEAT` は必ず `repeat` を渡すので、**この枝は製品からは 1 度も
   *   通らない** ── だから「渡さなければ元の刻みを保つ」という約束が、
   *   `rewrite.repeat` へ固定する変異で**壊れても誰も鳴らなかった**
   *   (CLAUDE.md §2「経路が一度も通っていない」)。
   * 🔑 約束を書いた以上、その約束が生きていることを直に見る。
   */
  it('⚠ repeat も省いたら、書かれている刻みが残る(= 何も書かない)', () => {
    expect(
      applyBodyRewrite('- [ ] ゴミ出し @2026-08-31 毎週', { kind: 'line-date', line: 0 }),
    ).toBeNull();
    // ⚠ 対照群 ── 刻みを渡せば当然変わる(上が「no-op だから null」であることの裏取り)
    expect(
      applyBodyRewrite('- [ ] ゴミ出し @2026-08-31 毎週', {
        kind: 'line-date',
        line: 0,
        repeat: 'month',
      }),
    ).toBe('- [ ] ゴミ出し @2026-08-31 毎月');
  });

  it('🔴 日付の無い行では何もしない(書いても読まれない形を作らない)', () => {
    expect(setRepeat('- [ ] 日付の無い項目', 'week')).toBeNull();
  });

  it('⚠ チェックリストでない行では何もしない', () => {
    expect(setRepeat('ただの段落 @2026-08-31', 'week')).toBeNull();
  });

  it('🔴 前後の字は 1 バイトも動かない', () => {
    expect(setRepeat('- [ ]   ゴミ出し   @2026-08-31   ', 'week')).toBe(
      '- [ ]   ゴミ出し   @2026-08-31 毎週   ',
    );
  });

  /**
   * ⚠ **日付を渡す既存の経路は 1 バイトも変えていない**(対照群)──
   * 省いたときだけ「保つ」のであって、渡したときの意味は前のままである。
   */
  it('⚠ 対照群 ── 日付を渡した回は、これまでどおり時刻が落ちる', () => {
    expect(applyBodyRewrite('- [ ] 朝会 @2026-08-31 09:30', { kind: 'line-date', line: 0, date: '2026-09-01' })).toBe(
      '- [ ] 朝会 @2026-09-01',
    );
  });
});

describe('改行コードの保持と isTaskLine の高速走査(#1097)', () => {
  it('🔴 isTaskLine が CRLF でも LF でも正しく行を判定する', () => {
    const docLf = '# 題\n- [ ] タスク 1\n本文\n- [x] タスク 2';
    expect(isTaskLine(docLf, 0)).toBe(false);
    expect(isTaskLine(docLf, 1)).toBe(true);
    expect(isTaskLine(docLf, 2)).toBe(false);
    expect(isTaskLine(docLf, 3)).toBe(true);
    expect(isTaskLine(docLf, 99)).toBe(false);
    expect(isTaskLine(docLf, -1)).toBe(false);

    const docCrlf = '# 題\r\n- [ ] タスク 1\r\n本文\r\n- [x] タスク 2';
    expect(isTaskLine(docCrlf, 0)).toBe(false);
    expect(isTaskLine(docCrlf, 1)).toBe(true);
    expect(isTaskLine(docCrlf, 2)).toBe(false);
    expect(isTaskLine(docCrlf, 3)).toBe(true);
  });

  it('🔴 CRLF 改行のノートでタスク切り替え時に CRLF が保持される', () => {
    const crlf = '- [ ] タスク A\r\n- [ ] タスク B\r\n';
    const rewritten = applyBodyRewrite(crlf, { kind: 'task', line: 0 });
    expect(rewritten).toBe('- [x] タスク A\r\n- [ ] タスク B\r\n');
  });

  it('🔴 CRLF 改行のノートで日付更新時に CRLF が保持される', () => {
    const crlf = '- [ ] タスク @2026-09-01\r\n- [ ] 別のタスク\r\n';
    const rewritten = applyBodyRewrite(crlf, { kind: 'line-date', line: 0, date: '2026-09-02' });
    expect(rewritten).toBe('- [ ] タスク @2026-09-02\r\n- [ ] 別のタスク\r\n');
  });

  it('🔴 CRLF 改行のノートで CSV セル更新時に CRLF が保持される', () => {
    const crlf = '```csv\r\na,b\r\n1,2\r\n```\r\n';
    const rewritten = applyBodyRewrite(crlf, { kind: 'csv-cell', line: 2, col: 1, value: '99' });
    expect(rewritten).toBe('```csv\r\na,b\r\n1,99\r\n```\r\n');
  });

  it('🔴 CRLF 改行のノートでリンク行入れ替え時に CRLF が保持される', () => {
    const crlf = '- [ノート1](entry:lid-1)\r\n- [ノート2](entry:lid-2)\r\n';
    const rewritten = applyBodyRewrite(crlf, {
      kind: 'link-move',
      line: 0,
      openLine: '- [ノート1](entry:lid-1)',
      dir: 'down',
    });
    expect(rewritten).toBe('- [ノート2](entry:lid-2)\r\n- [ノート1](entry:lid-1)\r\n');
  });
});


/**
 * 🔴 **チェックリストを丸ごとそろえる**(#1173)。
 *
 * 守る主張:
 * 1. 指した行だけが動く(印の 1 文字だけ。ほかの行・空白は byte 無傷)
 * 2. 🔴 **繰り返しの規則の行は触らない**(数だけ返す)
 * 3. 項目でなくなった行 / fence の中 / 範囲外は**数えて飛ばす**(当てずっぽうで書かない)
 * 4. 何も動かなければ**同じ本文**(書き直して更新日時だけ動かさない)
 */
describe('チェックリストをそろえる(#1173)', () => {
  const LIST = [
    '# 持ち物', // 0
    '', // 1
    '- [ ] 歯ブラシ', // 2
    '- [x] 充電器', // 3
    '  - [ ] ケーブル', // 4 (入れ子)
    '  - [x] 変換プラグ', // 5 (入れ子)
    '- [ ] ゴミ出し @2026-09-07 毎週', // 6 (繰り返し)
    '', // 7
    '本文', // 8
  ].join('\n');

  it('🔴 すべて完了にする ── 未完了だった行だけが動き、繰り返しの行は触らない', () => {
    const r = applyTaskRun(LIST, [2, 3, 4, 5, 6], 'done');
    const out = r.body.split('\n');
    expect(out[2]).toBe('- [x] 歯ブラシ');
    expect(out[4]).toBe('  - [x] ケーブル');
    // ⚠ 繰り返しの規則の行は 1 文字も動かない
    expect(out[6]).toBe('- [ ] ゴミ出し @2026-09-07 毎週');
    // ほかの行(見出し・本文・元から済んでいる行)は byte 無傷
    expect(out.filter((_, i) => ![2, 4].includes(i))).toEqual(
      LIST.split('\n').filter((_, i) => ![2, 4].includes(i)),
    );
    expect(r.changed).toBe(2);
    expect(r.skipped).toEqual({ repeat: 1, invalid: 0 });
  });

  it('🔴 すべて未完了に戻す ── 混在していても全部外れる(入れ子の分も)', () => {
    const r = applyTaskRun(LIST, [2, 3, 4, 5], 'open');
    const out = r.body.split('\n');
    expect(out.slice(2, 6)).toEqual([
      '- [ ] 歯ブラシ',
      '- [ ] 充電器',
      '  - [ ] ケーブル',
      '  - [ ] 変換プラグ',
    ]);
    expect(r.changed).toBe(2);
  });

  it('🔴 繰り返しの行は「済み」でも触らない(未完了へ戻す側でも)', () => {
    const body = '- [x] ゴミ出し @2026-09-07 毎週\n- [x] 牛乳\n';
    const r = applyTaskRun(body, [0, 1], 'open');
    expect(r.body).toBe('- [x] ゴミ出し @2026-09-07 毎週\n- [ ] 牛乳\n');
    expect(r.skipped.repeat).toBe(1);
    // ⚠ 繰り返しでない日付つきの行は動く(日付があるだけでは飛ばさない)
    const dated = applyTaskRun('- [ ] 歯医者 @2026-09-07\n', [0], 'done');
    expect(dated.body).toBe('- [x] 歯医者 @2026-09-07\n');
    expect(dated.skipped.repeat).toBe(0);
  });

  it('🔴 もう一度当てても同じ(同じ本文を返し、changed は 0)', () => {
    const once = applyTaskRun(LIST, [2, 3, 4, 5, 6], 'done');
    const twice = applyTaskRun(once.body, [2, 3, 4, 5, 6], 'done');
    expect(twice.body).toBe(once.body);
    expect(twice.changed).toBe(0);
    expect(twice.skipped.repeat).toBe(1);
  });

  it('⚠ 項目でない行・範囲外・frontmatter の中は数えて飛ばす(別の行を書かない)', () => {
    const body = '---\ntags: [a]\n---\n- [ ] 牛乳\n普通の行\n';
    // 0..2 は frontmatter / 4 は散文 / 99 は範囲外 / -1 と 1.5 は行番号ではない
    const r = applyTaskRun(body, [0, 1, 2, 3, 4, 99, -1, 1.5], 'done');
    expect(r.body).toBe('---\ntags: [a]\n---\n- [x] 牛乳\n普通の行\n');
    expect(r.changed).toBe(1);
    expect(r.skipped.invalid).toBe(7);
  });

  it('🔴 fence の中の行は書かない(コードの例を書き換えない)', () => {
    const body = ['- [ ] 本物', '```md', '- [ ] コードの例', '```'].join('\n');
    const r = applyTaskRun(body, [0, 2], 'done');
    expect(r.body).toBe(['- [x] 本物', '```md', '- [ ] コードの例', '```'].join('\n'));
    expect(r.skipped.invalid).toBe(1);
  });

  it('同じ行を 2 度渡しても 1 件(二重に数えない)', () => {
    const r = applyTaskRun('- [ ] あ\n', [0, 0], 'done');
    expect(r.changed).toBe(1);
    expect(r.skipped).toEqual({ repeat: 0, invalid: 0 });
  });

  it('CRLF のノートで CRLF が保たれ、空白の入れ方も整形されない', () => {
    const crlf = '-   [ ]   ゆるい\r\n- [x] 済み\r\n';
    expect(applyTaskRun(crlf, [0, 1], 'done').body).toBe('-   [x]   ゆるい\r\n- [x] 済み\r\n');
  });

  it('引用や番号つきの前置きでも効く(`task` と同じ規則を借りている)', () => {
    const body = '> - [ ] 引用の中\n1. [ ] 番号\n';
    expect(applyTaskRun(body, [0, 1], 'done').body).toBe('> - [x] 引用の中\n1. [x] 番号\n');
  });

  describe('applyBodyRewrite の口(`task-run`)', () => {
    it('動かせば本文を返す / 元からそろっていれば同じ本文 / 1 行も読めなければ null', () => {
      expect(applyBodyRewrite('- [ ] あ\n', { kind: 'task-run', lines: [0], to: 'done' })).toBe(
        '- [x] あ\n',
      );
      const same = '- [x] あ\n';
      expect(applyBodyRewrite(same, { kind: 'task-run', lines: [0], to: 'done' })).toBe(same);
      // ⚠ 画面の行番号が古い(どれも項目でない)ときは断る ── 「開き直してください」の側
      expect(
        applyBodyRewrite('普通の行\n', { kind: 'task-run', lines: [0, 5], to: 'done' }),
      ).toBeNull();
      expect(applyBodyRewrite('- [ ] あ\n', { kind: 'task-run', lines: [], to: 'done' })).toBeNull();
    });

    it('繰り返しの行だけを渡したときは「読めた」側(断らず、同じ本文)', () => {
      const body = '- [ ] ゴミ出し @2026-09-07 毎週\n';
      expect(applyBodyRewrite(body, { kind: 'task-run', lines: [0], to: 'done' })).toBe(body);
    });
  });

  it('知らせの字: 動いた件数と、繰り返しを飛ばした件数と、何も動かなかった回', () => {
    const run = (changed: number, repeat: number) => ({
      body: '',
      changed,
      skipped: { repeat, invalid: 0 },
    });
    expect(taskRunNotice(run(3, 2), 'done')).toBe(
      '3 件を完了にしました / 2 件は繰り返しなので触りませんでした',
    );
    expect(taskRunNotice(run(0, 2), 'open')).toBe('2 件は繰り返しなので触りませんでした');
    expect(taskRunNotice(run(0, 0), 'done')).toBe('すべて完了になっています');
    expect(taskRunNotice(run(0, 0), 'open')).toBe('すべて未完了になっています');
  });
});

describe('添付のファイル名の 1 行(#1220 穴②、裁定 A)', () => {
  /** ⚠ 期待値は**手で組んだ原文**(`attachmentBody` の出力を写さない)。説明の本文も付ける。 */
  const ATT = [
    '---',
    'attachment.name: scan.pdf',
    'attachment.mime: application/pdf',
    'attachment.size: 12345',
    'attachment.asset_key: ast-keep-me',
    'attachment.hash: abc123',
    '---',
    '',
    '説明です。',
    'attachment.name: これは説明の本文の行(書き換えない)',
    '',
  ].join('\n');

  it('🔴 attachment.name の 1 行だけが変わり、ほかの行は 1 byte も動かない', () => {
    const out = applyBodyRewrite(ATT, { kind: 'attachment-name', typed: '請求書' })!;
    const lines = ATT.split('\n');
    const next = out.split('\n');
    expect(next).toHaveLength(lines.length);
    expect(next[1]).toBe('attachment.name: 請求書.pdf');
    // 変わったのは 1 行だけ ── mime / size / asset_key / hash と説明は等値
    expect(next.filter((_, i) => i !== 1)).toEqual(lines.filter((_, i) => i !== 1));
  });

  it('CRLF の本文でも、その 1 行だけを書き換える(改行コードは保つ)', () => {
    const crlf = ATT.replace(/\n/g, '\r\n');
    const out = applyBodyRewrite(crlf, { kind: 'attachment-name', typed: '請求書' })!;
    expect(out).toBe(crlf.replace('attachment.name: scan.pdf', 'attachment.name: 請求書.pdf'));
  });

  it('🔴 拡張子は「書く直前の本文」の名前から決める(画面の古い名前ではない)', () => {
    const moved = ATT.replace('scan.pdf', 'moved.zip'); // 別の窓が先に変えていた形
    const out = applyBodyRewrite(moved, { kind: 'attachment-name', typed: '請求書' })!;
    expect(out.split('\n')[1]).toBe('attachment.name: 請求書.zip');
  });

  it('🔴 attachment.name が無い本文には何も書かない(鍵を足さない・同じ本文を返す)', () => {
    const tile = '---\nattachment.launcher_url: https://example.com\n---\n';
    expect(applyBodyRewrite(tile, { kind: 'attachment-name', typed: '名前' })).toBe(tile);
    const note = '# ただのノート\n\n本文\n';
    expect(applyBodyRewrite(note, { kind: 'attachment-name', typed: '名前' })).toBe(note);
    // 説明の中にだけ在る `attachment.name:` の行は、設定の行ではない
    const only = '---\ntags: [あ]\n---\nattachment.name: 説明の中の行\n';
    expect(applyBodyRewrite(only, { kind: 'attachment-name', typed: '名前' })).toBe(only);
  });

  it('同じ名前になるなら、同じ本文を返す(書かない・言わない)', () => {
    expect(applyBodyRewrite(ATT, { kind: 'attachment-name', typed: 'scan.pdf' })).toBe(ATT);
  });

  it('書いた名前は読み口(readAttachmentMeta)で同じ字に戻る(引用が要る名前でも)', () => {
    for (const typed of ['#1 報告', 'a: b', '[x]', 'true', '123', '- 先頭がハイフン']) {
      const out = applyBodyRewrite(ATT, { kind: 'attachment-name', typed })!;
      // `:` は _ に置き換わるので、読み口の答えは「置き換え後 + .pdf」
      const want = typed.trim().replace(/:/g, '_') + '.pdf';
      expect(readAttachmentMeta(out).name, `「${typed}」が往復しない`).toBe(want);
      expect(readAttachmentMeta(out).assetKey).toBe('ast-keep-me');
    }
  });
});
