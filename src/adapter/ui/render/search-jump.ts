/**
 * 🔴 **「探す」から本文の当たった所へ送って塗る**(#1102 段①)── DOM 側の仕事。
 *
 * > 設計:`docs/development/search-jump-design-2026-10.md`
 *
 * ## 何が起きるか
 *
 * 「探す」の結果の行を押すと、そのノートが別のウィンドウで開き、**本文の中の当たった語の所へ
 * 送られて塗られる**。本文の右上(「目次」の隣)に「1/4 件 ‹ ›」の小さな送りが出て、‹ › で
 * 前後の当たりへ送り直す。× か `Esc` で塗りも送りも消える。
 *
 * ## 🔴 塗り方は「本文の DOM を 1 バイトも変えない」(裁定:Gemini の答え A)
 *
 * CSS Custom Highlight API(`CSS.highlights` + `Highlight` + `::highlight(…)`)で、Range を
 * **ブラウザの塗りの表**に登録するだけである ── 節点は 1 つも増えない / 減らない。
 * そのため ①本文の差分描画(`applyBlocks`)を壊さない ②書き出した HTML / 印刷に混ざらない
 * ③ライブエディタの行の対応(`data-pkc-source-line`)を乱さない。
 * ⚠ **使えないブラウザでは塗らない**(送りだけ効く)。⚠ 無言にはしない ── 帯は出て、
 *   「n/m 件」と送りは動く(位置へ送る所までは Highlight に依らない)。
 *
 * ⚠ 塗りは**表示の寿命と同じ**に持つ:ノートが変わる / 編集に入る / × を押したら表から外す
 *   (`clearHitHighlights`)。Range は節点を掴むので、握ったまま忘れると本文が常駐する
 *   (2026-07-27「速やかな破棄」)。
 */
import { findHitSpans, findTerms } from '@features/filter/search-hits';

/** 当たった語の塗り(全部)。⚠ `app.css` の `::highlight(pkc-search-hit)` と同じ字。 */
export const HIT_HIGHLIGHT = 'pkc-search-hit';
/** いま送り先の 1 つ(強く塗る)。⚠ `app.css` の `::highlight(pkc-search-hit-current)` と同じ字。 */
export const HIT_CURRENT_HIGHLIGHT = 'pkc-search-hit-current';

/**
 * 当たりと数えない所。**画面の操作のために差し込んだ字**(ボタン・目印・並べ替えの矢印)を
 * 数えると、user が書いていない字を「当たり」と言う。
 */
const SKIP_SELECTOR = [
  'script',
  'style',
  'textarea',
  'button',
  'svg',
  '[aria-hidden="true"]',
  '.pkc-external-link-icon',
  '.pkc-table-sort-icon',
  '.pkc-code-lang',
  '.pkc-code-collapse-bar',
  '.pkc-heading-anchor',
].join(',');

/**
 * 本文の text node から、語の出現ごとに Range を作る(文書順)。
 * ⚠ **本文の DOM は読むだけ** ── Range を作るのは節点を動かさない。
 * ⚠ 畳んだ章(`hidden`)の中も数える(送るときに開く)。
 */
export function collectHitRanges(host: HTMLElement, query: string): Range[] {
  const terms = findTerms(query);
  if (terms.length === 0) return [];
  const doc = host.ownerDocument;
  const walker = doc.createTreeWalker(host, 4 /* NodeFilter.SHOW_TEXT */);
  const out: Range[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const spans = findHitSpans(text, terms);
    if (spans.length === 0) continue;
    // 🔑 差し込んだ操作の字は、当たったときだけ確かめる(全部の節点で `closest` を引かない)
    if (node.parentElement?.closest(SKIP_SELECTOR) != null) continue;
    for (const sp of spans) {
      const range = doc.createRange();
      range.setStart(node, sp.start);
      range.setEnd(node, sp.end);
      out.push(range);
    }
  }
  return out;
}

interface HighlightRegistry {
  set(name: string, value: unknown): unknown;
  delete(name: string): unknown;
}
type HighlightCtor = new (...ranges: Range[]) => { priority: number };

/** 塗りの表とコンストラクタ。⚠ どちらかが無い(古いブラウザ / happy-dom)なら `null`。 */
function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (css === undefined || css.highlights === undefined) return null;
  if (typeof Highlight !== 'function') return null;
  return { registry: css.highlights, Highlight };
}

/** このブラウザは塗れるか(帯の注記と test の分岐に使う)。 */
export function canHighlight(): boolean {
  return highlightApi() !== null;
}

/**
 * 当たりを全部塗り、`current` 番目だけ強く塗る。
 * @returns 塗れたか(`false` = このブラウザは塗れない。送りは別に効く)
 */
export function paintHitRanges(ranges: readonly Range[], current: number): boolean {
  const api = highlightApi();
  if (api === null) return false;
  if (ranges.length === 0) {
    api.registry.delete(HIT_HIGHLIGHT);
    api.registry.delete(HIT_CURRENT_HIGHLIGHT);
    return true;
  }
  api.registry.set(HIT_HIGHLIGHT, new api.Highlight(...ranges));
  const now = ranges[current];
  if (now === undefined) {
    api.registry.delete(HIT_CURRENT_HIGHLIGHT);
  } else {
    const strong = new api.Highlight(now);
    // ⚠ 全部の塗りと重なる所では、いまの 1 つが勝つ
    strong.priority = 1;
    api.registry.set(HIT_CURRENT_HIGHLIGHT, strong);
  }
  return true;
}

