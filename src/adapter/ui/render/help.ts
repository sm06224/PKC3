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
import { APP_ID, APP_VERSION, BUILD_KIND, BUILT_AT } from '@runtime/release-meta';
import { formatBuildStamp } from '@features/datetime/datetime-format';
import { NOTICES, noticeDate, recentNotices, type Notice } from '@features/notice/notice-log';
import manualText from '../../../../docs/manual.md?raw';
import { KEY_COMMANDS, chordLabel } from '@features/keymap';
import { appKeymap, type KeymapStore } from './keymap';
import { findManualRefs, resolveManualRef } from '@features/help/manual-refs';
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
  const label = kindLabel(kind);
  return `${APP_ID} v${APP_VERSION}${label === '' ? '' : `(${label})`}`;
}

/** 種別の呼び名。⚠ 本番は名乗らない(空)。 */
function kindLabel(kind: string): string {
  return kind === 'product' ? '' : kind === 'stage' ? '検証版' : '開発版';
}

/**
 * 🔴 **画面に出す版の行**(#789。user 裁定 2026-09-08「日時を足す」)。
 *
 * ⚠ **`versionText()` と分けてある。混ぜてはいけない。**
 *   `versionText()` は**マニュアルの窓を入れ替えるかの印**にも使われる
 *   (`main.ts` → `manualBuildTag(versionText(), MANUAL_TEXT)`)ので、
 *   そこに日時を入れると**毎ビルドで印が変わり、開いている窓が組み直される**
 *   ── user が読んでいた場所が、中身が 1 字も変わっていないのに失われる。
 * 🔑 だから**日時が付くのは「見せる字」だけ**である。
 *
 * ⚠ **本番では足さない** ── あちらは tag が版を名乗るので足りる。
 * ⚠ 焼いていない環境(dev server / test)では `builtAt` が `0` なので、
 *   これまでと 1 文字も変わらない。
 *
 * @param kind    build の種別(test から分岐を動かすため引数で受ける)
 * @param builtAt 焼いた時刻(epoch ms)。`0` なら足さない
 */
export function versionLine(kind: string = BUILD_KIND, builtAt: number = BUILT_AT): string {
  const label = kindLabel(kind);
  if (label === '') return versionText(kind);
  const stamp = buildStamp(builtAt);
  return `${APP_ID} v${APP_VERSION}(${label}${stamp === '' ? '' : `・${stamp}`})`;
}

/**
 * 焼いた時刻を「9/8 07:02」の形にする。⚠ **読む端末の時刻**で出す
 * (焼いた箱の時間帯をそのまま出すと、user の手元と合わない)。
 * 🔑 組み立ては `datetime-format.ts` の 1 か所から借りる ── ここで自前に組むと
 *   「時刻を組み立てる場所は 1 か所」の門に当たる(実際に当たった)。
 */
