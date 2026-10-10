/**
 * 🔴 **本文の中の `![説明](entry:ノート#h/見出し)` を、指した見出しの節の中身で置き換える**(#1459 ①)。
 *
 * 規則(綴り・節の範囲・鍵)は `features/markdown/section-embed.ts`。ここは**画面に描く側だけ**を持つ。
 * 描画器は前からこの綴りを `<div class="pkc-transclusion-placeholder">` の**空の器**にしていた
 * (`markdown-render.ts`)── 展開する側が無かった。これがその展開する側である。
 *
 * ## 何が起きるか(画面の言葉)
 *
 * - 指した節の中身が、その場に出る(題名のリンク + 節。読み取り専用)。元のノートを直すと追随する。
 * - 節が見つからない → 「見出しが見つかりません」と、元のノートを開くリンク(黙って空にしない)。
 * - ノートが無い → 「ノートが見つかりません」。
 * - 自分自身を指す / 節の中でさらに埋め込んでいる → **題名のリンクへ降ろす**(深さ ≤ 1。循環もここで止まる)。
 *
 * ## 板(`place-embed.ts`)と同じ作法を、同じ関数で
 *
 * 掃除は板と**同じ `sanitizeEmbedded`**(見出しは見出しでなくす / `id` は枠ごとの接頭辞 / 押せる口は
 * `select-entry` と `navigate-entry-ref` だけ)。図は読む面と同じ口(`hydrateFigures`)、添付画像は
 * 枠ごとの貸出(`AssetLends`)── 板と同じ理由で、**枠ごとに 1 つ**持つ。
 * 抜粋の入れ物も板と同じ(`state.placeBodies`。鍵が `<lid>#h/<印>`)。
 *
 * ## ⚠ 展開するのは「画像形」の参照だけ
 *
 * 描画器が器を出すのは `![…](entry:…)` だけ。`[字](entry:…)` のふつうのリンクには手を付けない。
 * 見出しを指さない画像形(`![](entry:ノート)` / `#log/…`)は**今までどおり**(空の器のまま。この段の範囲外)。
 */
import { parseEntryRef } from '@features/entry-ref/entry-ref';
import { placeEmbeddable, type PlaceExcerpt } from '@features/markdown/place-embed';
import { sectionKey } from '@features/markdown/section-embed';
import { AssetLends, type AssetLender } from './asset-lends';
import { pruneScopes, type MermaidScope } from './mermaid-hydrate';
import { sanitizeEmbedded, PLACE_MORE_NOTE } from './place-embed';
import { markViewBig } from './view-big';

/** 展開した器の class(展開前は `pkc-transclusion-placeholder`)。 */
export const SECTION_EMBED_CLASS = 'pkc-section-embed';
/** 画面の字。⚠ 使わない語(`ui-terms.ts`)を避けている。 */
export const SECTION_MISSING_NOTE = '見出しが見つかりません';
export const SECTION_NO_NOTE = 'ノートが見つかりません';
export const SECTION_LOADING_NOTE = '読み込んでいます';

const KEY_ATTR = 'data-pkc-section-key';
const PENDING_ATTR = 'data-pkc-section-pending';
const NS_ATTR = 'data-pkc-section-ns';
const SELECTOR = 'div.pkc-transclusion-placeholder[data-pkc-embed-ref], div.pkc-section-embed[data-pkc-embed-ref]';
/** 板の枠の中・展開済みの器の中の器は触らない(深さ ≤ 1。板の中の埋め込みは板の掃除が担当する)。 */
const NESTED = '[data-pkc-field="place-body"], .pkc-section-embed';

export interface SectionEmbedDeps {
  /** いま描いているノート自身の lid(自分を指す埋め込みは展開しない)。 */
  readonly selfLid: string;
  /** 抜粋(`state.placeBodies`)。鍵は `sectionKey`。無い = まだ読めていない。 */
  readonly excerptOf: (key: string) => PlaceExcerpt | undefined;
  readonly metaOf: (lid: string) => { readonly title: string; readonly archetype: string } | undefined;
  /** 本文を HTML に描く口(押せる旗も行番号も渡さない設定で呼ぶのは呼び側)。 */
  readonly render: (text: string) => Promise<string>;
  /** まだ持っていない抜粋の鍵を頼む(配線が `PLACE_BODIES_WANTED` を撃つ)。 */
  readonly wanted: (keys: readonly string[]) => void;
  readonly lender: AssetLender | null;
  readonly figures: (roots: readonly ParentNode[]) => MermaidScope[];
}

/** 枠ごとの `id` の接頭辞の連番。⚠ module に 1 つ(`place-embed.ts` の `nsSeq` と同じ理由)。 */
let nsSeq = 0;

