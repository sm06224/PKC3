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
import { lidOfNode } from '@adapter/ui/actions/lid-of-node';

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
    // ⚠ 2 本目の指では掴み直さない ── 前の掴みを restore せず捨てると、
    //   1 枚目が動かした見た目のまま置き去りになる(レビュー 2026-08-28)
    if (drag !== null) return;
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
    // 🔑 取りやめ(元の位置へ戻して離す)は**何も書かず、何も言わない** ──
    //   dispatch すると「値が変わらない」が下流で競合の顔をする(UX レビュー所見 2)
    if (x === d.startX && y === d.startY) {
      restore(d);
      return;
    }
    const lineRaw = d.block.getAttribute('data-pkc-place-line');
    const line = Number(lineRaw);
    /**
     * 🔴 **どの枠の板か**(#281 検算 2026-08-30)── 1 稿目は `openBody` だけを
     * 見ていたので、**横に留めた枠**の付箋を動かすと主の枠のノートを相手にしていた。
     * 引き方は `lid-of-node.ts` の 1 か所(`data-pkc-entry` / `data-pkc-split-lid`)。
     */
    const lid = lidOfNode(d.block, dispatcher.getState().openBody?.lid ?? null);
    /**
     * ⚠ 見た目は**常に**いったん戻す ── 書けた場合は BODY_REWRITTEN の再描画が
     * 正しい位置に置き直す。戻さないと、断られた drop(byte 不一致 / 行ずれ)で
     * 画面と本文が次の無関係な再描画まで食い違う(レビュー所見 5)。
     */
    restore(d);
    if (lineRaw === null || !Number.isInteger(line) || lid === null) return;
    dispatcher.dispatch({ type: 'MOVE_PLACE', lid, line, x, y });
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
