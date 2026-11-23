/**
 * 🔴 **輪郭の近接発光(ネオン)**(B2)── カードの**輪郭線そのもの**が、ポインタの近くだけ光る。
 *
 * ## 見え方
 *
 * ポインタから半径内にあるカードの輪郭(約 2px の線)に、`--neon`(テーマの `--accent` から導いた明るい色)と、
 * 中心の明るい芯(`--neon-core`)が点る。内側の地は光らない。離れると消えて、静止の輪郭(ヘアライン)だけに戻る。
 * 対象は 3 か所を**同じ 1 つの仕組み**で扱う: ログの記録(`[data-pkc-log-card]`)/ 情報ペインのカード(`[data-pkc-card]`)/
 * 左端の縦のバーのボタン(`button`)。旧い「バーの淡い灰色の光」(G1。`rail-glow.ts`)はこれに置き換えた。
 * 描くのは CSS(`app.css` の `::before` + `mask-composite: exclude`)。ここは**近いカードに局所座標(`--gx` / `--gy`)と印を書くだけ**。
 *
 * ## 🔴 定常のコスト(北極星「効くのは定常」)
 *
 * - **リスナーを付けない環境**: マウスの無い端末(`hover: none`)・指の端末(`pointer: coarse`)・動きを減らす設定・スマホ用画面。
 *   判定は `mayGlow`(features)1 か所 + `GLOW_QUERY` 1 本。付けない間は `pointerover` も観測器も**付けない**
 *   (残るのは環境の変化を聞く `matchMedia` の `change` だけ ── 戻したときに付け直すため)。
 * - 付ける環境でも、`pointermove` / 観測器 / `scroll` / `resize` は**ポインタが対象のゾーンに入っている間だけ**付ける。
 *   ゾーンの外にある間の仕事は `pointerover`(要素をまたぐとき 1 回の `closest`)だけ。
 * - 書き込みは **1 コマに 1 回**(`requestAnimationFrame`)。**矩形は汚れの印が立つまで測り直さない**
 *   (汚す: 子の追加・削除 / 属性の変化 / ゾーンの大きさ / スクロール / ウィンドウの大きさ)。
 *   ⚠ 汚れたら**同期で測らず**、次のコマ(最後のポインタの位置で)で測り直す ── スクロールしてもポインタが止まっていれば、
 *   そのコマで光の位置が追いつく(光が置いていかれない)。
 * - ⚠ 自分の書き込み(`style` / 印)は観測器から除く(でないと毎コマ汚れて測り直しが続く)。
 * - ⚠ 変数は**光る側のカード 1 枚**にだけ書く(`:root` / ゾーンへ書くと全子孫の style を計算し直す ── 実測 40 秒 / 600 回)。
 *
 * 呼び手: `main.ts`(`installNeonGlow`)と、版面が入れ替わるたびに通る `rail.ts` の `paintRail`(`syncNeonPhone`)。
 */
import { createRectCache, mayGlow, nearCards, NEON_RADIUS, type CardRect } from '@features/neon/near-cards';

/** 光らせてよい環境。⚠ 3 条件を 1 本の問いにまとめる(どれか 1 つでも外れたら付けない)。 */
export const GLOW_QUERY = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
/** 近いカードに付く印(CSS が読む)。 */
export const NEAR_ATTR = 'data-pkc-glow-near';

/** ゾーン(ポインタが入っている間だけ働く範囲)と、そこで光るカード。 */
export interface NeonZoneSpec {
  readonly zone: string;
  readonly cards: string;
  readonly radius: number;
}
export const NEON_ZONES: readonly NeonZoneSpec[] = [
  { zone: '[data-pkc-log-days]', cards: '[data-pkc-log-card]', radius: NEON_RADIUS.log },
  { zone: '[data-pkc-region="inspector"]', cards: '[data-pkc-card]', radius: NEON_RADIUS.inspector },
  { zone: '[data-pkc-region="rail"]', cards: 'button', radius: NEON_RADIUS.rail },
];
const ANY_ZONE = NEON_ZONES.map((z) => z.zone).join(', ');

