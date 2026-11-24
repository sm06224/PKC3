/**
 * 🔴 **輪郭の近接発光(ネオン)**(B2)── カードの**輪郭線そのもの**が、ポインタの近くだけ光る。
 *
 * ## 見え方
 *
 * ポインタから半径内にあるカードの輪郭(約 2px の線)に、`--neon`(テーマの `--accent` から導いた明るい色)と、
 * 中心の明るい芯(`--neon-core`)が点る。内側の地は光らない。離れると消えて、静止の輪郭(ヘアライン)だけに戻る。
 * 対象は**情報の 1 単位を囲む境界**を**同じ 1 つの仕組み**で扱う: ログの記録(`[data-pkc-log-card]`)/ 情報ペインのカードと入力欄 /
 * 左端の縦のバーのボタン(`button`)/ 本文のブロック(コード・表・図・引用・折りたたみ。通常のノートと Split の表示)/ 追記欄 /
 * 検索欄 / SQL の打つ欄。旧い「バーの淡い灰色の光」(G1。`rail-glow.ts`)はこれに置き換えた。
 * キーボードのフォーカスは**ここでは扱わない**(CSS の `:focus-visible` / `:focus-within` が同じ線を全周に静止させる。近接の光より優先)。
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
 * - ⚠ 自分の書き込み(`style` / 印)の観測器の記録は、コマの終わりに `takeRecords()` で捨てる(でないと毎コマ汚れて測り直しが続く)。
 *   捨てた後に届く記録は全部、他の変更として汚れにする(`style` だからと除かない)。
 * - 画面内の候補だけ測る: 候補は `IntersectionObserver` で見張り、画面に出ていない物は矩形を測らず書きもしない
 *   (本文のブロックを対象に入れた分の定常コストを増やさない)。観測器が無い環境では全部を候補にする。
 * - ⚠ 変数は**光る側のカード 1 枚**にだけ書く(`:root` / ゾーンへ書くと全子孫の style を計算し直す ── 実測 40 秒 / 600 回)。
 *
 * 呼び手: `main.ts`(`installNeonGlow` と、描き直しの後の `revalidateNeonGlow`)と、版面が入れ替わるたびに通る
 * `rail.ts` の `paintRail`(`syncNeonPhone`)。
 */
import { createRectCache, mayGlow, nearCards, NEON_RADIUS, type CardRect } from '@features/neon/near-cards';

/** 光らせてよい環境。⚠ 3 条件を 1 本の問いにまとめる(どれか 1 つでも外れたら付けない)。 */
export const GLOW_QUERY = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
/** 近いカードに付く印(CSS が読む)。 */
export const NEAR_ATTR = 'data-pkc-glow-near';

/** ゾーンの中で光る物の 1 種類(大きさの違う物が 1 つのゾーンに混ざるので、半径は種類ごと)。 */
export interface NeonTarget {
  readonly cards: string;
  readonly radius: number;
  /** ゾーンの直接の子だけが光る(CSS が `>` で書いている所。⚠ CSS と揃える ── 揃えないと光らない要素へ無駄に書く)。 */
  readonly direct: boolean;
}
/** ゾーン(ポインタが入っている間だけ働く範囲)と、そこで光る物。 */
export interface NeonZoneSpec {
  readonly zone: string;
  readonly targets: readonly NeonTarget[];
}
/** 入力欄(チェック・ラジオ・隠し・範囲・ファイル・色は輪郭を持たないので除く)。⚠ CSS の `FIELD` の並びと揃える(`tests/adapter/neon-glow.test.ts` が突き合わせる)。 */
export const NEON_FIELDS = 'input:not([type="checkbox"], [type="radio"], [type="hidden"], [type="range"], [type="file"], [type="color"]), textarea:not([data-pkc-field="sql-input"]), select';
export const NEON_ZONES: readonly NeonZoneSpec[] = [
  { zone: '[data-pkc-log-days]', targets: [{ cards: '[data-pkc-log-card]', radius: NEON_RADIUS.log, direct: true }] },
  {
    zone: '[data-pkc-region="inspector"]',
    targets: [
      { cards: '[data-pkc-card]', radius: NEON_RADIUS.inspector, direct: true },
      { cards: NEON_FIELDS, radius: NEON_RADIUS.field, direct: false },
    ],
  },
  // バーのボタンは群(タブ・操作)の中に入れ子で並ぶので直接の子ではない
  { zone: '[data-pkc-region="rail"]', targets: [{ cards: 'button', radius: NEON_RADIUS.rail, direct: false }] },
  // 本文(通常のノート・Split の表示。⚠ ログの本文は先頭のゾーンが握る)── コード・表・図の枠(`.pkc-md-block`)/ 折りたたみ / 引用
  {
    zone: '.pkc-md-rendered',
    targets: [{ cards: '.pkc-md-block, .pkc-details, blockquote:not(.pkc-section-callout)', radius: NEON_RADIUS.block, direct: false }],
  },
  { zone: '[data-pkc-region="append"]', targets: [{ cards: '[data-pkc-field="append-form"]', radius: NEON_RADIUS.block, direct: false }] },
  { zone: '[data-pkc-region="find-bar"]', targets: [{ cards: NEON_FIELDS, radius: NEON_RADIUS.field, direct: false }] },
  { zone: '[data-pkc-field="sql-editor"]', targets: [{ cards: '[data-pkc-field="sql-input-wrap"]', radius: NEON_RADIUS.block, direct: false }] },
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
  /**
   * 描き直しでゾーンの要素が差し替わったか(切り離されたか)を同期で確かめ、そのときだけ次のコマで付け直す(ポインタが止まっていても)。
   * ゾーンの外にいるとき・ゾーンが生きているときは何もしない(仕事 0)。呼び手: `main.ts` の状態の通知(描き直しの後)。
   */
  revalidate(): void;
  destroy(): void;
}

