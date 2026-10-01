/**
 * 🔴 **板に置いたノートの中身を、塊の中へ読み取り専用で描く**(#529 W3-①)。
 *
 * 規則の定数(切る量・既定の大きさ・出してよい型)は `features/markdown/place-embed.ts`、
 * 置く位置・題名の帯は `place-board.ts`。ここは**中身の描画と掃除だけ**を持つ。
 *
 * ## 何が起きるか(画面の言葉)
 *
 * 題名の帯の下に、置いたノートの本文(文・表・チェック)が出る。**押して変えられる物は
 * 1 つも無い**(チェックは押せず、表のセルは打てない)── 題名の帯を押すと、今の窓で
 * そのノートが開く。長い本文は途中で切れ、末尾の「続きは元のノートで」を押すと同じく開く。
 *
 * ## ⚠ 読み取り専用は「旗を渡さない」ことで成り立つ
 *
 * 描画器は `interactiveTasks` / `interactiveCells` / `interactiveCodeBlocks` / `interactiveTags` /
 * `interactiveDates` を**渡されたときだけ**押せる形で出す(書き出し・印刷と同じ作り)。
 * ここは**どれも渡さない**。さらに `sourceLineAnchors` も渡さない ── 行番号を焼くと、
 * 右クリックや目次の受け手が**置いたノートの行を、板のノートの行と取り違える**
 * (「押した物と効く先が食い違う」)。
 *
 * ## ⚠ 描いた後に掃除する理由(置いた先のノートの面へ漏らさない)
 *
 * 描画器の出力は**板のノート自身の本文の中に在る**ことを前提にした部品(見出しの `id`・
 * 目次・折りたたみ・コピーの帯)を含む。そのまま入れると:
 * - 見出しの `id` が板のノートの目次・`#章` へのジャンプと**衝突**する(設計 doc §6 の制約)
 * - 見出しの右クリックが**板のノートの章**を指してしまう
 * だから見出しは**見出しでない行**へ降ろし、`id` は全部剥がし、コピーの帯・ソース切替は外す。
 * 🔴 **入れ子の板は展開しない**(深さ ≤ 1)── 中の「置いたノート」は**題名だけの行**へ降りる。
 * 🔴 **図(mermaid / chart / 数式)と添付の画像は描かない**(W3-② ── 図は PNG へ焼いて
 *   描く不可侵の規律があり、まだ配線していない)。「図は元のノートで」の 1 行にする。
 *
 * ## 寿命
 *
 * 描いた HTML の控えは**いま板に在る lid の分だけ**(`sync` のたびに、無くなった物は捨てる)。
 * 新しい常駐は作らない ── 描くのは既存の markdown 描画口(ワーカー。使い捨て)である。
 */
import { placeEmbeddable, type PlaceExcerpt } from '@features/markdown/place-embed';

/** 塊の中の、置いたノートの本文の器。 */
export const PLACE_BODY_FIELD = 'place-body';
/** 塊に付く印(本文の器を持っている間だけ)── CSS が「題名の帯 + 送れる本文」の形に切り替える。 */
export const PLACE_EMBEDDED_ATTR = 'data-pkc-place-embedded';

/** 描き終えた内容の鍵 / 描いている最中の鍵(同じ鍵では頼み直さない)。 */
const KEY_ATTR = 'data-pkc-place-body-key';
const PENDING_ATTR = 'data-pkc-place-body-pending';

const BLOCK_SELECTOR = '.pkc-format-block.pkc-place[data-pkc-place-entry]';

/** 画面の字(図・画像・続き)── ⚠ 使わない語(`ui-terms.ts`)を避けている。 */
export const PLACE_FIGURE_NOTE = '図は元のノートで';
export const PLACE_IMAGE_NOTE = '画像は元のノートで';
export const PLACE_MORE_NOTE = '続きは元のノートで';

export interface PlaceEmbedDeps {
  /** いま描いているノート自身の lid(自分を置いた塊は展開しない)。 */
  readonly selfLid: string;
  /** 板のための抜粋(`state.placeBodies`)。無い = まだ読めていない。 */
  readonly excerptOf: (lid: string) => PlaceExcerpt | undefined;
  /** ノートの題名と型(無い = 消えている)。 */
  readonly metaOf: (lid: string) => { readonly title: string; readonly archetype: string } | undefined;
  /** 本文を HTML に描く口(ワーカー経由)。⚠ **押せる旗も行番号も渡さない設定**で呼ぶのは呼び側。 */
  readonly render: (text: string) => Promise<string>;
  /** まだ持っていない本文を頼む(配線が `PLACE_BODIES_WANTED` を撃つ)。 */
  readonly wanted: (lids: readonly string[]) => void;
}

