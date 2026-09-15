/** @vitest-environment happy-dom */
/**
 * 🔴 **自由配置の板**(#283 P4)── 位置を当てる(place-board)/ 掴んで動かす
 * (place-drag)/ 書換の門(MOVE_PLACE)。
 *
 * ## 守る主張
 *
 * 1. `.pkc-place` の塊が **本文の記法の位置**に置かれる(x= y= w= h= z=)
 * 2. `entry=` の塊は**題名の札**になり、押すとそのノートへ飛ぶ(展開はしない)
 * 3. 🔴 掴んで離すと `MOVE_PLACE` が飛び、**開き行を捕えた** REQUEST_BODY_REWRITE になる
 *    ── 行は描画が焼いた `data-pkc-source-line`(+ frontmatter)で指す
 * 4. 🔴 編集中は声に出して断る(reducer 1 か所 ── 掴む口を足しても取りこぼさない)
 * 5. 動かしていない(slop 未満)/ 元の位置へ戻した(取りやめ)なら書かない
 * 6. 🔴 塊の `data-pkc-entry` は名前を替えて外す ── 札の中のチェックを押したとき、
 *    `toggle-task` の closest が別ノートへ書かないため(レビュー実測 2026-08-28)
 * 7. 🔴 #676: 大きさ / 消す / 置く も**同じ門**(`RESIZE_PLACE` / `REMOVE_PLACE` /
 *    `ADD_PLACE` → 開き行を捕えた REQUEST_BODY_REWRITE。編集中は板の字で断る)。
 *    右下の角を掴むと見た目の大きさだけ動き、離すと `place-size` が 1 回飛ぶ
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { applyPlaceLayout, PLACE_FOCUS_ATTR } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag, NUDGE_SETTLE_MS } from '../../src/adapter/ui/render/place-drag';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
  ':::',
].join('\n');

/** 描画が吐く形(place-probe で実測した属性の並び。source-line 含む)を模す。 */
const RENDERED = [
  '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-h="200" data-pkc-w="320" data-pkc-x="120" data-pkc-y="40" data-pkc-source-line="0" data-pkc-source-end="3"><h3>買い出し</h3></div>',
  '<div class="pkc-format-block pkc-place" id="p2" data-pkc-format-block data-pkc-entry="n2" data-pkc-x="460" data-pkc-y="40" data-pkc-source-line="5" data-pkc-source-end="6"></div>',
].join('\n');

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * 🔴 **板どうしを繋ぐ線**(#530 段③a)。
 *
 * ⚠ **線は座標を持たない** ── `from=` / `to=` で 2 枚を指すだけで、引く場所は
 *   2 枚の位置から毎回計算する(板を動かせば線も付いてくる)。
 * ⚠ **happy-dom は `offsetWidth` に 0 を返す**ので、ここで通るのは
 *   「測れないときは札へ落とす」枝である ── その落とし先まで見る(CLAUDE.md §2)。
 */
describe('板どうしを繋ぐ線(#530 段③a)', () => {
  const LINES = [
    '<div class="pkc-format-block pkc-place" id="a" data-pkc-format-block data-pkc-w="100" data-pkc-h="60" data-pkc-x="0" data-pkc-y="0" data-pkc-source-line="0" data-pkc-source-end="1"></div>',
    '<div class="pkc-format-block pkc-place" id="b" data-pkc-format-block data-pkc-w="100" data-pkc-h="60" data-pkc-x="300" data-pkc-y="0" data-pkc-source-line="2" data-pkc-source-end="3"></div>',
    '<div class="pkc-format-block pkc-line" data-pkc-format-block data-pkc-from="a" data-pkc-to="b" data-pkc-source-line="4" data-pkc-source-end="5"></div>',
  ].join('\n');

  function board(html: string) {
    const host = document.createElement('div');
    host.className = 'pkc-md-rendered';
    host.innerHTML = html;
    document.body.append(host);
    applyPlaceLayout(host, () => null, 0);
    return host;
  }
  const drawn = (host: HTMLElement): SVGPathElement[] => [
    ...host.querySelectorAll<SVGPathElement>('[data-pkc-field="place-lines"] path'),
  ];
  /**
   * 🔑 **端点は `d` の中から読む**(#530 段③c)── 器を `<line>` から `<path>` へ
   *   替えたので、`x1` / `y1` という属性はもう無い。
   * ⚠ 別の属性へ写して持たせない ── 2 か所に持つと、片方だけ腐っても緑になる。
   */
  const ends = (l: SVGPathElement): number[] =>
    (l.getAttribute('d') ?? '').split(/[^\d.-]+/).filter((t) => t !== '').map(Number);
  const start = (l: SVGPathElement): number[] => ends(l).slice(0, 2);
  const finish = (l: SVGPathElement): number[] => ends(l).slice(-2);

  it('🔴 from= と to= の板の間に、いちばん近い辺どうしで線が引かれる', () => {
    const host = board(LINES);
    const ls = drawn(host);
    expect(ls.length, '線が 1 本も引かれていない').toBe(1);
    const l = ls[0]!;
    // 🔑 横に並べたので「右 → 左」── 中心へ刺すと板の上を横切る
    expect(l.getAttribute('data-pkc-line-from')).toBe('right');
    expect(l.getAttribute('data-pkc-line-to')).toBe('left');
    expect(start(l), '出る所が右辺の真ん中でない').toEqual([100, 30]);
    expect(finish(l), '入る所が左辺の真ん中でない').toEqual([300, 30]);
    // 🔑 省いたら**まっすぐ**(#530 段③c)── 書かなくても必ず届く形である
    expect(l.getAttribute('data-pkc-line-route')).toBe('straight');
    expect(l.getAttribute('d')).toBe('M 100 30 L 300 30');
  });

  /**
   * 🔴 **層は 1 枚だけ**(描き直しのたびに増えない)。
   * ⚠ 増えると、古い線が下に残ったまま新しい線が重なる ──
   *   「描画のたびに呼ぶ(冪等)」という、この file 冒頭の約束が破れる。
   */
  it('🔴 何度描き直しても、線の層は 1 枚しか無い', () => {
    const host = board(LINES);
    for (let i = 0; i < 3; i += 1) applyPlaceLayout(host, () => null, 0);
    expect(
      host.querySelectorAll('[data-pkc-field="place-lines"]').length,
      '描き直すたびに層が増えている',
    ).toBe(1);
    expect(drawn(host).length, '線が増えている / 消えている').toBe(1);
  });

  /**
   * ⚠ **指す先が無い線は、黙って飛ばす**(描かない)。
   * 🔑 ただし**本文からは消さない** ── user が書いた字を、こちらの都合で書き換えない。
   */
  it('⚠ 行き先が無い / 自分自身を指す線は描かない', () => {
    const bad = LINES.replace('data-pkc-to="b"', 'data-pkc-to="zzz"');
    expect(drawn(board(bad)).length, '居ない板へ線を引いている').toBe(0);
    document.body.innerHTML = '';
    const self = LINES.replace('data-pkc-from="a"', 'data-pkc-from="b"');
    expect(drawn(board(self)).length, '同じ板どうしに線を引いている').toBe(0);
    document.body.innerHTML = '';
    // 🔑 空振り防止 ── 正しい綴りでは 1 本出る(上の 0 が「いつも 0」ではない)
    expect(drawn(board(LINES)).length).toBe(1);
  });

  /**
   * 🔴 **手で書いた接続点が効く**(#530 段③b、user 裁定 2026-09-15)。
   * ⚠ 段③a のときは「綴りは受けるが効かない」だった ── 効かないままだと、
   *   書いた人には**書いた所と違う所から線が出る**としか見えない。
   */
  it('🔴 接続点つきの綴り(a:top)は、書いた辺から出る(#530 段③b)', () => {
    const withAnchor = LINES.replace('data-pkc-from="a"', 'data-pkc-from="a:top"').replace(
      'data-pkc-to="b"',
      'data-pkc-to="b:bottom"',
    );
    const l = drawn(board(withAnchor))[0]!;
    expect(l.getAttribute('data-pkc-line-from'), '書いた辺から出ていない').toBe('top');
    expect(l.getAttribute('data-pkc-line-to'), '書いた辺へ入っていない').toBe('bottom');
    // 🔑 座標も見る(上辺の真ん中 = x 50 / y 0)
    expect(start(l)).toEqual([50, 0]);
    // ⚠ 対照群 ── 書かなければ右 → 左(上の it)。書いたことで変わっている
  });

  /**
   * 🔴 **辺のどこか(分数)まで書ける**(user 裁定 2026-09-15)。
   * 🔑 **細かさに上限を作らない** ── 足りなければ、その間をさらに割れる。
   */
  it('🔴 辺の中点の、さらに中点を指せる(a:top@1/4)', () => {
    const withAnchor = LINES.replace('data-pkc-from="a"', 'data-pkc-from="a:top@1/4"');
    const l = drawn(board(withAnchor))[0]!;
    expect(l.getAttribute('data-pkc-line-from'), '分数が効いていない').toBe('top@1/4');
    // 板 a は x=0 幅 100 ── 上辺の 1/4 は x=25
    expect(start(l), '1/4 の所から出ていない').toEqual([25, 0]);
  });

  /**
   * 🔴 **読めない接続点は、黙って真ん中へ繋がない**(#530 段③b)。
   * ⚠ 黙って繋ぐと**線は出る**ので、打ち間違いに気づく手がかりが 1 つも残らない。
   */
  it('🔴 読めない接続点(a:righ)は、理由を言って線を引かない', () => {
    const bad = LINES.replace('data-pkc-from="a"', 'data-pkc-from="a:righ"');
    const host = board(bad);
    expect(drawn(host).length, '読めない綴りのまま線を引いている').toBe(0);
    const note = host.querySelector('[data-pkc-field="place-line-note"]');
    expect(note?.textContent ?? '', '断りが出ていない').toContain('righ');
    expect(note?.textContent ?? '', '直し方を言っていない').toContain('right@1/4');
    // 🔑 空振り防止 ── 読める綴りなら断りは出ない
    document.body.innerHTML = '';
    const ok = board(LINES.replace('data-pkc-from="a"', 'data-pkc-from="a:right@1/4"'));
    expect(ok.querySelector('[data-pkc-field="place-line-note"]'), '読める綴りを断っている')
      .toBeNull();
  });

  /**
   * 🔴 **線の通り方と、曲がる所を書ける**(#530 段③c、user 裁定 2026-09-15)。
   * 🔑 **同じ `bend=` を書いた線は同じ幹を通る** ── それが「図の動線を単純にする」
   *   の実体なので、**曲がる所が効いていること**を値で見る。
   */
  it('🔴 route= と bend= が効く(#530 段③c)', () => {
    const curved = LINES.replace(
      'data-pkc-to="b"',
      'data-pkc-to="b" data-pkc-route="curve" data-pkc-bend="v:260"',
    );
    const l = drawn(board(curved))[0]!;
    expect(l.getAttribute('data-pkc-line-route'), '通り方が焼かれていない').toBe('curve');
    expect(l.getAttribute('d'), '曲がる所が効いていない').toBe('M 100 30 C 260 30 260 30 300 30');
    // ⚠ 対照群 ── 書かなければまっすぐ(上の it)。書いたことで変わっている
    document.body.innerHTML = '';
    const elbow = LINES.replace('data-pkc-to="b"', 'data-pkc-to="b" data-pkc-route="elbow"');
    expect(drawn(board(elbow))[0]!.getAttribute('d'), '直角が効いていない')
      .toBe('M 100 30 L 200 30 L 200 30 L 300 30');
  });

  /**
   * 🔴 **読めない綴りは、黙ってまっすぐに倒さない**(#530 段③c)。
   * ⚠ 倒すと**線は出る**ので、打ち間違いに気づく手がかりが 1 つも残らない
   *   ── 接続点(`a:righ`)とまったく同じ型の実害である。
   */
  it('🔴 読めない route= / bend= は、理由を言って線を引かない', () => {
    for (const [attr, bad, want] of [
      ['data-pkc-route', 'elbo', '線の通り方に「elbo」は使えません'],
      ['data-pkc-bend', '320', '曲がる所に「320」は使えません'],
    ] as const) {
      document.body.innerHTML = '';
      const host = board(LINES.replace('data-pkc-to="b"', `data-pkc-to="b" ${attr}="${bad}"`));
      expect(drawn(host).length, `読めない ${attr} のまま線を引いている`).toBe(0);
      expect(
        host.querySelector('[data-pkc-field="place-line-note"]')?.textContent ?? '',
        `${attr} の断りが出ていない`,
      ).toContain(want);
    }
    // 🔑 空振り防止 ── 読める綴りなら断りは出ない
    document.body.innerHTML = '';
    const ok = board(LINES.replace(
      'data-pkc-to="b"',
      'data-pkc-to="b" data-pkc-route="elbow" data-pkc-bend="h:20"',
    ));
    expect(ok.querySelector('[data-pkc-field="place-line-note"]'), '読める綴りを断っている')
      .toBeNull();
  });

  /**
   * 🔴 **同じ 2 枚の間に何本も引いたら、辺の上で散らす**(user 裁定 2026-09-15)。
   * ⚠ 散らさないと 2 本目以降が**1 本目の真下に完全に重なって消える**
   *   ── 引いた本人には「1 本しか引けない」としか見えず、
   *   「A と B は別々の理由でつながっている」を図で言えない。
   */
  it('🔴 同じ 2 枚の間の 3 本が、別々の所に付く(#530 段③b)', () => {
    const three = LINES
      + '\n<div class="pkc-format-block pkc-line" data-pkc-format-block data-pkc-from="a"'
      + ' data-pkc-to="b" data-pkc-source-line="6" data-pkc-source-end="7"></div>'
      // ⚠ 逆向きに書いた線も「同じ 2 枚の間」である(向きで数を分けない)
      + '\n<div class="pkc-format-block pkc-line" data-pkc-format-block data-pkc-from="b"'
      + ' data-pkc-to="a" data-pkc-source-line="8" data-pkc-source-end="9"></div>';
    const ls = drawn(board(three));
    expect(ls.length, '線が 3 本引かれていない').toBe(3);
    /**
     * 🔴 **「散った」ではなく「どこに散ったか」を見る**(変異試験 M11 が SURVIVED で教えた)。
     * ⚠ 1 稿目は「3 本の `y1` が全部違う」しか見ておらず、**向きを揃える正規化を
     *   外しても緑**だった ── a→b の 2 本が `1/3, 2/3`(= 20, 40)、逆向きの b→a が
     *   単独の組になって `1/2`(= 30)になり、**たまたま 3 つとも違う値**になるからである。
     * 🔑 3 本が**同じ組**なら、板の高さ 60 の `1/4 / 2/4 / 3/4` = **15 / 30 / 45** に並ぶ。
     *   ⚠ 値そのものを書く ── 「違う」だけでは、違う散り方と見分けられない。
     */
    const ys = ls.map((l) => start(l)[1]!);
    expect([...ys].sort((a, b) => a - b), `3 本が同じ組として散っていない: ${ys.join(',')}`)
      .toEqual([15, 30, 45]);
    /**
     * 🔑 **3 本とも「右辺と左辺の間」を通る**(平行に並ぶ)。
     * ⚠ 出る辺の名前で数えてはいけない ── 3 本目は `b→a` と逆向きに書いたので
     *   出るのは **b の左辺**である(向きが違うだけで、通る道は同じ)。
     */
    const edge = (l: SVGPathElement, k: 'from' | 'to'): string =>
      (l.getAttribute(`data-pkc-line-${k}`) ?? '').split('@')[0]!;
    for (const l of ls) {
      expect(new Set([edge(l, 'from'), edge(l, 'to')]), '右辺と左辺の間を通っていない')
        .toEqual(new Set(['right', 'left']));
    }
  });

  it('🔴 1 本しか無いときは、これまでどおり辺の真ん中(位置が動かない)', () => {
    const l = drawn(board(LINES))[0]!;
    expect(l.getAttribute('data-pkc-line-from'), '1 本なのに分数が焼かれている').toBe('right');
    expect(start(l)).toEqual([100, 30]);
  });

  /**
   * 🔴 **板が 1 枚も無くなったら、線も残さない**。
   * ⚠ 残ると、板を全部消した本文で**線だけが宙に浮く**。
   */
  it('🔴 板を全部消すと、線の層ごと消える', () => {
    const host = board(LINES);
    expect(host.querySelector('[data-pkc-field="place-lines"]')).not.toBeNull();
    for (const el of host.querySelectorAll('.pkc-place')) el.remove();
    applyPlaceLayout(host, () => null, 0);
    expect(
      host.querySelector('[data-pkc-field="place-lines"]'),
      '板が無いのに線の層が残っている',
    ).toBeNull();
  });

  /**
   * 🔴 **線の層が、流れの中の中身を塞がない**(無言の dead click を作らない)。
   *
   * ⚠ この docstring は 1 稿目で「**掴む口**を塞がない」と書いていたが、
   *   **実ブラウザの変異試験が SURVIVED で嘘だと教えた** ── 掴む口は
   *   `host.prepend(svg)` の帰結で**そもそも層より前面**に居るので、この規則は効いていない。
   * 🔑 本当に守っているのは**位置を持たない中身**(本文の段落・リンク・下の断りの 1 行)──
   *   層は `inset: 0` で器いっぱいに広がるので、当てないと**本文が全部押せなくなる**。
   * ⚠ ここで見るのは**規則が在ること**だけである(`pointer-events` の効き目は
   *   happy-dom では測れない)── **効いていること**は
   *   `tests/smoke/place-board.smoke.spec.ts` が「板の無い所で層が最前面に来ていない」で見る。
   */
  it('🔴 線の層は押しを通す(流れの中の中身を塞がない)', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
    const rule = blocksFor(withoutMedia(css), "[data-pkc-field='place-lines']").join(' ');
    expect(rule, '線の層に pointer-events の規則が無い(掴む口が押せなくなる)').toContain(
      'pointer-events: none',
    );
  });

  /**
   * 🔴 **線は板より後ろに敷く**(着地前レビュー #3。変異試験が SURVIVED で教えた)。
   *
   * ⚠ `z-index` を持たない絶対配置は **DOM 順**で重なるので、`prepend` を `append` へ
   *   変えると**線が字の上に乗る** ── コメントが名指ししている当の事故である。
   * 🔑 だから見るのは「層が在る」ではなく「**層が先頭に在る**」。
   */
  it('🔴 線の層は、いちばん先頭に敷かれる(線が字の上に乗らない)', () => {
    const host = board(LINES);
    expect(
      host.firstElementChild?.getAttribute('data-pkc-field'),
      '線の層が先頭に無い(板より前面に来ると字が読めなくなる)',
    ).toBe('place-lines');
  });

  /**
   * 🔴 **引けない線は、理由を画面に出す**(動線レビュー ①)。
   *
   * ⚠ 1 稿目は**黙って飛ばして**いた ── 同じ file の `ensureCard` が
   *   「相手が消えていても黙って空にしない」と決めているのに、正反対だった。
   * 🔑 見るのは 3 つ:**断りが出る / その行が画面に出る(隠す規則の例外印が付く) /
   *   本文の字は消えていない**。
   */
  it('🔴 行き先の名前が無い線は、理由をその場に出す(黙って消さない)', () => {
    const host = board(
      LINES.replace('data-pkc-to="b"', 'data-pkc-to="zzz"'),
    );
    expect(drawn(host).length, '引けないのに線が引かれている').toBe(0);
    const decl = host.querySelector<HTMLElement>('.pkc-line')!;
    const note = decl.querySelector('[data-pkc-field="place-line-note"]');
    expect(note?.textContent, '引けない理由が出ていない').toBe(
      '線が引けません:「zzz」という名前の付箋がありません',
    );
    // ⚠ 隠す規則の**例外印**が付いていないと、断りを書いても画面には出ない
    expect(decl.hasAttribute('data-pkc-line-missing'), '断りが CSS に隠されたままである').toBe(
      true,
    );
    // ⚠ 対照群: 引ける線には断りが出ない(= 出しっぱなしではない)
    const ok = board(LINES);
    expect(
      ok.querySelector('[data-pkc-field="place-line-note"]'),
      '引けている線にまで断りが出ている',
    ).toBeNull();
  });

  /**
   * 🔴 **いちばん踏みやすい形は名指しで言う**(実測: 使えない字は綴りの検査で黙って落ちる)。
   * ⚠ `from=` から見ると「その名前の板が無い」と区別が付かないので、
   *   **名前の綴りのほうを言う** ── そうしないと user は在る付箋を探し続ける。
   * 🔑 使えないのは**区切りに使っている字**(空白 / `.` / `=` / `{` / `}` / 引用符)と
   *   **数で始まる名前**だけで、**日本語は使える**(#530、user 裁定 2026-09-15)──
   *   下の test が対で見る。
   * ⚠ 断り文に**数で始まる名前**を足したのは実測の後である ── `#1番` も落ちるのに
   *   理由の 3 つ目が言われておらず、user は原因を当てられなかった。
   */
  it('🔴 名前に使えない字を書いたときは、その理由を言う', () => {
    const host = board(LINES.replace('data-pkc-to="b"', 'data-pkc-to="a.b"'));
    const note = host.querySelector('[data-pkc-field="place-line-note"]');
    expect(note?.textContent, '名前の綴りの断りが出ていない').toBe(
      '線が引けません:名前に「a.b」は使えません ── 空白・記号(. = { } " \')・数で始まる名前は使えません。日本語は使えます',
    );
  });

  /**
   * ⚠ **数で始まる名前も同じ断りへ落ちる**(`#1番`)。
   * 🔑 「その名前の付箋がありません」ではなく**綴りの話だと言う**のが肝である ──
   *   落ち方が同じでも、言い方が違えば user の次の一手が変わる。
   */
  it('⚠ 数で始まる名前も、綴りの断りへ落ちる(在る付箋を探させない)', () => {
    const host = board(LINES.replace('data-pkc-to="b"', 'data-pkc-to="1番"'));
    const note = host.querySelector('[data-pkc-field="place-line-note"]')?.textContent ?? '';
    expect(note, '数で始まる名前で綴りの断りが出ていない').toContain('名前に「1番」は使えません');
    expect(note, '在る付箋を探させる言い方になっている').not.toContain('付箋がありません');
  });

  /**
   * 🔴 **日本語の名前で線が引ける**(#530、user 裁定 2026-09-15)。
   * ⚠ 直す前は `#今日` が**綴りの検査で黙って落ちて**いたので、
   *   「その名前の付箋がありません」と出て、user は在る付箋を探し続けた。
   * 🔑 ここは**対照群つき**で見る ── 断りが出ないことだけでなく、
   *   **線が実際に引けている**(`<line>` が 1 本出る)ことまで見る。
   */
  it('🔴 日本語の名前でも線が引ける(黙って落ちない)', () => {
    const jp = LINES.replace('id="b"', 'id="今日"').replace('data-pkc-to="b"', 'data-pkc-to="今日"');
    const host = board(jp);
    expect(
      host.querySelector('[data-pkc-field="place-line-note"]'),
      '日本語の名前で断りが出ている',
    ).toBeNull();
    expect(
      host.querySelectorAll('[data-pkc-field="place-lines"] path').length,
      '日本語の名前で線が引けていない',
    ).toBe(1);
  });

  /** ⚠ 板が 1 枚も無いときも黙らない(「機能そのものが無い」と読まれる)。 */
  it('🔴 板が 1 枚も無い本文でも、線の宣言は理由を出す', () => {
    const only = LINES.split('\n')[2]!;
    const host = board(only);
    expect(
      host.querySelector('[data-pkc-field="place-line-note"]')?.textContent,
      '板が無いときに黙っている',
    ).toBe('線が引けません:板(付箋)が 1 枚もありません');
  });

  /**
   * 🔴 **付箋の名前を、掴む口が言う**(動線レビュー ②)。
   * ⚠ 名前は画面のどこにも出ていなかった ── 線が引けないとき、確かめる術が
   *   本文を開くことだけだった。
   */
  it('🔴 掴む口のホバーに、その付箋の名前が出る', () => {
    const host = board(LINES);
    const grip = host.querySelector<HTMLElement>('#a [data-pkc-field="place-grip"]')!;
    expect(grip.title, '掴む口が名前を言っていない').toContain('名前は「a」です');
    // ⚠ 対照群: 名前の無い板では言わない(「名前は「」です」と出さない)
    const noId = board(LINES.replace(' id="a"', ''));
    const g2 = noId.querySelector<HTMLElement>('.pkc-place [data-pkc-field="place-grip"]')!;
    expect(g2.title, '名前が無いのに名前を言っている').not.toContain('名前は');
  });

  /**
   * 🔴 **測れない所で使う数は、CSS と同じでなければならない**(着地前レビュー #4)。
   *
   * ⚠ `place-board.ts` のコメントは「CSS の `min-width`/`min-height` と同じ数にする」と
   *   明言しているのに、**それを機械で突き合わせる検査が 1 つも無かった**
   *   (999/777 に変えても全 10344 件が緑だった)。
   * 🔑 §7「同じ値が 2 か所」は、**片方だけ動かせる形のまま放っておかない**。
   */
  it('🔴 測れないときの大きさが、CSS の下限と同じ数である', () => {
    const src = stripComments(readFileSync('src/adapter/ui/render/place-board.ts', 'utf-8'));
    const w = /PLACE_FALLBACK_W = (\d+)/.exec(src);
    const h = /PLACE_FALLBACK_H = (\d+)/.exec(src);
    expect(w, '落とし先の幅が読めない(この検査は空振り)').not.toBeNull();
    expect(h, '落とし先の高さが読めない(この検査は空振り)').not.toBeNull();
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const rule = blocksFor(css, '.pkc-md-rendered .pkc-format-block.pkc-place').join(' ');
    expect(rule, '板の規則が引けていない(この検査は空振り)').toContain('min-width');
    expect(rule, `落とし先の幅 ${w![1]}px が CSS の min-width と違う`).toContain(
      `min-width: ${w![1]}px`,
    );
    expect(rule, `落とし先の高さ ${h![1]}px が CSS の min-height と違う`).toContain(
      `min-height: ${h![1]}px`,
    );
  });

  /**
   * 🔴 **宣言の塊を隠す規則が、本当に隠しているか**(着地前レビュー #5)。
   * ⚠ `markdown-css-parity` は「その class 名が CSS のどこかに在るか」しか見ないので、
   *   `display: none` を `color: red` に変えても緑だった(= 宣言が本文に赤字で出る)。
   */
  it('🔴 線の宣言の塊は、規則で隠されている', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const hide = blocksFor(css, '.pkc-md-rendered .pkc-format-block.pkc-line').join(' ');
    expect(hide, '宣言の塊を隠す規則が無い(指すだけの行が本文に出る)').toContain('display: none');
    // ⚠ そして**引けなかった線だけは出す**(上の断りが隠れたままにならない)
    const show = blocksFor(
      css,
      '.pkc-md-rendered .pkc-format-block.pkc-line[data-pkc-line-missing]',
    ).join(' ');
    expect(show, '断りを出すための例外の規則が無い').toContain('display: block');
  });
});

