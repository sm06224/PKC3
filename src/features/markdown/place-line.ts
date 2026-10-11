/**
 * 🔴 **板どうしを繋ぐ線の計算**(#530 段③a〜③b。user 裁定 2026-09-14 / 2026-09-15)。
 *
 * ## 🔑 線は「置いた物」ではない
 *
 * ⚠ 線は**座標を持たない** ── `from=` / `to=` で 2 枚の板を指すだけで、
 *   引く場所は**毎回その 2 枚の位置から計算する**。
 * 🔑 だから**板を動かせば線も付いてくる**。座標を書く形にすると、
 *   板を動かした日に線だけ置き去りになる(そして本文には気づく手がかりが無い)。
 *
 * ## 🔴 接続点は「辺 + 辺のどこか」である(user 裁定 2026-09-15)
 *
 * **求められていたのは「付ける場所を user が決められること」と、その細かさに
 * 上限が無いこと**である。⚠ **直しているのはこの画面である**:段③a は接続点を
 * 辺の真ん中 4 つしか持たなかったので、**同じ 2 枚の間に 2 本目を引くと
 * 1 本目と座標が完全に一致し、画面には 1 本しか出ていないように見えた** ──
 * 「A と B は別々の理由でつながっている」が図で言えず、しかも user 側に
 * 避ける手段が 1 つも無かった(点を指す口が無い)。
 *
 * 🔑 だから接続点は `辺` ではなく **`辺 + 分数`** を持つ:
 *
 * ```
 *          top@1/4   top   top@3/4
 *              │      │      │
 *   left@1/4 ──┼──────┼──────┼── right@1/4
 *              │      │      │
 *       left ──┼─────[板]────┼── right
 * ```
 *
 * ⚠ **分数で持つ**(`0.25` のような小数ではない)── 小数にすると
 *   `1/3` が往復で `0.333…` になり、**書いた字と焼いた字が食い違う**。
 * ⚠ **角(0 と 1)は持たない** ── 角は 2 通りに綴れてしまう
 *   (`top@1` と `right@0` が同じ点)ので、綴りが 1 つに決まらない。
 *
 * ## ⚠ ここは計算だけを持つ(features 層)
 *
 * 実際の大きさ(`offsetWidth`)は描画器が測る ── happy-dom は **0 を返す**ので、
 * 判断をあちらへ書くと **unit から永久に見えない**(CLAUDE.md §2)。
 */

import { PLACE_LINE_WIDTH_DEFAULT, type PlaceArrow } from './place-color';
import { rotatePointAround } from './place-rotate';

/**
 * 板 1 枚の場所と大きさ(器の左上が原点、px)。
 *
 * 🔴 `rot` は回転(度、右回り。#530 段⑤d)── **`x` `y` `w` `h` は回す前の四角のまま**で、`rot` を持つ四角は
 *   「中心の周りに `rot` 度回した四角」を表す。無い / 0 = 回していない(今までと 1 バイトも変わらない)。
 */
export interface PlaceRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rot?: number;
}

/**
 * 線が止まる**辺**。⚠ **中心は持たない** ── 中心へ刺すと線が板の上を横切る
 * (設計 doc §8.1 が名指しで挙げた、アンカーが無いときの実害そのもの)。
 */
export type PlaceEdge = 'top' | 'right' | 'bottom' | 'left';

/** ⚠ **並び順が tie-break である**(同じ距離なら先に在るほうを採る)。 */
export const PLACE_EDGES: readonly PlaceEdge[] = ['top', 'right', 'bottom', 'left'];

/** 分母の上限。⚠ これより細かい点は**画面で押し分けられない**ので受けない。 */
export const ANCHOR_DEN_MAX = 64;

/**
 * 接続点 1 つ ── **辺のどこか**。`num / den` は **0 と 1 の間**(既約)。
 *
 * ⚠ 辺を進む向きは **上下の辺 = 左から右 / 左右の辺 = 上から下**
 *   (字を読む向き)。ここを揃えないと `top@1/4` と `bottom@1/4` が
 *   **反対側**を指し、斜めの線だけ理由の分からないねじれ方をする。
 */