function removeEmptyParagraphsAround(el: Element): void {
  // `<p><div></div></p>` は HTML の解析で `<p></p><div></div><p></p>` になる(`markdown-render.ts` の注記)
  for (const sib of [el.previousElementSibling, el.nextElementSibling]) {
    if (sib !== null && sib.tagName === 'P' && sib.childNodes.length === 0) sib.remove();
  }
}

function linkButton(doc: Document, field: string, lid: string, text: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-field', field);
  b.setAttribute('data-pkc-action', 'select-entry');
  b.setAttribute('data-pkc-entry', lid);
  b.textContent = text;
  return b;
}

function noteLine(doc: Document, text: string): HTMLElement {
  const d = doc.createElement('div');
  d.setAttribute('data-pkc-field', 'section-embed-note');
  d.textContent = text;
  return d;
}

export class SectionEmbeds {
  /** 描いた HTML の控え(鍵 → 切り出した字と HTML)。⚠ 画面に在る鍵の分だけ残す。 */
  private readonly cache = new Map<string, { readonly text: string; readonly cut: boolean; readonly html: string }>();
  /** もう頼んだ鍵。 */
  private readonly asked = new Set<string>();
  /** 器ごとの貸出(⚠ 枠ごとに 1 つ ── `PlaceEmbeds.lends` と同じ理由)。 */
  private readonly lends = new Map<HTMLElement, AssetLends>();
  private readonly scopes: MermaidScope[] = [];
  private fresh: HTMLElement[] = [];

  /** 図の URL と貸出を返す(面を捨てる / 別のノートへ移る)。 */
  release(): void {
    for (const l of this.lends.values()) l.disposeAll();
    this.lends.clear();
    for (const sc of this.scopes.splice(0)) sc.dispose();
    this.fresh = [];
  }

  /** 別のノートへ移るとき。⚠ 頼んだ控えも手放す(読めなかった鍵を次の本文でも頼み直せる)。 */
  reset(): void {
    this.release();
    this.cache.clear();
    this.asked.clear();
  }

  /** 描き直しのたびに呼んでよい(冪等。同じ内容の器は触らない)。 */
  sync(host: HTMLElement, deps: SectionEmbedDeps): void {
    for (const [el, lends] of [...this.lends]) {
      if (el.isConnected) continue;
      lends.disposeAll();
      this.lends.delete(el);
    }
    pruneScopes(this.scopes);
    const need: string[] = [];
    const seen = new Set<string>();
    for (const el of host.querySelectorAll<HTMLElement>(SELECTOR)) {
      if (el.parentElement?.closest(NESTED) != null) continue;
      const ref = parseEntryRef(el.getAttribute('data-pkc-embed-ref') ?? '');
      if (ref.kind !== 'section') continue;
      const key = sectionKey(ref.lid, ref.id);
      seen.add(key);
      this.one(el, ref.lid, key, deps, need);
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    this.flushFigures(deps);
    if (need.length > 0) deps.wanted(need);
  }

  private one(el: HTMLElement, lid: string, key: string, deps: SectionEmbedDeps, need: string[]): void {
    const meta = deps.metaOf(lid);
    const doc = el.ownerDocument;
    if (meta === undefined) {
      this.shell(el, `n\u0000${lid}`, () => [noteLine(doc, SECTION_NO_NOTE)]);
      return;
    }
    // 🔴 自分を指す / 本文を持たない型は、展開せず題名のリンク(板の「自分自身は展開しない」と同じ)
    if (lid === deps.selfLid || !placeEmbeddable(meta.archetype)) {
      this.shell(el, `l\u0000${lid}\u0000${meta.title}`, () => [linkButton(doc, 'place-body-link', lid, meta.title)]);
      return;
    }
    const ex = deps.excerptOf(key);
    if (ex === undefined) {
      if (!this.asked.has(key)) {
        this.asked.add(key);
        need.push(key);
      }
      // 読み込み中。出ている物が在れば、そのまま残す(読み直しの間に空へ戻さない)
      if (el.getAttribute(KEY_ATTR) === null) this.shell(el, `w\u0000${lid}`, () => [noteLine(doc, SECTION_LOADING_NOTE)]);
      return;
    }
    this.asked.delete(key);
    if (ex.gone === true) {
      this.shell(el, `g\u0000${lid}`, () => [noteLine(doc, SECTION_NO_NOTE)]);
      return;
    }
    if (ex.missing === true) {
      this.shell(el, `m\u0000${lid}\u0000${meta.title}`, () => [
        noteLine(doc, SECTION_MISSING_NOTE),
        linkButton(doc, 'place-body-link', lid, meta.title),
      ]);
      return;
    }
    const stateKey = `o\u0000${lid}\u0000${meta.title}\u0000${ex.cut ? '1' : '0'}\u0000${ex.text}`;
    if (el.getAttribute(KEY_ATTR) === stateKey) return;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.text === ex.text && cached.cut === ex.cut) {
      this.fill(el, stateKey, cached.html, ex.cut, lid, meta.title, deps);
      this.flushFigures(deps);
      return;
    }
    if (el.getAttribute(PENDING_ATTR) === stateKey) return; // 描いている最中
    el.setAttribute(PENDING_ATTR, stateKey);
    void deps
      .render(ex.text)
      .then((html) => {
        this.cache.set(key, { text: ex.text, cut: ex.cut, html });
        // ⚠ もっと新しい鍵が来ている / 器が差し替わった ── この結果は載せない
        if (el.getAttribute(PENDING_ATTR) !== stateKey || !el.isConnected) return;
        this.fill(el, stateKey, html, ex.cut, lid, meta.title, deps);
        this.flushFigures(deps);
      })
      .catch(() => {
        // ⚠ 描けなかっただけ ── 次に呼ばれたときにもう一度描く
        if (el.getAttribute(PENDING_ATTR) === stateKey) el.removeAttribute(PENDING_ATTR);
      });
  }

