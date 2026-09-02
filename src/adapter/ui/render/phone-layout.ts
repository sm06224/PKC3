/**
 * スマホ用画面を**画面へ写す**(#632 段①)。判定は `features/phone-layout.ts`。
 *
 * 設計 doc: `docs/development/mobile-screen-design-2026-09.md` §2-4 / §2-5 / §2-8。
 *
 * 🔴 **幅を見るのはここ 1 か所**(`matchMedia`)。CSS には数字を 1 文字も書かない ──
 *   読むのは `data-pkc-layout='phone'` と `data-pkc-page=list|note|info` の 2 属性だけ。
 *   ⚠ 両方に書くと、片方だけ変えた日に **JS と CSS が別の幅で切り替わる**。
 *
 * 🔴 **3 面は同じ grid セルに重ねて `visibility` で切り替える**(`display:none` にしない)。
 *   ⚠ `display:none` にすると ① `mermaid-hydrate.ts` の `widthOf` が幅 0 で **640 に落ちて
 *   鍵が変わり、図を焼き直す**(`parentElement.clientWidth || host.clientWidth || 640`)
 *   ② `center.ts` が実測した「短い面では `scrollTop` が 0 に丸められる」を踏む
 *   ── どちらも**戻ってきたときに元へ戻らない**形の損である。
 *   🔑 `visibility` なら ResizeObserver 3 本(段組み / 横並べ / mermaid)は鳴らない。
 *
 * ⚠ **`inert` も対で付ける** ── `visibility:hidden` は焦点を止めるが、
 *   古い実装では見えない面の中へ Tab が入りうる。⚠ 属性で書く(`el.inert` の
 *   プロパティは happy-dom に無い)。
 *
 * ## この段で作っていないもの(段③)
 *
 * ⚠ **`PHONE_MIN_PX` の 2 本目の `matchMedia`**(対応外の 1 行)だけが**まだ無い**。
 *   使う所と一緒に足す ── 使い道のない seam を先に置くと、次に読む人が
 *   「配線されている」と読む(#69 の壊れたポインタの逆向き)。
 * 🔑 **`reveal` の 3 つの呼び元は段① へ前倒した**(`focus-search` / `filter-by-tag` /
 *   `toc-jump`。設計 doc §4-b)── 一覧は DOM から消えないので、直さないと
 *   #583 で直した無言の dead click がそのまま戻るためである。
 */
import {
  PHONE_MAX_PX,
  phoneBandShown,
  phonePageOf,
  phoneReturnShown,
  type PhoneOpen,
  type PhonePage,
  type PhoneShape,
} from '@features/phone-layout';

/** 器の印。⚠ unit / smoke はこの印で見る。 */
export const PHONE_BAR_REGION = 'phone-bar';
/**
 * 🔴 **一覧の上の「ノートへ →」**(user 裁定 2026-09-02)。⚠ 器は `shell.ts` が
 *   1 度だけ組み、中身を書くのは `paintReturn` **1 か所**である(帯と同じ作法)。
 */
export const PHONE_RETURN_REGION = 'phone-return';
/** shell に書く属性 2 つ。⚠ CSS が読むのはこの 2 つだけ。 */
export const PHONE_LAYOUT_ATTR = 'data-pkc-layout';
export const PHONE_PAGE_ATTR = 'data-pkc-page';

/**
 * 重ねる 3 面と、それを出すページ。⚠ **`pane` も center を出す** ──
 * 設定・ヘルプ等は center の中の面なので、器としては本文と同じである
 * (違うのは帯を出すかだけ)。
 * ⚠ **面を開いても `open` は残る** ── 面を閉じると、情報ページ / 一覧へ戻る。
 *   `phonePageOf` が面を優先するのは「**見せない**」であって「畳む」ではない
 *   (2026-09-02 の着地前レビューで言葉を直した)。
 */
const FACE: Readonly<Record<PhonePage, string>> = {
  list: 'sidebar',
  note: 'center',
  pane: 'center',
  info: 'inspector',
};

/** 描くのに要るもの。⚠ `AppState` そのものは取らない(判定に効く物だけ受ける)。 */
export interface PhoneRenderState extends PhoneShape {
  /** 帯に出す題名。⚠ 無ければ空文字(「(無題)」等の作り字はここで作らない)。 */
  readonly title: string;
}

