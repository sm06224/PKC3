/**
 * 🔴 **板どうしを繋ぐ線の計算**(#530 段③a / 段③b)。
 *
 * ⚠ ここで守るのは 4 つ:
 *   ① **いちばん近い辺から出て、いちばん近い辺へ入る**(板の上を横切らない)
 *   ② **同じ入力なら必ず同じ答え**(描くたびに違う辺から出ない)
 *   ③ 🆕 **同じ 2 枚の間の線は辺の上で散る**(user 裁定 2026-09-15)──
 *      散らさないと 2 本目が 1 本目の真下に重なり、**1 本しか引けないように見える**
 *   ④ 🆕 **手で書いた接続点は、こちらの都合で動かさない**
 */
import { describe, expect, it } from 'vitest';
import {
  anchorOf,
  anchorPoint,
  anchorRatio,
  anchorSpell,
  ANCHOR_DEN_MAX,
  parseAnchorSpell,
  PLACE_EDGES,
  placeLineAnchorOf,
  placeLineOf,
  placeLineTargetId,
  type PlaceRect,
} from '../../src/features/markdown/place-line';

const box = (x: number, y: number, w = 100, h = 60): PlaceRect => ({ x, y, w, h });
/** 🔑 綴りで比べる ── 記法・焼き印・この test が**同じ 1 つの字**を見る。 */
const ends = (l: { from: unknown; to: unknown }): [string, string] => [
  anchorSpell(l.from as never),
  anchorSpell(l.to as never),
];

describe('板どうしを繋ぐ線(#530 段③a)', () => {
  /**
   * 🔴 **横に並べたら「右 → 左」**。
   * ⚠ ここを外すと線が**板の上を横切る** ── 設計 doc §8.1 が
   *   「アンカーが無いときの実害」として名指しした形そのもの。
   */
  it('🔴 横に並ぶと 右 → 左 / 縦に並ぶと 下 → 上', () => {
    const right = placeLineOf(box(0, 0), box(300, 0));
    expect(ends(right), '横に並んだのに横の辺から出ていない').toEqual(['right', 'left']);
    // 🔑 座標も見る(辺の真ん中から出ている)
    expect([right.x1, right.y1], '出る所が右辺の真ん中でない').toEqual([100, 30]);
    expect([right.x2, right.y2], '入る所が左辺の真ん中でない').toEqual([300, 30]);

    expect(ends(placeLineOf(box(0, 0), box(0, 300))), '縦に並んだのに縦の辺から出ていない')
      .toEqual(['bottom', 'top']);

    // 🔑 逆向きも見る(左右・上下を取り違えていないこと)
    expect(anchorSpell(placeLineOf(box(300, 0), box(0, 0)).from)).toBe('left');
    expect(anchorSpell(placeLineOf(box(0, 300), box(0, 0)).from)).toBe('top');
  });

  /**
   * ⚠ **斜めに置いても、板を横切らない側から出る。**
   * 🔑 総当たり(4 × 4)が効いていることを、決め打ちでは出ない配置で見る。
   */
  it('⚠ 斜めでも、近いほうの辺どうしを結ぶ', () => {
    // 右下へ大きく離す ── 横の距離が縦より大きいので横の辺が近い
    expect(ends(placeLineOf(box(0, 0), box(400, 80)))).toEqual(['right', 'left']);
    // 下へ大きく離す ── 縦の距離が勝つ
    expect(ends(placeLineOf(box(0, 0), box(80, 400)))).toEqual(['bottom', 'top']);
  });

  /**
   * 🔴 **同じ入力なら必ず同じ答え**(描くたびに違う辺から出ない)。
   * ⚠ 重なった板は 16 通りのうち**同じ距離が何本も**出るので、
   *   tie-break が無いと答えがぶれる。
   */
  it('🔴 重なっていても答えがぶれない / 数が壊れない', () => {
    const same = box(10, 10);
    const first = placeLineOf(same, same);
    for (let i = 0; i < 5; i += 1) expect(placeLineOf(same, same)).toEqual(first);
    for (const v of [first.x1, first.y1, first.x2, first.y2]) {
      expect(Number.isFinite(v), '座標が数でない(NaN / Infinity)').toBe(true);
    }
    // ⚠ 大きさ 0 の板でも壊れない(w= に 0 と書ける)
    const zero = placeLineOf(box(0, 0, 0, 0), box(50, 50, 0, 0));
    for (const v of [zero.x1, zero.y1, zero.x2, zero.y2]) {
      expect(Number.isFinite(v), '大きさ 0 の板で座標が壊れた').toBe(true);
    }
  });

  /** 接続点の座標そのもの(既定は 4 つとも辺の真ん中)。 */
  it('⚠ 既定の接続点は 4 つとも辺の真ん中に在る', () => {
    const r = box(10, 20, 100, 60);
    expect(anchorPoint(r, anchorOf('top'))).toEqual({ x: 60, y: 20 });
    expect(anchorPoint(r, anchorOf('bottom'))).toEqual({ x: 60, y: 80 });
    expect(anchorPoint(r, anchorOf('left'))).toEqual({ x: 10, y: 50 });
    expect(anchorPoint(r, anchorOf('right'))).toEqual({ x: 110, y: 50 });
    // 🔑 空振り防止 ── 一覧が空なら上の総当たりは 1 度も回らない
    expect(PLACE_EDGES.length, '辺の一覧が空').toBe(4);
  });

  /**
   * 🔑 **`a:right` の綴りを受ける。**
   * ⚠ 受けないと「設計どおり書いたのに線が 1 本も出ない」になり、
   *   書いた人は**綴りを間違えたと読む**(いちばん気づけない外し方)。
   */
  it('🔑 from=a:right の「どの板か」だけを取り出す / 空は捨てる', () => {
    expect(placeLineTargetId('a')).toBe('a');
    expect(placeLineTargetId('a:right'), '接続点付きの綴りを捨てている').toBe('a');
    expect(placeLineTargetId('a:right@1/4'), '分数付きの綴りを捨てている').toBe('a');
    expect(placeLineTargetId(' a : left ')).toBe('a');
    expect(placeLineTargetId(''), '空の名前を板として扱っている').toBeNull();
    expect(placeLineTargetId(':right'), '名前の無い綴りを受けている').toBeNull();
    expect(placeLineTargetId(null)).toBeNull();
  });
});