export interface PlaceAnchor {
  readonly edge: PlaceEdge;
  readonly num: number;
  readonly den: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * 接続点を作る(既約にして返す)。既定は**辺の真ん中**。
 *
 * ⚠ **受けられない値は真ん中へ倒す** ── ここは内部の組み立て口なので、
 *   落とすのではなく**必ず 1 点を返す**(描画が途中で止まらない)。
 * 🔑 user が書いた字の検査は `parseAnchorSpell` の側でやる ── そちらは
 *   `null` を返すので、描画器が**理由を画面に出せる**。
 */
export function anchorOf(edge: PlaceEdge, num = 1, den = 2): PlaceAnchor {
  const n = Math.round(num);
  const d = Math.round(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d < 2 || n < 1 || n >= d) {
    return { edge, num: 1, den: 2 };
  }
  const g = gcd(n, d);
  return { edge, num: n / g, den: d / g };
}

/** 辺のどこか(0〜1)。⚠ 割り算はここ 1 か所 ── 呼ぶ側で `num/den` と書かない。 */
export function anchorRatio(a: PlaceAnchor): number {
  return a.num / a.den;
}

/**
 * その接続点の座標。
 *
 * 🔴 回した付箋(`r.rot`)は、**回す前の辺の点を中心の周りに回した座標**を返す(#530 段⑤d、設計 §5 A)──
 *   辺は「付箋の中の向き」なので、`right@1/4` は回した付箋の右辺を指し、90° 回すと画面の下側から出る。
 *   画面・ER 図・PowerPoint の書き出しが**この 1 本**を引く(§7)。
 */
export function anchorPoint(r: PlaceRect, a: PlaceAnchor): { x: number; y: number } {
  const p = unrotatedAnchorPoint(r, a);
  if (r.rot === undefined || r.rot === 0) return p;
  return rotatePointAround(p.x, p.y, r.x + r.w / 2, r.y + r.h / 2, r.rot);
}

function unrotatedAnchorPoint(r: PlaceRect, a: PlaceAnchor): { x: number; y: number } {
  const t = anchorRatio(a);
  if (a.edge === 'top') return { x: r.x + r.w * t, y: r.y };
  if (a.edge === 'bottom') return { x: r.x + r.w * t, y: r.y + r.h };
  if (a.edge === 'left') return { x: r.x, y: r.y + r.h * t };
  return { x: r.x + r.w, y: r.y + r.h * t };
}

/**
 * 🔑 **綴りは 1 か所で作る**(`right` / `right@1/4`)。
 *
 * ⚠ 真ん中は**辺の名前だけ**で綴る ── `right@1/2` と `right` が別物に見えると、
 *   本文と焼いた印を突き合わせる人が**2 通りの字を覚える**羽目になる。
 * ⚠ 画面に焼く `data-pkc-line-from` も**この字**である ── 記法と焼き印で
 *   別の綴りを使うと、検査が「どちらの字か」を毎回選ぶことになる(CLAUDE.md §7)。
 */
export function anchorSpell(a: PlaceAnchor): string {
  return a.num * 2 === a.den ? a.edge : `${a.edge}@${a.num}/${a.den}`;
}

const SPELL_RE = /^(top|right|bottom|left)(?:@(\d{1,3})\/(\d{1,3}))?$/;

/** 綴りを読む。⚠ **受けられない字は `null`**(黙って真ん中へ倒さない)。 */
export function parseAnchorSpell(raw: string): PlaceAnchor | null {
  const m = SPELL_RE.exec(raw.trim());
  if (m === null) return null;
  const edge = m[1] as PlaceEdge;
  if (m[2] === undefined) return anchorOf(edge);
  const n = Number(m[2]);
  const d = Number(m[3]);
  /**
   * ⚠ **`d < 2` は書かない** ── 死に節だからである(変異試験 M7 が SURVIVED で教えた)。
   * 🔑 `n >= 1` かつ `n < d` なら **必ず `d >= 2`** なので、分母 0 / 1 は
   *   下の 2 つが先に捕まえる(`right@1/0` は `n >= d`、`right@1/1` も `n >= d`)。
   * ⚠ 実測:正規表現が通す **`n, d` の 10^6 通り**を当てて、
   *   「`d < 2` だけが断る入力」は **0 件**だった。
   *   「これが無いと壊れる」と書く前に、外して壊れるのを見る(CLAUDE.md §1)。
   */
  if (d > ANCHOR_DEN_MAX || n < 1 || n >= d) return null;
  return anchorOf(edge, n, d);
}

/** 引く線 1 本。 */
export interface PlaceLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly from: PlaceAnchor;
  readonly to: PlaceAnchor;
}

/**
 * 同じ 2 枚の間に何本あるか。`index` は 0 始まり、`count` はその総数。
 *
 * 🔑 **n 本なら `k/(n+1)`** に置く(1 本なら真ん中 = これまでと 1px も変わらない)。
 * ⚠ **散らさないと 2 本目以降が「1 本目の真下」に完全に重なって消える** ──
 *   引いた本人には「線は 1 本しか引けない」としか見えない。これが直している
 *   実害である(user 裁定 2026-09-15)。
 */