/** 器を持つ塊の lid を全部返す(板が展開してよい塊だけ)。 */
function embeddable(deps: PlaceEmbedDeps, lid: string): boolean {
  const meta = deps.metaOf(lid);
  return meta !== undefined && lid !== deps.selfLid && placeEmbeddable(meta.archetype);
}

function ensureSlot(block: HTMLElement): HTMLElement {
  let slot = block.querySelector<HTMLElement>(`:scope > [data-pkc-field="${PLACE_BODY_FIELD}"]`);
  if (slot === null) {
    slot = block.ownerDocument.createElement('div');
    slot.setAttribute('data-pkc-field', PLACE_BODY_FIELD);
    // 🔑 題名の帯の直後へ(帯が無ければ末尾)── 掴む口・大きさの持ち手は動かさない
    const card = block.querySelector(':scope > [data-pkc-field="place-card"]');
    if (card !== null) card.after(slot);
    else block.append(slot);
  }
  block.setAttribute(PLACE_EMBEDDED_ATTR, '');
  return slot;
}

function dropSlot(block: HTMLElement): void {
  block.querySelector(`:scope > [data-pkc-field="${PLACE_BODY_FIELD}"]`)?.remove();
  block.removeAttribute(PLACE_EMBEDDED_ATTR);
}

/**
 * 描画器の出力を、板の中で読む形へ掃除する(上の「掃除する理由」)。
 * ⚠ 公開しているのは test が直に当てるため ── 掃除の漏れは画面で気づきにくい。
 */
export function sanitizeEmbedded(
  box: HTMLElement,
  titleOf: (lid: string) => string | null,
): void {
  const doc = box.ownerDocument;
  const note = (text: string, tag: 'span' | 'div', field = 'place-body-skip'): HTMLElement => {
    const el = doc.createElement(tag);
    el.setAttribute('data-pkc-field', field);
    el.textContent = text;
    return el;
  };

  // ① 入れ子の板は展開しない(深さ ≤ 1)── 置いたノートは**題名だけの行**へ、付箋は中身だけ残す
  for (const nested of [...box.querySelectorAll<HTMLElement>('.pkc-place')]) {
    const lid = nested.getAttribute('data-pkc-entry');
    if (lid !== null && lid !== '') {
      const link = doc.createElement('button');
      link.type = 'button';
      link.setAttribute('data-pkc-field', 'place-body-link');
      link.setAttribute('data-pkc-action', 'select-entry');
      link.setAttribute('data-pkc-entry', lid);
      link.textContent = titleOf(lid) ?? '(見つかりません)';
      nested.replaceWith(link);
    } else {
      const plain = doc.createElement('div');
      plain.setAttribute('data-pkc-field', 'place-body-note');
      plain.append(...nested.childNodes);
      nested.replaceWith(plain);
    }
  }
  for (const line of [...box.querySelectorAll('.pkc-line')]) line.remove();

  // ② 図・画像は描かない(W3-②)── 1 行に降ろす。⚠ 図は囲み(コピーの帯・切替つき)ごと降ろす
  for (const fig of [
    ...box.querySelectorAll<HTMLElement>('.pkc-mermaid-placeholder, .pkc-chart-placeholder, .pkc-math'),
  ]) {
    // 🔑 囲みごと降ろすのは「描画の囲み(`data-pkc-render-lang`)」だけ ── 表のセルの中の数式で
    //   表ごと消さない
    const target = fig.closest<HTMLElement>('.pkc-md-block[data-pkc-render-lang]') ?? fig;
    if (target.parentNode === null) continue; // 同じ囲みの 2 つ目は、もう降ろし済み
    target.replaceWith(note(PLACE_FIGURE_NOTE, target === fig && fig.tagName === 'SPAN' ? 'span' : 'div'));
  }
  for (const img of [...box.querySelectorAll('img[data-pkc-asset-key]')]) {
    img.replaceWith(note(PLACE_IMAGE_NOTE, 'span'));
  }
  // 添付へのリンクは、押しても何も起きない(受け手が居ない)── 字だけ残す
  for (const a of [...box.querySelectorAll('a[data-pkc-asset-key]')]) {
    const plain = doc.createElement('span');
    plain.append(...a.childNodes);
    a.replaceWith(plain);
  }

  // ③ 見出しは見出しでなくす(目次・章の右クリックが板のノートの章を指さない)
  for (const h of [...box.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]) {
    const row = doc.createElement('div');
    row.setAttribute('data-pkc-embedded-heading', h.tagName.slice(1));
    row.append(...h.childNodes);
    h.replaceWith(row);
  }

  // ④ コピーの帯・ソース切替は外す(受け手が行番号を前提にする)/ id は全部剥がす
  for (const el of [
    ...box.querySelectorAll('.pkc-md-copy-btn, .pkc-render-toggle-input, .pkc-render-toggle'),
  ])
    el.remove();
  for (const el of box.querySelectorAll('[id]')) el.removeAttribute('id');
  // ⑤ 押せるのは「別のノートへ飛ぶ」だけ。それ以外の押し口(`data-pkc-action`)は外す
  for (const el of box.querySelectorAll('[data-pkc-action]')) {
    const action = el.getAttribute('data-pkc-action');
    if (action !== 'navigate-entry-ref' && action !== 'select-entry') el.removeAttribute('data-pkc-action');
  }
}

