/**
 * ヘルプの面(P11 段④。user 指示 2026-08-07)。
 *
 * > 「**お知らせ掲載内容は過去のお知らせとして、最大 10 件を最新のリリース、
 * > 開発版の PKC3 のヘルプ画面から参照できるようにしてください /
 * > ヘルプ画面にはマニュアル導線も含めてください**」
 *
 * ## 作りは「設定 / フラグ」と同型
 *
 * ⚠ **かぶせる窓にしない。** この repo にモーダルは 1 件も無い ── 面はすべて
 * 「同じものが常に同じ場所にある」作法(`settings.ts:7-11`)。ここもそれに従う。
 * ⚠ 器は **1 度だけ組む**。面の切替は `hidden` の付け外しなので、器を捨てると
 * 押される寸前のボタンが消える(2026-08-07 に本文の面で実際に踏んだ)。
 *
 * ## マニュアルは**同梱**する(裁定 Q4)
 *
 * `docs/manual.md` を `?raw` で焼き込む。⚠ 外部リンクにすると
 * **オフラインで読めない**(マニュアル自身が「オフラインで使う」と書いている)し、
 * アプリ初の外向きリンクにもなる。同梱なら**版とマニュアルが必ず一致**し、
 * SW の precache に自動で載る(entry chunk の一部になるため)。
 *
 * ⚠ **重い処理はワーカーへ**(user 指示 2026-08-03 不可侵)── マニュアル全文の
 * 描画は共有の `MarkdownClient` に出す。1 度描いたら以後は描き直さない。
 *
 * ## 🔴 マニュアル側に文書内アンカーを持たせない
 *
 * 本文の見出しは `id=<slug>` を焼く。面は `hidden` で**同一 document に常駐**するので、
 * `#slug` は**先に作られた本文面の見出し**に当たる。マニュアルに `[…](#…)` や
 * `:::toc` を書くと、そこから壊れる ── `tests/adapter/help-pane.test.ts` が
 * 「マニュアルに文書内アンカーが 0 件」を機械で守る。
 */
import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';
import { NOTICES, noticeDate, recentNotices, type Notice } from '@features/notice/notice-log';
import manualText from '../../../../docs/manual.md?raw';
import { KEY_COMMANDS, chordLabel } from '@features/keymap';
import { appKeymap, type KeymapStore } from './keymap';
import {
  findInManual,
  manualLineCount,
  MANUAL_FIND_MAX_SECTIONS,
  type ManualHit,
  type ManualSection,
} from '@features/help/manual-find';

/** 焼き込んだマニュアルの原文(test から掴めるよう named export)。 */
export const MANUAL_TEXT: string = manualText;

/**
 * 版の表示。⚠ **1 か所で組む** ── 手組みの template を面ごとに増やさない。
 *
 * ⚠ 種別を**引数で受ける**(2026-08-08、変異試験の指摘)。`BUILD_KIND` は build 時に
 * 焼き込まれるので、既定引数のままだと **test から分岐を 1 つも動かせない** ──
 * 「開発版 / 検証版の刻印を落とす」変異が誰にも殺されなかった。
 */
export function versionText(kind: string = BUILD_KIND): string {
  const suffix = kind === 'product' ? '' : kind === 'stage' ? '(検証版)' : '(開発版)';
  return `${APP_ID} v${APP_VERSION}${suffix}`;
}

/**
 * markdown を描く口(worker 経路。⚠ 失敗したら素の原文を出す)。
 *
 * ⚠ **描画の材料も受ける**(2026-08-08。Issue #100 段①)── マニュアルもこの
 * コンテナの中で読まれる文書なので、`pkc://<自分>/…` の扱いは本文と揃える。
 * 揃えないと、同じ 1 行が**面によって別物に見える**(片方はリンク、片方は
 * 「別の PKC」の badge)。
 */
export interface HelpMarkdownPort {
  render(text: string, opts?: { currentContainerId?: string }): Promise<string>;
}