type MediaLike = {
  readonly matches: boolean;
  addEventListener?: (t: 'change', fn: () => void) => void;
  removeEventListener?: (t: 'change', fn: () => void) => void;
};

/**
 * 🔴 **スマホ用画面の器**(アプリに 1 個)。
 *
 * ⚠ **どの面を見ているかを `AppState` に持たない** ── 端末の見え方であって
 *   ノートのデータではない(`pane-visibility` と同じ分け方)。⚠ ただしあちらと違い
 *   **保存もしない** ── 「いまこのノートの情報を見ている」「一覧を見ている」は
 *   一時の文脈であり、次に起動したときに引き継ぐと user が頼んでいない画面から始まる。
 */
export class PhoneLayout {
  private root: HTMLElement | null = null;
  private media: MediaLike | null = null;
  private onChange: (() => void) | null = null;
  /**
   * 🔑 **本文の代わりに見せている物**(`{ kind, lid }`)。理由は features 側の
   *   `PhoneOpen` の docstring(情報と一覧を 2 つの field に分けない)。
   */
  private open: PhoneOpen = null;
  /** 最後に描いた材料。⚠ 帯を押したときは state が動かないので、ここから描き直す。 */
  private last: PhoneRenderState | null = null;
  /**
   * 🔴 **版面が入れ替わったことを外へ知らせる**(#632 段①)。
   *
   * ⚠ これが無いと**窓を狭めた回だけ一覧が真っ白になる** ── `applyPaneVisibility`
   *   は「スマホなら列の畳みを写さない」と決めたが、**書くのは呼ばれたときだけ**
   *   である。PC で一覧を畳んだまま窓を狭めると、`data-pkc-hidden-panes~='sidebar'`
   *   が残ったまま `data-pkc-layout='phone'` が付き、重ねた一覧が `display: none` の
   *   ままになる(押す口も無いので #609 の行き止まりが戻る)。
   * 🔑 **写す関数の入力が変わったら写し直す** ── CSS 側で `display` を上書きして
   *   隠す形にはしない(それは「効いているように見えるが、鳴らない」規則になる)。
   */
  private onToggle: (() => void) | null = null;
  /** 直前に写した版面。⚠ **変わったときだけ**知らせる(毎描画で走らせない)。 */
  private wasPhone: boolean | null = null;

  /**
   * 幅の見張りを張る。⚠ **戻り値で外せる**(unit が 1 件ずつ独立に張る)。
   * @param mm 差し替え口(unit / 別の窓)。既定は window の `matchMedia`。
   */
  install(
    root: HTMLElement,
    mm?: (q: string) => MediaLike,
    /** 版面が PC ⇄ スマホで入れ替わったときに 1 度呼ぶ。⚠ 上の `onToggle` を読む。 */
    onToggle?: () => void,
  ): () => void {
    this.dispose();
    this.root = root;
    this.onToggle = onToggle ?? null;
    this.wasPhone = null;
    /**
     * ⚠ **開いていた情報 / 一覧のページは持ち越さない** ── `install` は新しい器に
     *   張り直すことなので、前の器で開いていた文脈は消える。⚠ 消し忘れると unit で
     *   **1 つ前の test の状態の上で走る**(実際に踏んだ:2 件目の test だけ
     *   「← 一覧」が「← ノート」になっていた)。
     */
    this.open = null;
    this.last = null;
    const make =
      mm ?? ((q: string) => (globalThis as { matchMedia?: (q: string) => MediaLike }).matchMedia?.(q));
    const media = make(`(max-width: ${PHONE_MAX_PX}px)`) ?? null;
    this.media = media;
    if (media?.addEventListener) {
      const fn = (): void => this.paint();
      this.onChange = fn;
      media.addEventListener('change', fn);
    }
    this.paint();
    return () => this.dispose();
  }

  private dispose(): void {
    if (this.media?.removeEventListener && this.onChange)
      this.media.removeEventListener('change', this.onChange);
    this.media = null;
    this.onChange = null;
  }

  /** いまスマホ用画面か。⚠ `applyPaneVisibility` のガードもこれを読む。 */
  isPhone(): boolean {
    return this.media?.matches === true;
  }