  /** 器を「展開した器」にして、中身を作り直す(同じ鍵なら触らない)。 */
  private shell(el: HTMLElement, stateKey: string, build: () => Node[]): void {
    if (el.getAttribute(KEY_ATTR) === stateKey) return;
    this.adopt(el);
    el.replaceChildren(...build());
    el.setAttribute(KEY_ATTR, stateKey);
    el.removeAttribute(PENDING_ATTR);
    this.lends.get(el)?.prune();
  }

  private adopt(el: HTMLElement): void {
    if (el.classList.contains('pkc-transclusion-placeholder')) {
      el.classList.remove('pkc-transclusion-placeholder');
      el.classList.add(SECTION_EMBED_CLASS);
      removeEmptyParagraphsAround(el);
    }
  }

  private fill(
    el: HTMLElement,
    stateKey: string,
    html: string,
    cut: boolean,
    lid: string,
    title: string,
    deps: SectionEmbedDeps,
  ): void {
    const doc = el.ownerDocument;
    this.adopt(el);
    if (el.getAttribute(NS_ATTR) === null) el.setAttribute(NS_ATTR, `sec-${String(++nsSeq)}-`);
    const box = doc.createElement('div');
    box.innerHTML = html;
    sanitizeEmbedded(box, (l) => deps.metaOf(l)?.title ?? null, el.getAttribute(NS_ATTR) ?? '');
    // 🔴 節の中の埋め込みは**展開しない**(深さ ≤ 1。A→B→A の循環もここで止まる)── 題名のリンクへ
    for (const nested of [...box.querySelectorAll<HTMLElement>('.pkc-transclusion-placeholder')]) {
      const ref = parseEntryRef(nested.getAttribute('data-pkc-embed-ref') ?? '');
      if (ref.kind === 'invalid') {
        nested.remove();
        continue;
      }
      const t = deps.metaOf(ref.lid)?.title ?? SECTION_NO_NOTE;
      removeEmptyParagraphsAround(nested);
      nested.replaceWith(linkButton(doc, 'place-body-link', ref.lid, t));
    }
    const nodes: Node[] = [linkButton(doc, 'section-embed-source', lid, title), ...box.childNodes];
    if (cut) {
      const more = linkButton(doc, 'place-body-more', lid, PLACE_MORE_NOTE);
      nodes.push(more);
    }
    el.replaceChildren(...nodes);
    el.setAttribute(KEY_ATTR, stateKey);
    el.removeAttribute(PENDING_ATTR);
    this.hydrateImages(el, deps);
    if (el.querySelector('[data-pkc-mermaid-src], [data-pkc-chart-src], [data-pkc-math-src]') !== null) this.fresh.push(el);
  }

  private flushFigures(deps: SectionEmbedDeps): void {
    if (this.fresh.length === 0) return;
    const roots = this.fresh.filter((s) => s.isConnected);
    this.fresh = [];
    if (roots.length > 0) this.scopes.push(...deps.figures(roots));
  }

  private hydrateImages(el: HTMLElement, deps: SectionEmbedDeps): void {
    const imgs = [...el.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]')];
    if (imgs.length === 0) {
      this.lends.get(el)?.prune();
      return;
    }
    for (const img of imgs) markViewBig(img);
    if (deps.lender === null) {
      for (const img of imgs) img.setAttribute('data-pkc-asset-missing', '');
      return;
    }
    let l = this.lends.get(el);
    if (l === undefined) {
      l = new AssetLends();
      this.lends.set(el, l);
    }
    void l.hydrate(el, deps.lender);
  }
}
