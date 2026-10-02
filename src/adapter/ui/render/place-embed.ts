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
 * だから見出しは**見出しでない行**へ降ろし、コピーの帯・ソース切替は外す。
 * 🔴 **`id` は剥がさず、枠ごとの接頭辞(`place-<n>-`)を付ける**(W3-②。Gemini 裁定 Q3 = A)──
 *   同じノートを 2 枚置くと、見出し・脚注・図の `id` が**同じ文書の中で重複する**。接頭辞なら
 *   重複が無く、目次(`#章`)と脚注(`#fn1`)の押しが**同じ枠の中**の相手へ飛ぶ(別の枠・読む面の
 *   同じ `id` へ飛ばない)。`href="#…"` / `for` / `aria-labelledby` も同じ接頭辞で書き直す。
 * 🔴 **入れ子の板は展開しない**(深さ ≤ 1)── 中の「置いたノート」は**題名だけの行**へ降りる。
 *
 * ## 🔴 図と画像(W3-②)── 読む面と同じ口に乗せる(新しい仕掛けを作らない)
 *
 * - **図(mermaid / chart / 数式)**:器をそのまま残し、描いた後に `hydrateFigures`(読む面と同じ
 *   1 本)へ渡す。「見えたときに描く」の観測は `visible-watch.ts` の 1 本で、**枠の中でスクロール
 *   して見えていない図は焼かれない**(枠が 320px なので、焼く幅の鍵も読む面と別になる)。
 *   PNG は `<img>` 1 枚・IDB の鍵つき・ObjectURL は枠の寿命終端で返る(不可侵の規律はそのまま)。
 * - **本文の中の添付画像**:読む面と同じ貸出(`AssetLends`)。⚠ **枠ごとに 1 つ**持つ ──
 *   共有の 1 つだと、別の枠の描き直しが「世代」を進めて、飛んでいる貸出を捨てる。
 * - **添付ノートを置いたとき**:画像は**画像そのもの**を枠いっぱいに(`PlaceAttachment`)。
 *   PDF は題名の帯 + 「PDF」の字、Office・zip・その他は題名の帯だけ。
 *
 * ## 寿命
 *
 * 描いた HTML の控えは**いま板に在る lid の分だけ**(`sync` のたびに、無くなった物は捨てる)。
 * 図の塊・貸出は**枠(slot)が画面から外れたとき**と**別のノートへ移るとき**に返す
 * (`release`)。新しい常駐は作らない ── 描くのは既存の markdown 描画口(ワーカー。使い捨て)である。
 */
import { PLACE_NEAR_MARGIN, placeEmbeddable, type PlaceExcerpt } from '@features/markdown/place-embed';
import { AssetLends, type AssetLender } from './asset-lends';
import { pruneScopes, type MermaidScope } from './mermaid-hydrate';
import { markViewBig } from './view-big';
import { watchVisible, type VisibleWatch } from './visible-watch';

/** 塊の中の、置いたノートの本文の器。 */
export const PLACE_BODY_FIELD = 'place-body';
/** 塊に付く印(本文の器を持っている間だけ)── CSS が「題名の帯 + 送れる本文」の形に切り替える。 */
export const PLACE_EMBEDDED_ATTR = 'data-pkc-place-embedded';

/** 描き終えた内容の鍵 / 描いている最中の鍵(同じ鍵では頼み直さない)。 */
const KEY_ATTR = 'data-pkc-place-body-key';
const PENDING_ATTR = 'data-pkc-place-body-pending';
/** 枠ごとの `id` の接頭辞(`place-<n>-`)。⚠ 同じ枠は描き直しても同じ値のまま(押した先が動かない)。 */
export const PLACE_NS_ATTR = 'data-pkc-place-ns';
/** 添付ノートの枠の印(`image` / `pdf`)。CSS が「絵をいっぱいに」へ切り替える。 */
export const PLACE_ATTACHMENT_ATTR = 'data-pkc-place-attachment';
/** 置いた添付ノートの絵(`<img>`)の器。 */
export const PLACE_ATTACHMENT_IMAGE = 'place-attachment-image';

const BLOCK_SELECTOR = '.pkc-format-block.pkc-place[data-pkc-place-entry]';