describe('位置を当てる(applyPlaceLayout)', () => {
  function mounted() {
    const host = document.createElement('div');
    host.className = 'pkc-md-rendered';
    host.innerHTML = RENDERED;
    document.body.append(host);
    const titles = new Map([['n2', '相手のノート']]);
    const n = applyPlaceLayout(host, (l) => titles.get(l) ?? null, 0);
    return { host, n };
  }

  it('🔴 本文の記法の位置に置かれる(x= y= w= h=)', () => {
    const { host, n } = mounted();
    expect(n).toBe(2);
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    expect(p1.style.left).toBe('120px');
    expect(p1.style.top).toBe('40px');
    expect(p1.style.width).toBe('320px');
    expect(p1.style.height).toBe('200px');
    expect(host.classList.contains('pkc-board-host'), '器に板の印が無い').toBe(true);
    // いちばん下の塊(40+200)まで scroll で届く高さ
    expect(host.style.minHeight).toBe('280px');
  });

  it('🔑 開き行の行番号が焼かれる(source-line + frontmatter ぶん)', () => {
    const { host } = mounted();
    expect(
      [...host.querySelectorAll('.pkc-place')].map((el) => el.getAttribute('data-pkc-place-line')),
    ).toEqual(['0', '5']);
    // frontmatter があるノートでは、そのぶんずれる(taskLineOffset と同じ座標系)
    const host2 = document.createElement('div');
    host2.innerHTML = RENDERED;
    document.body.append(host2);
    applyPlaceLayout(host2, () => null, 3);
    expect(
      [...host2.querySelectorAll('.pkc-place')].map((el) => el.getAttribute('data-pkc-place-line')),
    ).toEqual(['3', '8']);
  });

  it('🔴 塊の data-pkc-entry は data-pkc-place-entry へ移して外す(closest の誤爆を作らない)', () => {
    const { host } = mounted();
    const p2 = host.querySelector<HTMLElement>('#p2')!;
    expect(p2.hasAttribute('data-pkc-entry'), '塊に data-pkc-entry が残っている').toBe(false);
    expect(p2.getAttribute('data-pkc-place-entry')).toBe('n2');
    // ⚠ 札の中に書いたチェックの印から closest で lid を引くと、当たるのは
    //   塊ではなく**札のボタンの外側 = 無し**であること(toggle-task は自ノートに書く)
    const inner = document.createElement('span');
    p2.prepend(inner);
    expect(inner.closest('[data-pkc-entry]')).toBeNull();
  });

  it('掴む口が 1 つずつ出る(2 回呼んでも増えない・見出しの字を汚さない・札も生き続ける)', () => {
    const { host } = mounted();
    applyPlaceLayout(host, () => '改名後', 0);
    const grips = host.querySelectorAll('[data-pkc-field="place-grip"]');
    expect(grips).toHaveLength(2);
    expect(grips[0]!.textContent, '印が字として入っている(写しが汚れる)').toBe('');
    expect(host.querySelector('h3')!.textContent).toBe('買い出し');
    // ⚠ 2 回目の呼び出し(entry は place-entry へ移設済み)でも札は描き直される
    expect(host.querySelector('#p2 [data-pkc-field="place-card"]')!.textContent).toBe('改名後');
  });

  it('🔴 entry= の塊は題名の札になり、押す先が select-entry(展開はしない)', () => {
    const { host } = mounted();
    const card = host.querySelector<HTMLButtonElement>('#p2 [data-pkc-field="place-card"]')!;
    expect(card.textContent).toBe('相手のノート');
    expect(card.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(card.getAttribute('data-pkc-entry')).toBe('n2');
  });

  it('相手が見つからないとき、いちばん多い原因(ID の貼り間違い)を先に言う', () => {
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    document.body.append(host);
    applyPlaceLayout(host, () => null, 0);
    const card = host.querySelector<HTMLButtonElement>('#p2 [data-pkc-field="place-card"]')!;
    expect(card.textContent).toBe('(見つかりません)');
    expect(card.title, '直し方(ID の形)を言っていない').toContain('entry:');
    expect(card.title).toContain('閉じ括弧');
  });

  it('板の塊が無ければ器の印も外す(戻り道)', () => {
    const { host } = mounted();
    host.innerHTML = '<p>ただの本文</p>';
    expect(applyPlaceLayout(host, () => null, 0)).toBe(0);
    expect(host.classList.contains('pkc-board-host')).toBe(false);
    expect(host.style.minHeight).toBe('');
  });

  it('読めない値(x="abc")は 0 扱い(黙って落ちない)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="pkc-format-block pkc-place" data-pkc-x="abc"></div>';
    document.body.append(host);
    applyPlaceLayout(host, () => null, 0);
    expect(host.querySelector<HTMLElement>('.pkc-place')!.style.left).toBe('0px');
  });
});

