/**
 * 🔴 **右のペインの目次で、いま読んでいる見出しを光らせる**(#1966 2-B 案 1)。
 *
 * 実測(#1966 のコメント): 右のペインの目次には現在地の印が無く、40 見出しのノートでは
 * 「いまどの章を読んでいるか」を目次から読み取れなかった。
 *
 * ## 作り
 * - 判定は **クイック目次と同じ 1 本**(`pickActiveHeading`)── 2 つの目次で光る章が食い違わない
 * - 光らせる印は行(`inspector-toc-item`)の `data-pkc-active` と、押し口の `aria-current="location"`
 * - 光った行が目次の枠の外なら、**目次の枠の中だけ**を送って見える所へ寄せる
 *
 * ## 🔴 守ること(user 指示 2026-11-16)
 * - **採寸は 1 描画フレームに 1 回まで** ── 送りの度に来る `scroll` は rAF 1 本に畳む。
 *   採寸(読む)を全部先に済ませてから印・送り(書く)をする(読み書きを交互にしない)。
 * - **本文の送りに触らない** ── `scrollIntoView` は祖先の送り全部(= 本文)まで動かすので使わない。
 *   書くのは目次の枠(`dd[data-pkc-field="inspector-toc"]`)の `scrollTop` だけ。
 * - 目次が見えていない(右のペインを畳んだ・見出しが無い)ときは採寸しない。
 *
 * ## どの送りを見るか
 * `scroll` は泡立たないので、document で**捕捉段**に 1 本だけ張り、本文の器を含む(または本文の器そのものの)
 * 送りだけを拾う ── 読む面(`detail-body`)・2 ペインの編集のプレビュー・1 ペインの編集(`editor-live`)。
 * ⚠ 横に並べた留めた枠(`split-body`)は別のノートなので拾わない。本文の中の表やコードの横送りも拾わない
 *   (本文の器を含まないので外れる)。
 */
import { pickActiveHeading } from './active-heading-dom';

/** 光った行の印(CSS が読む)。 */
export const INSPECTOR_TOC_ACTIVE_ATTR = 'data-pkc-active';

/** 目次の見出しが住む本文の器(読む面・2 ペインのプレビュー・1 ペインの編集)。 */
const CONTENT_SELECTOR =
  '[data-pkc-region="editor-preview"], [data-pkc-region="editor-live"], [data-pkc-field="detail-body"]';
const HEADING_SELECTOR = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]';

export interface InspectorTocSpy {
  /** 描き直し(本文・目次)の後に、1 フレーム後で印を付け直す。 */
  refresh: () => void;
  dispose: () => void;
}

/** 入れた spy(1 画面に 1 つ)。描き直しの側は `requestInspectorTocSpy()` だけを呼ぶ。 */
let installed: InspectorTocSpy | null = null;

/** 本文・目次を描き直したときに呼ぶ(spy が居なければ何もしない)。 */
export function requestInspectorTocSpy(): void {
  installed?.refresh();
}

interface Frame {
  readonly content: HTMLElement;
  readonly scroller: HTMLElement;
}

/**
 * 送りの起きた器から、本文の器と送りの器を引く。本文の器に関係しない送りなら `null`。
 * ⚠ 一覧(左のペイン)の送りで、その中を `querySelector` で舐めない ── 中央の面(`detail`)の中か、
 *   面を丸ごと含む外の器(スマホの 1 ページ送り)のときだけ探す。
 */
function frameOf(target: EventTarget | null, detail: HTMLElement | null): Frame | null {
  if (!(target instanceof HTMLElement) || detail === null) return null;
  if (target.matches(CONTENT_SELECTOR)) return { content: target, scroller: target };
  const scope = detail.contains(target) ? target : target.contains(detail) ? detail : null;
  const content = scope?.querySelector<HTMLElement>(CONTENT_SELECTOR) ?? null;
  return content === null ? null : { content, scroller: target };
}

/** 送りが無い(開いた直後・描き直し)ときの器 ── 本文の器と、`detail.ts` の `scroller` と同じ規則の送り。 */
function defaultFrame(root: HTMLElement): Frame | null {
  const content = root.querySelector<HTMLElement>(CONTENT_SELECTOR);
  if (content === null) return null;
  // 2 ペインのプレビューは自分で送る(左の欄に合わせて送られる)
  if (content.matches('[data-pkc-region="editor-preview"]')) return { content, scroller: content };
  const scroller =
    content.closest<HTMLElement>('[data-pkc-region="split-frame"]') ??
    content.closest<HTMLElement>('[data-pkc-region="detail"]') ??
    content;
  return { content, scroller };
}

