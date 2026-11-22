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
 * - 退避の間 `aria-label` も中身の文字も無い要素は名前を失うので、同じ字を `aria-label` へ一時付与する
 *   (戻すとき**自分が付けた値のままなら**外す)。`aria-label` が無い要素には出している間だけ
 *   `aria-describedby` を張る(既にある要素には触らない)。
 * - 🔑 **最前面**: 要素は `popover="manual"` で top layer へ載せる(`showModal()` のダイアログの前に出る)。
 *   開いているダイアログの中の対象では、ダイアログの子として載せる(modal 外の要素は inert になるため)。
 *   `popover` が無い環境では、ダイアログ内ならダイアログの子へ移す。
 * - 🔑 **退避中の `title` の書き換え**: `MutationObserver` で拾い、新しい字で退避を置き換えて再び外す
 *   (表示中なら字を更新)。**消す**ことは退避中は属性が無く見えないので、呼び出し側は
 *   `setTipTitle(el, null)` を使う(`getTipTitle` は退避中でも今の字を返す)。
 * - フォーカス経由は「直前の入力がキーボード」か `:focus-visible` のときだけ(クリックで出さない)。
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

/** 今の説明文。表示中(退避中)でも `title` と同じ字を返す。 */
export function getTipTitle(el: Element): string {
  return el.getAttribute(TIP_STASH_ATTR) ?? el.getAttribute('title') ?? '';
}

/**
 * 説明文を書く / 消す(`null` か空で消す)。ツールチップ表示中の要素は `title` が退避されていて
 * `removeAttribute('title')` では消せない(復元で古い字が戻る)ので、**消す経路はこの口を使う**。
 */
export function setTipTitle(el: Element, text: string | null): void {
  const clear = text === null || text === '';
  if (el.hasAttribute(TIP_STASH_ATTR)) {
    if (clear) el.removeAttribute(TIP_STASH_ATTR);
    else el.setAttribute(TIP_STASH_ATTR, text);
    el.removeAttribute('title');
    return;
  }
  if (clear) el.removeAttribute('title');
  else el.setAttribute('title', text);
}

/** 中身から名前が取れる要素か(字 / alt のある img / aria-label か title を持つ svg)。 */
function hasOwnName(el: Element): boolean {
  if ((el.textContent ?? '').trim() !== '') return true;
  return el.querySelector('img[alt]:not([alt=""]), svg[aria-label], svg title') !== null;
}

