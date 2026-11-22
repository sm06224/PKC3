/**
 * 🔴 **左端の縦のバーの近接発光**(#1982 ③-a-2。user 裁定 2026-11-22 = G1「色の無い淡い光:`--fg` 10% 前後」)。
 *
 * ## 見え方
 *
 * マウスがバーに入ると、ポインタの位置を中心に半径 72px ほどの淡い明るさ(`--fg` の 10%)がバーの地に広がり、
 * ポインタについて動く。近いアイコンほど明るい地に載る。色相は持たない(「色は意味にだけ」── アクセントは使わない)。
 * 描くのは**光の要素 1 つ**(`[data-pkc-field='rail-glow']`。`radial-gradient` を持つ 144px の円)で、
 * ここは**その要素の `transform` だけ**を書く(合成だけで動く ── 塗り直しも、バーの中のボタンの style の再計算も起こさない)。
 * ⚠ 1 稿目はバーに CSS 変数(位置)を書いていた ── 変数はバーの子孫全部へ継承されるので、600 回動かすと
 *   style の再計算が約 1.2 秒増えた(実測。対照群 35ms)。要素 1 つの `transform` に替えて解いた。
 *
 * ## 🔴 定常のコスト(北極星「効くのは定常」)
 *
 * - **リスナーを付けない環境**(user 指示 2026-11-22):マウスの無い端末(`hover: none`)・指の端末(`pointer: coarse`)・
 *   動きを減らす設定(`prefers-reduced-motion: reduce`)・スマホ用画面。判定は `GLOW_QUERY` 1 本 + 版面。
 *   ⚠ `matchMedia` が無い / 投げる器では**付けない側**へ倒す(光らなくても害は無い)。
 * - `pointermove` は**バーに入っている間だけ**付ける(`pointerenter` で付け、`pointerleave` で外す)。
 *   外にポインタがあるときの仕事は 0。
 * - 書き込みは **1 コマに 1 回**(`requestAnimationFrame` で間引く)。バーの位置は入った時に 1 度だけ測る(毎回測らない)。
 * - `filter` / 重ねた `box-shadow` は使わない。光の要素は**初めて入ったときに 1 度だけ**作る(付けない環境では DOM も変えない)。
 *
 * 呼び手は `rail.ts` の `paintRail` の 1 か所(版面が入れ替わるたびに必ずそこを通る)。
 */

/** 光らせてよい環境。⚠ 3 条件を 1 本の問いにまとめる(どれか 1 つでも外れたら付けない)。 */
export const GLOW_QUERY = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
/** 光っている間だけ付く印(CSS が読む)。 */
export const GLOW_ATTR = 'data-pkc-glow';
/** 光の要素の `data-pkc-field`。 */
export const GLOW_FIELD = 'rail-glow';
/** 光の円の半径(px)。⚠ `app.css` の光の要素の幅・高さ(144px)の半分と揃える。 */
export const GLOW_RADIUS = 72;

type MediaLike = {
  readonly matches: boolean;
  addEventListener?: (type: 'change', fn: () => void) => void;
  removeEventListener?: (type: 'change', fn: () => void) => void;
};
type MatchMedia = (q: string) => MediaLike | undefined;

interface Glow {
  /** いまリスナーを付けているか。 */
  on: boolean;
  /** 版面がスマホ用画面か(`paintRail` が最後に伝えた値)。 */
  phone: boolean;
  media: MediaLike | null;
  onMedia: () => void;
  onEnter: (e: PointerEvent) => void;
  onMove: (e: PointerEvent) => void;
  onLeave: () => void;
}

const glows = new WeakMap<HTMLElement, Glow>();

function defaultMatchMedia(): MatchMedia | null {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaLike }).matchMedia;
  return typeof mm === 'function' ? (q) => mm(q) : null;
}

function allowed(g: Glow): boolean {
  if (g.phone) return false;
  try {
    return g.media?.matches === true;
  } catch {
    return false;
  }
}

/**
 * バーの近接発光を、いまの版面と環境に合わせて付け外しする。**何度呼んでも同じ結果**。
 *
 * @param phone スマホ用画面か(付けない)
 * @param mm 差し替え口(unit)。既定は window の `matchMedia`
 */
export function syncRailGlow(rail: HTMLElement, phone: boolean, mm: MatchMedia | null = defaultMatchMedia()): void {
  let g = glows.get(rail);
  if (g === undefined) {
    let rect: DOMRect | null = null;
    let x = 0;
    let y = 0;
    let frame = 0;
    const view = rail.ownerDocument.defaultView;
    const raf = (fn: () => void): number =>
      view?.requestAnimationFrame ? view.requestAnimationFrame(fn) : (fn(), 0);
    let layer: HTMLElement | null = null;
    const paint = (): void => {
      frame = 0;
      if (rect === null || layer === null) return;
      layer.style.transform = `translate(${Math.round(x - rect.left - GLOW_RADIUS)}px, ${Math.round(y - rect.top - GLOW_RADIUS)}px)`;
      if (!rail.hasAttribute(GLOW_ATTR)) rail.setAttribute(GLOW_ATTR, '');
    };
    const created: Glow = {
      on: false,
      phone,
      media: null,
      onMedia: () => apply(rail, created),
      onEnter: (e) => {
        if (layer === null) {
          layer = rail.ownerDocument.createElement('div');
          layer.setAttribute('data-pkc-field', GLOW_FIELD);
          layer.setAttribute('aria-hidden', 'true');
          rail.append(layer);
        }
        rect = rail.getBoundingClientRect();
        rail.addEventListener('pointermove', created.onMove);
        created.onMove(e);
      },
      onMove: (e) => {
        x = e.clientX;
        y = e.clientY;
        if (frame === 0) frame = raf(paint) || 0;
      },
      onLeave: () => {
        rail.removeEventListener('pointermove', created.onMove);
        if (frame !== 0) view?.cancelAnimationFrame?.(frame);
        frame = 0;
        rect = null;
        rail.removeAttribute(GLOW_ATTR);
      },
    };
    g = created;
    try {
      g.media = mm?.(GLOW_QUERY) ?? null;
    } catch {
      g.media = null;
    }
    // 環境が変わったら(動きを減らす設定を入れた等)付け外しし直す ── `pointermove` ではないので定常の仕事にならない
    g.media?.addEventListener?.('change', g.onMedia);
    glows.set(rail, g);
  }
  g.phone = phone;
  apply(rail, g);
}

function apply(rail: HTMLElement, g: Glow): void {
  const want = allowed(g);
  if (want === g.on) return;
  g.on = want;
  if (want) {
    rail.addEventListener('pointerenter', g.onEnter);
    rail.addEventListener('pointerleave', g.onLeave);
  } else {
    g.onLeave();
    rail.removeEventListener('pointerenter', g.onEnter);
    rail.removeEventListener('pointerleave', g.onLeave);
  }
}

/** いま発光のリスナーを付けているか(test と smoke の観測点)。 */
export function railGlowActive(rail: HTMLElement): boolean {
  return glows.get(rail)?.on === true;
}
