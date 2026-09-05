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

  it('🔴 掴んだ時点の行と byte 一致しなければ書かない(別の窓の書込で行がずれた形)', () => {
    const shifted = RAW.replace('段落 A', '段落 A(別の窓が直した)');
    expect(applyBodyRewrite(shifted, { kind: 'move-lines', ...range(5, 5), toBefore: 29 })).toBeNull();
    // 対照群 ── 一致していれば動く
    expect(applyBodyRewrite(RAW, { kind: 'move-lines', ...range(5, 5), toBefore: 29 })).not.toBeNull();
    // 行数が合わない(範囲だけ広げた)荷物も断る
    expect(
      applyBodyRewrite(RAW, { kind: 'move-lines', start: 5, end: 6, toBefore: 29, lines: ['段落 A'] }),
    ).toBeNull();
  });

  it('🔴 掴んだ塊が(別の窓の書込で)囲いの中へ移っていたら書かない', () => {
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