/**
 * 🔴 **マニュアルを手放すまでの間**(#531 H3。ms)。
 *
 * ⚠ **「閉じたら捨てる」にしない** ── 実測(2026-08-28)で、入れ直しは
 *   **279 / 245 / 243 / 244 ms** 掛かる。閉じるたびに捨てると、開き直すたびに
 *   その時間を払う ── user 指示 2026-08-03 は「配る量」ではなく
 *   **「その後の動作がメモリくったり、もっさりだと嫌」**であり、
 *   **両方向とも**この指示に反する。
 * 🔑 だから**しばらく使われなかったら手放す** ── 計算のワーカーと同じ形である
 *   (`platform/worker-lease.ts`「ワーカーはしばらくつかわれないなら、キルと解放」)。
 * ⚠ ワーカーの既定(30 秒)より**ずっと長く**した ── あちらは連続操作の合間だが、
 *   ヘルプは「読んで、試して、また見に来る」ので、数分で戻ってくるのが普通である。
 */
export const HELP_MANUAL_IDLE_MS = 5 * 60_000;

export class HelpRenderer {
  private built = false;
  private manualHost: HTMLElement | null = null;
  /**
   * 🔴 **マニュアルを描いてあるか**(#531 H3)。⚠ `built`(器を組んだか)とは**別**
   *   である ── 器は捨てず、**中身だけ**を手放すので、2 つの状態が要る。
   */
  private manualDrawn = false;
  /** 手放しの予約。⚠ 面を見せた瞬間に**必ず取り消す**(見ている物を消さない)。 */
  private idleTimer: unknown = null;
  /** 最後に描いたときのコンテナ id ── 入れ直すときも同じ材料で描く。 */
  private lastCid = '';
  /** ショートカットの一覧(#256)。⚠ 器は捨てず、中身だけ書き換える。 */
  private keys: HTMLElement | null = null;
  /** 探した件数を出す所(#636)。 */
  private findCount: HTMLElement | null = null;
  /** 探した結果の一覧(#636)。 */
  private findHits: HTMLElement | null = null;
  /**
   * 🔴 **マニュアルを描き終える約束**(#636)。
   * ⚠ `manualDrawn` は `await` の**前**に立つので、「描いた」と言っていても
   *   器が空の瞬間がある ── 飛ぶ前に**ここを待つ**。
   */
  private manualReady: Promise<void> | null = null;
  private offKeymap: (() => void) | null = null;