type MediaLike = {
  readonly matches: boolean;
  addEventListener?: (type: 'change', fn: () => void) => void;
  removeEventListener?: (type: 'change', fn: () => void) => void;
};
export type NeonMatchMedia = (q: string) => MediaLike | undefined;

export interface NeonGlow {
  /** スマホ用画面か(付けない)。何度呼んでも同じ結果。 */
  setPhone(phone: boolean): void;
  /** いま `pointerover` を聞いているか(test / smoke の観測点)。 */
  listening(): boolean;
  /** いまポインタがゾーンに入っていて、`pointermove` などを付けているか。 */
  inZone(): boolean;
  destroy(): void;
}

type Item = CardRect & { readonly el: HTMLElement };

/**
 * @param mm 差し替え口(unit)。既定は window の `matchMedia`(無い / 投げる環境では**付けない側**へ倒す)
 */
export function createNeonGlow(doc: Document, mm?: NeonMatchMedia | null): NeonGlow {
  const view = doc.defaultView;
  const raf = view?.requestAnimationFrame?.bind(view);
  const caf = view?.cancelAnimationFrame?.bind(view);
  let media: MediaLike | null = null;
  try {
    const f = mm === undefined ? (view as unknown as { matchMedia?: NeonMatchMedia } | null)?.matchMedia?.bind(view) : mm;
    media = f?.(GLOW_QUERY) ?? null;
  } catch {
    media = null;
  }

  let phone = false;
  let on = false;

  // ── ゾーンの中にいる間だけの状態 ──
  let zone: HTMLElement | null = null;
  let spec: NeonZoneSpec | null = null;
  let px = 0;
  let py = 0;
  let known = false;
  let frame = 0;
  let mo: MutationObserver | null = null;
  let ro: ResizeObserver | null = null;
  let roFirst = true;
  const lit = new Map<HTMLElement, { gx: number; gy: number }>();
  const cache = createRectCache<Item>(() => {
    const out: Item[] = [];
    if (zone === null || spec === null) return out;
    for (const el of zone.querySelectorAll<HTMLElement>(spec.cards)) {
      const r = el.getBoundingClientRect();
      // 隠れている(畳み・非表示)カードは矩形が 0 ── 原点の近くで偽って光らせない
      if (r.width === 0 && r.height === 0) continue;
      out.push({ el, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return out;
  });

  const clearOne = (el: HTMLElement): void => {
    el.style.removeProperty('--gx');
    el.style.removeProperty('--gy');
    el.removeAttribute(NEAR_ATTR);
  };
  const clearAll = (): void => {
    for (const el of lit.keys()) clearOne(el);
    lit.clear();
  };

  const paint = (): void => {
    frame = 0;
    if (zone === null || spec === null || !known) return;
    if (!zone.isConnected) {
      leave();
      return;
    }
    const items = cache.get();
    const near = nearCards(items, px, py, spec.radius);
    const next = new Set<HTMLElement>();
    for (const n of near) {
      const el = items[n.index]!.el;
      next.add(el);
      const prev = lit.get(el);
      if (prev !== undefined && prev.gx === n.gx && prev.gy === n.gy) continue;
      el.style.setProperty('--gx', `${n.gx}px`);
      el.style.setProperty('--gy', `${n.gy}px`);
      if (!el.hasAttribute(NEAR_ATTR)) el.setAttribute(NEAR_ATTR, '');
      lit.set(el, { gx: n.gx, gy: n.gy });
    }
    for (const el of [...lit.keys()]) {
      if (next.has(el)) continue;
      clearOne(el);
      lit.delete(el);
    }
  };
  const schedule = (): void => {
    if (frame === 0 && raf !== undefined) frame = raf(paint);
  };

  /** 汚す ── ⚠ ここでは測らない。次のコマ(最後のポインタの位置)で測り直す。 */
  const markDirty = (): void => {
    cache.markDirty();
    if (known) schedule();
  };
  const onMove = (e: PointerEvent): void => {
    px = e.clientX;
    py = e.clientY;
    known = true;
    schedule();
  };
  const onMutations = (records: MutationRecord[]): void => {
    for (const r of records) {
      // 自分の書き込み(光っているカードの `style` / 印)は汚れではない
      if (r.type === 'attributes') {
        if (r.attributeName === NEAR_ATTR) continue;
        if (r.attributeName === 'style' && r.target instanceof HTMLElement && lit.has(r.target)) continue;
      }
      markDirty();
      return;
    }
  };
  const onResizeObserved = (): void => {
    // 観測を始めた直後の 1 回目は「いまの大きさ」の通知 ── 汚れではない(入った時に汚している)
    if (roFirst) {
      roFirst = false;
      return;
    }
    markDirty();
  };

  const enter = (z: HTMLElement, s: NeonZoneSpec, e: PointerEvent): void => {
    zone = z;
    spec = s;
    cache.reset();
    px = e.clientX;
    py = e.clientY;
    known = true;
    z.addEventListener('pointermove', onMove, { passive: true });
    z.addEventListener('pointerleave', leave);
    view?.addEventListener('scroll', markDirty, { capture: true, passive: true });
    view?.addEventListener('resize', markDirty);
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(onMutations);
      mo.observe(z, { childList: true, subtree: true, attributes: true });
    }
    if (typeof ResizeObserver !== 'undefined') {
      roFirst = true;
      ro = new ResizeObserver(onResizeObserved);
      ro.observe(z);
    }
    schedule();
  };
  function leave(): void {
    if (zone === null) return;
    zone.removeEventListener('pointermove', onMove);
    zone.removeEventListener('pointerleave', leave);
    view?.removeEventListener('scroll', markDirty, { capture: true });
    view?.removeEventListener('resize', markDirty);
    mo?.disconnect();
    ro?.disconnect();
    mo = null;
    ro = null;
    if (frame !== 0) caf?.(frame);
    frame = 0;
    clearAll();
    cache.reset();
    zone = null;
    spec = null;
    known = false;
  }

  /** ゾーンの外 → 中、ゾーンどうしの移り変わりだけを拾う(要素をまたぐときに 1 回)。 */
  const onOver = (e: PointerEvent): void => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (zone !== null && zone.contains(t)) return;
    const z = t.closest<HTMLElement>(ANY_ZONE);
    if (z === zone) return;
    leave();
    if (z === null) return;
    const s = NEON_ZONES.find((c) => z.matches(c.zone));
    if (s !== undefined) enter(z, s, e);
  };

  const allowed = (): boolean => {
    if (raf === undefined) return false;
    try {
      return mayGlow(media?.matches === true, phone);
    } catch {
      return false;
    }
  };
  const apply = (): void => {
    const want = allowed();
    if (want === on) return;
    on = want;
    if (want) doc.addEventListener('pointerover', onOver, { passive: true });
    else {
      doc.removeEventListener('pointerover', onOver);
      leave();
    }
  };
  media?.addEventListener?.('change', apply);
  apply();

  return {
    setPhone: (p) => {
      phone = p;
      apply();
    },
    listening: () => on,
    inZone: () => zone !== null,
    destroy: () => {
      media?.removeEventListener?.('change', apply);
      on = false;
      doc.removeEventListener('pointerover', onOver);
      leave();
    },
  };
}

let instance: NeonGlow | null = null;
let pendingPhone = false;

/** 起動時に 1 度だけ。2 度目以降は同じものを返す。 */
export function installNeonGlow(doc: Document): NeonGlow {
  if (instance === null) {
    instance = createNeonGlow(doc);
    instance.setPhone(pendingPhone);
  }
  return instance;
}

/** 版面がスマホ用画面か(`rail.ts` の `paintRail` が版面が入れ替わるたびに伝える)。起動前に呼ばれても覚えておく。 */
export function syncNeonPhone(phone: boolean): void {
  pendingPhone = phone;
  instance?.setPhone(phone);
}
