/**
 * 🔴 **上側に出すツールチップ**(#1982 A3)。既存の `title` 属性を**自動で**引き上げる。
 *
 * > user 指示 2026-11-22:大きいマウスカーソルでも読めるよう、ツールチップは対象とポインタの
 * > **上**に出す。上に収まらないときは下へ落とさず横へ。
 *
 * ## 仕組み(浮かぶ要素 1 枚 + 委譲)
 * - 要素は document に 1 枚だけ(`data-pkc-region="tooltip"`)。`pointerover` / `focusin` を委譲で拾う。
 * - 🔑 **載せている間だけ** `title` を `data-pkc-tip-title` へ退避する(ブラウザ標準の吹き出しを出さない)。
 *   離れたら戻す ── 載っていないとき DOM・test・アクセシブルネームは今までと同じ。
 * - `aria-label` が無い要素には、出している間だけ `aria-describedby` を張る(離れたら外す)。
 * - 載せている間に `title` が書き直されたら**新しい方を残し**、退避は捨てる(コードがヒントを更新する場面)。
 * - 対象が DOM から消えたら隠す。400ms 待って出し、離れる・押す・スクロール・Esc で即消す。
 *   タッチ(`pointerType: touch` / `hover: none`)では出さない。
 * 置き場所の計算は `features/tooltip/placement.ts`(純関数)。
 */
import { computeTipPlacement } from '@features/tooltip/placement';

export const TIP_STASH_ATTR = 'data-pkc-tip-title';
export const TIP_ID = 'pkc-tooltip';
const SHOW_DELAY_MS = 400;

export interface TooltipOptions {
  readonly delayMs?: number;
}

export function installTooltip(doc: Document = document, opts: TooltipOptions = {}): () => void {
  const win = doc.defaultView;
  if (win === null) return () => undefined;
  const delay = opts.delayMs ?? SHOW_DELAY_MS;

  let tip: HTMLElement | null = null;
  let current: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  let addedDescribedBy = false;
  let observer: MutationObserver | null = null;
  const pointer = { x: 0, y: 0 };

  const ensureTip = (): HTMLElement => {
    if (tip !== null && tip.isConnected) return tip;
    const el = doc.createElement('div');
    el.id = TIP_ID;
    el.setAttribute('role', 'tooltip');
    el.setAttribute('data-pkc-region', 'tooltip');
    el.hidden = true;
    doc.body.appendChild(el);
    tip = el;
    return el;
  };

  const hoverNone = (): boolean => {
    try {
      return typeof win.matchMedia === 'function' && win.matchMedia('(hover: none)').matches;
    } catch {
      return false;
    }
  };

  const hide = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    observer?.disconnect();
    observer = null;
    const el = current;
    current = null;
    if (el !== null) {
      if (addedDescribedBy) {
        if (el.getAttribute('aria-describedby') === TIP_ID) el.removeAttribute('aria-describedby');
      }
      const stash = el.getAttribute(TIP_STASH_ATTR);
      if (stash !== null) {
        // 載せている間に書き直されていたら、新しい方を残す(退避は捨てる)
        if (!el.hasAttribute('title')) el.setAttribute('title', stash);
        el.removeAttribute(TIP_STASH_ATTR);
      }
    }
    addedDescribedBy = false;
    shown = false;
    if (tip !== null) {
      tip.hidden = true;
      tip.removeAttribute('data-pkc-tip-side');
    }
  };

  const show = (): void => {
    timer = null;
    const el = current;
    if (el === null || !el.isConnected) {
      hide();
      return;
    }
    const text = el.getAttribute(TIP_STASH_ATTR) ?? '';
    if (text === '') return;
    const t = ensureTip();
    t.textContent = text;
    t.style.left = '0px';
    t.style.top = '0px';
    t.style.visibility = 'hidden';
    t.hidden = false;
    const tr = el.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const place = computeTipPlacement({
      target: tr,
      pointer,
      tip: { width: r.width, height: r.height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
    });
    t.style.left = `${Math.round(place.x)}px`;
    t.style.top = `${Math.round(place.y)}px`;
    t.setAttribute('data-pkc-tip-side', place.side);
    t.style.visibility = '';
    shown = true;
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-describedby')) {
      el.setAttribute('aria-describedby', TIP_ID);
      addedDescribedBy = true;
    }
  };

  const begin = (el: HTMLElement): void => {
    if (el === current) return;
    hide();
    const title = el.getAttribute('title');
    if (title === null || title === '') return;
    current = el;
    el.setAttribute(TIP_STASH_ATTR, title);
    el.removeAttribute('title');
    observer = new win.MutationObserver(() => {
      if (current !== null && !current.isConnected) hide();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    timer = setTimeout(show, delay);
  };

  const targetOf = (n: EventTarget | null): HTMLElement | null => {
    if (!(n instanceof win.Element)) return null;
    if (n.closest(`#${TIP_ID}`) !== null) return null;
    return n.closest<HTMLElement>('[title]') ?? n.closest<HTMLElement>(`[${TIP_STASH_ATTR}]`);
  };

  const onOver = (e: Event): void => {
    const pe = e as PointerEvent;
    if (pe.pointerType === 'touch' || hoverNone()) return;
    pointer.x = pe.clientX;
    pointer.y = pe.clientY;
    const el = targetOf(e.target);
    if (el === null) {
      hide();
      return;
    }
    begin(el);
  };
  const onMove = (e: Event): void => {
    const pe = e as PointerEvent;
    if (pe.pointerType === 'touch') return;
    pointer.x = pe.clientX;
    pointer.y = pe.clientY;
  };
  const onOut = (e: Event): void => {
    if (current === null) return;
    const rel = (e as PointerEvent).relatedTarget;
    if (rel instanceof win.Node && current.contains(rel)) return;
    hide();
  };
  const onFocusIn = (e: Event): void => {
    if (hoverNone()) return;
    const el = targetOf(e.target);
    if (el === null) return;
    const r = el.getBoundingClientRect();
    pointer.x = (r.left + r.right) / 2;
    pointer.y = (r.top + r.bottom) / 2;
    begin(el);
  };
  const onFocusOut = (): void => hide();
  const onPointerDown = (): void => hide();
  const onScroll = (): void => {
    if (current !== null || shown) hide();
  };
  const onKey = (e: Event): void => {
    if ((e as KeyboardEvent).key === 'Escape' && (current !== null || shown)) hide();
  };

  doc.addEventListener('pointerover', onOver, true);
  doc.addEventListener('pointermove', onMove, true);
  doc.addEventListener('pointerout', onOut, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('scroll', onScroll, true);
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('blur', onFocusOut);

  return () => {
    hide();
    doc.removeEventListener('pointerover', onOver, true);
    doc.removeEventListener('pointermove', onMove, true);
    doc.removeEventListener('pointerout', onOut, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('scroll', onScroll, true);
    doc.removeEventListener('keydown', onKey, true);
    win.removeEventListener('blur', onFocusOut);
    tip?.remove();
    tip = null;
  };
}
