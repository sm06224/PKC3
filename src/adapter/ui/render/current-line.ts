/**
 * 🔴 **いま打っている行を、左端の線で示す**(#2001 段 4。user 裁定 5 =「既定で入・色の塗りではなく左端の線」)。
 *
 * ## 作り(「測る」と「描く」を分ける)
 *
 * - **描くのは欄そのもの**: `<textarea data-pkc-current-line>` に CSS の変数 2 つ(`--pkc-cl-top` / `--pkc-cl-h`)を置くだけ。
 *   線は `background-attachment: local` の背景(`app.css`)なので、**版面を動かさない・スクロールに合わせて動く(再計算が要らない)・
 *   欄の外へはみ出さない**。重ねる要素も、スクロールの聞き手も持たない。
 * - **測るのは影の div**: `<textarea>` は行ごとに装飾できないので、同じ字・同じ幅・同じ字の形の div に本文を流し、
 *   `Range` で caret の行(論理行。折り返した行はまとめて 1 本)の縦の箱を引く(`caretPoint` と同じ影の作り)。
 *   影は**1 つだけ・欄に焦点が在る間だけ**持つ(離れたら外す)。
 * - **安く**: 起こすのは `selectionchange` / `input` / `focusin` / リサイズだけ。`requestAnimationFrame` で**1 フレームに 1 回**へ畳む。
 *   本文が変わっていなければ影の字は書き直さない(測るのは `Range` の矩形だけ)。変わったときは、前後の共通部分を除いた差分だけ
 *   `replaceData` で書く(5000 行の本文でも打鍵ごとに影を丸ごと作り直さない)。
 * - **IME の変換中は動かさない**(確定前の字で行が揺れる)。`compositionend` で合わせ直す。
 * - 字を選んでいる間は出さない(選びが「いまの場所」を示す)。動き(アニメーション)は持たない ── 動きを減らす設定の人にも同じ。
 * - ⚠ 設定で切れる(`appCurrentLine`)。⚠ 本文を書く 4 つの欄すべて(`editing-field.ts` の表が名前の正本)。
 */
import { boxOfRects, currentLineRange } from '@features/markdown/line-bounds';
import { EDITING_FIELD_KINDS, EDITING_FIELD_NAMES } from '../editing-field';
import { MIRROR_PROPS } from './inline-complete';

/** 欄に付ける印(CSS が読む)と、変数の名前。 */
export const CURRENT_LINE_ATTR = 'data-pkc-current-line';
export const CURRENT_LINE_TOP_VAR = '--pkc-cl-top';
export const CURRENT_LINE_HEIGHT_VAR = '--pkc-cl-h';
const MIRROR_FIELD = 'current-line-mirror';
const ZWSP = String.fromCharCode(0x200b);

const FIELD_NAMES: ReadonlySet<string> = new Set(EDITING_FIELD_KINDS.map((k) => EDITING_FIELD_NAMES[k]));