/**
 * 板の中の `entry=` の塊に、置いたノートの中身を描く(**描画のたびに呼んでよい**。冪等)。
 *
 * 呼ぶのは 2 つの場面:本文の板が描き直されたとき(`applyPlaceLayout` の後)と、
 * 抜粋が届いた / 書込で変わったとき(本文は描き直さず、この面だけ)。
 */
export class PlaceEmbeds {
  /** 描いた HTML の控え(`lid` → 鍵と HTML)。⚠ 板に在る lid の分だけ残す。 */
  private readonly cache = new Map<string, { readonly key: string; readonly html: string }>();
  /** もう頼んだ lid(描き直すたびに頼み直さない)。 */
  private readonly asked = new Set<string>();

  /** 別のノートへ移るとき。⚠ 頼んだ控えも手放す(読めなかった lid を次の板でも頼み直せる)。 */
  reset(): void {
    this.cache.clear();
    this.asked.clear();
  }

  sync(host: HTMLElement, deps: PlaceEmbedDeps): void {
    const seen = new Set<string>();
    const need: string[] = [];
    for (const block of host.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
      const lid = block.getAttribute('data-pkc-place-entry') ?? '';
      if (lid === '') continue;
      if (!embeddable(deps, lid)) {
        dropSlot(block);
        continue;
      }
      seen.add(lid);
      const ex = deps.excerptOf(lid);
      if (ex === undefined) {
        // まだ読めていない ── 頼む(1 度だけ)。出ている物が在れば、そのまま残す
        if (!this.asked.has(lid)) {
          this.asked.add(lid);
          need.push(lid);
        }
        continue;
      }
      this.asked.delete(lid);
      const key = `${ex.cut ? '1' : '0'}\u0000${ex.text}`;
      const slot = ensureSlot(block);
      if (slot.getAttribute(KEY_ATTR) === key) continue;
      const cached = this.cache.get(lid);
      if (cached !== undefined && cached.key === key) {
        this.fill(slot, key, cached.html, ex.cut, lid, deps);
        continue;
      }
      if (slot.getAttribute(PENDING_ATTR) === key) continue; // 描いている最中
      slot.setAttribute(PENDING_ATTR, key);
      void deps
        .render(ex.text)
        .then((html) => {
          this.cache.set(lid, { key, html });
          // ⚠ もっと新しい鍵が来ている / 塊が差し替わった ── この結果は載せない
          if (slot.getAttribute(PENDING_ATTR) !== key || slot.parentNode === null) return;
          this.fill(slot, key, html, ex.cut, lid, deps);
        })
        .catch(() => {
          // ⚠ 描けなかっただけ ── 次に呼ばれたときにもう一度描く
          if (slot.getAttribute(PENDING_ATTR) === key) slot.removeAttribute(PENDING_ATTR);
        });
    }
    // 板から無くなった lid の控えは捨てる(常駐を板の枚数に縛る)
    for (const lid of this.cache.keys()) if (!seen.has(lid)) this.cache.delete(lid);
    if (need.length > 0) deps.wanted(need);
  }

  private fill(
    slot: HTMLElement,
    key: string,
    html: string,
    cut: boolean,
    lid: string,
    deps: PlaceEmbedDeps,
  ): void {
    const doc = slot.ownerDocument;
    const box = doc.createElement('div');
    box.innerHTML = html;
    sanitizeEmbedded(box, (l) => deps.metaOf(l)?.title ?? null);
    slot.textContent = '';
    slot.append(...box.childNodes);
    if (cut) {
      // 🔑 続きは押して開ける(今の窓で。題名の帯と同じ口 `select-entry`)
      const more = doc.createElement('button');
      more.type = 'button';
      more.setAttribute('data-pkc-field', 'place-body-more');
      more.setAttribute('data-pkc-action', 'select-entry');
      more.setAttribute('data-pkc-entry', lid);
      more.textContent = PLACE_MORE_NOTE;
      slot.append(more);
    }
    slot.setAttribute(KEY_ATTR, key);
    slot.removeAttribute(PENDING_ATTR);
  }
}
