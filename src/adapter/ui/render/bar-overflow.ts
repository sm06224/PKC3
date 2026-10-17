/**
 * 🔴 **左の列の 3 本の帯を、どの幅でも 1 段に収める**(#1621。🟣 Gemini 裁定 = 推薦 A)。
 *
 * ## 何が起きていたか(実測。本物の build、高さ 800)
 *
 * 画面の幅が 1080px 以下になると、左の列が 180〜238px に細くなり、上のタブの帯・作る帯・
 * 下の帯(取り込む…ヘルプ)の 3 本が **それぞれ別の割れ方で 2 段**になっていた
 * (800px で 4+2 / 5+2 / 3+4。下の段に 1〜2 枚だけ残り、タブの下の段は横いっぱいに伸びる)。
 *
 * ## 直し方
 *
 * 入りきらない物を**後ろから**「⋯」の下へ畳み、押すと残りが名前つきで出る。
 * 本文の幅は変えない(左の列を太らせる案は採らなかった)。
 * - 畳むのは**見た目だけ**(`data-pkc-overflow` で `display: none`)。DOM から外さないので、
 *   帯を読む側(長押しのメニュー・縁・押せない理由)は何も変わらない。
 * - タブは**いま開いている物を畳まない**(どこに居るか分からなくなるため)。
 * - 「⋯」の中身は、長押しメニューと同じ口(`openContextMenu`)で出す。実体は `binder.ts` の
 *   `open-bar-more`。
 *
 * ⚠ 測るのは幅が変わったときだけ(`ResizeObserver`)。畳むと帯の高さが変わるので、
 *   高さの変化では測り直さない(自分の変更で輪を作らない)。
 */

/** 畳んだ物に付ける印。⚠ `app.css` の同名の規則と、`binder.ts` の「⋯」の中身が読む。 */
export const OVERFLOW_ATTR = 'data-pkc-overflow';
/** 「⋯」を押したときの action 名。⚠ `binder.ts` の handler 表と同じ綴り。 */
export const BAR_MORE_ACTION = 'open-bar-more';
/** 「⋯」の `data-pkc-field`。 */
export const BAR_MORE_FIELD = 'bar-more';

export interface BarOverflowOptions {
  /** 畳む候補(後ろから畳む)。 */
  readonly candidates: (bar: HTMLElement) => HTMLElement[];
  /** 畳んではいけない物(いま開いているタブ)。 */
  readonly protect?: (el: HTMLElement) => boolean;
}

/** 「⋯」のボタンを組む。⚠ `bar-tile` ではない(自分を長押しメニューに載せない)。 */
export function makeBarMore(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', BAR_MORE_ACTION);
  btn.setAttribute('data-pkc-field', BAR_MORE_FIELD);
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-label', '入りきらない操作を開く');
  btn.title = '入りきらない操作を開きます';
  btn.textContent = '⋯';
  return btn;
}

const visible = (el: HTMLElement): boolean => el.getBoundingClientRect().width > 0;

/** 見えている物の段の数。 */
function rowCount(items: readonly HTMLElement[]): number {
  const tops = new Set<number>();
  for (const el of items) {
    if (!visible(el)) continue;
    tops.add(Math.round(el.getBoundingClientRect().top));
  }
  return tops.size;
}

/**
 * 帯を測り直して、1 段に収まるまで後ろから畳む。
 * ⚠ 帯が表示されていない(幅 0)間は何もしない ── 畳んだ列で測ると全部畳んでしまう。
 */
export function fitBar(bar: HTMLElement, more: HTMLButtonElement, opts: BarOverflowOptions): void {
  const cands = opts.candidates(bar);
  for (const el of cands) el.removeAttribute(OVERFLOW_ATTR);
  for (const g of bar.querySelectorAll<HTMLElement>('[data-pkc-field="collection-app-group"]'))
    g.removeAttribute(OVERFLOW_ATTR);
  // 🔑 「⋯」は畳んだ物が在る間だけ **DOM にも在る**(帯のボタンの顔ぶれを、畳まない幅では変えない)
  more.remove();
  if (bar.getBoundingClientRect().width === 0) return;
  const track = (): HTMLElement[] => [...cands.filter((c) => !c.hasAttribute(OVERFLOW_ATTR)), more];
  if (rowCount(cands) <= 1) return;
  bar.append(more);
  for (let i = cands.length - 1; i >= 0; i--) {
    const el = cands[i]!;
    if (!visible(el)) continue;
    if (opts.protect?.(el) === true) continue;
    el.setAttribute(OVERFLOW_ATTR, '');
    // 塊の中身が全部畳まれたら、塊の区切りの線も一緒に畳む
    for (const g of bar.querySelectorAll<HTMLElement>('[data-pkc-field="collection-app-group"]')) {
      const left = [...g.children].some((c) => visible(c as HTMLElement));
      if (!left) g.setAttribute(OVERFLOW_ATTR, '');
    }
    if (rowCount(track()) <= 1) return;
  }
}

