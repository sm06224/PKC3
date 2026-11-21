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

/** `background-attachment: local` を描けるか(分からない環境は「描ける」とみなす ── 現行のブラウザはすべて描ける)。 */
export function supportsLocalBackground(view: Window | null): boolean {
  try {
    const css = (view as (Window & { CSS?: { supports?: (p: string, v: string) => boolean } }) | null)?.CSS;
    return typeof css?.supports !== 'function' ? true : css.supports('background-attachment', 'local');
  } catch {
    return true;
  }
}

export interface CurrentLineDeps {
  /** 読むたびに保存を見る(別のタブの変更に追随する)。 */
  enabled(): boolean;
}

export interface Mirror {
  readonly el: HTMLElement;
  readonly text: Text;
  /** 字の形・幅を写したときの鍵(変わっていなければ写し直さない)。 */
  styleKey: string;
}

/** 測りの控え(caret の行の頭と、その上端)。同じ行の中で打つ間は上端が動かないので、全文の影を使わず行だけ測る。 */
export interface LineCache {
  ta: HTMLTextAreaElement;
  from: number;
  /** `from` より前の字(これが変わっていなければ、行の上端は動いていない)。 */
  prefix: string;
  top: number;
  key: string;
  /** 前回測った本文・行末・高さ(caret だけ同じ行の中で動いたとき、何も測らず返す)。 */
  value: string;
  to: number;
  height: number;
}

export function createMirror(doc: Document): Mirror {
  const el = doc.createElement('div');
  el.setAttribute('data-pkc-field', MIRROR_FIELD);
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;top:0;left:-9999px;white-space:pre-wrap;overflow-wrap:break-word;';
  const text = doc.createTextNode('');
  el.append(text);
  doc.body.append(el);
  return { el, text, styleKey: '' };
}

/** 影の字の形・幅を欄に合わせる(鍵が同じなら何もしない)。 */
function styleMirror(m: Mirror, ta: HTMLTextAreaElement, cs: CSSStyleDeclaration): string {
  const width = ta.clientWidth + ta.clientLeft * 2;
  const key = [width, cs.fontFamily, cs.fontSize, cs.fontWeight, cs.lineHeight, cs.letterSpacing, cs.tabSize, cs.paddingLeft, cs.paddingRight, cs.paddingTop].join('|');
  if (m.styleKey !== key) {
    const el = m.el;
    for (const p of MIRROR_PROPS) el.style[p as never] = (cs[p as never] ?? '') as never;
    // 折り返す幅は、欄の中身の幅(縦のスクロールバーを除く)── 欄と同じ所で折り返すために
    el.style.boxSizing = 'border-box';
    el.style.overflowX = 'hidden';
    el.style.overflowY = 'hidden';
    el.style.width = `${String(width)}px`;
    m.styleKey = key;
  }
  return key;
}

/** `m` の [start, end) の縦の箱(行の高さの余白込み)と、`m` の上端からの位置。 */
function boxIn(m: Mirror, doc: Document, cs: CSSStyleDeclaration, start: number, end: number): { top: number; height: number } | null {
  const range = doc.createRange();
  range.setStart(m.text, start);
  range.setEnd(m.text, Math.min(end, m.text.length));
  const box = boxOfRects([...range.getClientRects()]);
  if (box === null) return null;
  const origin = m.el.getBoundingClientRect().top + m.el.clientTop;
  // 矩形は字の箱(フォントの高さ)── 行の高さ(line-height)の上下の余白を足して、行の箱にする
  const lh = Number.parseFloat(cs.lineHeight);
  const pad = Number.isFinite(lh) && lh > box.height ? (lh - box.height) / 2 : 0;
  return { top: box.top - origin - pad, height: box.height + pad * 2 };
}

/**
 * 欄の `ta`、caret の行の縦の箱(欄の padding box の左上が原点)を測る。測れなければ `null`。
 *
 * 🔑 **同じ行の中で打っている間は、全文の影を使わない**(5000 行で 1 打鍵あたり +17ms だった主因は、全文の影の組み直し)。
 *   行の上端は「行より前の字」と幅・字の形だけで決まるので、それらが前回と同じなら上端は控えを使い、
 *   **この行だけを入れた小さい影(`line`)で高さだけ**測る(折り返しは行の中の字だけで決まる)。
 *   行が替わった / 行より前の字が変わった / 幅や字の形が変わったときだけ、全文の影(`full`)で測り直す。
 */