export interface PlaceSpread {
  readonly index: number;
  readonly count: number;
}

/** 手で書いた接続点(片側だけでもよい)と、散らし方。 */
export interface PlacePin {
  readonly from?: PlaceAnchor | null;
  readonly to?: PlaceAnchor | null;
  readonly spread?: PlaceSpread | null;
}

/**
 * 🔴 **いちばん近い辺どうしを結び、同じ 2 枚の線は辺の上で散らす**(段③b)。
 *
 * 🔑 手順は **2 段**である:
 * 1. **辺を決める**(16 通りを総当たり)── ⚠ このとき使うのは
 *    **辺の真ん中**であって、散らした後の点ではない。
 *    🔑 そうしないと、同じ 2 枚の間の線が**本ごとに違う辺**から出て、
 *    平行に並ばない(1 本目だけ横から、2 本目は下から、という見え方になる)。
 * 2. **辺の上を滑らせる**(`k/(n+1)`)── 手で書いた側は滑らせない。
 *
 * ⚠ **同じ距離のときは `PLACE_EDGES` の並び順で決める**(`<` で比べる)──
 *   決めないと、描くたびに違う辺から出る形になりうる。
 */
export function placeLineOf(from: PlaceRect, to: PlaceRect, pin: PlacePin = {}): PlaceLine {
  const fromEdges = pin.from ? [pin.from.edge] : PLACE_EDGES;
  const toEdges = pin.to ? [pin.to.edge] : PLACE_EDGES;
  let bestA: PlaceEdge = fromEdges[0]!;
  let bestB: PlaceEdge = toEdges[0]!;
  let bestD = Infinity;
  for (const ea of fromEdges) {
    const p = anchorPoint(from, pin.from ?? anchorOf(ea));
    for (const eb of toEdges) {
      const q = anchorPoint(to, pin.to ?? anchorOf(eb));
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < bestD) {
        bestD = d;
        bestA = ea;
        bestB = eb;
      }
    }
  }
  const s = pin.spread ?? null;
  const num = s !== null && s.count >= 1 ? s.index + 1 : 1;
  const den = s !== null && s.count >= 1 ? s.count + 1 : 2;
  const a = pin.from ?? anchorOf(bestA, num, den);
  const b = pin.to ?? anchorOf(bestB, num, den);
  const p = anchorPoint(from, a);
  const q = anchorPoint(to, b);
  return { x1: p.x, y1: p.y, x2: q.x, y2: q.y, from: a, to: b };
}

/**
 * 🔴 **線の通り方**(#530 段③c。user 裁定 2026-09-15)。
 *
 * ⚠ **「どこで曲がるか」(`PlaceBend`)とは別の軸である** ── 形を選べても
 *   折れる位置を決められないと、線が何本もある図で**同じ幹を通せない**
 *   (= 線が増えるほどばらける)。だから 2 つの key に分けてある。
 */
export type PlaceRoute = 'straight' | 'elbow' | 'curve';

/** ⚠ 空振り防止 ── 一覧が空なら、綴りの検査は何も見ていない。 */
export const PLACE_ROUTES: readonly PlaceRoute[] = ['straight', 'elbow', 'curve'];

/**
 * 曲がる所。`axis: 'v'` は**縦線 x = `at`** の上で、`'h'` は**横線 y = `at`** の上で折れる。
 *
 * 🔑 **同じ `bend=` を書いた線は、同じ幹を通る** ── これが「図の動線を単純にする」
 *   の実体である(配線図のように揃う)。
 */
export interface PlaceBend {
  readonly axis: 'v' | 'h';
  readonly at: number;
}

/** ⚠ 接続点と同じく **3 つに分ける**(書いていない / 読めない / 読めた)。 */
export type RouteRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly route: PlaceRoute }
  | { readonly kind: 'bad'; readonly raw: string };

/** 同上。 */
export type BendRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly bend: PlaceBend }
  | { readonly kind: 'bad'; readonly raw: string };

/** `route=elbow` を読む。⚠ 読めない字は `bad`(黙って `straight` に倒さない)。 */
export function parseRouteSpell(raw: string | null): RouteRead {
  if (raw === null) return { kind: 'none' };
  const v = raw.trim();
  if (v === '') return { kind: 'none' };
  const hit = PLACE_ROUTES.find((r) => r === v);
  return hit === undefined ? { kind: 'bad', raw: v } : { kind: 'ok', route: hit };
}

const BEND_RE = /^([vh]):(\d{1,6})$/;

