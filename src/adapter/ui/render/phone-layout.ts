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
 * ## 幅の見張りは 2 本(#632 段③ で 2 本目を足した)
 *
 * | 見張り | 何のため |
 * |---|---|
 * | `max-width: PHONE_MAX_PX` | スマホ用画面へ切り替える |
 * | `max-width: PHONE_MIN_PX - 1` | **対応外の幅**を 1 度だけ知らせる(user 裁定 ⑥) |
 *
 * 🔴 **知らせる口はここが持たない** ── 帯の口(`showStatus`)は `main.ts` の
 *   ずっと後で組まれるので、`install` の時点では存在しない。🔑 だから
 *   **`onTooNarrow` で購読させる**(向きを 1 本にして、この file が
 *   `fold-notify` を import しない ── 逆向きに import があるので輪になる)。
 */
import {
  PHONE_MAX_PX,
  PHONE_MIN_PX,
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
   * 🔴 **対応外の幅の見張り**(#632 段③、user 裁定 ⑥)。
   * ⚠ **1 度だけ**言う ── 窓を掴んで狭めると `change` は何度も鳴るので、
   *   毎回言うと帯が知らせで埋まる(user にできることは 1 つも増えない)。
   */
  private narrow: MediaLike | null = null;
  private onNarrowChange: (() => void) | null = null;
  private narrowSubs: Array<(tooNarrow: boolean) => void> = [];
  /**
   * 🔴 **最後に伝えた値**。⚠ 初期は **`false`(広い)**にする ── 広い窓で
   *   立ち上げた回に `cb(false)` を配ると、**帯に出ていた別の知らせを消す**
   *   (このクラスは自分が何も言っていないときに帯を触ってはいけない)。
   */
  private lastTold = false;

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
    /**
     * 🔴 **2 本目 ── 対応外の幅**(user 裁定 ⑥「画面は止めない」)。
     * ⚠ `PHONE_MIN_PX` **未満**なので `- 1` する ── `min-width` で書くと
     *   「対応している側」を数えることになり、境目がずれても気づけない。
     */
    const narrow = make(`(max-width: ${PHONE_MIN_PX - 1}px)`) ?? null;
    this.narrow = narrow;
    this.lastTold = false;
    if (narrow?.addEventListener) {
      const fn = (): void => this.tellTooNarrow();
      this.onNarrowChange = fn;
      narrow.addEventListener('change', fn);
    }
    /**
     * ⚠ **ここでは鳴らさない**(#632 段③、変異試験 M7 が SURVIVED で教えた)。
     *   `install` は `boot` の前半、口を配る `setFoldNotify` は後半で呼ばれるうえ、
     *   ⚠ **`install` は先頭で `dispose()` を呼んで購読を空にする** ── つまり
     *   **この時点で聞いている人は必ず 0 人**なので、呼んでも素通りする。
     * 🔑 鳴らすのは `onTooNarrow`(**繋いだ瞬間**)1 か所である ── 2 か所に置くと、
     *   片方が no-op のまま「これが要る」という顔で残る。
     * ⚠ 帰結:**`install` を `setFoldNotify` の後で呼ぶと、対応外の 1 行は死ぬ**
     *   (購読ごと捨てられる)。いま `install` の呼び元は `main.ts` の 1 か所だけで、
     *   順番を入れ替える変異は `tests/smoke/phone.smoke.spec.ts` の 340px の腕が殺す。
     */
    this.paint();
    return () => this.dispose();
  }

  private dispose(): void {
    if (this.media?.removeEventListener && this.onChange)
      this.media.removeEventListener('change', this.onChange);
    this.media = null;
    this.onChange = null;
    if (this.narrow?.removeEventListener && this.onNarrowChange)
      this.narrow.removeEventListener('change', this.onNarrowChange);
    this.narrow = null;
    this.onNarrowChange = null;
    this.narrowSubs = [];
  }

  /**
   * いま**対応外の幅**か(`PHONE_MIN_PX` 未満)。
   * ⚠ **外に消費者を作らない**(着地前レビュー)── 幅の判定を配ると、
   *   「スマホか」と同じ問いに答える口が 2 つになる(CLAUDE.md §7)。
   */
  private tooNarrow(): boolean {
    return this.narrow?.matches === true;
  }

  /**
   * 🔴 **対応外の幅かどうかが「変わったとき」に伝える**購読口。
   *
   * ⚠ **知らせではなく状態を配る**(着地前の動線レビューで直した)── 1 稿目は
   *   「狭くなった」しか伝えず、**広げても帯の字が消えなかった**。状態の行は 1 行
   *   しかないので、消えない字は**本当に読ませたい文を押し出す**うえ、
   *   **対応している幅なのに「対応していません」と書いてある**= 画面が嘘をつく。
   *   ⚠ これは #300 段④ が常設バッジを外したのと同じ形である(`main.ts` に理由が在る)。
   * 🔑 だから `cb(true)` / `cb(false)` の**両方**を伝え、受け手が字を出し入れする。
   * 🔑 「**1 度だけ**」は保つ ── 同じ値を続けて伝えない(`lastTold`)ので、
   *   狭いあいだに何度呼ばれても字は 1 回しか出ない。
   * ⚠ 口をここが持たない ── 帯(`showStatus`)は `main.ts` の後ろで組まれるので、
   *   `install` の時点では存在しない。🔑 購読された時点で**もう狭ければその場で**伝える
   *   (でないと「起動時から狭い」= いちばん普通の場合を落とす)。
   * ⚠ 向きを 1 本にする ── この file は `fold-notify` を import しない
   *   (あちらが `appPhone` を読むので、双方向にすると輪になる)。
   */
  onTooNarrow(cb: (tooNarrow: boolean) => void): () => void {
    this.narrowSubs.push(cb);
    this.tellTooNarrow();
    return () => this.unsubTooNarrow(cb);
  }

  private unsubTooNarrow(cb: (tooNarrow: boolean) => void): void {
    this.narrowSubs = this.narrowSubs.filter((f) => f !== cb);
  }

  /**
   * ⚠ **変わったときだけ**伝える(掴んで動かすと `change` は何度も鳴る)。
   * ⚠ 誰も聞いていなければ**伝えたことにしない** ── そうしないと、口を繋ぐ前に
   *   狭くなった回が「伝え済み」になり、**起動時から狭い端末で 1 度も出ない**。
   */
  private tellTooNarrow(): void {
    const now = this.tooNarrow();
    if (now === this.lastTold || this.narrowSubs.length === 0) return;
    this.lastTold = now;
    for (const cb of [...this.narrowSubs]) cb(now);
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