export function installInspectorTocSpy(
  root: HTMLElement,
  raf: (cb: () => void) => number = (cb) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : (setTimeout(cb, 0) as unknown as number),
  caf: (id: number) => void = (id) =>
    typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id),
): InspectorTocSpy {
  const doc = root.ownerDocument;
  let rafId: number | null = null;
  let last: Frame | null = null;
  let activeSlug: string | null = null;
  let reveal = false;

  const paint = (): void => {
    rafId = null;
    const box = root.querySelector<HTMLElement>('[data-pkc-field="inspector-toc"]');
    if (box === null || box.hidden) return;
    const links = Array.from(box.querySelectorAll<HTMLElement>('[data-pkc-field="inspector-toc-link"]'));
    if (links.length === 0) return;
    // ⚠ 右のペインを畳んでいる(箱が無い)ときは採寸しない
    if (box.getClientRects().length === 0) return;
    const frame = last !== null && last.content.isConnected && last.scroller.isConnected ? last : defaultFrame(root);
    if (frame === null) return;

    // ── 読む(採寸はここだけ)──
    const slugs = new Set(links.map((l) => l.getAttribute('data-pkc-toc-slug') ?? ''));
    const headings: HTMLElement[] = [];
    const seen = new Set<string>();
    for (const h of Array.from(frame.content.querySelectorAll<HTMLElement>(HEADING_SELECTOR))) {
      if (!slugs.has(h.id) || seen.has(h.id)) continue;
      seen.add(h.id);
      headings.push(h);
    }
    const idx = pickActiveHeading(headings, frame.content, frame.scroller);
    const slug = idx < 0 ? null : headings[idx]!.id;
    const link = slug === null ? undefined : links.find((l) => l.getAttribute('data-pkc-toc-slug') === slug);
    let delta = 0;
    if (link !== undefined && (reveal || slug !== activeSlug) && box.scrollHeight > box.clientHeight) {
      const b = box.getBoundingClientRect();
      const r = (link.parentElement ?? link).getBoundingClientRect();
      if (r.top < b.top) delta = r.top - b.top;
      else if (r.bottom > b.bottom) delta = Math.min(r.bottom - b.bottom, r.top - b.top);
    }

    // ── 書く(印と、目次の枠の送りだけ)──
    for (const l of links) {
      const item = l.parentElement;
      const on = l === link;
      if (on) {
        if (l.getAttribute('aria-current') !== 'location') l.setAttribute('aria-current', 'location');
        if (item !== null && !item.hasAttribute(INSPECTOR_TOC_ACTIVE_ATTR)) item.setAttribute(INSPECTOR_TOC_ACTIVE_ATTR, '');
      } else {
        if (l.hasAttribute('aria-current')) l.removeAttribute('aria-current');
        if (item !== null && item.hasAttribute(INSPECTOR_TOC_ACTIVE_ATTR)) item.removeAttribute(INSPECTOR_TOC_ACTIVE_ATTR);
      }
    }
    // ⚠ `scrollIntoView` は使わない(本文の送りまで動かす)── 目次の枠の `scrollTop` だけ
    if (delta !== 0) box.scrollTop += delta;
    activeSlug = slug;
    reveal = false;
  };

  const schedule = (): void => {
    if (rafId !== null) return;
    rafId = raf(paint);
  };

  let detail: HTMLElement | null = null;
  const onScroll = (ev: Event): void => {
    if (detail === null || !detail.isConnected) detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]');
    const frame = frameOf(ev.target, detail);
    if (frame === null) return;
    last = frame;
    schedule();
  };
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });

  const spy: InspectorTocSpy = {
    refresh: () => {
      reveal = true;
      schedule();
    },
    dispose: () => {
      doc.removeEventListener('scroll', onScroll, { capture: true });
      if (rafId !== null) caf(rafId);
      rafId = null;
      if (installed === spy) installed = null;
    },
  };
  installed?.dispose();
  installed = spy;
  spy.refresh();
  return spy;
}