/**
 * 🔴 **辺のどこにでも付けられる**(user 裁定 2026-09-15)。
 *
 * **求められていたのは「付ける場所を user が決められること」と、その細かさに
 * 上限が無いこと**である ── 辺の真ん中 4 つしか無い形では、2 本目の線を
 * ずらすことも束ねることもできない(避ける手段が user 側に 1 つも無い)。
 */
describe('🔴 接続点は「辺 + 分数」(#530 段③b)', () => {
  it('🔴 中点 → その中点 → さらにその中点、と細かくできる', () => {
    const r = box(0, 0, 100, 60);
    // 上の辺を左から右へ。⚠ 1/2 → 1/4 → 1/8 が**別々の点**に出る
    expect(anchorPoint(r, anchorOf('top', 1, 2))).toEqual({ x: 50, y: 0 });
    expect(anchorPoint(r, anchorOf('top', 1, 4))).toEqual({ x: 25, y: 0 });
    expect(anchorPoint(r, anchorOf('top', 1, 8))).toEqual({ x: 12.5, y: 0 });
    expect(anchorPoint(r, anchorOf('top', 7, 8))).toEqual({ x: 87.5, y: 0 });
    // 🔑 左右の辺は**上から下**(上下の辺と向きを揃える ── 字を読む向き)
    expect(anchorPoint(r, anchorOf('left', 1, 4))).toEqual({ x: 0, y: 15 });
    expect(anchorPoint(r, anchorOf('right', 3, 4))).toEqual({ x: 100, y: 45 });
    // ⚠ 上下の辺どうしで向きが逆になっていない(ねじれの検算)
    expect(anchorPoint(r, anchorOf('bottom', 1, 4))).toEqual({ x: 25, y: 60 });
  });

  it('🔑 分数は既約にして持つ(2/4 と 1/2 が別物にならない)', () => {
    expect(anchorOf('top', 2, 4)).toEqual(anchorOf('top', 1, 2));
    expect(anchorSpell(anchorOf('top', 2, 4)), '真ん中なのに分数を焼いている').toBe('top');
    expect(anchorSpell(anchorOf('right', 3, 12))).toBe('right@1/4');
    expect(anchorRatio(anchorOf('right', 3, 4))).toBe(0.75);
  });

  it('🔴 綴りは往復する(書いた字と焼いた字が同じ)', () => {
    for (const s of ['top', 'right', 'bottom', 'left', 'right@1/4', 'top@7/8', 'left@5/16']) {
      const a = parseAnchorSpell(s);
      expect(a, `読めない綴り: ${s}`).not.toBeNull();
      expect(anchorSpell(a!), `往復しない綴り: ${s}`).toBe(s);
    }
    // 🔑 既約でない綴りは、既約にして返る(受けるが、焼く字は 1 つ)
    expect(anchorSpell(parseAnchorSpell('right@2/4')!)).toBe('right');
  });

  /**
   * 🔴 **読めない字は `null`**(黙って真ん中へ倒さない)。
   * ⚠ 倒すと**線は出る**ので、打ち間違いに気づく手がかりが 1 つも残らない。
   */
  it('🔴 受けない綴り ── 角・分母 0・逆さ・大きすぎる分母・辺でない字', () => {
    for (const s of [
      'righ', 'center', 'RIGHT', '', 'right@', 'right@1', 'right@0/4', 'right@4/4',
      'right@5/4', 'right@1/0', 'right@1/1', `right@1/${ANCHOR_DEN_MAX + 1}`, 'right@0.25',
      'right@1/-4', 'right@-1/4',
    ]) {
      expect(parseAnchorSpell(s), `受けてはいけない綴りを受けた: ${JSON.stringify(s)}`).toBeNull();
    }
    // ⚠ 空振り防止 ── 全部 null を返す実装でも上は通る
    expect(parseAnchorSpell(`right@1/${ANCHOR_DEN_MAX}`), '分母の上限ぴったりを断っている')
      .not.toBeNull();
  });

  /**
   * 🔴 **「書いていない」と「書いたが読めない」を分ける**(2 値にしない)。
   * ⚠ 混ぜると `righ` と打った人に**何も言わずに**真ん中へ繋ぐことになる。
   */
  it('🔴 接続点の読みは 3 つに分かれる', () => {
    expect(placeLineAnchorOf('a')).toEqual({ kind: 'none' });
    expect(placeLineAnchorOf(null)).toEqual({ kind: 'none' });
    expect(placeLineAnchorOf('a: ')).toEqual({ kind: 'none' });
    expect(placeLineAnchorOf('a:right')).toEqual({ kind: 'ok', anchor: anchorOf('right') });
    expect(placeLineAnchorOf('a:right@1/4'))
      .toEqual({ kind: 'ok', anchor: anchorOf('right', 1, 4) });
    expect(placeLineAnchorOf('a:righ'), '読めない字を「書いていない」と読んでいる')
      .toEqual({ kind: 'bad', raw: 'righ' });
  });
});