/** 画面の字(続き・PDF)── ⚠ 使わない語(`ui-terms.ts`)を避けている。 */
export const PLACE_MORE_NOTE = '続きは元のノートで';
export const PLACE_PDF_NOTE = 'PDF は元のノートで';

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
  /** 添付(画像)を借りる口。`null` = 添付の置き場が無い(借りられない画像は「見つからない」の印になる)。 */
  readonly lender: AssetLender | null;
  /**
   * 図の器を埋める口(読む面と**同じ 1 本**、`detail.ts` の `hydrateFigures`)。
   * ⚠ 必須にしてある ── 配線を落としても tsc が黙ると、板の中でだけ図が原文のまま残る。
   */
  readonly figures: (roots: readonly ParentNode[]) => MermaidScope[];
  /**
   * 🔴 **板を送る器**(スクロールする要素)。「見えそうな枠」はこの器からの距離で決める。
   * ⚠ `null` = 決められない(器の外の画面を基準にする)── 器が枠を切るので、離れた枠が
   *   余白の内側でも「見えていない」と読まれ、**スクロールに追従して描けなくなる**。
   */
  readonly viewRoot: Element | null;
}

/** 器を持つ塊の lid を全部返す(板が展開してよい塊だけ)。 */
function embeddable(deps: PlaceEmbedDeps, lid: string): boolean {
  const meta = deps.metaOf(lid);
  return meta !== undefined && lid !== deps.selfLid && placeEmbeddable(meta.archetype);
}

