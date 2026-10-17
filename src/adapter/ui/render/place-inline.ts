/**
 * 🔴 **板の付箋の上で、開かずに書く 2 つの小さな欄**(#529 W5-a「追記」/ W5-b「題名を直す」)。
 * 設計 `docs/development/board-edit-in-place-design-2026-10.md`(§2.1 / §2.3 / §6)。
 *
 * ## 作り
 *
 * - **付箋の下端の「追記」**(`place-append`)── 付箋の子。描画のたびに冪等に置く(`ensureGrip` と同じ作法)。
 *   出すのは**追記できる型**(`isAppendable` ── ノート・ログ)だけ。出方は CSS(ポインターを合わせたとき /
 *   `@media (hover: none)` では最初から)。
 * - **欄 1 つ**(`place-inline`)── 板の器(host)の直下に**重ね物**(`OVERLAY_ATTR`)として置く。
 *   🔑 付箋の中に置かない理由:付箋(塊)は板の本文が変わると**作り直される**ので、中に居る欄は
 *   打ちかけの字ごと捨てられる(`cell-input.ts` の #745 と同じ)。重ね物なら差分描画が数えずに残す。
 *   位置は付箋から引き直す(`positionPlaceInline`)── 描画のたびに呼ぶので、付箋を動かしても追って来る。
 * - 欄は同時に **1 つだけ**(開いている間に別の付箋の「追記」を押すと、前の欄は閉じて移る)。
 *
 * ⚠ ここは**描くだけ**。書く(`APPEND_TO_ENTRY` / `RENAME_ENTRY_TITLE`)のは binder の受け手。
 */

import { placeRotateOf, rotatedBounds } from '@features/markdown/place-rotate';
import { OVERLAY_ATTR } from './apply-blocks';

export const PLACE_APPEND_FIELD = 'place-append';
export const PLACE_INLINE_FIELD = 'place-inline';
export const PLACE_INLINE_INPUT_FIELD = 'place-inline-input';
export const PLACE_INLINE_NOTE_FIELD = 'place-inline-note';

/**
 * - `append` … 付箋のノートの末尾へ足す
 * - `rename` … 付箋のノートの題名を直す
 * - `text` … 🔴 ふつうの付箋の中の字を直す(#1662 1。置いたノートは無いので `data-pkc-entry` は板のノートの lid)
 */
export type PlaceInlineMode = 'append' | 'rename' | 'text';

/** 欄の字(画面の字。正本は用語集 `ui-terms.ts`)。 */
export const PLACE_APPEND_LABEL = '追記';
export const PLACE_APPEND_HINT = '押すと、開かずにこのノートの末尾へ足せます';
export const PLACE_INLINE_SEND_LABEL = '追記する';
export const PLACE_INLINE_RENAME_LABEL = '題名を直す';
export const PLACE_INLINE_CANCEL_LABEL = 'やめる';
export const PLACE_INLINE_TEXT_LABEL = '付箋の字を直す';

/**
 * 付箋の下端に「追記」を置く / 外す(冪等)。`appendable` が偽なら外す
 * (押しても書けないボタンを出さない ── 設計 §2.2)。
 * ⚠ `<button>` にする ── 掴む口と同じ理由(`row-swap` が button を編集の対象から外す)。
 */
export function syncPlaceAppendButton(block: HTMLElement, lid: string, appendable: boolean): void {
  let btn = block.querySelector<HTMLButtonElement>(`:scope > [data-pkc-field="${PLACE_APPEND_FIELD}"]`);
  if (!appendable) {
    btn?.remove();
    return;
  }
  if (btn === null) {
    btn = block.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-field', PLACE_APPEND_FIELD);
    btn.setAttribute('data-pkc-action', 'place-append-open');
    btn.textContent = PLACE_APPEND_LABEL;
    btn.title = PLACE_APPEND_HINT;
    block.append(btn);
  }
  // ⚠ 押した付箋の相手は**ボタン自身が持つ**(`selectedLid` を読まない ── 板では「選んでいるノート」と
  //   「付箋のノート」が別物。設計 §5)
  btn.setAttribute('data-pkc-entry', lid);
}

/** 開いている欄(無ければ `null`)。⚠ 探すのは `host` の直下だけ。 */
export function placeInlineOf(host: Element): HTMLElement | null {
  return host.querySelector<HTMLElement>(`:scope > [data-pkc-field="${PLACE_INLINE_FIELD}"]`);
}

/** 欄を閉じる。 @returns 閉じたか */
export function closePlaceInline(host: Element): boolean {
  const el = placeInlineOf(host);
  if (el === null) return false;
  anchors.delete(el);
  el.remove();
  return true;
}

/** 欄が付箋のどれに付いているか(付箋は作り直されるので、切れたら lid で引き直す)。 */
const anchors = new WeakMap<HTMLElement, HTMLElement>();

function blocksOf(host: Element, lid: string): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.pkc-place[data-pkc-place-entry]')].filter(
    (b) => b.getAttribute('data-pkc-place-entry') === lid,
  );
}

/**
 * 欄を開く(同時に 1 つ)。既に同じ付箋・同じ型の欄が開いていれば**作り直さず**焦点だけ戻す
 * (開き直すと打ちかけが消える)。
 * @param initial 欄に最初に入れる字(題名を直すときのいまの題名)
 */