/** `bend=v:320` を読む。⚠ 読めない字は `bad`。 */
export function parseBendSpell(raw: string | null): BendRead {
  if (raw === null) return { kind: 'none' };
  const v = raw.trim();
  if (v === '') return { kind: 'none' };
  const m = BEND_RE.exec(v);
  if (m === null) return { kind: 'bad', raw: v };
  return { kind: 'ok', bend: { axis: m[1] as 'v' | 'h', at: Number(m[2]) } };
}

/**
 * 🔑 **書かなかったときの曲がり所** ── 出る辺の向きで軸を決め、2 点の**真ん中**で折る。
 *
 * ⚠ 軸を「出る辺」から採る ── 右の辺から出た線を**横線**で折ると、
 *   出た直後に板の中へ戻る形になる(辺から離れる向きに折らないと通れない)。
 */
function defaultBend(ln: PlaceLine): PlaceBend {
  return ln.from.edge === 'left' || ln.from.edge === 'right'
    ? { axis: 'v', at: (ln.x1 + ln.x2) / 2 }
    : { axis: 'h', at: (ln.y1 + ln.y2) / 2 };
}

/** ⚠ 端数を丸める ── 同じ線を描き直すたびに `d` の字が揺れると、検査が読めない。 */
const n2 = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * 🔴 **引く形そのもの(SVG の `d`)**(#530 段③c)。
 *
 * 🔑 **曲線は「控えめ」にする**(user 裁定 2026-09-15)── 制御点を
 *   **曲がる線の上に置く**ので、ふくらみが **2 点の間から外へ出ない**。
 *   ⚠ 外向きに突き出す描き方(接続点の向きへ大きく出てから回り込む)は採らない ──
 *   線が何本もあるとき、ふくらみ同士が重なってどれがどれか読めなくなる。
 * 🔑 だから `elbow` と `curve` は**同じ曲がり所を共有する** ── 角を丸めるかどうかの
 *   違いしかない(形を変えても幹は動かない)。
 */
export function placePathOf(
  ln: PlaceLine,
  route: PlaceRoute = 'straight',
  bend: PlaceBend | null = null,
): string {
  const head = `M ${n2(ln.x1)} ${n2(ln.y1)}`;
  if (route === 'straight') return `${head} L ${n2(ln.x2)} ${n2(ln.y2)}`;
  const b = bend ?? defaultBend(ln);
  if (b.axis === 'v') {
    const x = n2(b.at);
    return route === 'elbow'
      ? `${head} L ${x} ${n2(ln.y1)} L ${x} ${n2(ln.y2)} L ${n2(ln.x2)} ${n2(ln.y2)}`
      : `${head} C ${x} ${n2(ln.y1)} ${x} ${n2(ln.y2)} ${n2(ln.x2)} ${n2(ln.y2)}`;
  }
  const y = n2(b.at);
  return route === 'elbow'
    ? `${head} L ${n2(ln.x1)} ${y} L ${n2(ln.x2)} ${y} L ${n2(ln.x2)} ${n2(ln.y2)}`
    : `${head} C ${n2(ln.x1)} ${y} ${n2(ln.x2)} ${y} ${n2(ln.x2)} ${n2(ln.y2)}`;
}

/**
 * 🔑 **`from=a:right@1/4` の「どの板か」だけを取り出す**(段③a)。
 *
 * ⚠ 空の名前は `null`(id を持たない板は指せない)。
 */
export function placeLineTargetId(raw: string | null): string | null {
  if (raw === null) return null;
  const id = raw.split(':')[0]?.trim() ?? '';
  return id === '' ? null : id;
}

/**
 * `from=` / `to=` に書かれた接続点。⚠ **3 つに分ける**(2 値にしない)──
 * 「書いていない」と「書いたが読めない」を混ぜると、`righ` と打った人に
 * **何も言わずに真ん中へ繋ぐ**ことになり、綴りの誤りが永久に見つからない。
 */
export type AnchorRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly anchor: PlaceAnchor }
  | { readonly kind: 'bad'; readonly raw: string };

/** `a:right@1/4` の後ろ半分を読む。 */
export function placeLineAnchorOf(raw: string | null): AnchorRead {
  if (raw === null) return { kind: 'none' };
  const i = raw.indexOf(':');
  if (i < 0) return { kind: 'none' };
  const rest = raw.slice(i + 1).trim();
  if (rest === '') return { kind: 'none' };
  const a = parseAnchorSpell(rest);
  return a === null ? { kind: 'bad', raw: rest } : { kind: 'ok', anchor: a };
}