function ensureSlot(block: HTMLElement, newNs: () => string): HTMLElement {
  let slot = block.querySelector<HTMLElement>(`:scope > [data-pkc-field="${PLACE_BODY_FIELD}"]`);
  if (slot === null) {
    slot = block.ownerDocument.createElement('div');
    slot.setAttribute('data-pkc-field', PLACE_BODY_FIELD);
    // 🔑 枠ごとの `id` の接頭辞(同じノートを 2 枚置いても `id` が重複しない)
    slot.setAttribute(PLACE_NS_ATTR, newNs());
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
 *
 * @param ns 枠ごとの `id` の接頭辞(`place-<n>-`)。⚠ **必須**にしてある ── 付け忘れる呼び出しを
 *   tsc が止める(付けないと、同じノートを 2 枚置いた板で `id` が重複する)。
 */
export function sanitizeEmbedded(
  box: HTMLElement,
  titleOf: (lid: string) => string | null,
  ns: string,
): void {
  const doc = box.ownerDocument;

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

  // ② 図(`.pkc-mermaid-placeholder` / `.pkc-chart-placeholder` / `.pkc-math`)と本文の画像
  //    (`img[data-pkc-asset-key]`)は**そのまま残す** ── 描いた後に読む面と同じ口が埋める(`fill`)。
  //    添付へのリンクは、押しても何も起きない(受け手が居ない)── 字だけ残す
  for (const a of [...box.querySelectorAll('a[data-pkc-asset-key]')]) {
    const plain = doc.createElement('span');
    plain.append(...a.childNodes);
    a.replaceWith(plain);
  }

  // ③ 見出しは見出しでなくす(目次・章の右クリックが板のノートの章を指さない)
  //    🔑 `id` は行へ写す(目次の押しが同じ枠の中の行へ飛べる ── 接頭辞は下の ④)
  for (const h of [...box.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]) {
    const row = doc.createElement('div');
    row.setAttribute('data-pkc-embedded-heading', h.tagName.slice(1));
    const id = h.getAttribute('id');
    if (id !== null && id !== '') row.setAttribute('id', id);
    row.append(...h.childNodes);
    h.replaceWith(row);
  }

  // ④ コピーの帯・ソース切替は外す(受け手が行番号を前提にする)
  for (const el of [
    ...box.querySelectorAll('.pkc-md-copy-btn, .pkc-render-toggle-input, .pkc-render-toggle'),
  ])
    el.remove();
  /**
   * 🔴 **`id` は枠ごとの接頭辞つきで残す**(Gemini 裁定 Q3 = A)。
   * ⚠ 剥がすと目次(`#章`)・脚注(`#fn1`)の押しが**板のノートや別の枠の同じ `id`** へ飛ぶ。
   * 🔑 `id` を持つ要素 / それを指す `href="#…"` / `for` / `aria-labelledby` / `aria-describedby` を
   *   **同じ接頭辞で全部**書き直す(片方だけだと、リンクが宙に浮く)。
   */
  for (const el of box.querySelectorAll('[id]')) el.setAttribute('id', ns + (el.getAttribute('id') ?? ''));
  for (const a of box.querySelectorAll('a[href^="#"]'))
    a.setAttribute('href', `#${ns}${(a.getAttribute('href') ?? '#').slice(1)}`);
  for (const el of box.querySelectorAll('[for]')) el.setAttribute('for', ns + (el.getAttribute('for') ?? ''));
  for (const attr of ['aria-labelledby', 'aria-describedby']) {
    for (const el of box.querySelectorAll(`[${attr}]`)) {
      const ids = (el.getAttribute(attr) ?? '').split(/\s+/).filter((t) => t !== '');
      el.setAttribute(attr, ids.map((t) => ns + t).join(' '));
    }
  }
  // ⑤ 押せるのは「別のノートへ飛ぶ」だけ。それ以外の押し口(`data-pkc-action`)は外す
  for (const el of box.querySelectorAll('[data-pkc-action]')) {
    const action = el.getAttribute('data-pkc-action');
    if (action !== 'navigate-entry-ref' && action !== 'select-entry') el.removeAttribute('data-pkc-action');
  }
}

/** 切り出しの鍵(同じ鍵では描き直さない)。 */
function keyOf(ex: PlaceExcerpt): string {
  if (ex.att !== undefined) return `a\u0000${ex.att.kind}\u0000${ex.att.mime}\u0000${ex.att.key}`;
  return `${ex.cut ? '1' : '0'}\u0000${ex.text}`;
}

/**
 * 板の中の `entry=` の塊に、置いたノートの中身を描く(**描画のたびに呼んでよい**。冪等)。
 *
 * 呼ぶのは 2 つの場面:本文の板が描き直されたとき(`applyPlaceLayout` の後)と、
 * 抜粋が届いた / 書込で変わったとき(本文は描き直さず、この面だけ)。
 *
 * ## 🔴 中身を描くのは「近づいた枠」から(W3-③)
 *
 * 全部の枠に最初から中身を出すと、板を開く時間が枠の数に比例して伸びた(N = 200 で初回 6〜9 秒、
 * 開き直しで主スレッドが 0.4〜0.7 秒固まる。実測 `docs/development/place-embed-measure-2026-10.md`)。だから:
 * - **画面から `PLACE_NEAR_MARGIN` までに近づいた枠から**器を作って中身を入れる(離れた枠は帯だけ)
 * - 「近づいたか」は `watchVisible`(図の「見えたとき」と**同じ 1 本**)に余白と基準の器を渡して問う。
 *   観測器は板 1 つにつき 1 つ(枠ごとに作らない)
 * - 🔴 **一度描いた枠は、離れても捨てない。** 捨てる版(離れて 1.5 秒で器ごと返す)も作って測ったが、
 *   枠を作り直すたびに画像を新しい URL で読み直し、**ブラウザの控えが積もって**、板を何往復もすると
 *   常駐が捨てない版より増えた(N = 200 で 14 往復後に 760〜840MB の鋸歯 ── 捨てない版は 640〜650MB で止まる)。
 *   捨てて得られる分(圧迫の通知で控えを返させた後で 30〜45MB)は、その測り方のぶれ(捨てない版の 3 回が
 *   501〜610MB)に埋もれる。**捨てない**。
 * ⚠ 本文の抜粋(`placeBodies`)は**離れた枠の分も頼む** ── 切った文字列で小さく、添付ノートは
 *   読むまで「画像か」が分からず、大きさ(既定の 320 × 240 を当てるか)が決まらないため。
 * ⚠ 観測できない環境(`IntersectionObserver` が無い)では**今までどおり全部の枠に出す**。
 */
export class PlaceEmbeds {
  /** 描いた HTML の控え(`lid` → 鍵と HTML)。⚠ 板に在る lid の分だけ残す。 */
  private readonly cache = new Map<string, { readonly key: string; readonly html: string }>();
  /** もう頼んだ lid(描き直すたびに頼み直さない)。 */
  private readonly asked = new Set<string>();
  /**
   * 🔴 **枠ごとの貸出の帳簿**(W3-②)。⚠ **枠ごとに 1 つ**にする ── `AssetLends.hydrate` は呼ぶたびに
   * 世代を進めて、飛んでいる貸出を「古い」と捨てる。共有の 1 つだと、別の枠の描き直しが
   * 自分の枠の画像を落とす。⚠ 枠が画面から外れたら返す(`sync` の頭)。
   */
  private readonly lends = new Map<HTMLElement, AssetLends>();
  /** 図の塊(読む面と同じ `MermaidScope`)。⚠ 器が全部外れたら畳む(`pruneScopes`)/ `release` で全部畳む。 */
  private readonly scopes: MermaidScope[] = [];
  /** この回で器を埋め直した枠(まとめて 1 回で図の塊を作る ── 観測器を枠ごとに積まない)。 */
  private fresh: HTMLElement[] = [];
  /** 枠の接頭辞の連番。⚠ `reset` でも戻さない(古い `href` が別の枠を指さない)。 */
  private nsSeq = 0;

  /** 近づいたかの観測(板に 1 つ)。`null` = まだ作っていない / 観測できない環境。 */
  private watcher: VisibleWatch | null = null;
  /** 観測に載せた塊。 */
  private readonly watched = new Set<HTMLElement>();
  /** 近づいた塊。⚠ 一度入れたら離れても外さない(`release` まで)。 */
  private readonly near = new Set<HTMLElement>();
  /**
   * 近づいた塊の lid。⚠ 描き直しで**塊そのものが作り直された**とき、近づいていた lid は引き継ぐ ──
   * 引き継がないと、板の本文を 1 行直すたびに、描いてあった枠が全部 1 回空になる。
   */
  private readonly nearLids = new Set<string>();
  /** 観測の通知から `sync` を呼ぶための控え。 */
  private host: HTMLElement | null = null;
  private deps: PlaceEmbedDeps | null = null;

  /** 器を手放す(別のノートへ移る / 面を畳む)。⚠ 図の URL と貸出をここで返す(不可侵の規律)。 */
  release(): void {
    for (const lends of this.lends.values()) lends.disposeAll();
    this.lends.clear();
    for (const sc of this.scopes.splice(0)) sc.dispose();
    this.fresh = [];
    this.watcher?.disconnect();
    this.watcher = null;
    this.watched.clear();
    this.near.clear();
    this.nearLids.clear();
    this.host = null;
    this.deps = null;
  }

  /** 別のノートへ移るとき。⚠ 頼んだ控えも手放す(読めなかった lid を次の板でも頼み直せる)。 */
  reset(): void {
    this.release();
    this.cache.clear();
    this.asked.clear();
  }

  /** 塊を観測に載せる(離れた塊の中身を作らない)。 */
  private watch(blocks: readonly HTMLElement[], root: Element | null): void {
    if (typeof IntersectionObserver !== 'function') return;
    // 🔑 板でない本文では観測器を作らない(`syncPlaceEmbeds` は本文を描くたびに呼ばれる)
    if (this.watcher === null && blocks.length === 0) return;
    this.watcher ??= watchVisible((b) => this.onNear(b), {
      root,
      rootMargin: `${String(PLACE_NEAR_MARGIN)}px`,
    });
    for (const b of [...this.watched]) {
      if (b.isConnected) continue;
      this.watcher.unobserve(b);
      this.watched.delete(b);
      this.near.delete(b);
    }
    for (const b of blocks) {
      if (this.watched.has(b)) continue;
      this.watched.add(b);
      // 🔑 前の塊が近づいていた lid なら、作り直された塊も近づいたことにする(観測の答えを待たない)
      if (this.nearLids.has(b.getAttribute('data-pkc-place-entry') ?? '')) this.near.add(b);
      else this.watcher.observe(b);
    }
  }

  /** 塊が近づいた(1 度だけ呼ばれる)。中身を作る。 */
  private onNear(b: HTMLElement): void {
    this.near.add(b);
    this.nearLids.add(b.getAttribute('data-pkc-place-entry') ?? '');
    if (this.host !== null && this.deps !== null) this.sync(this.host, this.deps);
  }

  sync(host: HTMLElement, deps: PlaceEmbedDeps): void {
    this.host = host;
    this.deps = deps;
    // 🔴 画面から外れた枠の貸出・図を先に返す(差し替えで消えた塊は通知が来ない)
    for (const [slot, lends] of [...this.lends]) {
      if (slot.isConnected) continue;
      lends.disposeAll();
      this.lends.delete(slot);
    }
    pruneScopes(this.scopes);
    const blocks = [...host.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
    this.watch(blocks, deps.viewRoot);
    const seen = new Set<string>();
    const need: string[] = [];
    for (const block of blocks) {
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
      const meta = deps.metaOf(lid)!;
      // 🔴 絵を出せない添付(Office・zip・その他)は題名の帯だけ(W3-① のまま)
      if (meta.archetype === 'attachment' && ex.att === undefined) {
        dropSlot(block);
        continue;
      }
      // 🔴 近づいていない枠は中身を作らない(帯だけ)
      if (this.watcher !== null && !this.near.has(block)) continue;
      const key = keyOf(ex);
      const slot = ensureSlot(block, () => `place-${String(++this.nsSeq)}-`);
      if (slot.getAttribute(KEY_ATTR) === key) continue;
      if (ex.att !== undefined) {
        this.fillAttachment(slot, key, ex.att, meta.title, lid, deps);
        continue;
      }
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
          this.flushFigures(deps);
        })
        .catch(() => {
          // ⚠ 描けなかっただけ ── 次に呼ばれたときにもう一度描く
          if (slot.getAttribute(PENDING_ATTR) === key) slot.removeAttribute(PENDING_ATTR);
        });
    }
    // 板から無くなった lid の控えは捨てる(常駐を板の枚数に縛る)
    for (const lid of this.cache.keys()) if (!seen.has(lid)) this.cache.delete(lid);
    this.flushFigures(deps);
    if (need.length > 0) deps.wanted(need);
  }

  /** この回に埋め直した枠の図を、**まとめて 1 回**で読む面と同じ口へ渡す。 */
  private flushFigures(deps: PlaceEmbedDeps): void {
    if (this.fresh.length === 0) return;
    const roots = this.fresh.filter((s) => s.isConnected);
    this.fresh = [];
    if (roots.length > 0) this.scopes.push(...deps.figures(roots));
  }

  private lendsOf(slot: HTMLElement): AssetLends {
    let l = this.lends.get(slot);
    if (l === undefined) {
      l = new AssetLends();
      this.lends.set(slot, l);
    }
    return l;
  }

  /** 枠の中の添付画像を借りて差す(⚠ 印は差す前に付ける ── 押し所と `src` の有無は別の話)。 */
  private hydrateImages(slot: HTMLElement, deps: PlaceEmbedDeps): void {
    const imgs = [...slot.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]')];
    if (imgs.length === 0) return;
    for (const img of imgs) markViewBig(img);
    if (deps.lender === null) {
      for (const img of imgs) img.setAttribute('data-pkc-asset-missing', '');
      return;
    }
    void this.lendsOf(slot).hydrate(slot, deps.lender);
  }

  /** 置いた添付ノートの絵(画像)/ 字(PDF)を枠へ入れる。 */
  private fillAttachment(
    slot: HTMLElement,
    key: string,
    att: NonNullable<PlaceExcerpt['att']>,
    title: string,
    lid: string,
    deps: PlaceEmbedDeps,
  ): void {
    const doc = slot.ownerDocument;
    slot.textContent = '';
    slot.setAttribute(PLACE_ATTACHMENT_ATTR, att.kind);
    if (att.kind === 'image') {
      const img = doc.createElement('img');
      img.setAttribute('data-pkc-field', PLACE_ATTACHMENT_IMAGE);
      img.setAttribute('data-pkc-asset-key', att.key);
      img.alt = title;
      img.decoding = 'async';
      slot.append(img);
      this.hydrateImages(slot, deps);
    } else {
      // 🔴 字だけの行にしない(#1264 §1)── 隣の「続きは元のノートで」と同じ押し所(`select-entry`)。
      //    直す前は `<div>` で、「元のノートで」と言うのに**押しても何も起きなかった**
      const note = doc.createElement('button');
      note.type = 'button';
      note.setAttribute('data-pkc-field', 'place-body-skip');
      note.setAttribute('data-pkc-action', 'select-entry');
      note.setAttribute('data-pkc-entry', lid);
      note.textContent = PLACE_PDF_NOTE;
      slot.append(note);
    }
    slot.setAttribute(KEY_ATTR, key);
    slot.removeAttribute(PENDING_ATTR);
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
    sanitizeEmbedded(box, (l) => deps.metaOf(l)?.title ?? null, slot.getAttribute(PLACE_NS_ATTR) ?? '');
    slot.textContent = '';
    slot.removeAttribute(PLACE_ATTACHMENT_ATTR);
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
    // 🔴 図と画像(W3-②)── 読む面と同じ口へ。⚠ 器を入れた**後**に呼ぶ(繋がっていないと面が読めない)
    this.hydrateImages(slot, deps);
    if (slot.querySelector('[data-pkc-mermaid-src], [data-pkc-chart-src], [data-pkc-math-src]') !== null)
      this.fresh.push(slot);
  }
}