/** 塗りを表から外す。⚠ 無くても呼んでよい(冪等)。 */
export function clearHitHighlights(): void {
  const api = highlightApi();
  if (api === null) return;
  api.registry.delete(HIT_HIGHLIGHT);
  api.registry.delete(HIT_CURRENT_HIGHLIGHT);
}

/** 送った位置を、画面の上から何割の所に置くか(帯・目次の下に潜らせない)。 */
const LAND_RATIO = 0.35;
/** 送った後に画像の読み込みで位置がずれても、この間は追いかける。 */
const SETTLE_MS = 1500;

/**
 * 当たりを画面の中へ送る。
 *
 * 🔑 **語そのものの高さへ送る**(段落の中央ではない)── 長い段落の中の 1 語を探しているので、
 *   段落を中央に置くと語が画面の外に出る。段組みの横送りは段落ごと(語の列を引く物差しが無い)。
 * ⚠ **画像の読み込みで押し流されたら送り直す**(`loading="lazy"` の画像が上で育つ ──
 *   `binder.ts` の `scrollSettled` と同じ作法)。⚠ user が自分で動かしたら手を離す。
 */
export function scrollToHit(scroller: HTMLElement, host: HTMLElement, range: Range): void {
  const go = (): void => {
    const el = range.startContainer.parentElement;
    if (host.closest('[data-pkc-columns-on]') !== null) {
      el?.scrollIntoView({ block: 'center', inline: 'center' });
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // 箱を持たない(畳んだまま / 描けない環境)── 親の塊まで
      el?.scrollIntoView({ block: 'center' });
      return;
    }
    const frame = scroller.getBoundingClientRect();
    scroller.scrollTop += rect.top - (frame.top + scroller.clientHeight * LAND_RATIO);
  };
  go();
  const doc = host.ownerDocument;
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    host.removeEventListener('load', go, true);
    for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown'])
      doc.removeEventListener(t, stop, true);
  };
  const timer = setTimeout(stop, SETTLE_MS);
  host.addEventListener('load', go, true);
  for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) doc.addEventListener(t, stop, true);
}

export interface SearchJumpBarView {
  /** 本文の当たりの数。 */
  readonly total: number;
  /** いま送り先の位置(0 始まり)。 */
  readonly index: number;
  /** 探した語(帯のヒントに出す)。 */
  readonly query: string;
}

export interface SearchJumpBarHandle {
  readonly element: HTMLElement;
  /**
   * 帯を更新する。`null` = 隠す。
   * @param gapPx 右の列の押し(目次)の幅 + すき間。⚠ 目次が出ているときだけ非 0
   *   (「目次の隣」へ置くので、重ならないように右を空ける)
   */
  update(view: SearchJumpBarView | null, gapPx: number): void;
  dispose(): void;
}

/** 帯の字。⚠ 当たりが 1 件も無いときは、その事実を言う(数字の 0 で黙らない)。 */
export function searchJumpLabel(total: number, index: number): string {
  return total <= 0 ? '本文に当たった所はありません' : `${index + 1}/${total} 件`;
}

/**
 * 🔴 **本文の右上の送りの帯**(「1/4 件 ‹ ›」と ×)。
 *
 * 🔑 作りは「目次」(`quick-toc.ts`)と同じ ── 高さ 0 の `sticky` の箱を**本文の面の先頭**に置く
 *   (本文の行を 1px も押し下げず、送った先でも右上に居る)。
 * ⚠ 押し所は `data-pkc-action` で受ける(`binder.ts`)── ここは**描くだけ**で dispatch しない。
 */
export function installSearchJumpBar(container: HTMLElement): SearchJumpBarHandle {
  const doc = container.ownerDocument;
  const wrapper = doc.createElement('div');
  wrapper.className = 'pkc-search-jump';
  wrapper.setAttribute('data-pkc-field', 'search-jump');
  wrapper.setAttribute('role', 'group');
  wrapper.setAttribute('aria-label', '探した語の当たり');
  wrapper.hidden = true;

  const label = doc.createElement('span');
  label.className = 'pkc-search-jump-count';
  label.setAttribute('data-pkc-field', 'search-jump-count');
  label.setAttribute('aria-live', 'polite');

  const button = (text: string, name: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'pkc-search-jump-btn';
    b.setAttribute('aria-label', name);
    b.title = name;
    b.textContent = text;
    return b;
  };
  // ⚠ 受け手の名前は**ここに字で書く**(変数で配らない)── 「どの操作がどこから焼かれるか」を
  //   静的に追える形にしておく(`tests/action-outlets.test.ts` の「追えない出口」を増やさない)
  const prev = button('‹', '前の当たりへ');
  prev.setAttribute('data-pkc-action', 'search-jump-prev');
  const next = button('›', '次の当たりへ');
  next.setAttribute('data-pkc-action', 'search-jump-next');
  const end = button('×', '当たりの表示を閉じる');
  end.setAttribute('data-pkc-action', 'search-jump-end');

  wrapper.append(label, prev, next, end);
  // 🔑 先頭に置く ── `sticky; top` は通常の位置より下へしか動けない(目次と同じ理由)
  container.prepend(wrapper);

  return {
    element: wrapper,
    update: (view, gapPx) => {
      if (view === null) {
        wrapper.hidden = true;
        return;
      }
      label.textContent = searchJumpLabel(view.total, view.index);
      wrapper.title = `「${view.query}」の当たり`;
      // 当たりが無いときは送れない(押せるのに何も起きない、を作らない)
      prev.disabled = view.total <= 0;
      next.disabled = view.total <= 0;
      wrapper.style.setProperty('--pkc-search-jump-gap', `${Math.max(0, Math.round(gapPx))}px`);
      wrapper.hidden = false;
    },
    dispose: () => wrapper.remove(),
  };
}
