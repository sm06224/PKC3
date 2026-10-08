/**
 * 🔴 **付箋どうしを、掴んで繋ぐ**(#530 段③d)── 入力の配線だけ。
 * どの辺か / ● ⊕ の位置 / 離した先の板は `features/markdown/place-handles.ts`(pure)、
 * 本文へ何を書くかは `CONNECT_PLACE`(reducer)→ `place-notation.ts` の `connectPlaces`(pure)が持つ。
 *
 * > 裁定(🟣 Gemini、2026-10-01、https://github.com/sm06224/PKC3/issues/530#issuecomment-5932857648):
 * > 付箋に乗せたとき、**乗せた辺にだけ ● 1 つと両隣に ⊕ 2 つ**を出す。⊕ に乗せるとそこが ● になり、
 * > さらに細かく選べる。常時は何も出さない。名前の無い付箋を繋ぐと、本文へ名前を自動で足す。
 *
 * ## ⚠ 乗せたときだけ出す
 *
 * 印は**付箋の外の層**(`.pkc-board-host` の子)に置く ── 付箋は `overflow: auto` なので、
 * 辺をまたぐ印を付箋の子にすると半分が切れる。付箋にも他の辺にも出さない(常時は 0 個)。
 * 毎回作り直さない ── 乗せている辺と ● が変わらない間は**同じ要素のまま**にする
 * (押した瞬間に押された要素が差し替わると、掴めない)。
 *
 * ## ⚠ 掴んでいる間は見た目だけ(書くのは離したとき 1 回)
 *
 * 仮の線(SVG 1 本)をマウスの位置まで引く。離した位置が**別の付箋の上**なら
 * `CONNECT_PLACE` を 1 回撃つ。付箋の外 / 同じ付箋 / `Esc` / 途中で切れた(pointercancel)
 * ときは**何も書かず、何も言わず**仮の線だけ消す(`place-drag.ts` の取りやめと同じ作法)。
 *
 * ## ⚠ 編集中は掴めない
 *
 * 出すのも掴むのも `phase === 'ready'` のときだけ。⚠ reducer(`bodyRewriteGate`)も同じ条件で
 * 断る ── 印を出さないのは**押して断られる口を作らない**ため、reducer は**取りこぼし**(掴んだ後に
 * 状態が変わった)の最後の門である。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import {
  anchorOf,
  anchorPoint,
  anchorSpell,
  parseAnchorSpell,
  type PlaceAnchor,
  type PlaceEdge,
  type PlaceRect,
} from '@features/markdown/place-line';
import {
  connectHandles,
  nearestEdge,
  topPlaceAt,
  type PlaceDrop,
} from '@features/markdown/place-handles';
import { intAttr, rectOf } from './place-board';
import { placeTargetOf } from './place-drag';

/** 押すと掴むの境目(px)。⚠ `place-drag.ts` と同じ値(同じ手で動かす)。 */
const DRAG_SLOP = 4;

const PLACE_SELECTOR = '.pkc-format-block.pkc-place';
const HOST_SELECTOR = '.pkc-board-host';
const LAYER_FIELD = 'place-connect-handles';
const HANDLE_FIELD = 'place-handle';
const GHOST_FIELD = 'place-connect-ghost';
const TARGET_ATTR = 'data-pkc-connect-target';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 画面の字。⚠ 文言は**起きること**で書く(user 指示 2026-08-21。出どころは CLAUDE.md の節)。 */
const DOT_LABEL = '別の付箋までドラッグすると、線でつなぎます(離した位置が本文に書かれます)';
const PLUS_LABEL = 'マウスを合わせると、線を付ける位置を細かく選べます';

/** 乗せている付箋と辺。 */
interface Hover {
  readonly block: HTMLElement;
  readonly edge: PlaceEdge;
  /** いま ● になっている点(⊕ に乗せると、その点へ動く)。 */
  readonly focus: PlaceAnchor;
}

interface Drag {
  readonly pointerId: number;
  readonly block: HTMLElement;
  readonly host: HTMLElement;
  readonly anchor: PlaceAnchor;
  readonly startClientX: number;
  readonly startClientY: number;
  moved: boolean;
  ghost: SVGSVGElement | null;
  marked: HTMLElement | null;
}

/** 器(host)の座標へ写す ── 付箋の `x=` / `y=` と同じ座標系(`binder.ts` の「ここに板を置く」と同じ式)。 */
function hostPoint(host: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = host.getBoundingClientRect();
  return {
    x: clientX - r.left - host.clientLeft + host.scrollLeft,
    y: clientY - r.top - host.clientTop + host.scrollTop,
  };
}

function handleOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(`[data-pkc-field="${HANDLE_FIELD}"]`);
}

/**
 * root へ 1 度だけ配線する(`installPlaceDrag` と同じ作法)。
 * @returns 外す関数。アプリ本体では外さない(同寿命)が、test は外せる必要がある。
 */
export function installPlaceConnect(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const doc = root.ownerDocument;
  let hover: Hover | null = null;
  let layer: HTMLElement | null = null;
  let drag: Drag | null = null;
  let swallowClick = false;

  const ready = (): boolean => dispatcher.getState().phase === 'ready';

  const clearHandles = (): void => {
    layer?.remove();
    layer = null;
    hover = null;
  };

  const makeHandle = (
    kind: 'dot' | 'plus',
    anchor: PlaceAnchor,
    rect: PlaceRect,
  ): HTMLElement => {
    const el = doc.createElement('button');
    el.type = 'button';
    el.tabIndex = -1; // ⚠ 乗せて掴む物 ── Tab の通り道を増やさない
    el.setAttribute('data-pkc-field', HANDLE_FIELD);
    el.setAttribute('data-pkc-handle', kind);
    el.setAttribute('data-pkc-anchor', anchorSpell(anchor));
    const p = anchorPoint(rect, anchor);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    const label = kind === 'dot' ? DOT_LABEL : PLUS_LABEL;
    el.title = label;
    el.setAttribute('aria-label', label);
    return el;
  };

  /** 乗せた辺に ● と ⊕ を出す(同じ辺・同じ ● なら作り直さない)。 */
  const showHandles = (block: HTMLElement, edge: PlaceEdge, focus: PlaceAnchor | null): void => {
    const host = block.closest<HTMLElement>(HOST_SELECTOR);
    if (host === null) return;
    const h = connectHandles(edge, focus);
    if (
      hover !== null &&
      layer !== null &&
      layer.isConnected &&
      hover.block === block &&
      hover.edge === edge &&
      anchorSpell(hover.focus) === anchorSpell(h.dot)
    ) {
      return; // 同じ辺・同じ ● ── 作り直さない(押した瞬間に押された要素が差し替わらないように)
    }
    layer?.remove();
    const rect = rectOf(block);
    const box = doc.createElement('div');
    box.setAttribute('data-pkc-field', LAYER_FIELD);
    box.setAttribute('data-pkc-edge', edge);
    for (const a of h.plus) box.append(makeHandle('plus', a, rect));
    box.append(makeHandle('dot', h.dot, rect));
    /**
     * ⚠ この層には**重ね物の印(`OVERLAY_ATTR`)を付けていない**(#1464 段 1 の着地前レビュー #2)──
     *   乗っている間に本文が描き直されると、今までどおり丸ごと作り直しへ倒れる(層は消える)。
     *   印を付けるなら、描き直しの後に古い `hover.block`(外れた節点)を指したまま残る層を
     *   消す経路が要る。板を離した直後の `replaced` を実ブラウザで見てから決める(#1464 段 2)。
     */
    host.append(box);
    layer = box;
    hover = { block, edge, focus: h.dot };
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag !== null) {
      moveDrag(e);
      return;
    }
    const target = e.target;
    if (!(target instanceof Element)) return;
    const over = handleOf(target);
    if (over !== null) {
      // 🔑 ⊕ に乗せたら、そこが ● になる(さらに細かく選べる)── ● に乗せても何も変えない
      if (over.getAttribute('data-pkc-handle') === 'plus' && hover !== null) {
        const a = parseAnchorSpell(over.getAttribute('data-pkc-anchor') ?? '');
        if (a !== null) showHandles(hover.block, hover.edge, a);
      }
      return;
    }
    const block = target.closest<HTMLElement>(PLACE_SELECTOR);
    if (block === null || block.closest(HOST_SELECTOR) === null || !ready()) {
      if (layer !== null) clearHandles();
      return;
    }
    const host = block.closest<HTMLElement>(HOST_SELECTOR)!;
    const p = hostPoint(host, e.clientX, e.clientY);
    const edge = nearestEdge(rectOf(block), p.x, p.y);
    if (hover !== null && hover.block === block && hover.edge === edge && layer?.isConnected) {
      return; // 同じ辺の上を動いているだけ
    }
    showHandles(block, edge, null);
  };

  const onPointerDown = (e: PointerEvent): void => {
    swallowClick = false;
    if (e.button !== 0 || drag !== null) return;
    const handle = handleOf(e.target);
    if (handle === null || hover === null) return;
    if (!ready()) {
      clearHandles(); // 編集中は掴めない(印も残さない)
      return;
    }
    const anchor = parseAnchorSpell(handle.getAttribute('data-pkc-anchor') ?? '');
    const host = hover.block.closest<HTMLElement>(HOST_SELECTOR);
    if (anchor === null || host === null) return;
    drag = {
      pointerId: e.pointerId,
      block: hover.block,
      host,
      anchor,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      ghost: null,
      marked: null,
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // 捕まえられない環境でも、pointermove は document から届く
    }
    e.preventDefault();
  };

  /** host の中の付箋を、離した先の候補として全部集める。 */
  const candidates = (host: HTMLElement): PlaceDrop<HTMLElement>[] =>
    [...host.querySelectorAll<HTMLElement>(PLACE_SELECTOR)].map((item) => ({
      item,
      rect: rectOf(item),
      z: intAttr(item, 'data-pkc-z') ?? 0,
    }));

  const mark = (d: Drag, block: HTMLElement | null): void => {
    if (d.marked === block) return;
    d.marked?.removeAttribute(TARGET_ATTR);
    block?.setAttribute(TARGET_ATTR, '');
    d.marked = block;
  };

  const moveDrag = (e: PointerEvent): void => {
    const d = drag;
    if (d === null || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    if (!d.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
    d.moved = true;
    const from = anchorPoint(rectOf(d.block), d.anchor);
    const to = hostPoint(d.host, e.clientX, e.clientY);
    if (d.ghost === null) {
      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('data-pkc-field', GHOST_FIELD);
      svg.append(doc.createElementNS(SVG_NS, 'path'));
      d.host.append(svg);
      d.ghost = svg;
    }
    d.ghost.firstElementChild!.setAttribute('d', `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
    const over = topPlaceAt(candidates(d.host), to.x, to.y);
    mark(d, over !== null && over.item !== d.block ? over.item : null);
  };

  /** 掴みを終える(見た目を全部戻す)。⚠ 本文には 1 byte も触らない。 */
  const endDrag = (): void => {
    const d = drag;
    drag = null;
    if (d === null) return;
    mark(d, null);
    d.ghost?.remove();
  };

  const onPointerUp = (e: PointerEvent): void => {
    const d = drag;
    if (d === null || e.pointerId !== d.pointerId) return;
    endDrag();
    if (!d.moved) return;
    swallowClick = true;
    // 掴んで離す間に、器ごと消えた(本文が描き直された)なら何も書かない
    if (!d.block.isConnected || !d.host.isConnected) {
      clearHandles();
      return;
    }
    const p = hostPoint(d.host, e.clientX, e.clientY);
    const over = topPlaceAt(candidates(d.host), p.x, p.y);
    clearHandles();
    // 付箋の外 / 掴んだ付箋自身の上で離した ── 何も書かない
    if (over === null || over.item === d.block) return;
    // ⚠ ここで `ready()` を見ない ── 掴んだ後に編集へ入っていれば、**reducer が理由を声に出して断る**
    //   (`bodyRewriteGate`)。ここで黙って返すと、離した user には何も起きなかったように見える。
    const from = placeTargetOf(d.block, dispatcher);
    const to = placeTargetOf(over.item, dispatcher);
    if (from === null || to === null || from.lid !== to.lid) return;
    dispatcher.dispatch({
      type: 'CONNECT_PLACE',
      lid: from.lid,
      line: from.line,
      toLine: to.line,
      // 🔑 掴んだ側は ● の位置(`right` / `right@1/4`)、離した側は**離した辺の中央**
      fromAnchor: anchorSpell(d.anchor),
      toAnchor: anchorSpell(anchorOf(nearestEdge(over.rect, p.x, p.y))),
    });
  };

  const onPointerCancel = (): void => {
    if (drag === null) return;
    endDrag(); // 途中で切れたら仮の線を消す(本文はまだ書いていない)
    clearHandles();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || drag === null) return;
    e.preventDefault();
    endDrag();
    clearHandles();
  };

  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  /** ウィンドウの外へ出たら印を畳む(`relatedTarget` が無い = 文書の外)。 */
  const onPointerOut = (e: PointerEvent): void => {
    if (drag !== null || e.relatedTarget !== null) return;
    clearHandles();
  };

  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', onPointerCancel);
  doc.addEventListener('pointerout', onPointerOut);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown);
  return () => {
    endDrag(); // ⚠ 外した後に仮の線・印・予告を残さない
    clearHandles();
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', onPointerCancel);
    doc.removeEventListener('pointerout', onPointerOut);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKeyDown);
  };
}