/**
 * 🔴 **同じ 2 枚の間の線は、辺の上で散らす**(user 裁定 2026-09-15)。
 *
 * 🔴 **直している実害はこれ**:段③a は接続点が辺の真ん中 4 つだけだったので、
 * **同じ 2 枚の間に 2 本目を引くと 1 本目と座標が完全に一致し、画面には
 * 1 本しか出ていないように見えた** ── 「A と B は別々の理由でつながっている」を
 * 図で言えない。
 */
describe('🔴 同じ 2 枚の間の線が重ならない(#530 段③b)', () => {
  it('🔴 1 本なら真ん中のまま(これまでと 1px も変わらない)', () => {
    const plain = placeLineOf(box(0, 0), box(300, 0));
    const one = placeLineOf(box(0, 0), box(300, 0), { spread: { index: 0, count: 1 } });
    expect(one, '1 本のときに位置が動いた').toEqual(plain);
  });

  it('🔴 2 本なら 1/3 と 2/3 / 3 本なら 1/4・真ん中・3/4', () => {
    const at = (index: number, count: number): [string, string] =>
      ends(placeLineOf(box(0, 0), box(300, 0), { spread: { index, count } }));
    expect(at(0, 2)).toEqual(['right@1/3', 'left@1/3']);
    expect(at(1, 2)).toEqual(['right@2/3', 'left@2/3']);
    expect(at(0, 3)).toEqual(['right@1/4', 'left@1/4']);
    expect(at(1, 3), '真ん中は分数を焼かない').toEqual(['right', 'left']);
    expect(at(2, 3)).toEqual(['right@3/4', 'left@3/4']);
  });

  it('🔴 散らしても「同じ辺」から出る(平行に並ぶ)', () => {
    // ⚠ 辺を散らした後の点で選ぶと、本ごとに違う辺から出て平行にならない
    const edges = [0, 1, 2, 3, 4].map(
      (i) => ends(placeLineOf(box(0, 0), box(300, 0), { spread: { index: i, count: 5 } }))
        .map((s) => s.split('@')[0]).join('→'),
    );
    expect(new Set(edges), '本ごとに辺が変わっている(平行に並ばない)')
      .toEqual(new Set(['right→left']));
    // 🔑 それでも y は 5 本とも別 ── 空振り防止(全部同じ点なら散っていない)
    const ys = [0, 1, 2, 3, 4].map(
      (i) => placeLineOf(box(0, 0), box(300, 0), { spread: { index: i, count: 5 } }).y1,
    );
    expect(new Set(ys).size, '散らしたはずが同じ所に重なっている').toBe(5);
  });
});