describe('書換の門(MOVE_PLACE)', () => {
  function booted() {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', '板'), meta('n2', '相手のノート')],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
    events.length = 0;
    return { d, events };
  }

  it('🔴 開き行を捕えた REQUEST_BODY_REWRITE になる', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 5, x: 10, y: 20 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n1',
      rewrite: {
        kind: 'place-move',
        line: 5,
        openLine: ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
        x: 10,
        y: 20,
      },
    });
  });

  it('🔴 編集中は声に出して断る(掴む口を足しても取りこぼさない ── reducer 1 か所)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 0, x: 1, y: 2 });
    expect(d.getState().error ?? '', '理由が出ていない').toContain('編集を終了');
    expect(d.getState().error ?? '', '押した場所と文言が合っていない').toContain('板');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  /**
   * 🔴 **横に留めた枠の付箋も、その枠のノートへ書く**(#281 検算 2026-08-30)。
   *
   * ⚠ 直す前は `openBody` だけを見ていたので、留めた枠の付箋を動かすと
   *   ①主の枠が板でなければ**黙って no-op** ②主の枠も板なら**別のノートの
   *   同じ行を書き換えうる**、の 2 つに落ちていた。
   * 🔑 この it は**主の枠を板ではないノート**にして撃つ ── そうしないと、
   *   openBody から拾った行が偶然一致して「直った」に見えることがある。
   */
  it('🔴 横に留めた枠の付箋は、その枠のノートの行を書く(主の枠ではない)', () => {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'ふつうのノート'), meta('n2', '板')],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'ただの本文\nもう 1 行\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: BOARD });
    events.length = 0;

    d.dispatch({ type: 'MOVE_PLACE', lid: 'n2', line: 5, x: 10, y: 20 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '留めた枠の付箋を動かしても書換の依頼が出ない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n2',
      rewrite: { kind: 'place-move', line: 5, openLine: BOARD.split('\n')[5], x: 10, y: 20 },
    });
  });

  /**
   * 対照群 ── 🔑 **留めていない lid では書かない。** これが無いと、上の it は
   * 「lid の門を丸ごと外した」変異でも緑になる(門が生きていることを見ていない)。
   */
  it('🔴 対照群: 留めてもいない・開いてもいない lid では書かない', () => {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'ふつうのノート'), meta('n2', '板')],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'ただの本文\nもう 1 行\n' });
    events.length = 0;
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n2', line: 5, x: 10, y: 20 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('🔴 開いているノートと違う lid では書かない(実在する別ノートの lid でも)', () => {
    const { d, events } = booted();
    // ⚠ metas に**実在する** n2 で撃つ ── 「meta が無いから」の門に救われない形で、
    //   「openBody と違うから」の門そのものを見る(§1「救い手が別」)
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n2', line: 0, x: 1, y: 2 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('板の開き行でない行 / 範囲の外の行は書かない', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 2, x: 1, y: 2 });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 99, x: 1, y: 2 });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: -1, x: 1, y: 2 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  /**
   * 🔴 **#676 の 3 つも同じ門を通る。** ⚠ 3 つとも**別の it** にする ── 1 つの it に
   * 束ねると、1 つの case を丸ごと落とす変異が「他の 2 つが飛んだ」で緑になる。
   */
  it('🔴 RESIZE_PLACE ── 開き行を捕えた place-size の依頼になる', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'RESIZE_PLACE', lid: 'n1', line: 0, w: 400, h: 90 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'place-size', line: 0, openLine: BOARD.split('\n')[0], w: 400, h: 90 },
    });
  });

  it('🔴 REMOVE_PLACE ── 開き行を捕えた place-remove の依頼になる', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'REMOVE_PLACE', lid: 'n1', line: 5 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'place-remove', line: 5, openLine: BOARD.split('\n')[5] },
    });
    // ⚠ 依頼に行番号と開き行**以外**の鍵が無い(x / y を持ち込む変異は別の kind と混ざる)
    expect(Object.keys((ev as { rewrite: object }).rewrite).sort()).toEqual(['kind', 'line', 'openLine']);
  });

  it('🔴 RAISE_PLACE ── 開き行を捕えた place-raise の依頼になる(#676 段②)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'RAISE_PLACE', lid: 'n1', line: 0 });
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'place-raise', line: 0, openLine: BOARD.split('\n')[0] },
    });
    events.length = 0;
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'RAISE_PLACE', lid: 'n1', line: 0 });
    expect(d.getState().error ?? '').toContain('前へ');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('🔴 SET_PLACE_SHAPE ── 開き行を捕えた place-shape の依頼になる(#530 案 A)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'SET_PLACE_SHAPE', lid: 'n1', line: 0, shape: 'diamond' });
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'place-shape', line: 0, openLine: BOARD.split('\n')[0], shape: 'diamond' },
    });
    // 🔴 編集中は**声に出して**断る(黙って捨てない)
    events.length = 0;
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'SET_PLACE_SHAPE', lid: 'n1', line: 0, shape: 'ellipse' });
    expect(d.getState().error ?? '').toContain('形');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('🔴 SET_PLACE_SHAPE ── 知らない綴りは依頼を作らない(#530)', () => {
    const { d, events } = booted();
    // ⚠ 型では止まらない経路(境界を越えてきた値)を模す
    d.dispatch({
      type: 'SET_PLACE_SHAPE',
      lid: 'n1',
      line: 0,
      shape: 'wedgeEllipseCallout' as never,
    });
    expect(
      events.filter((e) => e.type === 'REQUEST_BODY_REWRITE'),
      '知らない図形名が PowerPoint まで流れる',
    ).toHaveLength(0);
  });

  it('🔴 ADD_PLACE ── 座標だけを持つ place-add の依頼になる(行番号を持たない)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'ADD_PLACE', lid: 'n1', x: 30, y: 50 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({ lid: 'n1', rewrite: { kind: 'place-add', x: 30, y: 50 } });
  });

  it('🔴 板ではないノートにも置ける(1 枚目 ── 器が板になる仕様)', () => {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'ふつうのノート')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'ただの本文\n' });
    events.length = 0;
    d.dispatch({ type: 'ADD_PLACE', lid: 'n1', x: 1, y: 2 });
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-add', x: 1, y: 2 },
    });
  });

  /**
   * 🔴 **編集中は 3 つとも声に出して断る**(門は 1 か所)。⚠ 文言は**押した場所と対**
   * (CLAUDE.md「文言は押した場所と対で pin する」)── 「動かして」の字が 3 つに配られると
   * 大きさを変えようとした人が「動かしてなどいない」と読む。
   */
  it.each([
    ['RESIZE_PLACE', { type: 'RESIZE_PLACE', lid: 'n1', line: 0, w: 1, h: 2 } as const, '大きさ'],
    ['REMOVE_PLACE', { type: 'REMOVE_PLACE', lid: 'n1', line: 0 } as const, '消して'],
    ['ADD_PLACE', { type: 'ADD_PLACE', lid: 'n1', x: 1, y: 2 } as const, '置いて'],
  ])('🔴 編集中の %s は理由を出して書かない', (_name, action, word) => {
    const { d, events } = booted();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch(action);
    const error = d.getState().error ?? '';
    expect(error, '理由が出ていない').toContain('編集を終了');
    expect(error, '押した場所と文言が合っていない').toContain('板');
    expect(error, '操作の名前が文言に無い').toContain(word);
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('負・小数の値 / 板でない行 / 開いていない lid では 3 つとも書かない', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'RESIZE_PLACE', lid: 'n1', line: 0, w: -1, h: 2 });
    d.dispatch({ type: 'RESIZE_PLACE', lid: 'n1', line: 2, w: 1, h: 2 });
    d.dispatch({ type: 'REMOVE_PLACE', lid: 'n1', line: 2 });
    d.dispatch({ type: 'REMOVE_PLACE', lid: 'n2', line: 5 });
    d.dispatch({ type: 'ADD_PLACE', lid: 'n1', x: 1.5, y: 2 });
    d.dispatch({ type: 'ADD_PLACE', lid: 'n2', x: 1, y: 2 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });
});