/** ゾーンの矩形を読み直す間隔(ms)。 */
const ZONE_BOX_EVERY_MS = 200;

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
  /** 画面に出ているかを見張る観測器(候補を画面内へ絞る)。 */
  let io: IntersectionObserver | null = null;
  /** 見張っている候補。 */
  const watched = new Set<HTMLElement>();
  /** 観測器が「画面に出ていない」と教えた候補(教えられるまでは「出ている」として扱う ── 光り損ねない側へ倒す)。 */
  const offscreen = new Set<HTMLElement>();
  /** 光っているカード(`ro` で大きさも見ている)。 */
  const lit = new Map<HTMLElement, { gx: number; gy: number }>();
  /** `ro` に付けた直後で、最初の通知(いまの大きさ)をまだ受けていないカード。 */
  const fresh = new Set<HTMLElement>();
  /** 次のコマで、ゾーンの差し替えを確かめるか。 */
  let revalidating = false;
  /** 最後に測ったゾーンの矩形(動いた / 大きさが変わったことを、コマの頭で安く確かめる)。 */
  let zoneBox: { left: number; top: number; width: number; height: number } | null = null;
  let boxAt = 0;
  const now = (): number => view?.performance?.now() ?? 0;
  const watch = (el: HTMLElement): void => {
    if (io === null || watched.has(el)) return;
    watched.add(el);
    io.observe(el);
  };
  const cache = createRectCache<Item>(() => {
    const out: Item[] = [];
    if (zone === null || spec === null) return out;
    const zr = zone.getBoundingClientRect();
    zoneBox = { left: zr.left, top: zr.top, width: zr.width, height: zr.height };
    boxAt = now();
    const seen = new Set<HTMLElement>();
    for (const t of spec.targets) {
      for (const el of zone.querySelectorAll<HTMLElement>(t.cards)) {
        if (t.direct && el.parentElement !== zone) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        watch(el);
        // 画面に出ていない(観測器が「出ていない」と教えた)物は測らない・書かない
        if (offscreen.has(el)) continue;
        const r = el.getBoundingClientRect();
        // 隠れている(畳み・非表示)カードは矩形が 0 ── 原点の近くで偽って光らせない
        if (r.width === 0 && r.height === 0) continue;
        out.push({ el, left: r.left, top: r.top, right: r.right, bottom: r.bottom, radius: t.radius });
      }
    }
    // 外れた(切り離された)物の見張りをやめる
    if (io !== null) {
      for (const el of [...watched]) {
        if (el.isConnected) continue;
        io.unobserve(el);
        watched.delete(el);
        offscreen.delete(el);
      }
    }
    return out;
  });

  const clearOne = (el: HTMLElement): void => {
    ro?.unobserve(el);
    fresh.delete(el);
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
    if (revalidating) {
      revalidating = false;
      refresh();
    }
    if (zone === null || spec === null || !known) return;
    if (!zone.isConnected) {
      leave();
      return;
    }
    // 🔴 自分の書き込みの記録は、コマの終わりに `takeRecords()` で捨てる(下)── だから、まだ届いていない記録は**全部、他の誰かの変更**
    //    (子の増減・属性・`style` の変化)。⚠ 自分の書き込みを「`style` だから無視」で見分けると、外から `style` で大きさが変わっても見逃す
    if (mo !== null && mo.takeRecords().length > 0) cache.markDirty();
    // ゾーンが動いた / 大きさが変わった(上に別の塊が現れた・画像や字体の読み込みで伸びた)── 読んだ値を比べるだけ(コマの頭は描画の直後で、レイアウトは済んでいる)
    // ⚠ 毎コマは読まない(コマの頭で矩形を読むと、ホバーなどで汚れた style がそこで強制的に計算され、1 コマに 2 回の再計算になる ── 実測)。
    //   動いたゾーンの追従は 200ms ごとで足りる(上に塊が現れるのは、ポインタの動きより遅い出来事)
    const t = now();
    if (zoneBox !== null && t - boxAt >= ZONE_BOX_EVERY_MS) {
      boxAt = t;
      const zr = zone.getBoundingClientRect();
      if (zr.left !== zoneBox.left || zr.top !== zoneBox.top || zr.width !== zoneBox.width || zr.height !== zoneBox.height) cache.markDirty();
    }
    const items = cache.get();
    const near = nearCards(items, px, py, 0);
    const next = new Set<HTMLElement>();
    for (const n of near) {
      const el = items[n.index]!.el;
      next.add(el);
      const prev = lit.get(el);
      if (prev !== undefined && prev.gx === n.gx && prev.gy === n.gy) continue;
      el.style.setProperty('--gx', `${n.gx}px`);
      el.style.setProperty('--gy', `${n.gy}px`);
      if (!el.hasAttribute(NEAR_ATTR)) {
        el.setAttribute(NEAR_ATTR, '');
        // 光っている間だけ、そのカードの大きさも見る(画像・字体の読み込みで伸びても測り直す)
        if (ro !== null) {
          fresh.add(el);
          ro.observe(el);
        }
      }
      lit.set(el, { gx: n.gx, gy: n.gy });
    }
    for (const el of [...lit.keys()]) {
      if (next.has(el)) continue;
      clearOne(el);
      lit.delete(el);
    }
    mo?.takeRecords();
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
  const onMutations = (): void => {
    // 自分の書き込みの記録は `paint` が `takeRecords()` で捨てているので、ここへ届くのは他の変更だけ
    markDirty();
  };
  const onResizeObserved = (entries: readonly { target: Element }[]): void => {
    // 観測を始めた直後の 1 回目は「いまの大きさ」の通知 ── 汚れではない(入った時 / 光らせた時に汚している)
    let changed = false;
    for (const e of entries) {
      const el = e.target as HTMLElement;
      if (fresh.delete(el)) continue;
      if (el === zone && roFirst) {
        roFirst = false;
        continue;
      }
      changed = true;
    }
    if (changed) markDirty();
  };
  const onFonts = (): void => markDirty();
  const onIntersect = (entries: readonly { target: Element; isIntersecting: boolean }[]): void => {
    let changed = false;
    for (const e of entries) {
      const el = e.target as HTMLElement;
      if (!watched.has(el)) continue;
      if (e.isIntersecting) changed = offscreen.delete(el) || changed;
      else if (!offscreen.has(el)) {
        offscreen.add(el);
        changed = true;
        // 画面の外へ出た物に光が残らない
        if (lit.has(el)) {
          clearOne(el);
          lit.delete(el);
        }
      }
    }
    if (changed) markDirty();
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
    doc.fonts?.addEventListener?.('loadingdone', onFonts);
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(onMutations);
      mo.observe(z, { childList: true, subtree: true, attributes: true });
    }
    if (typeof IntersectionObserver !== 'undefined') io = new IntersectionObserver(onIntersect);
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
    doc.fonts?.removeEventListener?.('loadingdone', onFonts);
    mo?.disconnect();
    ro?.disconnect();
    io?.disconnect();
    mo = null;
    ro = null;
    io = null;
    watched.clear();
    offscreen.clear();
    if (frame !== 0) caf?.(frame);
    frame = 0;
    clearAll();
    cache.reset();
    fresh.clear();
    zoneBox = null;
    zone = null;
    spec = null;
    known = false;
  }

  /** 差し替わったゾーンから出て、いまのポインタの下にゾーンがあれば入り直す(ポインタが止まっていても光る)。 */
  function refresh(): void {
    if (zone === null || zone.isConnected) return;
    const x = px;
    const y = py;
    leave();
    const t = doc.elementFromPoint?.(x, y);
    if (t === null || t === undefined) return;
    const z = t.closest<HTMLElement>(ANY_ZONE);
    const sp = z === null ? undefined : NEON_ZONES.find((c) => z.matches(c.zone));
    if (z !== null && sp !== undefined) enter(z, sp, { clientX: x, clientY: y } as PointerEvent);
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

  /** ポインタがウィンドウの外へ出た ── 最後の位置を忘れ、光を消す(古い座標で描き直しの後に光らせない)。 */
  const onWindowLeave = (): void => {
    leave();
    px = 0;
    py = 0;
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
    if (want) {
      doc.addEventListener('pointerover', onOver, { passive: true });
      doc.documentElement.addEventListener('pointerleave', onWindowLeave);
    } else {
      doc.removeEventListener('pointerover', onOver);
      doc.documentElement.removeEventListener('pointerleave', onWindowLeave);
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
    revalidate: () => {
      // 同期で確かめ、差し替わった(切り離された)ときだけ次のコマを予約する ── 普通の状態の通知は rAF を 0 本
      if (zone === null || zone.isConnected) return;
      revalidating = true;
      schedule();
    },
    destroy: () => {
      media?.removeEventListener?.('change', apply);
      on = false;
      doc.removeEventListener('pointerover', onOver);
      doc.documentElement.removeEventListener('pointerleave', onWindowLeave);
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

/** 描き直しの後に呼ぶ(ゾーンが差し替わっていたら、次のコマで付け直す)。ゾーンの外にいる間・ゾーンが生きている間の仕事は 0。 */
export function revalidateNeonGlow(): void {
  instance?.revalidate();
}

/** 版面がスマホ用画面か(`rail.ts` の `paintRail` が版面が入れ替わるたびに伝える)。起動前に呼ばれても覚えておく。 */
export function syncNeonPhone(phone: boolean): void {
  pendingPhone = phone;
  instance?.setPhone(phone);
}