/** 🔴 **手で書いた接続点は動かさない**(user が決めた所に付く)。 */
describe('🔴 手で書いた接続点が勝つ(#530 段③b)', () => {
  it('🔴 書いた側は、散らしても動かない', () => {
    const pinned = anchorOf('top', 1, 4);
    const l = placeLineOf(box(0, 0), box(300, 0), {
      from: pinned,
      spread: { index: 1, count: 3 },
    });
    expect(anchorSpell(l.from), '手で書いた接続点を散らしで上書きした').toBe('top@1/4');
    expect([l.x1, l.y1], '書いた接続点と座標が合っていない').toEqual([25, 0]);
    // ⚠ 対照群 ── 書かなかった側は散っている(両側が固まっていないこと)
    expect(anchorSpell(l.to)).toBe('left');
  });

  /**
   * 🔴 **相手の辺は「留めた点」から選ぶ ── 留めた辺の真ん中からではない。**
   * ⚠ 真ん中から選ぶと、辺の端に留めた線が**わざわざ遠いほうへ**入る。
   * 🔑 だから対照群は「同じ辺の真ん中に留めた場合」にする ── 答えが分かれる。
   */
  it('🔑 片方を書くと、もう片方は「その点から」いちばん近い辺を選ぶ', () => {
    const wide = box(0, 0, 400, 40);
    const small = box(0, 200, 40, 40);
    // 下辺の右端(7/8 = x 350)に留める ── そこからは相手の右辺がいちばん近い
    const far = placeLineOf(wide, small, { from: anchorOf('bottom', 7, 8) });
    expect(anchorSpell(far.from)).toBe('bottom@7/8');
    expect(anchorSpell(far.to), '留めた点ではなく辺の真ん中から選んでいる').toBe('right');
    // ⚠ 対照群 ── 同じ辺でも**真ん中**に留めると、相手は上辺になる
    const mid = placeLineOf(wide, small, { from: anchorOf('bottom') });
    expect(anchorSpell(mid.to), '留める場所で相手が変わっていない').toBe('top');
  });

  it('🔑 両方書いたら、総当たりは 1 通りしか回らない', () => {
    const l = placeLineOf(box(0, 0), box(300, 0), {
      from: anchorOf('left', 1, 4),
      to: anchorOf('bottom', 3, 4),
    });
    expect(ends(l)).toEqual(['left@1/4', 'bottom@3/4']);
    expect([l.x1, l.y1]).toEqual([0, 15]);
    expect([l.x2, l.y2]).toEqual([375, 60]);
  });
});