export function measureCurrentLine(
  ta: HTMLTextAreaElement,
  mirrors: { full: Mirror; line: Mirror },
  cache: { current: LineCache | null },
): { top: number; height: number } | null {
  const doc = ta.ownerDocument;
  const cs = doc.defaultView?.getComputedStyle(ta);
  if (cs === undefined) return null;
  const value = ta.value;
  const { from, to } = currentLineRange(value, ta.selectionStart);
  const key = [ta.clientWidth, cs.fontFamily, cs.fontSize, cs.lineHeight, cs.paddingLeft, cs.paddingRight, cs.letterSpacing].join('|');
  const c = cache.current;
  // 最速の道: 本文も行も幅も字の形も同じ(caret が同じ行の中で動いただけ)── 何も測らない
  if (c !== null && c.ta === ta && c.from === from && c.to === to && c.key === key && c.value === value) {
    return { top: c.top, height: c.height };
  }
  if (c !== null && c.ta === ta && c.from === from && c.key === key && value.startsWith(c.prefix)) {
    // 速い道: 行だけ測る
    styleMirror(mirrors.line, ta, cs);
    patchText(mirrors.line.text, value.slice(from, to) + ZWSP);
    const b = boxIn(mirrors.line, doc, cs, 0, mirrors.line.text.length);
    if (b !== null) {
      cache.current = { ...c, to, value, height: b.height };
      return { top: c.top, height: b.height };
    }
  }
  styleMirror(mirrors.full, ta, cs);
  patchText(mirrors.full.text, value + ZWSP);
  // 行末の `\n`(最後の行なら末尾の ZWSP)まで含める ── 空の行にも箱ができる
  const b = boxIn(mirrors.full, doc, cs, from, to + 1);
  if (b === null) {
    cache.current = null;
    return null;
  }
  cache.current = { ta, from, prefix: value.slice(0, from), top: b.top, key, value, to, height: b.height };
  return b;
}

/**
 * root で 1 か所受ける。返す関数で全部外す(影も消える)。
 * ⚠ 焦点が欄に在るあいだだけ影を持つ。
 */
export function bindCurrentLine(root: HTMLElement, deps: CurrentLineDeps): () => void {
  const doc = root.ownerDocument;
  // 🔴 線は `background-attachment: local`(内容といっしょにスクロールする背景)に頼る ── 使えない環境では、
  //   線が欄の上端に貼り付いて**違う行に出る**ので、描かない(何も束ねない)
  if (!supportsLocalBackground(doc.defaultView)) return () => undefined;
  const view = doc.defaultView; // ⚠ window の resize は聞かない(欄の幅の変化は ResizeObserver が拾う。常時の聞き手を増やさない)
  let mirrors: { full: Mirror; line: Mirror } | null = null;
  const cache: { current: LineCache | null } = { current: null };
  let current: HTMLTextAreaElement | null = null;
  let frame: number | null = null;
  let composing = false;
  let observer: ResizeObserver | null = null;
  let attrObserver: MutationObserver | null = null;

  const dropMirror = (): void => {
    mirrors?.full.el.remove();
    mirrors?.line.el.remove();
    mirrors = null;
    cache.current = null;
  };
  const clear = (): void => {
    if (current !== null) {
      current.removeAttribute(CURRENT_LINE_ATTR);
      current.style.removeProperty(CURRENT_LINE_TOP_VAR);
      current.style.removeProperty(CURRENT_LINE_HEIGHT_VAR);
    }
    observer?.disconnect();
    attrObserver?.disconnect();
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
    if (ta === null || !ta.isConnected || !deps.enabled()) {
      // 別の欄へ移った / 設定で切った: 印も影も外す
      clear();
      return;
    }
    if (ta.selectionStart !== ta.selectionEnd) {
      // 🔴 選び中は**印だけ**外す(影・控え・聞き手は残す ── Shift+矢印のたびに全文の影を作り直さない)
      ta.removeAttribute(CURRENT_LINE_ATTR);
      return;
    }
    if (current !== ta) {
      clear();
      current = ta;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => schedule());
        observer.observe(ta);
      }
      // 字の大きさ・配色の切り替え(`<html>` の属性 / inline の変数)は欄の大きさを変えないことがある ── 属性の変化でも測り直す。
      // ⚠ 欄に焦点が在る間だけ張る(`clear` で外す)
      if (typeof MutationObserver !== 'undefined') {
        attrObserver = new MutationObserver(() => schedule());
        attrObserver.observe(doc.documentElement, { attributes: true });
      }
    }
    mirrors ??= { full: createMirror(doc), line: createMirror(doc) };
    const box = measureCurrentLine(ta, mirrors, cache);
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