export function openPlaceInline(
  host: HTMLElement,
  block: HTMLElement,
  mode: PlaceInlineMode,
  lid: string,
  initial: string,
  /** `text` のときだけ ── 付箋の開き行の行番号(`data-pkc-place-line`。書く先を欄が持つ)。 */
  placeLine?: string,
): HTMLElement {
  const doc = host.ownerDocument;
  const cur = placeInlineOf(host);
  if (cur !== null && cur.getAttribute('data-pkc-mode') === mode && cur.getAttribute('data-pkc-entry') === lid && anchors.get(cur) === block) {
    focusPlaceInline(cur);
    return cur;
  }
  closePlaceInline(host);
  const el = doc.createElement('div');
  el.setAttribute('data-pkc-field', PLACE_INLINE_FIELD);
  el.setAttribute(OVERLAY_ATTR, '');
  el.setAttribute('data-pkc-mode', mode);
  el.setAttribute('data-pkc-entry', lid);
  if (placeLine !== undefined) el.setAttribute('data-pkc-place-line', placeLine);
  // 🔑 付箋の中の押し・ドラッグ・ダブルクリックを奪わない ── 欄は付箋の外(host の子)に居る
  const input = doc.createElement('textarea');
  input.setAttribute('data-pkc-field', PLACE_INLINE_INPUT_FIELD);
  input.rows = mode === 'append' ? 2 : mode === 'text' ? 3 : 1;
  input.value = initial;
  input.setAttribute(
    'aria-label',
    mode === 'append' ? 'このノートの末尾へ足す字' : mode === 'text' ? '付箋の字' : '新しい題名',
  );
  input.placeholder =
    mode === 'append'
      ? '足す字(Enter で追記・Shift+Enter で改行・Esc でやめる)'
      : mode === 'text'
        ? '付箋の字(Enter で確定・Shift+Enter で改行・Esc でやめる)'
        : '新しい題名(Enter で直す・Esc でやめる)';
  const note = doc.createElement('div');
  note.setAttribute('data-pkc-field', PLACE_INLINE_NOTE_FIELD);
  note.hidden = true;
  note.setAttribute('role', 'alert');
  const send = doc.createElement('button');
  send.type = 'button';
  send.setAttribute('data-pkc-action', 'place-inline-commit');
  send.textContent =
    mode === 'append'
      ? PLACE_INLINE_SEND_LABEL
      : mode === 'text'
        ? PLACE_INLINE_TEXT_LABEL
        : PLACE_INLINE_RENAME_LABEL;
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.setAttribute('data-pkc-action', 'place-inline-cancel');
  cancel.textContent = PLACE_INLINE_CANCEL_LABEL;
  const row = doc.createElement('div');
  row.setAttribute('data-pkc-field', 'place-inline-row');
  row.append(send, cancel);
  el.append(input, note, row);
  host.append(el);
  anchors.set(el, block);
  positionPlaceInline(host);
  focusPlaceInline(el);
  return el;
}

function focusPlaceInline(el: HTMLElement): void {
  const input = el.querySelector<HTMLTextAreaElement>(`[data-pkc-field="${PLACE_INLINE_INPUT_FIELD}"]`);
  if (input === null) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** 欄に理由を出す(字は残す)。 */
export function showPlaceInlineNote(el: HTMLElement, text: string | null): void {
  const note = el.querySelector<HTMLElement>(`[data-pkc-field="${PLACE_INLINE_NOTE_FIELD}"]`);
  if (note === null) return;
  note.textContent = text ?? '';
  note.hidden = text === null || text === '';
}

/** 欄の中の字。 */
export function placeInlineText(el: HTMLElement): string {
  return el.querySelector<HTMLTextAreaElement>(`[data-pkc-field="${PLACE_INLINE_INPUT_FIELD}"]`)?.value ?? '';
}

/**
 * 欄を付箋の位置へ置く(冪等。描画のたびに呼ぶ)。付箋が作り直されていたら lid で引き直し、
 * **付箋そのものが無くなっていれば欄を閉じる**(行き先の無い欄を残さない)。
 * 追記は付箋の**下**、題名は付箋の**上端(題名の帯の上)**に重ねる。
 */
export function positionPlaceInline(host: Element): void {
  const el = placeInlineOf(host);
  if (el === null) return;
  const lid = el.getAttribute('data-pkc-entry') ?? '';
  let block = anchors.get(el);
  if (block === undefined || !block.isConnected) {
    // 🔴 ふつうの付箋(`text`)は置いたノートが無いので、開き行の行番号で引き直す(#1662 1)
    const placeLine = el.getAttribute('data-pkc-place-line');
    block =
      placeLine === null
        ? blocksOf(host, lid)[0]
        : [...host.querySelectorAll<HTMLElement>('.pkc-place:not([data-pkc-place-entry])')].find(
            (b) => b.getAttribute('data-pkc-place-line') === placeLine,
          );
    if (block === undefined) {
      closePlaceInline(host);
      return;
    }
    anchors.set(el, block);
  }
  const num = (v: string): number => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
  const left = num(block.style.left);
  const top = num(block.style.top);
  // 測れない所(happy-dom)では置いた高さ / 0 へ落ちる
  const h = block.offsetHeight > 0 ? block.offsetHeight : num(block.style.height);
  const w = block.offsetWidth > 0 ? block.offsetWidth : num(block.style.width);
  const mode = el.getAttribute('data-pkc-mode');
  /**
   * 🔴 回した付箋は**回した外接四角**に重ねる(#530 段⑤d)── `left` / `top` / 幅 / 高さは回す前の四角なので、
   * そのまま使うと追記欄が傾いた付箋の角に食い込む / 離れる。回していなければ今までと同じ式。
   */
  const rot = placeRotateOf(block.getAttribute('data-pkc-rotate'));
  const b = rot === 0 ? { x: left, y: top, w, h } : rotatedBounds({ x: left, y: top, w, h }, rot);
  el.style.left = `${b.x}px`;
  el.style.top = `${mode === 'append' ? b.y + b.h : b.y}px`;
  if (b.w > 0) el.style.width = `${b.w}px`;
}
