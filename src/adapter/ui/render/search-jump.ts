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
import { findHitSpans, jumpTerms } from '@features/filter/search-hits';
import { settleJump } from './long-note';

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

/** 集める当たりの上限。⚠ 超えた分は塗らない・数えない(巨大な本文で Range を作り続けない)。 */
export const HIT_RANGE_MAX = 50000;

/**
 * 語の途中で切れ目にならない入れ物。⚠ 一覧にある物の**外側**(段落・見出し・表のセル・コードの塊…)で
 * text node をつなげて引く ── 太字・リンク・コードの色分けの `<span>` は切れ目にしない。
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT',
  'TH', 'THEAD', 'TR', 'UL',
]);

interface Seg {
  readonly node: Text;
  /** つないだ字の中での、この節点の始まり。 */
  readonly at: number;
}

/**
 * 本文の text node から、語の出現ごとに Range を作る(文書順)。
 * 🔑 **同じブロックの中の text node はつなげて引く** ── 太字・リンク・コードの色分けをまたぐ語も当たる
 *   (Range の始まりと終わりが別の節点にあってよい)。
 * ⚠ 切れ目:ブロックが変わる所 / `<br>` / 数えない所(`SKIP_SELECTOR`)── そこをまたいで語をつなげない。
 * ⚠ **本文の DOM は読むだけ** ── Range を作るのは節点を動かさない。
 * ⚠ 畳んだ章(`hidden`)の中も数える(送るときに開く)。
 */
export function collectHitRanges(
  host: HTMLElement,
  query: string,
  origin: 'find' | 'filter' = 'find',
): Range[] {
  const terms = jumpTerms(query, origin);
  if (terms.length === 0) return [];
  const doc = host.ownerDocument;
  // SHOW_ELEMENT | SHOW_TEXT ── `<br>` を切れ目として拾うため要素も歩く
  const walker = doc.createTreeWalker(host, 1 | 4);
  const out: Range[] = [];

  // 親の要素ごとに引いた結果(同じ段落の節点で `closest` を引き直さない)
  const skipCache = new WeakMap<Element, boolean>();
  const blockCache = new WeakMap<Element, Element>();
  const skipped = (el: Element): boolean => {
    let v = skipCache.get(el);
    if (v === undefined) {
      v = el.closest(SKIP_SELECTOR) !== null;
      skipCache.set(el, v);
    }
    return v;
  };
  const blockOf = (el: Element): Element => {
    let v = blockCache.get(el);
    if (v === undefined) {
      let cur: Element = el;
      while (cur !== host && !BLOCK_TAGS.has(cur.tagName.toUpperCase()) && cur.parentElement !== null)
        cur = cur.parentElement;
      v = cur;
      blockCache.set(el, v);
    }
    return v;
  };

  let segs: Seg[] = [];
  let joined = '';
  let block: Element | null = null;

  /** @returns 上限に達したか */
  const flush = (): boolean => {
    const cur = segs;
    const text = joined;
    segs = [];
    joined = '';
    block = null;
    if (cur.length === 0) return false;
    const spans = findHitSpans(text, terms);
    // 節点の添字を二分探索する(当たりが多い長い段落で線形に舐めない)
    const locate = (pos: number, endSide: boolean): { node: Text; offset: number } => {
      let lo = 0;
      let hi = cur.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const seg = cur[mid]!;
        // 終わりは「その節点の終端」に置く(次の節点の 0 ではなく)── 始まりは次の節点の頭へ
        if (endSide ? seg.at < pos : seg.at <= pos) lo = mid;
        else hi = mid - 1;
      }
      const seg = cur[lo]!;
      return { node: seg.node, offset: pos - seg.at };
    };
    for (const sp of spans) {
      if (out.length >= HIT_RANGE_MAX) return true;
      const st = locate(sp.start, false);
      const en = locate(sp.end, true);
      const range = doc.createRange();
      range.setStart(st.node, st.offset);
      range.setEnd(en.node, en.offset);
      out.push(range);
    }
    return false;
  };

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if ((node as Element).tagName.toUpperCase() === 'BR' && flush()) return out;
      continue;
    }
    const parent = node.parentElement;
    if (parent === null) continue;
    // 🔑 差し込んだ操作の字は切れ目にする(混ぜると、user が書いていない字と語がつながる)
    if (skipped(parent)) {
      if (flush()) return out;
      continue;
    }
    const b = blockOf(parent);
    if (block !== null && b !== block && flush()) return out;
    block = b;
    const text = node.nodeValue ?? '';
    if (text === '') continue;
    segs.push({ node: node as Text, at: joined.length });
    joined += text;
  }
  flush();
  return out;
}

interface HighlightRegistry {
  set(name: string, value: unknown): unknown;
  delete(name: string): unknown;
}
type HighlightCtor = new (...ranges: Range[]) => { priority: number; add(range: Range): unknown };

/** 塗りの表とコンストラクタ。⚠ どちらかが無い(古いブラウザ / happy-dom)なら `null`。 */
function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (css === undefined || css.highlights === undefined) return null;
  if (typeof Highlight !== 'function') return null;
  return { registry: css.highlights, Highlight };
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
  // ⚠ 展開(`new Highlight(...ranges)`)しない ── 引数が多すぎて RangeError になりうる
  const all = new api.Highlight();
  for (const r of ranges) all.add(r);
  api.registry.set(HIT_HIGHLIGHT, all);
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
  // 🔴 長大なノートは、当たりの周りが描かれて実寸になった後に 1 度だけ合わせ直す(#1467)
  settleJump(range.startContainer.parentElement ?? host, go);
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

/**
 * 帯の字。⚠ 当たりが 1 件も無いときは、その事実を言う(数字の 0 で黙らない)。
 * 🔴 0 件の字は**数えない範囲まで言う**(#1206 D6)── 抜粋に語が見えているのに「当たった所は
 *   ありません」と断定すると嘘になる(図や html の囲みの中は数えない ── 設計 doc §3)。
 *   太字・リンクをまたぐ語は、同じブロックの中ならつなげて数える。
 */
export function searchJumpLabel(total: number, index: number): string {
  return total <= 0 ? '本文の字には一致しませんでした(図の中は数えません)' : `${index + 1}/${total} 件`;
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
  wrapper.setAttribute('aria-label', '探した語の一致');
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
  const prev = button('‹', '前の一致へ');
  prev.setAttribute('data-pkc-action', 'search-jump-prev');
  const next = button('›', '次の一致へ');
  next.setAttribute('data-pkc-action', 'search-jump-next');
  const end = button('×', '一致の表示を閉じる');
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
      wrapper.title = `「${view.query}」の一致`;
      // 当たりが無いときは送れない(押せるのに何も起きない、を作らない)
      prev.disabled = view.total <= 0;
      next.disabled = view.total <= 0;
      wrapper.style.setProperty('--pkc-search-jump-gap', `${Math.max(0, Math.round(gapPx))}px`);
      wrapper.hidden = false;
    },
    dispose: () => wrapper.remove(),
  };
}
