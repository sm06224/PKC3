/**
 * 🔴 **`{…}` の中身を読む判定を、直に当てる**(#530)。
 *
 * ## ⚠ なぜ別に置くか
 *
 * この関数は **描く側からしか呼ばれていなかった** ── だから
 * 「名前として受けるか」を試すには、毎回 markdown を 1 本描いて HTML を見るしかなく、
 * **描き方が変わると検査の意味も変わる**(CLAUDE.md §3「判定関数を直に当てる test を
 * 別に置く」)。⚠ 2026-09-15 の時点で、この関数を名指しで呼ぶ test は **1 つも無かった**。
 *
 * ## 🔑 ここで守るのは 2 つ
 *
 * ① **名前(`#id`)には日本語が使える**(user 裁定 2026-09-15、#530)
 * ② 🔴 **class(`.名前`)と key(`名前=値`)は広げていない** ── こちらは綴りが
 *    **CSS の類別名と HTML の属性名になる**ので、同じ字を受けると出口が変わる。
 * ⚠ ②に検査が無いと、「ついでに揃えました」で**黙って広がる**
 *    (広げた側は user に見える変更なので、勝手に決めてよい物ではない)。
 */
import { describe, expect, it } from 'vitest';
import { NAME_RE, parseBlockDirectiveAttrs } from '@features/markdown/block-directive-attrs';

describe('名前として受ける字(#530)', () => {
  /**
   * 🔑 **先頭が対照群(ASCII)である** ── ここが落ちる回は、以降の判定が全部無意味。
   * ⚠ 日本語だけを並べると、「ASCII も日本語も等しく壊れた日」に緑のままになる。
   */
  const OK = ['today', 'a2', '_x', '今日', '買い物-1', 'ｶﾅ', '図A', '😀'] as const;

  it('🔴 日本語・かな・漢字・カタカナ・絵文字が名前になる', () => {
    for (const id of OK) {
      expect(parseBlockDirectiveAttrs(`format #${id} .pkc-place`).id, `名前にならない: ${id}`).toBe(
        id,
      );
    }
  });

  /**
   * ⚠ **空白は「使えない字」ではなく「切れ目」である。**
   * 🔑 ここを一緒くたに「断る」と書くと、マニュアルの説明が実際と食い違う
   *   (`#今日 明日` は断られるのではなく、名前が `今日` になる)。
   */
  it('⚠ 空白から後ろは名前に入らない(断るのではなく、そこで切れる)', () => {
    expect(parseBlockDirectiveAttrs('format #今日 明日').id).toBe('今日');
  });

  it('🔴 記号と、数で始まる名前は受けない(打ち間違いを黙って飲まない)', () => {
    for (const id of ['今日.明日', 'a.b', '1st', '1番', '今日#明日', '今日"', "今日'"]) {
      expect(parseBlockDirectiveAttrs(`format #${id}`).id, `使えない名前を通した: ${id}`).toBe(
        undefined,
      );
    }
  });

  /** ⚠ 空振り防止 ── 判定そのものが「全部 false」になっていないことを見る。 */
  it('⚠ 判定は両方向に動く(全部 true / 全部 false になっていない)', () => {
    expect(NAME_RE.test('今日')).toBe(true);
    expect(NAME_RE.test('1st')).toBe(false);
  });
});

/**
 * 🔴 **広げたのは名前だけ**(#530 の裁定は「付箋の名前」についてである)。
 *
 * ⚠ class は `class="…"` に、key は属性名と `data-` の綴りになるので、
 *   同じ字を受けると**出る HTML が変わる** ── user に見える変更なので、
 *   揃えるかどうかは裁定が要る(いまは揃えない)。
 * 🔑 だから**対照群つき**で見る:同じ形の ASCII が受かることまで見ないと、
 *   「parser ごと壊れている」を緑と読む。
 */
describe('🔴 class と key は広げていない(名前だけの裁定である)', () => {
  it('🔴 `.日本語` は類別として拾わない(ASCII は拾う)', () => {
    expect(parseBlockDirectiveAttrs('format .important').classes, '対照群が拾えていない').toEqual([
      'important',
    ]);
    expect(parseBlockDirectiveAttrs('format .大事').classes, '日本語の類別を拾った').toEqual([]);
  });

  /**
   * ⚠ **`format` 自身も「値なしの key」として拾われる**(実測。1 稿目はここを落として
   *   test が赤くなった ── 製品は正しく、こちらの前提が違った)。
   * 🔑 だから期待値にも残す ── **実際の形をそのまま書く**ほうが、次に読む人が迷わない。
   */
  it('🔴 日本語の key は拾わない(ASCII は拾う)', () => {
    expect(parseBlockDirectiveAttrs('format author="Smith"').kvs, '対照群が拾えていない').toEqual({
      format: true,
      author: 'Smith',
    });
    expect(parseBlockDirectiveAttrs('format 著者="Smith"').kvs, '日本語の key を拾った').toEqual({
      format: true,
    });
  });

  it('🔴 日本語の flag(値なし)も拾わない(ASCII は拾う)', () => {
    expect(parseBlockDirectiveAttrs('format quote').kvs, '対照群が拾えていない').toEqual({
      format: true,
      quote: true,
    });
    expect(parseBlockDirectiveAttrs('format 引用').kvs, '日本語の flag を拾った').toEqual({
      format: true,
    });
  });
});