/** 帯ごとの「測り直し」。⚠ `fitSidebarBars` が boot の直前に同期で呼ぶ。 */
const refits = new WeakMap<HTMLElement, () => void>();

/**
 * 帯を 1 段に保つ。幅が変わるたびに測り直す。返り値は止める関数。
 * ⚠ `ResizeObserver` が無い環境(古い test 環境)では何もしない。
 */
export function installBarOverflow(bar: HTMLElement, opts: BarOverflowOptions): () => void {
  const more = makeBarMore();
  refits.set(bar, () => fitBar(bar, more, opts));
  if (typeof ResizeObserver === 'undefined') return () => {};
  let lastWidth = -1;
  const ro = new ResizeObserver((entries) => {
    const w = Math.round(entries[0]?.contentRect.width ?? 0);
    if (w === lastWidth) return;
    lastWidth = w;
    fitBar(bar, more, opts);
  });
  ro.observe(bar);
  /**
   * いま開いている物が変わったら測り直す(畳んだ物が「いま開いている物」になったとき、
   * 畳んだままだとどこに居るか分からない)。⚠ 畳みの印(`data-pkc-overflow`)は
   * 見ない ── 自分の書き込みで輪を作らない。
   */
  const mo =
    opts.protect === undefined || typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => fitBar(bar, more, opts));
  mo?.observe(bar, { attributes: true, attributeFilter: ['data-pkc-active'], subtree: true });
  /**
   * 🔴 **字体が届くと語の幅が変わる**(帯の幅は変わらないので `ResizeObserver` は鳴らない)。
   * 届いた後にも 1 度測り直す。⚠ 無い環境(test)では何もしない。
   */
  const fonts = (bar.ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
  const onFonts = (): void => fitBar(bar, more, opts);
  fonts?.addEventListener?.('loadingdone', onFonts);
  return () => {
    ro.disconnect();
    mo?.disconnect();
    fonts?.removeEventListener?.('loadingdone', onFonts);
  };
}

/** 3 本の帯の畳み方。⚠ `shell.ts` が建てた直後に呼ぶ。 */
export function installSidebarBarOverflow(sidebar: HTMLElement): void {
  const bar = (r: string): HTMLElement | null =>
    sidebar.querySelector<HTMLElement>(`[data-pkc-region="${r}"]`);
  const tabs = bar('browse-tabs');
  if (tabs !== null)
    installBarOverflow(tabs, {
      candidates: (b) => [...b.querySelectorAll<HTMLElement>(':scope > button[data-pkc-browse]')],
      protect: (el) => el.hasAttribute('data-pkc-active'),
    });
  for (const r of ['create-bar', 'collection-bar']) {
    const el = bar(r);
    if (el !== null)
      installBarOverflow(el, {
        candidates: (b) => [...b.querySelectorAll<HTMLElement>('button[data-pkc-bar-tile]')],
      });
  }
}

/**
 * 左の列の 3 本の帯を、**いま同期で**測り直す。
 * 🔴 `ResizeObserver` は次の描画まで鳴らないので、boot の印(`data-pkc-boot="ready"`)を
 *   立てる前に 1 度呼ぶ ── 呼ばないと「印が立った直後は割れたまま」の瞬間ができる。
 */
export function fitSidebarBars(root: ParentNode): void {
  for (const r of ['browse-tabs', 'create-bar', 'collection-bar']) {
    const el = root.querySelector<HTMLElement>(`[data-pkc-region="sidebar"] [data-pkc-region="${r}"]`);
    if (el !== null) refits.get(el)?.();
  }
}