function buildStamp(builtAt: number): string {
  if (!Number.isFinite(builtAt) || builtAt <= 0) return '';
  return formatBuildStamp(new Date(builtAt));
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
  /** 面の中の目次(#719)。⚠ マニュアルを描いた**後**に埋める(id が要る)。 */
  private tocHost: HTMLElement | null = null;

  /** 「← さっきの場所へ戻る」の帯(#779 段⑧)。⚠ 器は捨てず `hidden` で畳む。 */
  private backHost: HTMLElement | null = null;

  /** 飛ぶ前のスクロール位置(祖先ぜんぶ)。⚠ 帰ったら `null` に戻す。 */
  private backTo: readonly { el: HTMLElement; top: number }[] | null = null;
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
    /**
     * 🔴 **いまどこに保存しているか**(#811 の 2 番目、2026-09-09)。
     *
     * ⚠ 直す前、これが読めるのは**帯のツールチップだけ**だった ──
     *   **指で触る端末では読めない**(user 報告は iPhone である)。しかも帯の 1 行は
     *   **落ちた回にしか出ない**ので、「ちゃんと保存できている」ことを確かめる道が
     *   画面に 1 つも無かった。
     * 🔑 **関数で受ける**(値の写しにしない)── このタブは途中で**本体へ昇格**しうる
     *   ので、boot の一瞬を写して持つと**古い字を出し続ける**(§7 の型)。
     * ⚠ 既定は `null` = **出さない**(この面だけを組む test を壊さない)。
     */
    private readonly storageWhere: (() => string) | null = null,
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

  /**
   * いまの保存先を書く。⚠ 器がまだ無い / 渡されていない回は**何もしない**。
   * 🔑 字は `features/storage/storage-notice.ts` が 1 か所で持つ(ここは描くだけ)。
   */
  private paintStorage(): void {
    if (this.storageWhere === null) return;
    const el = this.region.querySelector<HTMLElement>('[data-pkc-field="help-storage"]');
    if (el !== null) el.textContent = this.storageWhere();
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
    /**
     * 🔴 **保存先は毎回描き直す**(#811 の 2 番目)── 器は 1 度しか組まないが、
     *   このタブは途中で**本体へ昇格**しうるので、組んだときの字のままだと
     *   **古い保存先を出し続ける**。⚠ `built` の判定より**前**に置く
     *   (後ろに置くと、2 回目以降は早期 return に食われて更新されない)。
     */
    this.paintStorage();
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

    // ── ① マニュアル(目次つき)────────────────────────────
    /**
     * 🔴 **先頭はマニュアル**(#719。user 裁定 2026-09-06 = 案 A)。
     *
     * cowork 実測 2026-09-05:「ヘルプを開くと、まず**これまでのお知らせが 11 件**
     * 並び、その下にショートカット・マニュアルが続く。本文 **106,339 字 /
     * `scrollHeight` 5455px**、面の中のリンク **0 件**」──
     * **「使い方を知りたい」で開いた人が最初に読むのがリリースノート**だった。
     *
     * ⚠ **版はここへ移した**(下に節を残さない)── 理由は「**沈めない**」1 つである。
     *   ⚠ 「§7(同じ値を 2 か所に描かない)」と書いていたが、**それは理由になっていない**
     *   (着地前レビューの指摘)── repo の門(`docs-parity`)が守っているのは
     *   「**`APP_VERSION` を組み立てる file が 1 つ**」= 出どころであって、
     *   同じ `versionText()` の戻り値を 2 か所に描いても食い違いようがない。
     *   🔑 それでも 1 つにしたのは、**2 つ目を下に置くと沈む**からである。
     */
    /**
     * 🔴 **設定から移してきた**(P11)。設定は「あなたが選ぶもの」の場所で、
     * 版は選べない ── 困ったときに見る場所がここである。
     * ⚠ **2 か所に出さない**(`settings.ts` から消した)── 同じ値を 2 経路で
     *   描くと、片方だけ直して食い違う。`docs-parity` が両方を見る。
     * ⚠ 版の種別(検証版 / 開発版)は**文字で出す** ── 設定は hover の `title`
     *   にしか入れておらず、タッチ端末・キーボードだけの user には届かなかった。
     */
    const mh = document.createElement('h3');
    mh.textContent = 'マニュアル';
    body.append(mh);

    const ver = document.createElement('p');
    ver.setAttribute('data-pkc-field', 'help-version');
    /**
     * ⚠ **名前を付ける**(着地前レビュー・動線 7)。⚠ 面の先頭から「マニュアル」の
     *   見出しの下へ移したので、裸の版番号は**マニュアルの版**と読める位置になった。
     * 🔑 何のための数字かも書く ── 版を見る唯一の理由は**不具合の報告に添えること**である。
     */
    // ⚠ ここは**見せる字**なので `versionLine()`(日時つき)── 入れ替えの印は `versionText()`
    ver.textContent = `この版: ${versionLine()}(不具合の報告に添えてください)`;
    body.append(ver);

    /**
     * 🔴 **保存先も、版の隣に字で出す**(#811 の 2 番目)。
     * ⚠ **版と同じ扱い** ── どちらも「困ったときに見に来る事実」で、
     *   帯のツールチップは指で触る端末では読めない。
     * ⚠ **毎回描き直す**(下の `render()` 側)── 本体へ昇格すると字が変わる。
     */
    if (this.storageWhere !== null) {
      const where = document.createElement('p');
      where.setAttribute('data-pkc-field', 'help-storage');
      // ⚠ **組んだその場でも書く** ── `render()` の頭の塗り直しは、まだ器が無いので
      //   1 回目は空振りする(2 回目以降だけが通る)
      where.textContent = this.storageWhere();
      body.append(where);
    }


    /**
     * 🔴 **アプリとして開く口**(#645。user 要望 2026-08-31)。
     *
     * > 「**ヘルプの中からマニュアルをアプリとして出してください。
     * > ちっとも改善していません**」
     *
     * ⚠ 直前の #636 で足したのは**探す欄**だけで、マニュアルは
     *   `max-height: 60vh` の箱に入ったままだった ── 3599 行を画面の 6 割の
     *   高さから覗く形は 1 ミリも変わっていない。ここが**その箱を出る道**である。
     * ⚠ **マニュアルの箱の外**に置く ── 箱の中に入れると `drawManual` の
     *   `innerHTML = …` で消える(探す欄と同じ理由)。
     *   ⚠ 「見出しのすぐ下」と書いてあったが、いまは **見出し → 版 → ここ → 探す欄 →
     *   目次 → 本文** である(#719 で並べ替えた)。
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

    /**
     * 🔴 **面の中の目次**(#719 案 A)。⚠ 直す前は面の中のリンクが **0 件**で、
     * 10 万字を目次なしで探す形だった(別窓のほうには #648 で目次が在る)。
     *
     * 🔴 **段は全部並べる**(2026-09-11、#531 の残り)。⚠ 直す前は h1〜h3 の 85 本だけで、
     *   `####` の **94 本が目次に出なかった** ── **同じマニュアルなのに別窓の目次には
     *   全部出る**ので、面と窓で中身が違っていた(user から見れば「窓では見つかるのに
     *   面では見つからない」)。飛ぶのに `id` は要らない(器の `scrollTop` で送る)。
     * ⚠ **`data-pkc-action` を足さない** ── `operation-table.test.ts` が等値 pin
     *   しており、足すと 5 つ鳴る。押した所は**ここで直に受ける**
     *   (探す欄・`app-dialog` の `palette-filter` と同じ前例)。
     * ⚠ **`<a href="#…">` にしない** ── 面は `hidden` で同一 document に常駐するので、
     *   `#slug` は**先に作られた本文面の見出し**に当たる(この file の冒頭の戒め)。
     *   だから `<button>` + 器の `scrollTop` で送る。
     *
     * 🔴 **置き場所は「別窓ボタンと探す欄の後ろ」**(着地前レビュー・動線 1、実測)。
     *   ⚠ 目次の行は**素の `<button>`**(描いた DOM の見出しの実数。⚠ 原文の `^#` を
     *   数えると多く出るが、囲みの中の `#` が混ざる)なので、
     *   前に置くと **その回数だけ `Tab` を押さないと**「別のウィンドウで開く」と
     *   「マニュアルの中を探す」に届かない ── **目次を使わない人には壁**になる。
     * ⚠ 副産物:目次はマニュアルを描き終えてから中身が入るので、前に置くと
     *   **入った瞬間に下のボタンが 250px ほど飛ぶ**(押そうとした物が指の下から逃げる)。
     */
    /**
     * 🔴 **見える名前を付ける**(着地前レビュー・動線 3)。⚠ 直す前は `aria-label` だけ
     *   だったので、**読み上げには名前が届き、目で見ている人には届かない**という
     *   逆転が起きていた ── 版のすぐ下に「枠だけの箱」が出る形だった。
       * ⚠ **かつてここには「大きい見出しだけ出ます」と断りが在った** ── 段を全部並べる
     *   ようにしたので**嘘になった**ので外した(#531)。🔑 **断りは、断る中身が在るときだけ置く**
     *   ── 残しておくと「細かい見出しは別窓へ」と**在る道を隠す**案内になる。
     */
    const tocHead = document.createElement('p');
    tocHead.setAttribute('data-pkc-field', 'settings-note');
    tocHead.textContent =
      '目次 ── 見出しを全部並べます。言葉で探すときは下の「マニュアルの中を探す」へ';
    body.append(tocHead);
    this.tocHost = document.createElement('nav');
    this.tocHost.setAttribute('data-pkc-region', 'help-toc');
    this.tocHost.setAttribute('aria-label', 'マニュアルの目次');
    body.append(this.tocHost);

    /**
     * 🔴 **「← さっきの場所へ戻る」の帯**(#779 段⑧、user 裁定 2026-09-08)。
     * ⚠ **本文の器より先に組む**(本文の上に出す)── 飛んだ先は画面の上に来るので、
     *   帰り道も上に在るほうが目に入る。⚠ 既定は畳んでおく。
     */
    this.backHost = document.createElement('p');
    this.backHost.setAttribute('data-pkc-region', 'help-jump-back');
    this.backHost.hidden = true;
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.setAttribute('data-pkc-field', 'manual-jump-back');
    backBtn.textContent = '← さっきの場所へ戻る';
    backBtn.addEventListener('click', () => {
      this.goBack();
    });
    this.backHost.append(backBtn);
    body.append(this.backHost);

    this.manualHost = document.createElement('div');
    this.manualHost.setAttribute('data-pkc-region', 'help-manual');
    this.manualHost.className = 'pkc-md-rendered';
    // ⚠ 描く前も**器は置く**(後から差し込むので、器が無いと入れ先が消える)
    this.manualHost.textContent = 'マニュアルを読み込んでいます…';
    body.append(this.manualHost);

    // ── ② ショートカットキー ────────────────────────────
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

    // ── ③ これまでのお知らせ(畳む)──────────────────────
    /**
     * 🔴 **題名だけ並べ、押すと開く**(#719 案 A)。
     * ⚠ 直す前は 11 件の中身が**全部開いたまま**先頭に居たので、
     *   マニュアルまで 5455px スクロールする形だった。
     * ⚠ **`<details>` を使う** ── この repo は「主要な導線を畳まない」を規律に
     *   持ち、`shell` に `<details>` が 0 件であることを test で pin しているが、
     *   ここは **shell ではなくヘルプの面**で、畳むのは**読み物**である
     *   (押す導線ではない)。
     */
    const nh = document.createElement('h3');
    nh.textContent = 'これまでのお知らせ';
    body.append(nh);

    const list = document.createElement('div');
    list.setAttribute('data-pkc-region', 'help-notices');
    // ⚠ **件数を切るのは `recentNotices` だけ**(面ごとに slice を書かない)
    for (const n of recentNotices(this.notices)) {
      const item = document.createElement('details');
      /**
       * ⚠ **`data-pkc-notice` は使わない** ── 取込の注意(`notices.ts`)が
       * 既にその名前で、同じ document に居る。名前がかぶると、片方を数える
       * 検査がもう片方まで拾う(CLAUDE.md「id らしく見える名前は id として扱われる」)。
       */
      item.setAttribute('data-pkc-help-notice', n.id);
      const t = document.createElement('summary');
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
    this.syncToc();
    this.linkRefs();
  }

  /**
   * 🔴 **本文の「→「名前」」を押せる字にする**(#779 段⑧、user 裁定 2026-09-08)。
   *
   * ⚠ **描いた DOM を歩く**(原文を書き換えない)── `docs/manual.md` は
   *   マニュアルの窓・持ち歩ける HTML も読む正本なので、そこへ `#` を書けない
   *   (`help.ts` 冒頭)。🔑 押せる形にするのは**この面の中だけ**である。
   *
   * ⚠ **見出しと囲みの中は歩かない** ── 見出しの中の参照を押せる字にすると
   *   目次の字が変わり、`code` の中は「書き方の例」であって参照ではない。
   *
   * ⚠ **解決しない参照は素の字のまま**(`resolveManualRef` が `null`)──
   *   押しても何も起きない字を作らないため(この repo がいちばん嫌う形)。
   */
  private linkRefs(): void {
    const host = this.manualHost;
    if (host === null) return;
    const heads = [...host.querySelectorAll<HTMLElement>('h1, h2, h3, h4')];
    const names = heads.map((h) => h.textContent ?? '');
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    /** ⚠ 歩きながら差し替えると walker が壊れるので、**先に集めてから**当てる。 */
    const jobs: { node: Text; hits: { name: string; start: number; end: number }[] }[] = [];
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const node = n as Text;
      if (node.parentElement?.closest('h1, h2, h3, h4, h5, h6, code, pre') != null) continue;
      const hits = findManualRefs(node.data).filter(
        (h) => resolveManualRef(h.name, names) !== null,
      );
      if (hits.length > 0) jobs.push({ node, hits });
    }
    for (const job of jobs) {
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const hit of job.hits) {
        if (hit.start > at) frag.append(job.node.data.slice(at, hit.start));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-field', 'manual-ref');
        btn.setAttribute('data-pkc-ref', hit.name);
        btn.textContent = hit.name;
        btn.title = `「${hit.name}」の節へ送ります`;
        /**
         * ⚠ **押したときに引き直す**(飛び先の要素を掴まない)── 描き直しで
         *   器が入れ替わっても迷子にならない(目次の行と同じ作法)。
         * 🔑 **名前で引く** ── 条 6(同名の見出しを 2 つ作らない)を満たしたので、
         *   名前から見出しが**一意に決まる**(#793、2026-09-08)。
         */
        const want = hit.name;
        btn.addEventListener('click', () => {
          const now = [...host.querySelectorAll<HTMLElement>('h1, h2, h3, h4')];
          const title = resolveManualRef(
            want,
            now.map((h) => h.textContent ?? ''),
          );
          if (title === null) return;
          const target = now.find((h) => (h.textContent ?? '') === title) ?? null;
          if (target === null) return;
          this.jumpTo(target, true);
        });
        frag.append(btn);
        at = hit.end;
      }
      if (at < job.node.data.length) frag.append(job.node.data.slice(at));
      job.node.replaceWith(frag);
    }
  }

  /**
   * 🔴 **その見出しまで送る**(目次の行と本文の参照で**同じ 1 か所**。§7)。
   *
   * 🔴 **外側は動かさない**(着地前レビュー・動線 4、実測)。
   * ⚠ `scrollIntoView` は**スクロールできる祖先を全部**動かすので、外側
   *   (`[data-pkc-region='detail']`)まで動いて**目次が画面の外へ出る**
   *   (実測: 押す前 `outerScrollTop 0` / 押した後 **494**)。目次は
   *   「押して読んで、また押す」物なので、1 回で消えては使えない。
   * 🔑 **送ってから外側だけ戻す**。⚠ 内側を自分で計算しない
   *   (`getBoundingClientRect` は happy-dom で 0 ── 観測点を捨てない)。
   *
   * @param offerBack 🔴 **本文の参照から飛んだときだけ `true`**。
   *   ⚠ 目次から飛んだときは出さない ── 目次は**画面にずっと在る**ので、
   *   もう一度押せば戻れる(帰り道が既に在る所に、2 つ目を作らない)。
   */
  private jumpTo(target: HTMLElement, offerBack: boolean): void {
    const host = this.manualHost;
    if (host === null) return;
    /**
     * ⚠ **戻る先は「動かした物の位置」で控える** ── `scrollIntoView` は
     *   スクロールできる祖先を全部動かすので、控えるのも**祖先ぜんぶ**にする。
     *   ⚠ 動かない要素の `scrollTop` は 0 で、0 を書き戻すのは無害である。
     */
    const chain: { el: HTMLElement; top: number }[] = [];
    /**
     * 🔴 **`host` 自身から控える**(2026-09-08、smoke を読んで見つけた)。
     * ⚠ 1 稿目は `host.parentElement` から始めていたが、**実際に動くのは
     *   `help-manual` 自身**である(`max-height: 60vh; overflow: auto` の器 ──
     *   `help-announce.smoke.spec.ts` が「動くのは help-body ではなくマニュアルの箱」と
     *   実測で書いている)。⚠ unit は版面を持たないので、親を手で動かす台では
     *   **どちらの実装でも緑**になり、この取り違えを見られなかった。
     */
    for (let el: HTMLElement | null = host; el !== null; el = el.parentElement) {
      chain.push({ el, top: el.scrollTop });
      if (el.getAttribute('data-pkc-region') === 'detail') break;
    }
    const outer = host.closest<HTMLElement>('[data-pkc-region="detail"]');
    const keep = outer?.scrollTop ?? 0;
    target.scrollIntoView({ block: 'start' });
    if (outer !== null && outer !== undefined) outer.scrollTop = keep;
    if (offerBack) this.showBack(chain);
  }

  /**
   * 🔴 **「← さっきの場所へ戻る」を出す**(user 裁定 2026-09-08「戻る道も付ける」)。
   *
   * ⚠ **片道の操作を作らない** ── 飛べるなら帰れなければならない
   *   (CLAUDE.md「面から**置ける**なら、面から**外せなければならない**」の読む版)。
   * ⚠ 帰ったら**その表示は消す** ── 帰り道を使い切ったのに残っていると、
   *   もう一度押した人が**知らない場所へ飛ばされる**。
   * ⚠ **器は捨てず、中身だけ書き換える**(この repo で 3 度踏んだ形)。
   */
  private showBack(chain: readonly { el: HTMLElement; top: number }[]): void {
    const bar = this.backHost;
    if (bar === null) return;
    bar.hidden = false;
    this.backTo = chain;
  }

  /** 控えた位置へ戻して、帰り道を畳む。 */
  private goBack(): void {
    const to = this.backTo;
    this.backTo = null;
    if (this.backHost !== null) this.backHost.hidden = true;
    if (to === null) return;
    for (const { el, top } of to) el.scrollTop = top;
  }

  /**
   * 🔴 **マニュアルの見出しの全数**(2026-09-11、#531 の残り)。
   *
   * ⚠ ここが**目次を組む側と、押されて飛ぶ側の唯一の列挙**である ── 2 通りに書くと、
   *   片方だけ段数を変えた日に「並ぶのに飛べない行」が出る(§7)。
   * 🔑 **`id` を条件にしない** ── 直す前は `h1[id], h2[id], h3[id]` で拾っており、
   *   描画器が `id` を焼くのが h1〜h3 だけなので、**`####` の 94 本が目次に出なかった**。
   *   ⚠ 同じマニュアルなのに**別窓の目次には全部出る**ので、面と窓で中身が違っていた。
   * ⚠ `id` を焼く規則のほうを広げる手もあったが、**そちらは血管が太い**
   *   (書き出す HTML・`:::toc`・追記の見出し選び・textlog の錨が同じ規則を読む)。
   *   飛ぶのに `id` は要らない(器の `scrollTop` で送る)ので、**ここだけで閉じる**。
   */
  private manualHeadings(): HTMLElement[] {
    const host = this.manualHost;
    if (host === null) return [];
    return [...host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')];
  }

  /**
   * 目次を組む(#719)。⚠ **描いた DOM から拾う** ── 原文を別に走査すると、
   * 描画器が id を焼く規則(重複の連番)と**二重に持つ**ことになる(§7)。
   */
  private syncToc(): void {
    const nav = this.tocHost;
    if (nav === null || this.manualHost === null) return;
    nav.textContent = '';
    const heads = this.manualHeadings();
    for (const [at, h] of heads.entries()) {
      const row = document.createElement('button');
      row.type = 'button';
      /**
       * ⚠ **要素を掴まない**(控えるのは**何番目か**だけ)── 掴むと `dropManual` の後も
       *   外れた見出しノードが全数ぶん保持される(2026-07-27 の不可侵指示と逆向き)。
       * 🔑 **番号で引く**理由:`id` は h1〜h3 にしか焼かれず、`#slug` の選択子は
       *   数字で始まる見出し(85 本中 30 本)で `SyntaxError` を投げ、しかも
       *   **happy-dom は escape 済みの選択子を解決しない**ので unit から通せなかった。
       *   番号なら構文解析そのものが要らない(§7「検出するより起こらなくする」)。
       */
      const label = h.textContent ?? '';
      row.setAttribute('data-pkc-field', 'help-toc-row');
      row.setAttribute('data-pkc-level', h.tagName.slice(1));
      row.textContent = label;
      row.addEventListener('click', () => {
        /**
         * 🔴 **描き終わるのを待つ**(着地前レビュー・動線 2)。⚠ 5 分使わないと
         *   `dropManual()` が**本文だけ**捨てる(目次の行は残る)ので、開き直した直後の
         *   250ms ほどは見出しが 1 本も無く、**押しても何も起きず理由も出ない**。
         * 🔑 同じ file の探す欄(`jumpToSection`)は既に `await this.manualReady` している
         *   ── 新しく足した目次だけ、その 1 行が無かった。
         */
        void this.manualReady?.then(() => {
          /**
           * ⚠ **同じ列挙をもう一度引く**(要素を掴まない)── 組み直しで器が
           *   入れ替わっても迷子にならない。
           * 🔑 番号が動かない根拠:マニュアルの原文は**焼き込みの定数**で、
           *   `dropManual()` の後も**同じ字から同じ順で**組み直される。版が変われば
           *   頁ごと読み込み直しになるので、目次も一緒に組み直る。
           */
          const target = this.manualHeadings()[at] ?? null;
          if (target === null) return;
          // ⚠ 送り方は `jumpTo` 1 か所(§7)── 目次と本文の参照で 2 通りに書かない
          this.jumpTo(target, false);
        });
      });
      nav.append(row);
    }
  }
}
