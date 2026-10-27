/**
 * 🔴 **ノートの中だけを探す小さな欄**(#1163 依頼 163 = 採用案 ③)。
 *
 * ## 何が起きるか
 *
 * ノートを開いているとき `Ctrl+F` を押すと、中央ペインの右上に小さな欄が出て、**いま見ているノートの本文の中だけ**を探す。
 * 一致を塗り、「n / m」と数え、`Enter` / `Shift+Enter` で次・前へ送り、`Esc`(または × )で閉じて焦点を元の場所へ戻す。
 * 左の「本文ごと探す」欄(全ノート)へ行く道は `Ctrl+Shift+F` に残してある(ノートを開いていないときの `Ctrl+F` もそちら)。
 *
 * ## 3 つの面を同じ欄で
 *
 * - 読む面の本文(1 件表示。留めた枠 / 並べた枠のときは焦点のある枠)
 * - 編集の 2 ペインのプレビュー(`editor-preview`)
 * - ライブエディタ(`editor-live`)
 * 欄は**どの面でも同じ場所**(中央ペインの右上)に出る ── 面で配置を変えない。出す面は {@link resolveFindTarget} の 1 か所で決める。
 *
 * ## 塗り方は「本文の DOM を 1 バイトも変えない」
 *
 * CSS Custom Highlight API(`CSS.highlights`)で Range を塗りの表へ登録するだけにする(「探す」から送る塗りと同じ作り。
 * 数え方・語の揃え方は `search-jump.ts` の `collectHitRanges` の 1 本 ── 全角と半角・濁点の持ち方を揃えて比べる)。
 * ⚠ 使えないブラウザでは `<mark>` で包んで塗り、閉じる / 数え直すときに**必ず元の節点へ戻す**(`normalize()` まで)。
 * ⚠ 塗りは欄の寿命と同じ:閉じたら表から外す(Range が節点を掴んだまま常駐しない)。
 *
 * ## 本文が描き直されたら数え直す
 *
 * 編集中のプレビューは打つたびに、読む面はノートが変わるたびに描き直される。欄は対象を `MutationObserver` で見て、
 * 落ち着いてから数え直す。対象のノートが無くなった(別の画面へ移った)ら欄ごと閉じる。
 */
import { collectHitRanges, scrollToHit } from './search-jump';
import { BODY_HOST_SELECTOR } from './detail';
import { revealBlock } from './heading-fold';
import { wrapHitIndex } from '@features/filter/search-hits';

/** 当たりの塗り(全部)。⚠ `app.css` の `::highlight(pkc-note-find)` と同じ字。 */
export const NOTE_FIND_HIGHLIGHT = 'pkc-note-find';
/** いま送り先の 1 つ。⚠ `app.css` の `::highlight(pkc-note-find-current)` と同じ字。 */
export const NOTE_FIND_CURRENT_HIGHLIGHT = 'pkc-note-find-current';

/** 本文が描き直されてから数え直すまでの待ち(ms)。打つたびに全部を数え直さない。 */
const RECOUNT_MS = 120;

/**
 * 🔴 **探す対象(いま見ている本文)を決める ── この関数 1 本**(§7 同じ問いに答える場所を複数作らない)。
 *
 * 優先は「ライブエディタ > 2 ペインのプレビュー > 読む面の本文」。複数の枠が並んでいるときは、焦点のある枠
 * (`active` を含む `[data-pkc-region="detail"]` / `split-frame`)を先に取り、無ければ最初の枠。
 * ⚠ 編集の 2 ペインの**原文(textarea)は対象にしない** ── 打っている字そのものは `Ctrl+F` の相手ではなく、
 *   プレビューのほうが「見ている物」である(`collectHitRanges` も textarea は数えない)。
 * @returns ノートが開いていなければ `null`(呼び側は左の探す欄へ回す)
 */