  constructor(
    private readonly region: HTMLElement,
    /** ⚠ アプリ全体で 1 個の `MarkdownClient` を渡す(面ごとに作らない)。 */
    private readonly markdown: HelpMarkdownPort | null = null,
    /**
     * 登記表。⚠ **注入できるようにする**(2026-08-08、変異試験の指摘)──
     * `NOTICES` が 1 件しか無いので、**上限も並びも「測っていない次元」**だった
     * (`recentNotices` を通さず丸ごと出す変異が素通りした)。
     */
    private readonly notices: readonly Notice[] = NOTICES,
    /**
     * 🔴 **キーの割当**(#256)。⚠ **一覧はここで手書きしない** ── PKC2 は
     * ヘルプの一覧を手書きの配列で持っていたので実装とズレた(2 件確認)。
     * ここは `KEY_COMMANDS` + いまの割当を描くだけである。
     */
    private readonly keymap: KeymapStore = appKeymap,
    /**
     * 🔴 **時計**(#531 H3)。⚠ **注入できるようにする** ── 実時間を待つ test は
     *   書けない(5 分待たせるか、待たずに「たぶん動く」と書くかの二択になる)。
     *   `worker-lease.ts` が同じ理由で同じ形を持っている。
     */
    private readonly timers: {
      set: (fn: () => void, ms: number) => unknown;
      clear: (h: unknown) => void;
    } = {
      set: (fn, ms) => globalThis.setTimeout(fn, ms),
      clear: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    /** 手放すまでの間(ms)。⚠ test は短くする。 */
    private readonly idleMs: number = HELP_MANUAL_IDLE_MS,
  ) {}

  /**
   * 🔴 **この面が見えなくなった**(#531 H3)── `CenterRouter` が面を入れ替えた
   * ときに呼ぶ。
   *
   * ⚠ **その場では捨てない。** しばらく戻って来なかったときだけ手放す
   *   (入れ直しは実測 243〜279ms ── 閉じるたびに払わせない)。
   * 🔑 **器は捨てない** ── 捨てると、押される寸前のボタンが消える
   *   (2026-08-07 に本文の面で実際に踏んだ。この file の冒頭にも書いてある)。
   *   手放すのは**マニュアルの中身だけ**である(実測で 6,884 → 499 節点、
   *   **6,385 節点(92.8%)**が返る)。
   */
  onHidden(): void {
    // ⚠ 描いていないなら予約しない(空の器をもう一度空にしても何も返らない)
    if (!this.manualDrawn || this.idleTimer !== null) return;
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = null;
      this.dropManual();
    }, this.idleMs);
  }

  /** マニュアルの中身だけ手放す。⚠ **器と、その上の見出しは残す**。 */
  private dropManual(): void {
    const host = this.manualHost;
    if (host === null || !this.manualDrawn) return;
    this.manualDrawn = false;
    // ⚠ 空にしない ── 次に開いたとき、描き終わるまでの数百 ms が**白紙**になる
    host.textContent = 'マニュアルを読み込んでいます…';
  }

  /** 予約を取り消す。⚠ **見せる前**に呼ぶ(見ている物を消さないため)。 */
  private cancelIdle(): void {
    if (this.idleTimer === null) return;
    this.timers.clear(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * @param currentContainerId いま開いているコンテナ(Issue #100 段①)。
   *   ⚠ 器は 1 度しか組まないので、**描くときの値**がそのまま焼かれる ──
   *   コンテナを切り替える経路が入ったら、ここも作り直しの対象になる。
   */
  render(currentContainerId = ''): void {
    /**
     * 🔴 **見せる前に予約を取り消す**(#531 H3)── ここを飛ばすと、
     * 開いた直後に予約が満期を迎えて**読んでいる最中に中身が消える**。
     */
    this.cancelIdle();
    if (this.built) {
      // 🔴 **手放してあったら入れ直す**(#531 H3)。⚠ 器は在るので、
      //    描き直すのは**中身だけ**である
      if (!this.manualDrawn) this.manualReady = this.drawManual(currentContainerId || this.lastCid);
      return;
    }
    this.built = true;
    this.region.textContent = '';

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = 'ヘルプ';
    this.region.append(head);

    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'help-body');
    this.region.append(body);

    // ── ① この版 ────────────────────────────────────────
    /**
     * 🔴 **設定から移してきた**(P11)。設定は「あなたが選ぶもの」の場所で、
     * 版は選べない ── 困ったときに見る場所がここである。
     * ⚠ **2 か所に出さない**(`settings.ts` から消した)── 同じ値を 2 経路で
     *   描くと、片方だけ直して食い違う。`docs-parity` が両方を見る。
     * ⚠ 版の種別(検証版 / 開発版)は**文字で出す** ── 設定は hover の `title`
     *   にしか入れておらず、タッチ端末・キーボードだけの user には届かなかった。
     */
    const ver = document.createElement('p');
    ver.setAttribute('data-pkc-field', 'help-version');
    ver.textContent = versionText();
    body.append(ver);

    // ── ② 過去のお知らせ ────────────────────────────────
    const nh = document.createElement('h3');
    nh.textContent = 'これまでのお知らせ';
    body.append(nh);

    const list = document.createElement('div');
    list.setAttribute('data-pkc-region', 'help-notices');
    // ⚠ **件数を切るのは `recentNotices` だけ**(面ごとに slice を書かない)
    for (const n of recentNotices(this.notices)) {
      const item = document.createElement('section');
      /**
       * ⚠ **`data-pkc-notice` は使わない** ── 取込の注意(`notices.ts`)が
       * 既にその名前で、同じ document に居る。名前がかぶると、片方を数える
       * 検査がもう片方まで拾う(CLAUDE.md「id らしく見える名前は id として扱われる」)。
       */
      item.setAttribute('data-pkc-help-notice', n.id);
      const t = document.createElement('h4');
      t.setAttribute('data-pkc-field', 'notice-title');
      // ⚠ 日付は id から引く(field を二重に持たない)
      t.textContent = `${noticeDate(n.id)} ${n.title}`;
      const ul = document.createElement('ul');
      for (const line of n.items) {
        const li = document.createElement('li');
        // ⚠ **素のテキスト**として出す(記法は書かない決まり。test が守る)
        li.textContent = line;
        ul.append(li);
      }
      item.append(t, ul);
      list.append(item);
    }
    body.append(list);

    // ── ③ ショートカットキー ────────────────────────────
    /**
     * 🔑 **いま効いている割当**を出す(user 指示 2026-08-18)。
     * ⚠ 割り当て直す口は**設定の面 1 か所**にする ── 同じ操作を 2 か所に置くと、
     *   どちらが正か user にも分からなくなる。ここは読む場所である。
     * ⚠ 面は 1 度しか組まないので、割当が変わったら**この節だけ**描き直す
     *   (器を捨てない ── 2026-08-07 の dead click の型)。
     */
    const kh = document.createElement('h3');
    kh.textContent = 'ショートカットキー';
    body.append(kh);
    const kn = document.createElement('p');
    kn.setAttribute('data-pkc-field', 'settings-note');
    kn.textContent =
      'Ctrl は Mac では ⌘ でも同じように効きます。割り当て直しは設定画面でできます。';
    body.append(kn);
    this.keys = document.createElement('div');
    this.keys.setAttribute('data-pkc-region', 'help-keymap');
    body.append(this.keys);
    this.syncKeys();
    // ⚠ 購読は器と同じ寿命(面は畳んでも捨てない)── 二重に張らないよう 1 度だけ
    this.offKeymap?.();
    this.offKeymap = this.keymap.onChange(() => {
      this.syncKeys();
    });

    // ── ④ マニュアル ────────────────────────────────────
    const mh = document.createElement('h3');
    mh.textContent = 'マニュアル';
    body.append(mh);

    /**
     * 🔴 **アプリとして開く口**(#645。user 要望 2026-08-31)。
     *
     * > 「**ヘルプの中からマニュアルをアプリとして出してください。
     * > ちっとも改善していません**」
     *
     * ⚠ 直前の #636 で足したのは**探す欄**だけで、マニュアルは
     *   `max-height: 60vh` の箱に入ったままだった ── 3599 行を画面の 6 割の
     *   高さから覗く形は 1 ミリも変わっていない。ここが**その箱を出る道**である。
     * ⚠ **見出しのすぐ下**に置く ── 箱の中に入れると `drawManual` の
     *   `innerHTML = …` で消える(探す欄と同じ理由)。
     * ⚠ **`built` ガードの内側**で 1 度だけ組む(`render()` は毎回走る)。
     * ⚠ **`<h3>` を足さない**(`help-pane.test.ts` が h3 の並びを等値 pin している)。
     */
    const openBar = document.createElement('div');
    openBar.setAttribute('data-pkc-region', 'help-manual-open');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    /**
     * 🔴 **押された所を受けるのは binder 1 か所**(#645)。
     * ⚠ ここで直に listener を張ると、**出すかどうかの判定**(この file)と
     *   **押されたときの口**(`binder.ts` の `openManualWindow`)が別々になる ──
     *   片方だけ配線した日に、出ているのに何も起きないボタンになる(§7)。
     * 🔑 だから**いつも出す**。受け手が居ない環境では binder が理由を言う。
     */
    openBtn.setAttribute('data-pkc-action', 'open-manual-window');
    openBtn.textContent = 'マニュアルを別のウィンドウで開く';
    openBtn.title =
      'マニュアルだけのウィンドウを開きます(目次つき・窓いっぱい。Ctrl+F でブラウザの検索が使えます)';
    const openNote = document.createElement('span');
    openNote.setAttribute('data-pkc-field', 'settings-note');
    // 🔑 **何が起きるか**を押す前に言う(この画面の本文は消えない)
    openNote.textContent = '目次つきで、窓いっぱいに出ます。この画面はそのまま残ります';
    openBar.append(openBtn, openNote);
    body.append(openBar);

    /**
     * 🔴 **探す欄は器の「外・直上」に置く**(#636)。
     *
     * ⚠ **器の中に入れてはいけない** ── `drawManual` は `host.innerHTML = …` で
     *   中身を丸ごと差し替えるので、欄ごと消える。
     * ⚠ **`built` ガードの内側で 1 度だけ組む** ── `render()` は面を開いている間
     *   **毎回**走るので、外に置くと**打った字が 1 文字ごとに消える**。
     * ⚠ **`<h3>` を足さない** ── `help-pane.test.ts` が h3 の並びを**等値 pin**
     *   している(見出しを増やすと落ちる)。
     * ⚠ **`data-pkc-action` を足さない** ── `operation-table.test.ts` の等値 pin が
     *   5 つ鳴る。押した所は**ここで直に受ける**(前例: `app-dialog.ts` の
     *   `palette-filter`)。
     */
    const findBar = document.createElement('div');
    findBar.setAttribute('data-pkc-region', 'help-find-bar');
    const find = document.createElement('input');
    // 🔑 **面に居座る欄**なので `search`(`entry-filter` / `dual-filter` と同じ流儀)
    find.type = 'search';
    find.setAttribute('data-pkc-field', 'help-find');
    find.placeholder = 'マニュアルの中を探す';
    find.title = 'マニュアルの中を探します(Esc で、打った字を消します)';
    // ⚠ placeholder を名前代わりにしない(消えると読み上げが黙る)
    find.setAttribute('aria-label', 'マニュアルの中を探す');
    this.findCount = document.createElement('span');
    this.findCount.setAttribute('data-pkc-field', 'help-find-count');
    this.findHits = document.createElement('div');
    this.findHits.setAttribute('data-pkc-region', 'help-find-hits');
    find.addEventListener('input', () => {
      this.syncFind(find.value);
    });
    find.addEventListener('keydown', (ev) => {
      // ⚠ 面の鍵へ漏らさない ── ここは字を打つ欄である
      if ((ev as KeyboardEvent).key !== 'Escape') return;
      find.value = '';
      this.syncFind('');
    });
    findBar.append(find, this.findCount, this.findHits);
    body.append(findBar);

    this.manualHost = document.createElement('div');
    this.manualHost.setAttribute('data-pkc-region', 'help-manual');
    this.manualHost.className = 'pkc-md-rendered';
    // ⚠ 描く前も**器は置く**(後から差し込むので、器が無いと入れ先が消える)
    this.manualHost.textContent = 'マニュアルを読み込んでいます…';
    body.append(this.manualHost);

    this.manualReady = this.drawManual(currentContainerId);
    void this.manualReady;
  }

  /**
   * ショートカットの一覧を描く。⚠ **表(`KEY_COMMANDS`)が正本**。
   * ⚠ 割当が空のコマンドも**行ごと出す** ── 「割当なし」が見えないと、
   *   user は「そんな操作は無い」と読む(外した本人が戻せなくなる)。
   */
  private syncKeys(): void {
    const host = this.keys;
    if (!host) return;
    const bindings = this.keymap.getBindings();
    host.textContent = '';
    const dl = document.createElement('dl');
    for (const cmd of KEY_COMMANDS) {
      const dt = document.createElement('dt');
      dt.setAttribute('data-pkc-field', 'help-key-command');
      dt.setAttribute('data-pkc-command', cmd.id);
      dt.textContent = cmd.label;
      const dd = document.createElement('dd');
      dd.setAttribute('data-pkc-field', 'help-key-chords');
      dd.setAttribute('data-pkc-command', cmd.id);
      const list = bindings[cmd.id] ?? cmd.defaults;
      dd.textContent = list.length === 0 ? '割り当てなし' : list.map((c) => chordLabel(c)).join(' / ');
      dl.append(dt, dd);
    }
    host.append(dl);
  }

  /**
   * マニュアルを描く。
   * ⚠ ワーカーが使えないときは**素の原文**を出す ── 白紙にしない。
   *
   * ⚠ **二重描画のガードは置かない**(2026-08-08、変異試験の指摘)。`render()` の
   * `built` ガードが先に効くので、ここは構造上 1 度しか呼ばれない ──
   * 置いていたガードは**誰も通らない死んだ防御**で、消しても test は 1 件も
   * 落ちなかった(「在るのに効かない」は次に読む人を惑わせる)。
   */
  /**
   * 🔴 **打った字で節を絞る**(#636)。⚠ **本文は 1 バイトも隠さない** ──
   *   隠すとブラウザの Ctrl+F から見えなくなり、user 指示②と衝突する。
   */
  private syncFind(query: string): void {
    const count = this.findCount;
    const hits = this.findHits;
    if (!count || !hits) return;
    hits.textContent = '';
    const q = query.trim();
    if (q === '') {
      count.textContent = '';
      return;
    }
    const found = findInManual(MANUAL_TEXT, q);
    if (found.length === 0) {
      // ⚠ **次の一手を書く** ── 「0 件」だけだと、user は打ち方が悪いのか
      //    載っていないのか分からない
      count.textContent =
        '見つかりませんでした ── 別の言い方でも試せます(例: ルビ / 予定 / 書き出し)';
      return;
    }
    const total = found.reduce((n, h) => n + h.count, 0);
    const shown = found.slice(0, MANUAL_FIND_MAX_SECTIONS);
    const rest = found.length - shown.length;
    // ⚠ **切ったことを言う**(黙って減らさない)
    count.textContent =
      `${total} か所(${found.length} 節)` + (rest > 0 ? ` ── 下に出すのは ${shown.length} 節、あと ${rest} 節` : '');
    for (const hit of shown) hits.append(this.findRow(hit));
  }

  /** 探した結果の 1 行。押すとその節へ送る。 */
  private findRow(hit: ManualHit): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('data-pkc-find-index', String(hit.section.index));
    // ⚠ 記法は落として出す(`**強調**` の星がそのまま見えないように)
    row.textContent = `${hit.section.title.replace(/[*`_]/gu, '')}(${hit.count})`;
    row.addEventListener('click', () => {
      void this.jumpToSection(hit.section);
    });
    return row;
  }

  /**
   * 🔴 **その節まで送る**(#636)。
   *
   * ⚠ **`id` では飛べない** ── 見出し 160 本のうち `id` が焼かれるのは h1〜h3 だけで、
   *   しかも同一 document に本文の面が常駐しているので `#slug` はそちらに当たる。
   * 🔑 **源文の見出しの通し番号**で、描かれた `h1〜h6` の同じ番号を掴む
   *   (**160 = 160** の対応を `manual-find.test.ts` が pin している)。
   * ⚠ **描き終えるのを待つ** ── `manualDrawn` は `await` の前に立つので、
   *   開いた直後に押すと器はまだ空である。
   */
  private async jumpToSection(section: ManualSection): Promise<void> {
    if (!this.manualDrawn) this.manualReady = this.drawManual(this.lastCid);
    await this.manualReady;
    const host = this.manualHost;
    if (!host) return;
    if (section.index < 0) {
      host.scrollTop = 0;
      return;
    }
    const heads = host.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6');
    const head = heads[section.index];
    if (head) {
      head.scrollIntoView({ block: 'start' });
      return;
    }
    /**
     * 🔴 **見出しが 1 本も無いときの逃げ道**(着地前に自分で踏んだ)。
     *
     * ⚠ ワーカーが無い / 描画に失敗したときは `drawManual` が
     *   **素の原文**(`host.textContent = MANUAL_TEXT`)を出すので、
     *   `h1〜h6` が **0 本**になる ── そのまま返すと、**並んだ行が全部
     *   dead click** になる(押しても何も起きず、理由も出ない)。
     * 🔑 だから**行の比**で送る。正確ではないが、**押した手応えは返る**。
     */
    const lines = manualLineCount(MANUAL_TEXT);
    const ratio = lines > 0 ? section.line / lines : 0;
    host.scrollTop = Math.round(host.scrollHeight * ratio);
  }

  private async drawManual(currentContainerId: string): Promise<void> {
    if (!this.manualHost) return;
    const host = this.manualHost;
    // ⚠ 入れ直しのために材料を控える(#531 H3)── 2 度目は面から id が来ない
    this.lastCid = currentContainerId;
    // 🔴 **描き終える前に立てる**(#531 H3)── `await` の間にもう 1 度
    //    入れ直しに来ると、**同じ物を 2 回描く**(ワーカーを 2 回起こす)
    this.manualDrawn = true;
    if (!this.markdown) {
      host.textContent = MANUAL_TEXT;
      return;
    }
    try {
      host.innerHTML = await this.markdown.render(MANUAL_TEXT, { currentContainerId });
    } catch {
      host.textContent = MANUAL_TEXT;
    }
  }
}