export function installTooltip(doc: Document = document, opts: TooltipOptions = {}): () => void {
  const win = doc.defaultView;
  if (win === null) return () => undefined;
  const delay = opts.delayMs ?? SHOW_DELAY_MS;
  const canPopover = typeof win.HTMLElement.prototype.showPopover === 'function';

  let tip: HTMLElement | null = null;
  let current: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  let addedDescribedBy = false;
  /** 自分が付けた一時の `aria-label`(null = 付けていない)。 */
  let tempLabel: string | null = null;
  let lastText = '';
  let attrObserver: MutationObserver | null = null;
  let removeObserver: MutationObserver | null = null;
  let keyboardInput = false;
  const pointer = { x: 0, y: 0 };

  // hover: none は変わらない(端末の性質)── 毎回 matchMedia を引かず、change で更新する
  let hoverNoneValue = false;
  let mql: MediaQueryList | null = null;
  const onMql = (e: MediaQueryListEvent): void => {
    hoverNoneValue = e.matches;
  };
  try {
    if (typeof win.matchMedia === 'function') {
      mql = win.matchMedia('(hover: none)');
      hoverNoneValue = mql.matches;
      mql.addEventListener?.('change', onMql);
    }
  } catch {
    mql = null;
  }
  const hoverNone = (): boolean => hoverNoneValue;

  const hostOf = (el: Element): HTMLElement => {
    const dlg = el.closest('dialog[open]');
    return dlg instanceof win.HTMLElement ? dlg : doc.body;
  };

  const ensureTip = (host: HTMLElement): HTMLElement => {
    if (tip === null || !tip.isConnected) {
      const el = doc.createElement('div');
      el.id = TIP_ID;
      el.setAttribute('role', 'tooltip');
      el.setAttribute('data-pkc-region', 'tooltip');
      if (canPopover) el.setAttribute('popover', 'manual');
      el.hidden = true;
      tip = el;
    }
    if (tip.parentElement !== host) host.appendChild(tip);
    return tip;
  };

  const closePopover = (t: HTMLElement): void => {
    if (!canPopover) return;
    try {
      if (t.matches(':popover-open')) t.hidePopover();
    } catch {
      /* 閉じていた */
    }
  };

  const hide = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    attrObserver?.disconnect();
    attrObserver = null;
    removeObserver?.disconnect();
    removeObserver = null;
    const el = current;
    current = null;
    if (el !== null) {
      if (addedDescribedBy) {
        if (el.getAttribute('aria-describedby') === TIP_ID) el.removeAttribute('aria-describedby');
      }
      if (tempLabel !== null && el.getAttribute('aria-label') === tempLabel) el.removeAttribute('aria-label');
      const stash = el.getAttribute(TIP_STASH_ATTR);
      if (stash !== null) {
        // 載せている間に書き直されていたら、新しい方を残す(退避は捨てる)
        if (!el.hasAttribute('title')) el.setAttribute('title', stash);
        el.removeAttribute(TIP_STASH_ATTR);
      }
    }
    tempLabel = null;
    addedDescribedBy = false;
    shown = false;
    if (tip !== null) {
      closePopover(tip);
      tip.hidden = true;
      tip.removeAttribute('data-pkc-tip-side');
    }
  };

  const place = (el: HTMLElement, text: string): void => {
    const t = ensureTip(hostOf(el));
    t.textContent = text;
    t.style.left = '0px';
    t.style.top = '0px';
    t.style.visibility = 'hidden';
    t.hidden = false;
    if (canPopover) {
      try {
        if (!t.matches(':popover-open')) t.showPopover();
      } catch {
        /* 接続前など。fixed のまま出す */
      }
    }
    const tr = el.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const p = computeTipPlacement({
      target: tr,
      pointer,
      tip: { width: r.width, height: r.height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
    });
    t.style.left = `${Math.round(p.x)}px`;
    t.style.top = `${Math.round(p.y)}px`;
    t.setAttribute('data-pkc-tip-side', p.side);
    t.style.visibility = '';
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
    place(el, text);
    shown = true;
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-describedby')) {
      el.setAttribute('aria-describedby', TIP_ID);
      addedDescribedBy = true;
    }
    // 消える対象の検知はここから(載せた直後の待ちの間は張らない。待ち明けの isConnected で足りる)
    removeObserver?.disconnect();
    removeObserver = new win.MutationObserver(() => {
      if (current !== null && !current.isConnected) hide();
    });
    removeObserver.observe(doc.documentElement, { childList: true, subtree: true });
  };

  /** 退避中の `title` / 退避属性の変化を取り込む(書き換え → 置き換え、消去 → 破棄)。 */
  const resync = (): void => {
    const el = current;
    if (el === null) return;
    const written = el.getAttribute('title');
    if (written !== null) {
      el.removeAttribute('title');
      if (written === '') el.removeAttribute(TIP_STASH_ATTR);
      else el.setAttribute(TIP_STASH_ATTR, written);
    }
    const text = el.getAttribute(TIP_STASH_ATTR);
    if (text === null || text === '') {
      el.removeAttribute(TIP_STASH_ATTR);
      hide(); // 退避が無いので何も戻らない
      return;
    }
    if (text === lastText) return;
    if (tempLabel !== null && el.getAttribute('aria-label') === tempLabel) {
      el.setAttribute('aria-label', text);
      tempLabel = text;
    }
    lastText = text;
    if (shown) place(el, text);
  };

  const begin = (el: HTMLElement): void => {
    if (el === current) return;
    hide();
    const title = el.getAttribute('title');
    if (title === null || title === '') return;
    current = el;
    lastText = title;
    el.setAttribute(TIP_STASH_ATTR, title);
    el.removeAttribute('title');
    // title を外している間の名前: 名前も中身の字も無い要素にだけ、同じ字を一時付与
    if (
      !el.hasAttribute('aria-label') &&
      !el.hasAttribute('aria-labelledby') &&
      !hasOwnName(el)
    ) {
      el.setAttribute('aria-label', title);
      tempLabel = title;
    }
    attrObserver = new win.MutationObserver(resync);
    attrObserver.observe(el, { attributes: true, attributeFilter: ['title', TIP_STASH_ATTR] });
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
  const focusVisible = (el: HTMLElement): boolean => {
    try {
      return el.matches(':focus-visible');
    } catch {
      return false;
    }
  };
  const onFocusIn = (e: Event): void => {
    if (hoverNone()) return;
    const el = targetOf(e.target);
    if (el === null) return;
    // クリックで移ったフォーカス・モーダルの開閉に伴うフォーカス移動では出さない
    if (!keyboardInput && !focusVisible(el)) return;
    const r = el.getBoundingClientRect();
    pointer.x = (r.left + r.right) / 2;
    pointer.y = (r.top + r.bottom) / 2;
    begin(el);
  };
  const onFocusOut = (): void => hide();
  const onPointerDown = (): void => {
    keyboardInput = false;
    hide();
  };
  const onScroll = (): void => {
    if (current !== null || shown) hide();
  };
  const onKey = (e: Event): void => {
    keyboardInput = true;
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
    mql?.removeEventListener?.('change', onMql);
    tip?.remove();
    tip = null;
  };
}