export function resolveFindTarget(root: HTMLElement, active: Element | null): HTMLElement | null {
  const frames = [
    ...root.querySelectorAll<HTMLElement>(
      '[data-pkc-region="center"] [data-pkc-region="split-frame"], [data-pkc-region="center"] [data-pkc-region="detail"]',
    ),
  ];
  const scopes: ParentNode[] = [];
  const mine = active?.closest('[data-pkc-region="split-frame"]') ?? null;
  if (mine !== null) scopes.push(mine);
  scopes.push(...frames, root);
  for (const scope of scopes) {
    const hit =
      scope.querySelector<HTMLElement>('[data-pkc-region="editor-live"]') ??
      scope.querySelector<HTMLElement>('[data-pkc-region="editor-preview"]') ??
      scope.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
    if (hit !== null && hit.closest('[hidden]') === null) return hit;
  }
  return null;
}

interface HighlightRegistry {
  set(name: string, value: unknown): unknown;
  delete(name: string): unknown;
}
type HighlightCtor = new (...ranges: Range[]) => { priority: number; add(range: Range): unknown };

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (css === undefined || css.highlights === undefined) return null;
  if (typeof Highlight !== 'function') return null;
  return { registry: css.highlights, Highlight };
}

function clearHighlights(): void {
  const api = highlightApi();
  if (api === null) return;
  api.registry.delete(NOTE_FIND_HIGHLIGHT);
  api.registry.delete(NOTE_FIND_CURRENT_HIGHLIGHT);
}

function paintHighlights(ranges: readonly Range[], current: number): boolean {
  const api = highlightApi();
  if (api === null) return false;
  if (ranges.length === 0) {
    clearHighlights();
    return true;
  }
  // ⚠ 展開(`new Highlight(...ranges)`)しない ── 引数が多すぎて RangeError になりうる
  const all = new api.Highlight();
  for (const r of ranges) all.add(r);
  api.registry.set(NOTE_FIND_HIGHLIGHT, all);
  const now = ranges[current];
  if (now === undefined) {
    api.registry.delete(NOTE_FIND_CURRENT_HIGHLIGHT);
  } else {
    const strong = new api.Highlight(now);
    strong.priority = 1;
    api.registry.set(NOTE_FIND_CURRENT_HIGHLIGHT, strong);
  }
  return true;
}

const MARK_CLASS = 'pkc-note-find-mark';
const MARK_CURRENT_CLASS = 'pkc-note-find-mark-current';

/**
 * 塗りの表が使えないブラウザ用:Range の中の字を `<mark>` で包む。当たりごとの `<mark>` の並びを返す。
 * ⚠ 後ろの当たりから包む(前の当たりの節点・添字がずれない)。
 */
function wrapWithMarks(ranges: readonly Range[]): HTMLElement[][] {
  const out: HTMLElement[][] = new Array(ranges.length);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    const doc = range.startContainer.ownerDocument!;
    const parts: { node: Text; from: number; to: number }[] = [];
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
      parts.push({ node: range.startContainer as Text, from: range.startOffset, to: range.endOffset });
    } else {
      // 🔑 始点・終点は `collectHitRanges` が必ず text 節点に置く ── 文書順に歩いて、始点から終点までを拾う
      const walker = doc.createTreeWalker(range.commonAncestorContainer, 4);
      let inside = false;
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const t = n as Text;
        if (t === range.startContainer) inside = true;
        if (inside) {
          const len = t.nodeValue?.length ?? 0;
          const from = t === range.startContainer ? range.startOffset : 0;
          const to = t === range.endContainer ? range.endOffset : len;
          if (to > from) parts.push({ node: t, from, to });
        }
        if (t === range.endContainer) break;
      }
    }
    const marks: HTMLElement[] = [];
    for (let k = parts.length - 1; k >= 0; k--) {
      const { node, from, to } = parts[k]!;
      const mid = from > 0 ? node.splitText(from) : node;
      if (to - from < (mid.nodeValue?.length ?? 0)) mid.splitText(to - from);
      const mark = doc.createElement('mark');
      mark.className = MARK_CLASS;
      mid.parentNode?.insertBefore(mark, mid);
      mark.append(mid);
      marks.unshift(mark);
    }
    out[i] = marks;
  }
  return out;
}