/** `curr` を `next` へ、前後の共通部分を除いた差分だけで書き換える(`data` を丸ごと替えない)。 */
export function patchText(node: Text, next: string): void {
  const curr = node.data;
  if (curr === next) return;
  const max = Math.min(curr.length, next.length);
  let a = 0;
  while (a < max && curr.charCodeAt(a) === next.charCodeAt(a)) a += 1;
  let b = 0;
  while (b < max - a && curr.charCodeAt(curr.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b += 1;
  node.replaceData(a, curr.length - a - b, next.slice(a, next.length - b));
}

export interface CurrentLineDeps {
  /** 読むたびに保存を見る(別のタブの変更に追随する)。 */
  enabled(): boolean;
}

/** 欄の `ta`、caret の行の縦の箱(欄の padding box の左上が原点)を測る。測れなければ `null`。 */
export function measureCurrentLine(
  ta: HTMLTextAreaElement,
  mirror: { el: HTMLElement; text: Text },
): { top: number; height: number } | null {
  const doc = ta.ownerDocument;
  const cs = doc.defaultView?.getComputedStyle(ta);
  if (cs === undefined) return null;
  const el = mirror.el;
  for (const p of MIRROR_PROPS) el.style[p as never] = (cs[p as never] ?? '') as never;
  // 折り返す幅は、欄の中身の幅(縦のスクロールバーを除く)── 欄と同じ所で折り返すために
  el.style.boxSizing = 'border-box';
  el.style.overflowX = 'hidden';
  el.style.overflowY = 'hidden';
  el.style.width = `${String(ta.clientWidth + ta.clientLeft * 2)}px`;
  patchText(mirror.text, ta.value + ZWSP);
  const caret = ta.selectionStart;
  const { from, to } = currentLineRange(ta.value, caret);
  const range = doc.createRange();
  // 行末の `\n`(最後の行なら末尾の ZWSP)まで含める ── 空の行にも箱ができる
  range.setStart(mirror.text, from);
  range.setEnd(mirror.text, Math.min(to + 1, mirror.text.length));
  const box = boxOfRects([...range.getClientRects()]);
  if (box === null) return null;
  const origin = el.getBoundingClientRect().top + el.clientTop;
  // 矩形は字の箱(フォントの高さ)── 行の高さ(line-height)の上下の余白を足して、行の箱にする
  const lh = Number.parseFloat(cs.lineHeight);
  const pad = Number.isFinite(lh) && lh > box.height ? (lh - box.height) / 2 : 0;
  return { top: box.top - origin - pad, height: box.height + pad * 2 };
}

/**
 * root で 1 か所受ける。返す関数で全部外す(影も消える)。
 * ⚠ 焦点が欄に在るあいだだけ影を持つ。
 */
export function bindCurrentLine(root: HTMLElement, deps: CurrentLineDeps): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView; // ⚠ window の resize は聞かない(欄の幅の変化は ResizeObserver が拾う。常時の聞き手を増やさない)
  let mirror: { el: HTMLElement; text: Text } | null = null;
  let current: HTMLTextAreaElement | null = null;
  let frame: number | null = null;
  let composing = false;
  let observer: ResizeObserver | null = null;

  const dropMirror = (): void => {
    mirror?.el.remove();
    mirror = null;
  };
  const clear = (): void => {
    if (current !== null) {
      current.removeAttribute(CURRENT_LINE_ATTR);
      current.style.removeProperty(CURRENT_LINE_TOP_VAR);
      current.style.removeProperty(CURRENT_LINE_HEIGHT_VAR);
    }
    observer?.disconnect();
    current = null;
    dropMirror();
  };
  const fieldAt = (el: Element | null): HTMLTextAreaElement | null =>
    el !== null && el.tagName === 'TEXTAREA' && FIELD_NAMES.has(el.getAttribute('data-pkc-field') ?? '')
      ? (el as HTMLTextAreaElement)
      : null;

  const update = (): void => {
    frame = null;
    if (composing) return;
    const ta = fieldAt(doc.activeElement);
    if (ta === null || !ta.isConnected || !deps.enabled() || ta.selectionStart !== ta.selectionEnd) {
      // 別の欄へ移ったら、前の欄の印は外す。選び中は印を外して影も捨てる
      clear();
      return;
    }
    if (current !== ta) {
      clear();
      current = ta;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => schedule());
        observer.observe(ta);
      }
    }
    if (mirror === null) {
      const el = doc.createElement('div');
      el.setAttribute('data-pkc-field', MIRROR_FIELD);
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;top:0;left:-9999px;white-space:pre-wrap;overflow-wrap:break-word;';
      const text = doc.createTextNode('');
      el.append(text);
      doc.body.append(el);
      mirror = { el, text };
    }
    const box = measureCurrentLine(ta, mirror);
    if (box === null) {
      ta.removeAttribute(CURRENT_LINE_ATTR);
      return;
    }
    const top = `${box.top.toFixed(1)}px`;
    const h = `${box.height.toFixed(1)}px`;
    if (ta.style.getPropertyValue(CURRENT_LINE_TOP_VAR) !== top) ta.style.setProperty(CURRENT_LINE_TOP_VAR, top);
    if (ta.style.getPropertyValue(CURRENT_LINE_HEIGHT_VAR) !== h) ta.style.setProperty(CURRENT_LINE_HEIGHT_VAR, h);
    if (!ta.hasAttribute(CURRENT_LINE_ATTR)) ta.setAttribute(CURRENT_LINE_ATTR, '');
  };

  /** 🔑 1 フレームに 1 回へ畳む。 */
  function schedule(): void {
    if (frame !== null) return;
    frame =
      view !== null && typeof view.requestAnimationFrame === 'function'
        ? view.requestAnimationFrame(update)
        : (setTimeout(update, 16) as unknown as number);
  }
  const onStart = (): void => {
    composing = true;
  };
  const onEnd = (): void => {
    composing = false;
    schedule();
  };

  doc.addEventListener('selectionchange', schedule);
  doc.addEventListener('focusin', schedule);
  doc.addEventListener('focusout', schedule);
  root.addEventListener('input', schedule);
  root.addEventListener('compositionstart', onStart, true);
  root.addEventListener('compositionend', onEnd, true);
  return () => {
    doc.removeEventListener('selectionchange', schedule);
    doc.removeEventListener('focusin', schedule);
    doc.removeEventListener('focusout', schedule);
    root.removeEventListener('input', schedule);
    root.removeEventListener('compositionstart', onStart, true);
    root.removeEventListener('compositionend', onEnd, true);
    if (frame !== null) {
      if (view !== null && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
      else clearTimeout(frame);
      frame = null;
    }
    clear();
  };
}