  /** いま出ているページ。⚠ スマホでなければ `null`。 */
  page(): PhonePage | null {
    if (!this.isPhone()) return null;
    return phonePageOf(this.last ?? { selectedLid: null, viewMode: 'detail', editing: false }, this.open);
  }

  /** 情報ページを開く。⚠ **どのノートで開いたか**を憶える(別のノートへ移ると閉じる)。 */
  showInfo(lid: string | null): void {
    this.open = lid === null ? null : { kind: 'info', lid };
    this.paint();
  }

  /**
   * 🔴 **ノートを開いたまま一覧を見せる**(user 裁定 2026-09-02)。
   *
   * ⚠ **選択は外さない** ── 直す前は `DESELECT_ENTRY` を撃っていたので、
   *   一覧へ戻ると**読んでいたノートが分からなくなる**(戻り道は「もう一度探す」
   *   しかない)。裁定は「**開いたままにし、一覧の上に「ノートへ →」を出す**」。
   * ⚠ 開いているノートが無ければ**何も憶えない**。
   *   🔑 ただし**これは画面を守っていない**(2026-09-02 の着地前レビューで検算した)──
   *   守っているのは `phoneReturnShown` の `selectedLid !== null` 側で、ここに
   *   `{ kind:'list', lid:'' }` を入れても行は 1 度も出ない。⚠ 意味の無い値を
   *   憶えないための整理であって、「これが無いと壊れる」ではない。
   */
  showList(): void {
    const lid = this.last?.selectedLid ?? null;
    this.open = lid === null ? null : { kind: 'list', lid };
    this.paint();
  }

  /** 本文ページへ戻る(情報も一覧も畳む)。 */
  showNote(): void {
    this.open = null;
    this.paint();
  }

  /**
   * 🔴 **その面を出すために、こちら側でできることをやる**(#632 段①、設計 doc §2-15)。
   *
   * ⚠ これが無いと **#583 で直した無言の dead click が、スマホでそのまま戻る** ──
   *   一覧は DOM から消えず `visibility` で隠れるだけなので、`focus-search` の
   *   `querySelector` は**見つけてしまい**、隠れた欄に焦点を入れて何も起きない。
   *   🔴 しかも鍵は食われている(`prevent()` が先)。
   * 🔑 押した user の意図は「**探したい**」であって「本文を開いたままにしたい」では
   *   ない ── #583 が「畳んでいたら戻してから効かせる」を選んだのと同じ理由で、
   *   スマホでは**ページを移す**。
   *
   * @returns `'needs-detail'` = 一覧まで**まだ届いていない**(中央が設定・ヘルプ等の
   *   面を出している)。⚠ **ここでは dispatch しない**(renderer は state を動かさない
   *   ── 層規約)ので、呼び側が `SET_VIEW_MODE` を撃つ。
   */
  reveal(face: 'list' | 'note'): 'needs-detail' | 'none' {
    if (face === 'note') {
      this.showNote();
      return 'none';
    }
    this.showList();
    return this.isPhone() && this.page() !== 'list' ? 'needs-detail' : 'none';
  }

  /** state が動いたら描き直す。⚠ 呼び元は `main.ts` の `onState` 1 か所。 */
  render(st: PhoneRenderState): void {
    this.last = st;
    this.paint();
  }

  /**
   * 属性と帯を書く。⚠ **ここが唯一の書き手**である ── 面ごとに書くと、
   * 面を 1 つ足した日にその面だけ切り替わらない。
   */
  private paint(): void {
    const root = this.root;
    if (root === null) return;
    const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]');
    if (shell === null) return;
    const bar = root.querySelector<HTMLElement>(`[data-pkc-region="${PHONE_BAR_REGION}"]`);
    const back = root.querySelector<HTMLElement>(`[data-pkc-region="${PHONE_RETURN_REGION}"]`);
    /**
     * ⚠ **state が来る前でも描く** ── `install()` は boot の早い所で走り、
     *   `applyPaneVisibility` の復元より**前**に印を立てる必要がある
     *   (立っていないと、畳んだ列がスマホでも復元されてしまう)。
     *   その時点で選ばれているノートは無いので、既定は一覧ページである。
     */
    const st: PhoneRenderState = this.last ?? { selectedLid: null, viewMode: 'detail', editing: false, title: '' };