/** `<mark>` を元の節点へ戻す(隣り合った字の節点も 1 つに戻す)。 */
function unwrapMarks(groups: readonly (readonly HTMLElement[])[]): void {
  const parents = new Set<Node>();
  for (const g of groups) {
    for (const m of g) {
      const p = m.parentNode;
      if (p === null) continue;
      while (m.firstChild !== null) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      parents.add(p);
    }
  }
  for (const p of parents) (p as Element).normalize?.();
}

/** 欄が出ている間の持ち物。 */
interface Finder {
  readonly root: HTMLElement;
  readonly bar: HTMLElement;
  readonly input: HTMLInputElement;
  readonly count: HTMLElement;
  readonly prev: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  target: HTMLElement | null;
  ranges: Range[];
  marks: HTMLElement[][];
  index: number;
  returnFocus: HTMLElement | null;
  observer: MutationObserver | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const FINDERS = new WeakMap<HTMLElement, Finder>();

function observe(f: Finder): void {
  f.observer?.disconnect();
  if (f.target === null || typeof MutationObserver === 'undefined') return;
  f.observer ??= new MutationObserver((records) => {
    // 🔴 欄自身の変化(件数の字)は数え直さない ── 送るたびに全文を数え直す無駄を作らない
    if (records.every((r) => f.bar.contains(r.target))) return;
    schedule(f);
  });
  // 🔑 対象そのものではなく中央ペインを見る ── ノートを切り替えると対象の器ごと差し替わる(対象の中の変化だけ見ていると気づけない)
  const scope = f.target.closest<HTMLElement>('[data-pkc-region="center"]') ?? f.target;
  f.observer.observe(scope, { childList: true, subtree: true, characterData: true });
}

function schedule(f: Finder): void {
  if (f.timer !== null) clearTimeout(f.timer);
  f.timer = setTimeout(() => {
    f.timer = null;
    recount(f, false);
  }, RECOUNT_MS);
}

/** 塗りと印を全部外す(欄は残す)。 */
function clearPaint(f: Finder): void {
  f.observer?.disconnect();
  clearHighlights();
  unwrapMarks(f.marks);
  f.marks = [];
  f.ranges = [];
}

/** 編集中の面か(ライブエディタ / 2 ペインのプレビュー)。 */
function isEditSurface(el: HTMLElement): boolean {
  return el.matches('[data-pkc-region="editor-live"], [data-pkc-region="editor-preview"]');
}

function label(f: Finder): void {
  const q = f.input.value.trim();
  const total = f.marks.length > 0 ? f.marks.length : f.ranges.length;
  if (q === '') {
    f.count.textContent = '';
    f.input.removeAttribute('aria-invalid');
  } else {
    f.count.textContent = total === 0 ? '0 / 0' : `${f.index + 1} / ${total}`;
    if (total === 0) f.input.setAttribute('aria-invalid', 'true');
    else f.input.removeAttribute('aria-invalid');
  }
  f.prev.disabled = total === 0;
  f.next.disabled = total === 0;
}

function paintCurrent(f: Finder, scroll: boolean): void {
  const total = f.marks.length > 0 ? f.marks.length : f.ranges.length;
  f.index = wrapHitIndex(f.index, total);
  if (f.marks.length > 0) {
    f.marks.forEach((g, i) =>
      g.forEach((m) => m.classList.toggle(MARK_CURRENT_CLASS, i === f.index)),
    );
  } else {
    paintHighlights(f.ranges, f.index);
  }
  label(f);
  if (!scroll || f.target === null || total === 0) return;
  const el =
    f.marks.length > 0
      ? (f.marks[f.index]?.[0] ?? null)
      : (f.ranges[f.index]?.startContainer.parentElement ?? null);
  if (el === null) return;
  // 🔴 畳んだ章の中なら、開いてから送る(「探す」から送るときと同じ作法)
  revealBlock(f.target, el);
  const scroller = scrollerOf(f.target);
  if (f.marks.length > 0) {
    el.scrollIntoView?.({ block: 'center' });
  } else {
    scrollToHit(scroller, f.target, f.ranges[f.index]!);
  }
}

/** 実際にスクロールする祖先(無ければ中央ペイン)。 */
function scrollerOf(target: HTMLElement): HTMLElement {
  for (let el: HTMLElement | null = target; el !== null; el = el.parentElement) {
    const oy = el.ownerDocument.defaultView?.getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') return el;
  }
  return (target.closest('[data-pkc-region="center"]') as HTMLElement | null) ?? target;
}

/**
 * 数え直して塗る。
 * @param fresh 打ち直した(先頭の当たりへ送る)。`false` = 本文が描き直された(いまの位置を保つ)
 */
function recount(f: Finder, fresh: boolean): void {
  clearPaint(f);
  // 🔑 前に見ていた枠を手がかりにする(別の枠へ焦点が移っても、探している枠を取り違えない)
  const target = resolveFindTarget(f.root, f.target ?? f.returnFocus);
  if (target === null) {
    // 見ていたノートが無くなった(別の画面へ移った)── 欄ごと閉じる
    closeNoteFind(f.root, false);
    return;
  }
  // 🔑 対象の器が替わった(ノートの切り替え / 読む面 ⇄ 編集面)── 位置は引き継がず、先頭から数え直す
  const replaced = f.target !== target;
  f.target = target;
  const q = f.input.value.trim();
  if (q !== '') {
    f.ranges = collectHitRanges(target, q, 'phrase');
    // 🔴 `<mark>` で包むのは読む面だけ。編集面(ライブエディタ / 2 ペインのプレビュー)は打つたびに描き直され、行の対応を持つので、
    //   本文へ字や節点を混ぜる道を断つ ── 塗れないブラウザでは件数と送り(スクロール)だけにする
    if (f.ranges.length > 0 && highlightApi() === null && !isEditSurface(target)) {
      f.marks = wrapWithMarks(f.ranges);
      f.ranges = [];
    }
  }
  if (fresh || replaced) f.index = 0;
  paintCurrent(f, fresh || replaced);
  observe(f);
}

function step(f: Finder, by: number): void {
  const total = f.marks.length > 0 ? f.marks.length : f.ranges.length;
  if (total === 0) return;
  f.index = wrapHitIndex(f.index + by, total);
  paintCurrent(f, true);
}

function build(root: HTMLElement): Finder {
  const doc = root.ownerDocument;
  const bar = doc.createElement('div');
  bar.className = 'pkc-note-find';
  bar.setAttribute('data-pkc-region', 'note-find');
  bar.setAttribute('role', 'search');
  bar.setAttribute('aria-label', 'このノートの中を探す');

  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'pkc-note-find-input';
  input.setAttribute('data-pkc-field', 'note-find-input');
  input.setAttribute('aria-label', 'このノートの中を探す');
  input.placeholder = 'このノートの中を探す';
  input.autocomplete = 'off';
  input.spellcheck = false;

  const count = doc.createElement('span');
  count.className = 'pkc-note-find-count';
  count.setAttribute('data-pkc-field', 'note-find-count');
  count.setAttribute('aria-live', 'polite');

  const btn = (text: string, name: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'pkc-note-find-btn';
    b.setAttribute('aria-label', name);
    b.title = name;
    b.textContent = text;
    return b;
  };
  const prev = btn('‹', '前の一致へ(Shift+Enter / Ctrl+Shift+G)');
  prev.setAttribute('data-pkc-field', 'note-find-prev');
  const next = btn('›', '次の一致へ(Enter / Ctrl+G)');
  next.setAttribute('data-pkc-field', 'note-find-next');
  const end = btn('×', '閉じる(Esc)');
  end.setAttribute('data-pkc-field', 'note-find-close');
  bar.append(input, count, prev, next, end);

  const f: Finder = {
    root,
    bar,
    input,
    count,
    prev,
    next,
    target: null,
    ranges: [],
    marks: [],
    index: 0,
    returnFocus: null,
    observer: null,
    timer: null,
  };

  input.addEventListener('input', () => recount(f, true));
  input.addEventListener('keydown', (ev) => {
    // 日本語入力の変換確定の Enter は送りに使わない(Safari は確定の Enter が `isComposing: false` で `keyCode` だけ 229 になる。binder.ts と同じ門)
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      step(f, ev.shiftKey ? -1 : 1);
    } else if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.code === 'KeyG' || ev.key.toLowerCase() === 'g')) {
      // 🔴 Ctrl+G / Ctrl+Shift+G でも次・前へ(#1102 段③。「探す」から来た一致の送りと同じ鍵)。ブラウザの「ページ内を検索」の既定を止める
      ev.preventDefault();
      ev.stopPropagation();
      step(f, ev.shiftKey ? -1 : 1);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      // ⚠ 背後の「ノートを閉じる」(Esc)を巻き込まない
      ev.stopPropagation();
      closeNoteFind(root, true);
    }
  });
  prev.addEventListener('click', () => step(f, -1));
  next.addEventListener('click', () => step(f, 1));
  end.addEventListener('click', () => closeNoteFind(root, true));
  return f;
}