describe('掴んで動かす(place-drag)', () => {
  function mounted() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    root.append(host);
    applyPlaceLayout(host, () => null, 0);
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '板')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
    events.length = 0;
    const off = installPlaceDrag(root, d);
    const grip = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
    const block = host.querySelector<HTMLElement>('#p1')!;
    return { root, host, d, events, off, grip, block };
  }

  const opts = { bubbles: true, pointerId: 1, button: 0 };

  function down(grip: HTMLElement, x = 0, y = 0, o: Record<string, unknown> = opts): void {
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: x, clientY: y }));
  }
  function move(x: number, y: number, o: Record<string, unknown> = opts): void {
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x, clientY: y }));
  }
  function up(x: number, y: number, o: Record<string, unknown> = opts): void {
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x, clientY: y }));
  }
  function drag(grip: HTMLElement, dx: number, dy: number): void {
    down(grip);
    move(dx, dy);
    up(dx, dy);
  }

  it('🔴 掴んで離すと、動いた先の位置で MOVE_PLACE → 書換の依頼が飛ぶ(行番号つき)', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(30, -10);
    // 掴んでいる間は見た目だけ動く
    expect(block.style.left).toBe('150px');
    expect(block.style.top).toBe('30px');
    up(30, -10);
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({ rewrite: { kind: 'place-move', line: 0, x: 150, y: 30 } });
    // ⚠ 見た目はいったん戻る ── 書けた位置は BODY_REWRITTEN の再描画が置き直す。
    //   戻さないと、断られた drop で画面と本文が食い違ったまま残る(レビュー所見 5)
    expect(block.style.left).toBe('120px');
    expect(block.style.top).toBe('40px');
    off();
  });

  it('slop 未満(押しただけ)では動かさず、書かない', () => {
    const { events, grip, block, off } = mounted();
    drag(grip, 2, 2);
    expect(block.style.left).toBe('120px');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    off();
  });

  it('🔑 動かして元の位置へ戻して離す(取りやめ)── 何も書かず、見た目も戻る', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(30, 30);
    move(0, 0);
    up(0, 0);
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    expect(block.style.left).toBe('120px');
    off();
  });

  it('左上より外へは出さない ── 掴んでいる間の見た目も、書く座標も 0 で止まる', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(-500, -500);
    // ⚠ 見た目の clamp(離す前)── event だけ見ると、この行を消しても緑になる
    expect(block.style.left).toBe('0px');
    expect(block.style.top).toBe('0px');
    up(-500, -500);
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev).toMatchObject({ rewrite: { kind: 'place-move', x: 0, y: 0 } });
    off();
  });

  it('🔴 動かした後の click は 1 回だけ飲む(離した指が札の押し物に落ちない)', () => {
    const { grip, block, off } = mounted();
    drag(grip, 30, 30);
    const click1 = new MouseEvent('click', { bubbles: true, cancelable: true });
    block.dispatchEvent(click1);
    expect(click1.defaultPrevented, 'drop 直後の click が素通りしている').toBe(true);
    const click2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    block.dispatchEvent(click2);
    expect(click2.defaultPrevented, '2 回目の click まで飲んでいる').toBe(false);
    off();
  });

  it('途中で切れたら(pointercancel)見た目を戻し、その後の move は効かない', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(30, 30);
    expect(block.style.left).toBe('150px');
    document.dispatchEvent(new PointerEvent('pointercancel', { ...opts }));
    expect(block.style.left).toBe('120px');
    move(60, 60);
    expect(block.style.left, '掴みが生きたままになっている').toBe('120px');
    up(60, 60);
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    off();
  });

  it('🔴 掴んでいる最中の 2 本目の指では掴み直さない(1 枚目を置き去りにしない)', () => {
    const { host, grip, block, off } = mounted();
    const grip2 = host.querySelector<HTMLElement>('#p2 [data-pkc-field="place-grip"]')!;
    const block2 = host.querySelector<HTMLElement>('#p2')!;
    down(grip);
    move(30, 30);
    const o2 = { ...opts, pointerId: 2 };
    down(grip2, 0, 0, o2);
    move(90, 90, o2);
    expect(block2.style.left, '2 本目の指が別の塊を掴んでいる').toBe('460px');
    // 1 本目の掴みは生きている
    move(50, 50);
    expect(block.style.left).toBe('170px');
    up(50, 50);
    off();
  });

  /**
   * 🔴 **右下の角で大きさを変える**(#676)。掴む / 取りやめ / 離す の作法は位置と同じ。
   */
  describe('角を掴んで大きさを変える(#676)', () => {
    function sizeHandle(host: HTMLElement, id: string): HTMLElement {
      const h = host.querySelector<HTMLElement>(`#${id} [data-pkc-field="place-size"]`);
      expect(h, `前提が崩れている: ${id} に大きさの持ち手が無い`).not.toBeNull();
      return h!;
    }

    it('持ち手が板ごとに 1 つ出る(2 回当てても増えない・字は入れない)', () => {
      const { host } = mounted();
      applyPlaceLayout(host, () => null, 0);
      const handles = host.querySelectorAll('[data-pkc-field="place-size"]');
      expect(handles).toHaveLength(2);
      expect(handles[0]!.textContent).toBe('');
      expect(handles[0]!.getAttribute('aria-label') ?? '', '何が起きるかを言っていない').toContain('大きさ');
    });

    it('🔴 掴んでいる間は見た目の大きさだけ動き、離すと RESIZE_PLACE → place-size が 1 回飛ぶ', () => {
      const { host, events, block, off } = mounted();
      const handle = sizeHandle(host, 'p1');
      down(handle);
      move(40, 30);
      expect(block.style.width).toBe('360px');
      expect(block.style.height).toBe('230px');
      // ⚠ 位置は動いていない(位置の掴みと配線を共有しているので、ここで見る)
      expect(block.style.left).toBe('120px');
      expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE'), '離す前に書いた').toHaveLength(0);
      up(40, 30);
      const asks = events.filter((e) => e.type === 'REQUEST_BODY_REWRITE');
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ rewrite: { kind: 'place-size', line: 0, w: 360, h: 230 } });
      // ⚠ 見た目はいったん戻る(書けた大きさは再描画が当て直す)
      expect(block.style.width).toBe('320px');
      expect(block.style.height).toBe('200px');
      off();
    });

    it('🔑 元の大きさへ戻して離す(取りやめ)── 何も書かず、見た目も戻る', () => {
      const { host, events, block, off } = mounted();
      const handle = sizeHandle(host, 'p1');
      down(handle);
      move(40, 30);
      move(0, 0);
      up(0, 0);
      expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
      expect(block.style.width).toBe('320px');
      off();
    });

    it('🔴 下限より小さくはできない ── 見た目も書く値も 120×40 で止まる(CSS の min と同じ)', () => {
      const { host, events, block, off } = mounted();
      const handle = sizeHandle(host, 'p1');
      down(handle);
      move(-1000, -1000);
      expect(block.style.width).toBe('120px');
      expect(block.style.height).toBe('40px');
      up(-1000, -1000);
      expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
        rewrite: { kind: 'place-size', w: 120, h: 40 },
      });
      off();
    });

    it('w= / h= を持たない塊は実寸を基点にし、戻すときは style を外す', () => {
      const { host, events, off } = mounted();
      const block2 = host.querySelector<HTMLElement>('#p2')!;
      expect(block2.style.width, '前提が崩れている: p2 に width が当たっている').toBe('');
      const handle = sizeHandle(host, 'p2');
      down(handle);
      move(200, 100);
      // happy-dom の offsetWidth は 0 なので、基点 0 + 200 = 200(下限 120 の上)、高さは 100
      expect(block2.style.width).toBe('200px');
      up(200, 100);
      expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
        rewrite: { kind: 'place-size', line: 5, w: 200, h: 100 },
      });
      expect(block2.style.width, '無かった width が残っている').toBe('');
      expect(block2.style.height).toBe('');
      off();
    });

    it('途中で切れたら(pointercancel)大きさを戻し、書かない', () => {
      const { host, events, block, off } = mounted();
      down(sizeHandle(host, 'p1'));
      move(40, 30);
      document.dispatchEvent(new PointerEvent('pointercancel', { ...opts }));
      expect(block.style.width).toBe('320px');
      up(40, 30);
      expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
      off();
    });
  });

  /**
   * 🔴 **矢印キーで動かす**(#676 段②)。守るのは 2 つ ── ①押している間は書かず、手が止まって
   * `NUDGE_SETTLE_MS` で **1 回だけ**書く(1 押し 1 書込だと再描画で焦点が落ちて 2 押し目が
   * 効かない)②再描画の後、同じ開き行の持ち手に焦点が戻る。
   */
  describe('矢印キーで動かす(#676 段②)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function key(el: HTMLElement, k: string, o: KeyboardEventInit = {}): KeyboardEvent {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o });
      el.dispatchEvent(e);
      return e;
    }

    it('🔴 3 押しで見た目は 3 回動き、止まって 300ms で MOVE_PLACE が 1 回だけ飛ぶ', () => {
      vi.useFakeTimers();
      const { events, grip, block, off } = mounted();
      grip.focus();
      const e1 = key(grip, 'ArrowRight');
      key(grip, 'ArrowRight');
      key(grip, 'ArrowDown');
      expect(e1.defaultPrevented, '画面が一緒に流れる(既定を止めていない)').toBe(true);
      expect(block.style.left).toBe('122px');
      expect(block.style.top).toBe('41px');
      expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE'), '手を止める前に書いた').toHaveLength(0);
      vi.advanceTimersByTime(NUDGE_SETTLE_MS - 1);
      expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE'), '止まる前に書いた').toHaveLength(0);
      vi.advanceTimersByTime(1);
      const asks = events.filter((e) => e.type === 'REQUEST_BODY_REWRITE');
      expect(asks, '1 回だけでない').toHaveLength(1);
      expect(asks[0]).toMatchObject({ rewrite: { kind: 'place-move', line: 0, x: 122, y: 41 } });
      // ⚠ 見た目はいったん戻る(掴みと同じ)。焦点を返す印が器に置かれている
      expect(block.style.left).toBe('120px');
      expect(block.parentElement!.getAttribute(PLACE_FOCUS_ATTR)).toBe('0');
      off();
    });

    it('Shift で 10px、左上より外へは出ない', () => {
      vi.useFakeTimers();
      const { events, grip, block, off } = mounted();
      key(grip, 'ArrowLeft', { shiftKey: true });
      expect(block.style.left).toBe('110px');
      for (let i = 0; i < 20; i += 1) key(grip, 'ArrowUp', { shiftKey: true });
      expect(block.style.top).toBe('0px');
      vi.advanceTimersByTime(NUDGE_SETTLE_MS);
      expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
        rewrite: { kind: 'place-move', x: 110, y: 0 },
      });
      off();
    });

    it('🔑 Esc で取りやめ ── 見た目が戻り、時間が経っても書かない', () => {
      vi.useFakeTimers();
      const { events, grip, block, off } = mounted();
      key(grip, 'ArrowRight');
      key(grip, 'ArrowRight');
      key(grip, 'Escape');
      expect(block.style.left).toBe('120px');
      vi.advanceTimersByTime(NUDGE_SETTLE_MS * 2);
      expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
      off();
    });

    it('持ち手の外(塊の本文・角の持ち手)で押した矢印は何もしない / Ctrl つきも無視', () => {
      vi.useFakeTimers();
      const { host, events, grip, block, off } = mounted();
      const e = key(block, 'ArrowRight');
      expect(e.defaultPrevented).toBe(false);
      key(host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-size"]')!, 'ArrowRight');
      key(grip, 'ArrowRight', { ctrlKey: true });
      expect(block.style.left).toBe('120px');
      vi.advanceTimersByTime(NUDGE_SETTLE_MS);
      expect(events.filter((e2) => e2.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
      off();
    });

    it('🔴 再描画(塊が差し替わる)の後、同じ開き行の持ち手に焦点が戻り、印は外れる', () => {
      vi.useFakeTimers();
      const { host, grip, off } = mounted();
      grip.focus();
      key(grip, 'ArrowRight');
      vi.advanceTimersByTime(NUDGE_SETTLE_MS);
      expect(host.getAttribute(PLACE_FOCUS_ATTR), '前提が崩れている: 印が無い').toBe('0');
      // 再描画を模す ── 塊が x=121 で描き直され、掴む口も作り直される
      host.innerHTML = RENDERED.replace('data-pkc-x="120"', 'data-pkc-x="121"');
      expect(host.contains(grip), '前提が崩れている: 古い口が残っている').toBe(false);
      applyPlaceLayout(host, () => null, 0);
      const fresh = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
      expect(document.activeElement, '焦点が同じ付箋の持ち手に戻っていない').toBe(fresh);
      expect(host.hasAttribute(PLACE_FOCUS_ATTR), '印が残っている(次の無関係な再描画で焦点が跳ぶ)').toBe(false);
      // 対照群: 印が無ければ、再描画は焦点を動かさない
      fresh.blur();
      host.innerHTML = RENDERED;
      applyPlaceLayout(host, () => null, 0);
      expect(document.activeElement).not.toBe(host.querySelector('#p1 [data-pkc-field="place-grip"]'));
      off();
    });
  });
});