/**
 * 🔴 **矢じりの形**(#530。Gemini 裁定 2026-10-11 依頼 15)。
 *
 * ## 何をしているか
 *
 * 線の**端点**に、**塗りつぶした三角**を 1 つ置く。向きは**その端で線が進んでいる向き**
 * (まっすぐなら 2 点を結ぶ向き / 折れ線・曲線なら端点に着く最後の区間の向き)。
 *
 * ## 🔑 なぜ SVG の `<marker>` ではなく「自前の三角」か
 *
 * - `<marker>` の色は `context-stroke` が要る(古い描画器は黒く塗る)── 線の色を**変数**で
 *   渡している(`--pkc-line-stroke`)この版では、三角を普通の `<path>` として置き、**同じ変数**で塗るほうが
 *   確実に「線と同じ色」になる
 * - 大きさは**線の太さに比例**させる(太い線に小さな三角が付くと、矢じりが線に埋もれる)
 * - 描く形を `d` の字として持つので、**画面・印刷・別ウィンドウ**が同じ DOM から同じ形になる
 *
 * ⚠ 曲線(`curve`)の端の向きは**制御点から端点へ**(= 折れ線の最後の区間と同じ)。
 *   制御点が曲がる線の上に在る(`placePathOf`)ので、折れ線の向きで曲線の接線と一致する。
 * ⚠ 区間の長さが 0(`bend=` が端点に重なる)ときは**その前の区間**を見る ── 全部 0 なら矢じりは出さない。
 */
export interface PlaceArrowHeads {
  /** 始まり側(`from=`)の三角の `d`。両端のときだけ。 */
  readonly start: string | null;
  /** 終わり側(`to=`)の三角の `d`。`end` と `both` のとき。 */
  readonly end: string | null;
}

/** 矢じりの長さ(px)。⚠ 太さに比例 ── 標準(2px)で 12px、4px で 16px。 */
export function arrowHeadLength(width: number): number {
  return 8 + 2 * width;
}

/** 線が通る点の列(折れ線)── 矢じりの向きを決めるためだけに使う。 */
function polylineOf(ln: PlaceLine, route: PlaceRoute, bend: PlaceBend | null): Array<readonly [number, number]> {
  const a: readonly [number, number] = [ln.x1, ln.y1];
  const z: readonly [number, number] = [ln.x2, ln.y2];
  if (route === 'straight') return [a, z];
  const b = bend ?? defaultBend(ln);
  return b.axis === 'v'
    ? [a, [b.at, ln.y1], [b.at, ln.y2], z]
    : [a, [ln.x1, b.at], [ln.x2, b.at], z];
}

/** 三角の `d`。`tip` が先端、`dir` は外へ向かう単位ベクトル。 */
function headPath(tip: readonly [number, number], dir: readonly [number, number], len: number): string {
  const half = len * 0.4;
  const bx = tip[0] - dir[0] * len;
  const by = tip[1] - dir[1] * len;
  const nx = -dir[1];
  const ny = dir[0];
  return (
    `M ${n2(tip[0])} ${n2(tip[1])} `
    + `L ${n2(bx + nx * half)} ${n2(by + ny * half)} `
    + `L ${n2(bx - nx * half)} ${n2(by - ny * half)} Z`
  );
}

/** 点列の端から見て、最初の「長さのある」区間の向き(外向きの単位ベクトル)。 */
function outward(pts: ReadonlyArray<readonly [number, number]>, atEnd: boolean): readonly [number, number] | null {
  const n = pts.length;
  for (let k = 1; k < n; k += 1) {
    const tip = atEnd ? pts[n - k]! : pts[k - 1]!;
    const prev = atEnd ? pts[n - k - 1]! : pts[k]!;
    const dx = tip[0] - prev[0];
    const dy = tip[1] - prev[1];
    const d = Math.hypot(dx, dy);
    if (d > 0.001) return [dx / d, dy / d];
  }
  return null;
}

/**
 * @param width 線の太さ(px)。`null` = 標準。
 * @param arrow `none` は何も返さない(`start` も `end` も `null`)。
 */
export function placeArrowHeadsOf(
  ln: PlaceLine,
  route: PlaceRoute,
  bend: PlaceBend | null,
  arrow: PlaceArrow,
  width: number | null,
): PlaceArrowHeads {
  if (arrow === 'none') return { start: null, end: null };
  const len = arrowHeadLength(width ?? PLACE_LINE_WIDTH_DEFAULT);
  const pts = polylineOf(ln, route, bend);
  const e = outward(pts, true);
  const st = arrow === 'both' ? outward(pts, false) : null;
  return {
    start: st === null ? null : headPath(pts[0]!, st, len),
    end: e === null ? null : headPath(pts[pts.length - 1]!, e, len),
  };
}