/** 欄が出ているか。 */
export function isNoteFindOpen(root: HTMLElement): boolean {
  return FINDERS.has(root);
}

/** 探せる本文(ノート)があるか。⚠ パレットの「押せるか」(`dry`)の答えにも使う。 */
export function canNoteFind(root: HTMLElement): boolean {
  return resolveFindTarget(root, root.ownerDocument.activeElement) !== null;
}

/**
 * 欄を出す(出ているなら欄へ焦点を戻して全選択)。
 * @returns 探せる本文が無いとき `false`(呼び側は左の探す欄へ回す)
 */
export function openNoteFind(root: HTMLElement): boolean {
  const doc = root.ownerDocument;
  let existing = FINDERS.get(root);
  // 欄が画面から外れていた(中央ペインごと組み直された)なら、持ち物を捨てて組み直す
  if (existing !== undefined && !existing.bar.isConnected) {
    closeNoteFind(root, false);
    existing = undefined;
  }
  if (existing !== undefined) {
    existing.input.focus();
    existing.input.select();
    return true;
  }
  const target = resolveFindTarget(root, doc.activeElement);
  if (target === null) return false;
  const f = build(root);
  const active = doc.activeElement;
  f.returnFocus = active instanceof HTMLElement && active !== doc.body ? active : null;
  f.target = target;
  FINDERS.set(root, f);
  (root.querySelector<HTMLElement>('[data-pkc-region="center"]') ?? root).append(f.bar);
  observe(f);
  // 選択している字があれば、それを探す語の初期値にする(ブラウザの検索と同じ)
  const sel = doc.getSelection?.()?.toString().trim() ?? '';
  if (sel !== '' && sel.length <= 200 && !sel.includes('\n')) {
    f.input.value = sel;
    recount(f, true);
  }
  f.input.focus();
  f.input.select();
  return true;
}

/**
 * 欄を閉じる。塗りも印も全部外す。
 * @param restoreFocus 開く前に焦点のあった場所へ戻す(`Esc` / × )。⚠ 画面が変わって閉じるときは戻さない
 */
export function closeNoteFind(root: HTMLElement, restoreFocus: boolean): void {
  const f = FINDERS.get(root);
  if (f === undefined) return;
  FINDERS.delete(root);
  if (f.timer !== null) clearTimeout(f.timer);
  clearPaint(f);
  f.observer = null;
  f.bar.remove();
  const back = f.returnFocus;
  if (restoreFocus && back !== null && back.isConnected) back.focus();
}