/**
 * 🔴 **位置の CSS は読む面(board-host)だけに当てる**(レビュー所見 3・6、2026-08-28)。
 *
 * `.pkc-md-rendered` 起点の規則は**編集の 2 面と書き出した閲覧用 HTML にも**当たる。
 * 位置を当てる `place-board.ts` はそこに居ないので、絶対配置をそちらへ書くと
 * **付箋が左上に積み重なった壊れた面**になる(書き出した 1 枚は配った相手に届く)。
 * ⚠ happy-dom は描画しないので、規則は**構文で**読む(`css-blocks` の作法)。
 */
describe('板の CSS ── 位置は board-host 起点だけ', () => {
  const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

  it('🔴 絶対配置(+ 読み幅の上限外し)は .pkc-board-host 起点', () => {
    const pos = blocksFor(APP, '.pkc-board-host .pkc-format-block.pkc-place').join(';');
    expect(pos, '位置の規則が無い(選択子を変えたならこの test も追随する)').toContain(
      'position: absolute',
    );
    expect(pos, '板の上では読み幅の上限(--read-w)を外す ── w= を 672px で黙って切らない').toContain(
      'max-width: none',
    );
  });

  it('🔴 見た目の規則(.pkc-md-rendered 起点)に位置を混ぜない', () => {
    const look = blocksFor(APP, '.pkc-md-rendered .pkc-format-block.pkc-place').join(';');
    expect(look, '見た目の規則が無い(選択子を変えたならこの test も追随する)').toContain('border');
    expect(look, '編集面・書き出しで付箋が積み重なる(position が漏れている)').not.toContain(
      'position',
    );
  });
});
