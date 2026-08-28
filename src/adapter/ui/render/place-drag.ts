/**
 * 🔴 **板の塊を掴んで動かす**(#283 P4-b)── 入力の配線だけ。
 * どこへ書くかは `MOVE_PLACE`(reducer)→ `place-notation.ts`(pure)が持つ。
 *
 * ## ⚠ 掴んでいる最中は見た目だけ動かす
 *
 * 書くのは**離したとき 1 回**(user 指示 2026-08-27「掴んで動かしている最中に
 * 焼き直さない」の向き ── 動かしている間は dispatch も再描画も走らせない)。
 *
 * ## ⚠ 押すと掴むを取り違えない(`pane-resize` と同じ作法)
 *
 * `DRAG_SLOP` を越えるまでは「押した」扱い。動かした後の `click` は 1 回捨てる
 * (捨てないと、離した指の `click` が塊の中の押し物に落ちる)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

/** 押すと掴むの境目(px)。 */
const DRAG_SLOP = 4;

interface Drag {
  readonly block: HTMLElement;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  /** 掴んだ時点の位置(data-pkc-x / y ── 描画が当てた値)。 */
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

/**
 * root へ 1 度だけ配線する(`installPaneResize` と同じ作法)。
 * @returns 外す関数。アプリ本体では外さない(同寿命)が、test は外せる必要がある。
 */
export function installPlaceDrag(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const doc = root.ownerDocument;
  let drag: Drag | null = null;
  let swallowClick = false;

  const onPointerDown = (e: PointerEvent): void => {
    swallowClick = false;
    if (e.button !== 0) return;
    const grip = (e.target as Element | null)?.closest<HTMLElement>(
      '[data-pkc-field="place-grip"]',
    );
    const block = grip?.closest<HTMLElement>('.pkc-format-block.pkc-place') ?? null;
    if (!grip || block === null) return;
    drag = {
      block,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: Number(block.getAttribute('data-pkc-x')) || 0,
      startY: Number(block.getAttribute('data-pkc-y')) || 0,
      moved: false,
    };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // 捕まえられない環境でも、下の pointermove は document から届く
    }
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
    drag.moved = true;
    drag.block.style.left = `${Math.max(0, drag.startX + dx)}px`;
    drag.block.style.top = `${Math.max(0, drag.startY + dy)}px`;
  };

  const restore = (d: Drag): void => {
    d.block.style.left = `${d.startX}px`;
    d.block.style.top = `${d.startY}px`;
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    swallowClick = true;
    const x = Math.max(0, Math.round(d.startX + (e.clientX - d.startClientX)));
    const y = Math.max(0, Math.round(d.startY + (e.clientY - d.startClientY)));
    const ordinalRaw = d.block.getAttribute('data-pkc-place-ordinal');
    const ordinal = Number(ordinalRaw);
    const lid = dispatcher.getState().openBody?.lid ?? null;
    if (ordinalRaw === null || !Number.isInteger(ordinal) || lid === null) {
      // ⚠ 書けないなら見た目も戻す ── 画面と本文を食い違わせない
      restore(d);
      return;
    }
    dispatcher.dispatch({ type: 'MOVE_PLACE', lid, ordinal, x, y });
  };

  const onPointerCancel = (): void => {
    if (drag === null) return;
    restore(drag); // 途中で切れたら戻す(本文はまだ書いていない)
    drag = null;
  };

  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', onPointerCancel);
  doc.addEventListener('click', onClick, true);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', onPointerCancel);
    doc.removeEventListener('click', onClick, true);
  };
}