    if (!this.isPhone()) {
      shell.removeAttribute(PHONE_LAYOUT_ATTR);
      shell.removeAttribute(PHONE_PAGE_ATTR);
      for (const region of Object.values(FACE))
        shell.querySelector(`[data-pkc-region="${region}"]`)?.removeAttribute('inert');
      if (bar) bar.hidden = true;
      // ⚠ PC では 1px も場所を取らせない(スマホでしか意味の無い行である)
      if (back) back.hidden = true;
      this.notifyToggle();
      return;
    }

    const page = phonePageOf(st, this.open);
    shell.setAttribute(PHONE_LAYOUT_ATTR, 'phone');
    shell.setAttribute(PHONE_PAGE_ATTR, page);
    const live = FACE[page];
    for (const region of new Set(Object.values(FACE))) {
      const el = shell.querySelector(`[data-pkc-region="${region}"]`);
      if (el === null) continue;
      if (region === live) el.removeAttribute('inert');
      else el.setAttribute('inert', '');
    }
    if (bar) this.paintBar(bar, st, page);
    if (back) this.paintReturn(back, st);
    this.notifyToggle();
  }

  /** ⚠ `paint()` の末尾で 1 度だけ ── 呼び先が `applyPaneVisibility` なので再入しない。 */
  private notifyToggle(): void {
    const now = this.isPhone();
    if (this.wasPhone === now) return;
    this.wasPhone = now;
    this.onToggle?.();
  }

  /**
   * 帯の中身。⚠ **器は作り直さない**(`shell.ts` が 1 度だけ組む)── 作り直すと
   * 押している最中のボタンが指の下から消える(収録の帯と同じ理由)。
   */
  private paintBar(bar: HTMLElement, st: PhoneRenderState, page: PhonePage): void {
    const shown = phoneBandShown(page);
    bar.hidden = !shown;
    if (!shown) return;
    const back = bar.querySelector<HTMLElement>('[data-pkc-field="phone-back"]');
    const info = bar.querySelector<HTMLElement>('[data-pkc-field="phone-info"]');
    const title = bar.querySelector<HTMLElement>('[data-pkc-field="phone-title"]');
    if (back) {
      /**
       * 🔴 **戻る先はページで変わる**(設計 doc §2-6)── 本文からは一覧へ、
       *   情報からは本文へ。⚠ 字も一緒に変える ── 「← 一覧」のまま情報ページで
       *   押させると、**一気に一覧まで飛ぶ**と読まれる(押した結果が予告と違う)。
       */
      const toList = page !== 'info';
      back.setAttribute(PHONE_PAGE_ATTR, toList ? 'list' : 'note');
      back.textContent = toList ? '← 一覧' : '← ノート';
      back.title = toList ? '一覧へ戻ります' : 'ノートの本文へ戻ります';
    }
    // ⚠ 情報ページでは「情報」を出さない ── いま居る場所へ行くボタンは dead click
    if (info) info.hidden = page === 'info';
    if (title) title.textContent = st.title;
  }

  /**
   * 🔴 **一覧の上の「ノートへ →(題名)」**(user 裁定 2026-09-02
   * 「**開いたままにし、一覧の上に「ノートへ →」を出す**」)。
   *
   * ⚠ **出るのは「ノートを開いたまま一覧を見ている」ときだけ** ── 起動直後の
   *   ような、そもそも開いているノートが無い一覧では出さない(押す先が無い)。
   *   判定は `phoneReturnShown` = `phonePageOf` に聞く 1 か所である。
   * ⚠ **器は作り直さない**(帯と同じ) ── 一覧は state のたびに組み直されるが、
   *   この行は `shell.ts` が sidebar の**先頭子**として 1 度だけ作る。
   */
  private paintReturn(back: HTMLElement, st: PhoneRenderState): void {
    const shown = phoneReturnShown(st, this.open);
    back.hidden = !shown;
    if (!shown) return;
    const title = back.querySelector<HTMLElement>('[data-pkc-field="phone-return-title"]');
    if (title) title.textContent = st.title;
  }
}

/** アプリ共有の 1 個(`appPanes` / `appKeymap` と同じ作法)。 */
export const appPhone = new PhoneLayout();
