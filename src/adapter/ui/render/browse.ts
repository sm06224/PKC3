/**
 * 左の列 ── **探す場所**(P8 段⑤)。
 *
 * > user 指摘 2026-08-03「**上のメニューと左ペインのメニューにかぶりがある /
 * > 分けもなくて、扱いにくい**」
 *
 * 🔴 かぶりの原因は「**どこに何を置くかの規則が無かった**」こと。決めた規則:
 *
 * | 場所 | 扱うもの | 持つ操作 |
 * |---|---|---|
 * | 上の帯 | アプリ全体 | 設定だけ |
 * | **左** | **ノート全体** | 探す・作る・入れる・出す・片づける |
 * | 中央 | いま開いているもの | 編集・保存 |
 * | 右 | 選んでいるもの | 書き出す・履歴・削除 |
 *
 * 🔑 そして **フォルダとアプリは「見る場所」ではなく「探し方」**である。
 * だから中央のビューではなく、**この列のタブ**にした ── 中央は常に
 * 「いま開いているノート」を出す(業務画面の作法:同じものが常に同じ場所にある)。
 *
 * ⚠ 描画器は使い回す(`FilerRenderer` / `LauncherRenderer`)── 置き場所が
 * 変わっただけで、中身の意味論は変えていない。
 */
import { blockedActionNote, canNavBack, canNavForward, type AppState } from '@adapter/state/app-state';
import { ScrollMemory } from './scroll-memory';
import { FilerRenderer } from './filer';
import { LauncherRenderer } from './launcher';
import { ScheduleRenderer } from './schedule';
import { ContactsRenderer } from './contacts';
import { CapturesRenderer } from './captures';
import { GraphRenderer } from './graph';
import { TimersRenderer } from './timers';
import { PcFolderRenderer } from './pc-folder';
import { LocalFolder } from '@adapter/platform/local-folder';
import type { AssetLender } from './detail';

// 🔑 型と既定は `browse-mode.ts` が持つ(#240 段⑤)── 既定が 4 か所に散っていた
export type { BrowseMode } from './browse-mode';
import { DEFAULT_BROWSE_MODE, type BrowseMode } from './browse-mode';
import { KindBarRenderer } from './kind-bar';
import { SavedSearchBar } from './saved-searches';
import { setPrimary } from './icons';
import { contactsKnownEmpty, markContactsTabEmpty } from './tabs-a11y';
import { setBlocked } from './shortcut-hint';
import { findCommand } from '@features/keymap';
import { commandQueryOf } from '@features/palette/command-query';
import { revealDelta } from './list-reveal';
import { fitSidebarBars } from './bar-overflow';

/**
 * タブ。⚠ 文言は「探し方」を表す(「詳細」のような場所の名前にしない)。
 * ⚠ 図案は**ここに持たない** ── `icons.ts` の `BROWSE_ICONS` が正本
 * (P9 段③。絵文字の表が 3 か所に散っていたのを 1 つに寄せた)。
 */
export const BROWSE_TABS: readonly { mode: BrowseMode; label: string }[] = [
  { mode: 'filer', label: 'フォルダ' },
  { mode: 'launcher', label: 'アプリ' },
  /**
   * 🔴 **予定**(#292 段③。user 指示 2026-08-23)。
   * ⚠ ここに置くのは、上の表が「**左 = ノート全体**」と決めているからである ──
   *   予定はノート全体を横断して見るもので、**中央(本文)を退かす理由が無い**。
   */
  { mode: 'schedule', label: '予定' },
  /**
   * 🔴 **連絡先**(#278 段①。user 指示 2026-08-19)。
   * ⚠ ここに置くのは、上の表が「**左 = ノート全体**」と決めているからである ──
   *   連絡先は**ノート**なので、閉じても失う物が無い(#292 段⑤ の見分け方)。
   */
  { mode: 'contacts', label: '連絡先' },
  /**
   * 🔴 **録ったもの**(#683 段①。user 要望 2026-09-03)。
   * ⚠ ここに置くのは、上の表が「**左 = ノート全体**」と決めているからである ──
   *   録ったものは**添付ノート**なので、閉じても失う物が無い(#292 段⑤ の見分け方)。
   */
  { mode: 'captures', label: '音/動画' },
  /**
   * 🔴 **PC**(#215 段①。🟣 Gemini 裁定 2026-10-01「別のタブに並べ、押すと取り込んで開く」。
   *   タブの字は 2026-10-02 の裁定 A で「パソコン」→「PC」)。⚠ 「パソコン」(4 文字)だと
   *   1366 / 1440px で 2 段へ折り返したが、「PC」なら 1101px から 1 段に収まる。
   * ⚠ 中身は**パソコンのフォルダの直下**で、ノートではない ── それでも左に置くのは、
   *   中央(本文)を退かさずに眺められるからである(#300)。押して開くのは**取り込んだノート**で、
   *   このタブは開いたまま残る。
   */
  { mode: 'pc', label: 'PC' },
  /**
   * 🔴 **関係グラフ**(#281 ①。user 指示 2026-08-19)。
   * ⚠ ここに置くのは、上の表が「**左 = ノート全体**」と決めているからである ──
   *   グラフはノート全体のつながりを映す**ノートの見方**で、閉じても失う物が無い。
   */
  { mode: 'graph', label: 'グラフ' },
  /**
   * 🔴 **計った時間**(#683 ①。user 要望 2026-09-03)。
   * ⚠ ここに置くのは、上の表が「**左 = ノート全体**」と決めているからである ──
   *   計った時間の正本は**ノートの本文**で、閉じても失う物が無い(#292 段⑤ の見分け方)。
   */
  { mode: 'timers', label: '時間' },
  /**
   * 🔴 **手書き**(#1448)。別ウィンドウ(「画像に描き込む」「手書きして置く…」)が塞がれたときの退避先 ──
   * 退避先は中央ではなく**左のタブ**(中央の本文を奪わない)。⚠ **描いている間だけ**タブが出る(普段は隠れている)。
   */
  { mode: 'draw', label: '手書き' },
] as const;

/**
 * 🔴 **編集中に黙って死ぬボタンの名指し**(#791。user 裁定 2026-09-08)。
 *
 * ⚠ **帯のボタン全部にしてはいけない** ── 添付 / 録音 / 画面 / 計る は
 *   **編集中でも動く**(預かる)ので、薄くすると嘘になる。
 * 🔑 ここに足すのは「`phase !== 'ready'` で**無言 return する** handler を持つ物」だけ。
 *   ⚠ `binder.ts` の handler を直したら、この一覧も見直す(§7 ── 判定が 2 か所にある)。
 * ⚠ **選択子は `data-pkc-field` に限らない**(#1054 段②-2)── ▼ の合成メニューの
 *   項目は面ごとに 1 つの `data-pkc-field` を持たないので、`[data-pkc-region="…"]`
 *   で範囲を切った `data-pkc-action` の複合選択子も入る(名前が「FIELDS」のままなのは
 *   PKC2 由来の慣習 ── 中身は「押せない理由を添える先」の一覧である)。
 */
const BLOCKABLE_FIELDS: readonly string[] = [
  // 今日の日付のノートを開く(`open-today` が `phase !== 'ready'` で黙って降りる)
  '[data-pkc-field="open-today"]',
  /*
   * 1 件も無い一覧の「+ ノートを作る」(`CREATE_ENTRY` を phase が捨てる)。
   * ⚠ **重なるのは `initializing` だけ**である(実測)── `editing` / `error` は
   *   **開いている本文**が要るので、そのノートが `entryMetas` に居て一覧が空にならない。
   *   レビューは `error` と書いていたが、その形は**到達しない**。
   */
  '[data-pkc-field="empty-start-create"]',
  /**
   * 🔴 **▼ の合成メニューの中の「種類」と「今日」**(#1054 段②-2。
   *   着地前レビューが指摘)。
   *
   * ⚠ 直す前は**帯のタイル(`today` / `create-run`)だけ**を薄くしており、
   *   同じ action を持つ**メニューの複製**(`menuToday` / 種類の一覧)は濃いまま
   *   押せそうに見えて、押しても何も起きなかった(`open-today` / `CREATE_ENTRY` は
   *   `phase !== 'ready'` を黙って捨てる ── 上のタイルと同じ理由)。
   * ⚠ **道具の複製(添付・録音・画面・計る)は含めない** ── あちらは編集中でも動く
   *   (`NOTE_TOOL_ACTIONS` が別に断る。ここへ足すと嘘になる)。
   * 🔑 `[data-pkc-region="create-menu"]` で範囲を切る ── 範囲を切らずに
   *   `[data-pkc-action="pick-create-kind"]` だけ書くと、他の面に同じ action が
   *   生えた日にそちらまで薄くなる。
   */
  '[data-pkc-region="create-menu"] [data-pkc-action="pick-create-kind"]',
  '[data-pkc-region="create-menu"] [data-pkc-action="open-today"]',
  // 🔴 テンプレートから作る(#1645。`CREATE_ENTRY` を phase が捨てるので、種類・今日と同じに薄くする)
  '[data-pkc-region="create-menu"] [data-pkc-action="create-from-template"]',
];
export const BLOCKABLE_SELECTOR = BLOCKABLE_FIELDS.join(', ');

export class BrowseRouter {
  private readonly panes: Record<BrowseMode, HTMLElement>;
  /**
   * 🔴 **種類の札は面ではなく器が描く**(#478)── 帯は左の列(shell)に在り、
   *   面をまたいで居座るので、**開いている面に関係なく毎回**描き直す。
   */
  private readonly kindBar: KindBarRenderer;
  /** 🔴 保存した検索の帯(#1038 C1)。器が無い組み方(test)では持たない。 */
  private readonly savedBar: SavedSearchBar | null;
  private readonly filer: FilerRenderer;
  private readonly launcher: LauncherRenderer;
  private readonly schedule: ScheduleRenderer;
  private readonly contacts: ContactsRenderer;
  /** 🔴 録ったもの(#683 段①)。⚠ **中身を借りる**ので、面を捨てるとき返す。 */
  private readonly captures: CapturesRenderer;
  /** 🔴 関係グラフ(#281 ①)。 */
  private readonly graph: GraphRenderer;
  /** 🔴 計った時間(#683 ①)。 */
  private readonly timers: TimersRenderer;
  /** 🔴 パソコンのフォルダ(#215 段①)。⚠ handle は持たない(`LocalFolder` が持ち主)。 */
  private readonly pc: PcFolderRenderer;
  /** 🔴 手書きのタブ(#1448)。描いている間だけ出す。 */
  private readonly drawTab: HTMLElement | null;
  /**
   * 🔑 **面ごとに位置を覚える**(P8 段⑫。user 指示「サイドバーも同じ、
   * スクロールが発生するすべての画面が対象だよ」)。3 つの面が**同じ器**を
   * 使い回しているので、覚えないとタブを行き来しただけで位置が混ざる。
   */
  private readonly scroll: ScrollMemory;
  /** 探す欄(面の外に在る ── どの面でも見えている)。 */
  private readonly filterInput: HTMLInputElement | null;
  /** 🔴 ノートの一覧の器(`>` を打っている間は隠す)と、代わりに出す操作の一覧の器(#274 段①)。 */
  private readonly host: HTMLElement;
  private readonly commandList: HTMLElement | null;
  /**
   * 🔴 **`>` の間は出さない帯 3 つ**(#1206 D2)── 探し方のタブ / 並び順 / 作る帯。
   * ⚠ 隠す物は**この 3 つだけ**(探す欄・戻る進む・種類の札 `kind-bar` は別の作法で動く)。
   */
  private readonly hideWhileCommand: readonly HTMLElement[];
  /** 左の「一覧の並び順」。⚠ 2 ペインの列見出しからも変わるので、描くたびに state へ合わせる。 */
  private readonly sortSelect: HTMLSelectElement | null;
  /** 並びの向きを逆にするボタン(依頼 198)。 */
  private readonly sortReverse: HTMLButtonElement | null;
  /**
   * 🔴 **戻る「‹」/ 進む「›」**(#190)。⚠ **面に関係なく**ここが合わせる(#813 段③-a)。
   * 直す前は一覧の描画器だけが `disabled` を動かしていたので、**既定のフォルダのタブでは
   * 履歴が積まれてもボタンが死んだまま**だった(押せないので近道の `Alt+←` しか無かった)。
   */
  private readonly navBack: HTMLButtonElement | null;
  private readonly navForward: HTMLButtonElement | null;
  private lastHistory: AppState['selectionHistory'] | null = null;
  /** 🔴 開いているノートの行へ送った最後のノート(依頼 277)。変わったときだけ送る。 */
  private lastRevealed: string | null = null;
  /** 送りの予約(最新の 1 本だけ生かす)。 */
  private revealToken = 0;
  /** 左の列の「+ ノート」(主の操作の印を phase で付け外しする)。 */
  private readonly createRun: HTMLElement | null;
  /** 🔴 指で触る端末へ理由を届ける 1 行(#791 ③)。⚠ CSS が出し分ける。 */
  private readonly createBlockedNote: HTMLElement | null;
  /** 押せない理由を探す範囲(左の列 / 面の器)。 */
  private readonly roots: readonly HTMLElement[];
  private last: BrowseMode;

  /**
   * @param initial 最初に出す探し方(#240 段⑤)。⚠ **器の hidden も同じ値で組む** ──
   *   ここを 'list' 固定にしていたので、既定を変えると**タブは選ばれているのに
   *   中身は一覧のまま**という食い違いが出た(段⑤ の実装中に実際に踏んだ)。
   */
  constructor(
    sidebar: HTMLElement,
    host: HTMLElement,
    initial: BrowseMode = DEFAULT_BROWSE_MODE,
    /** ⚠ test 注入用(既定は実時刻)── 「今日」を面ごとに読まない。 */
    now?: () => Date,
    /**
     * 🔴 **添付の中身を借りる口**(#683 段①)。⚠ `null` なら「聞く」を出さない
     *   ── 押しても何も起きないボタンを作らない。
     */
    assets: AssetLender | null = null,
    /** 🔴 借り終えたことを外へ知らせる口(#683 段①)。⚠ 渡さないと器が出ない。 */
    onCaptureReady: () => void = () => {},
    /**
     * 🔴 **パソコンのフォルダ**(#215 段①)。⚠ 持ち主は `main.ts` ── binder の押し口と
     *   **同じ 1 つ**を渡す(2 つ作ると、押した先と描いている先が別になる)。
     *   省略 = このブラウザでは使えない扱い(test 用)。
     */
    pcFolder: LocalFolder = new LocalFolder({
      picker: null,
      open: async () => {},
      fail: () => {},
      onChange: () => {},
    }),
  ) {
    this.last = initial;
    this.host = host;
    this.commandList = sidebar.querySelector<HTMLElement>('[data-pkc-region="command-list"]');
    this.sortSelect = sidebar.querySelector<HTMLSelectElement>('select[data-pkc-field="entry-sort"]');
    this.sortReverse = sidebar.querySelector<HTMLButtonElement>('button[data-pkc-field="entry-sort-reverse"]');
    this.hideWhileCommand = [
      '[data-pkc-region="browse-tabs"]',
      '[data-pkc-field="entry-sort"]',
      '[data-pkc-region="create-bar"]',
    ].flatMap((sel) => {
      const el = sidebar.querySelector<HTMLElement>(sel);
      return el === null ? [] : [el];
    });
    const pane = (mode: BrowseMode): HTMLElement => {
      const el = document.createElement('div');
      el.setAttribute('data-pkc-browse-pane', mode);
      if (mode !== initial) el.hidden = true;
      host.append(el);
      return el;
    };
    this.panes = {
      filer: pane('filer'),
      launcher: pane('launcher'),
      schedule: pane('schedule'),
      contacts: pane('contacts'),
      captures: pane('captures'),
      graph: pane('graph'),
      timers: pane('timers'),
      pc: pane('pc'),
      draw: pane('draw'),
    };
    this.drawTab = sidebar.querySelector<HTMLElement>('[data-pkc-browse="draw"]');
    if (this.drawTab !== null) this.drawTab.hidden = true;
    this.scroll = new ScrollMemory(host);
    /**
     * 🔴 **探す欄は面の外にある**(2026-08-29、#536 ②)。⚠ 面の中の renderer に
     *   同期を持たせると、**その面を開いていない間は古い字が残る** ──
     *   すぐ下の `kindBar`(#478)と同じ理由である。
     */
    this.filterInput = sidebar.querySelector<HTMLInputElement>(
      '[data-pkc-field="entry-filter"]',
    );
    /**
     * 🔴 **「+ ノート」の濃さは phase で決まる**(#722 P2-10。着地前レビュー・動線 1)。
     * ⚠ ここに置く理由は上の 2 つと同じ ── **面に関係なく**合わせる必要がある
     *   (どの面を開いていても左の列に出ているボタンである)。
     */
    this.createRun = sidebar.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    this.navBack = sidebar.querySelector<HTMLButtonElement>('[data-pkc-action="nav-back"]');
    this.navForward = sidebar.querySelector<HTMLButtonElement>('[data-pkc-action="nav-forward"]');
    this.createBlockedNote = sidebar.querySelector<HTMLElement>(
      '[data-pkc-field="create-blocked-note"]',
    );
    // 押せない理由を添える先を探す範囲 ── 左の列(帯 + 一覧)と、面の器(ファイラ)
    // ⚠ 器が左の列の中に在るとき(既定の組み方)は左の列だけを歩く ── 2 つとも渡すと同じ要素を 2 度拾う(#1087)
    this.roots = sidebar.contains(host) ? [sidebar] : [sidebar, host];
    this.kindBar = new KindBarRenderer(sidebar);
    const savedHost = sidebar.querySelector<HTMLElement>('[data-pkc-region="saved-searches"]');
    this.savedBar = savedHost === null ? null : new SavedSearchBar(savedHost, 'filter');
    this.filer = new FilerRenderer(this.panes.filer);
    // 🔴 取り込んだ絵を出すために貸し口を渡す(#856 段②)── 渡さなければ字と図案だけ出る
    this.launcher = new LauncherRenderer(this.panes.launcher, undefined, assets);
    this.schedule = new ScheduleRenderer(this.panes.schedule, now);
    this.contacts = new ContactsRenderer(this.panes.contacts);
    this.captures = new CapturesRenderer(this.panes.captures, assets, onCaptureReady);
    this.graph = new GraphRenderer(this.panes.graph);
    this.timers = new TimersRenderer(this.panes.timers);
    this.pc = new PcFolderRenderer(this.panes.pc, pcFolder);
  }

  /** 🔴 手書きの面の器(#1448)。道具と台はここへ組む(`openImageDrawInPane`)。 */
  drawPaneRoot(): HTMLElement {
    return this.panes.draw;
  }

  /** 🔴 手書きのタブを出す / 畳む(#1448)。描いている間だけ出す。 */
  setDrawTab(visible: boolean): void {
    if (this.drawTab === null) return;
    this.drawTab.hidden = !visible;
    // 🔴 タブの数が変わる ⇒ 1 段に収まるか測り直す(帯の幅は変わらず、`ResizeObserver` は鳴らない)
    const bar = this.drawTab.closest<HTMLElement>('[data-pkc-region="sidebar"]');
    if (bar !== null) fitSidebarBars(bar.parentElement ?? bar);
  }

  /**
   * 押せない理由を添える先。⚠ **口を 1 つにする**(CLAUDE.md §7)── 面ごとに
   * `setBlocked` を書くと、次に足した面だけ黙って死ぬ。
   */
  private blockables(): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (this.createRun !== null) out.push(this.createRun);
    // 🔑 選択子は 1 本にまとめて 1 回で歩く(#1087)── 4 本 × 根の数だけ全体を歩いていた
    // 🔑 **一覧の行の中は歩かない**(#1087)。押せない理由を添える先は帯・メニュー・空の一覧の
    //    案内であって、行(`<tbody>`)の中には 1 つも無い ── 全体への `querySelectorAll` は
    //    状態が動くたび(編集の 1 打鍵ごとも)行の数に比例して全部の行を歩いていた。
    //    ⚠ 見つかる物は同じ(`tests/adapter/browse-blockables-walk.test.ts` が全数で突き合わせる)。
    for (const r of this.roots) {
      const walker = r.ownerDocument.createTreeWalker(r, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (n) =>
          n.nodeName === 'TBODY'
            ? NodeFilter.FILTER_REJECT
            : (n as Element).matches(BLOCKABLE_SELECTOR)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP,
      });
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) out.push(n as HTMLElement);
    }
    return out;
  }

  render(state: AppState, mode: BrowseMode): void {
    // 🔴 連絡先が 0 件と分かっている間は、左のタブを「⋯」の下へ回す(#475 項目 5)
    const doc = this.roots[0]?.ownerDocument;
    if (doc !== undefined) markContactsTabEmpty(doc, contactsKnownEmpty(state));
    // 🔴 並び順の選択欄を state に合わせる(2 ペインの列見出しで変えたとき、欄が古いままだった)
    if (this.sortSelect !== null && this.sortSelect.value !== state.entrySort) {
      this.sortSelect.value = state.entrySort;
    }
    // 🔴 「自分で並べた順」には向きが無い ── 押せない(依頼 198)
    if (this.sortReverse !== null) this.sortReverse.disabled = state.entrySort === 'manual';
    // 🔑 面 = 探し方 × 「絞り込み中かどうか」。⚠ 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    // ⚠ **種類の絞りも「絞り込み中」に数える**(#411)── 数えないと、札を押した
    //    ときだけスクロールが前の位置のまま残る(語で絞ったときと振る舞いが違う)
    const filtering = state.filterQuery !== '' || state.kindFilter.size > 0;
    // 🔴 フォルダ面は**入っているフォルダごと**に位置を覚える(#1087)。鍵に現在地が無いと、
    //    フォルダへ入ったときルートの深さで開き、戻ったときにルートの位置も失っていた。
    const scopeKey = mode === 'filer' ? (state.scopeLid ?? '') : '';
    const key = `${mode}|${filtering ? 'q' : ''}|${scopeKey}`;
    // 🔑 位置は `ScrollMemory` が `scroll` イベントで覚えている ── ここで `scrollTop` を読まない
    //    (読むと直前の描き直しの強制レイアウトをここで払う。#1467 段 3-e)
    if (mode !== this.last) {
      this.panes[this.last].hidden = true;
      this.panes[mode].hidden = false;
      /**
       * 🔴 **録ったものから出たら、借りた中身を返す**(#683 段①)。
       * ⚠ 録音 1 本で数百 MB になりうるので、**その場で返す**
       *   (不可侵指示 2026-07-27「ライフサイクル終端で速やかに破棄」)。
       * ⚠ タブは行き来されるので、返さないと**切り替えた回数ぶん積み上がる**。
       */
      if (this.last === 'captures') this.captures.dispose();
      /**
       * 🔴 **アプリの一覧から出たら、借りた絵を返す**(#856 段②)── 上と同じ理由。
       *
       * ⚠ タブを切り替えても**器は残る**(`hidden` にするだけ)ので、
       *   `<img>` は `isConnected` のままである ── つまり「画面から消えたら返す」の
       *   仕掛けは**1 つも働かない**。ここで返さないと、**行き来した回数ぶん
       *   握ったまま**になる。
       * ⚠ 戻ってきたときは `render` が組み直して借り直す(指紋は `hidden` を見ないが、
       *   タブが変われば必ず `render` が走る)。
       */
      if (this.last === 'launcher') this.launcher.disposeAssets();
      this.last = mode;
    }
    // 🔴 **札の帯は面に関係なく描く**(#478)── 面の中の renderer に持たせると、
    //    その面を開いていない間は**古い DOM のまま**になり、押しても嘘をつく。
    this.kindBar.render(state, mode);
    // 保存した検索の帯も面に関係なく描く(語と札は面をまたいで効いているため。種類の札と同じ理由)
    this.savedBar?.render(state);
    /**
     * 🔴 **戻る・進むの生死も面に関係なく合わせる**(#190 → #813 段③-a)。
     * ⚠ 選択と連動して動くことが多いが、掃除(`pruneHistory`)だけが動く回もあるので、
     *   **履歴そのもの**を指紋にする(押せないのに生きている = dead click を作らない)。
     */
    if (state.selectionHistory !== this.lastHistory) {
      /**
       * 🔴 **押せない理由を hover に出す**(#1087 L4)── 理由は操作の定義(`keymap.ts` の `whyNot`)の 1 か所から採る。
       * ⚠ `disabled` だけだと、なぜ薄いのかがどこにも書かれない(`setBlocked` が 3 つ同時に動かす)。
       */
      if (this.navBack)
        setBlocked(this.navBack, canNavBack(state) ? null : (findCommand('nav-back')?.whyNot ?? null));
      if (this.navForward)
        setBlocked(
          this.navForward,
          canNavForward(state) ? null : (findCommand('nav-forward')?.whyNot ?? null),
        );
      this.lastHistory = state.selectionHistory;
    }
    /**
     * 🔴 **編集中は「+ ノート」を押せない形にする**(#722 P2-10 → #761)。
     *
     * ⚠ `CREATE_ENTRY` は `phase !== 'ready'` を**黙って捨てる**ので、直す前の
     *   「+ ノート」は**押しても 1 ドットも動かず、理由も出なかった** ──
     *   画面でいちばん濃い物が無反応だと、user は「壊れた」か「自分の押し方が
     *   悪い」と読む。⚠ #722 P2-10 では**濃さだけ**を直しており、押した結果は
     *   そのままだった(その残りがこれ)。
     * 🔑 `setBlocked` が 3 つ同時に動かす ── 見た目(`disabled`)/ 説明の末尾の
     *   理由 / 鍵で撃たれたときに出す字。**字は `blockedActionNote` の 1 か所**
     *   から採る(情報ペインの帯と同じ ── CLAUDE.md §7)。
     */
    if (this.createRun !== null) {
      const ready = state.phase === 'ready';
      setPrimary(this.createRun, ready);
    }
    /**
     * 🔴 **同じ帯の「今日」も、1 件も無い一覧の「作る」も、同じ字で断る**
     *   (#791 ①②。user 裁定 2026-09-08「『今日』も薄くする」)。
     *
     * ⚠ 直す前は **「+ ノート」だけ**が薄くなり、その 1 つ右の「今日」は
     *   **濃いまま押せそうに見えて、押しても何も起きなかった**(`open-today` の
     *   handler が `phase !== 'ready'` で無言 return する)。
     *   🔴 #761 で「**薄い = 押せない**」を user に教えたぶん、隣がその規則を
     *   裏切ると**直す前より悪い** ── user は自分の押し方を疑う。
     * ⚠ **同じ帯でも薄くしてはいけない物がある** ── 添付 / 録音 / 画面 / 計る は
     *   **編集中でも動く**(預かる)。黙って死んでいたのは「今日」1 つだけだった。
     * 🔑 だから**名指しの一覧**で持つ ── 「帯のボタン全部」にすると、
     *   動く物まで薄くなる(この差は phase では表せない)。
     * ⚠ 「1 件も無い一覧の作る」は**描き直されるたびに別の要素**なので、
     *   構築時ではなく**毎回引き直す**(`empty-start` は filer が render 中に作る)。
     */
    /**
     * 🔴 **絞りの字も面に関係なく合わせる**(#536 ②)。
     * ⚠ 打鍵中は `value === filterQuery` なので書き戻しは起きない(caret を壊さない)。
     */
    if (this.filterInput !== null && this.filterInput.value !== state.filterQuery)
      this.filterInput.value = state.filterQuery;
    /**
     * 🔴 **`>` を打っている間は、ノートの一覧の場所に操作の一覧を出す**(#274 段①。姿 = D)。
     *
     * ⚠ **新しい面ではない** ── 同じ場所の中身が替わるだけで、探す欄から手を離さずに
     *   戻れる(`>` を消す)。⚠ 行は `binder.ts` が描く(「いま押せるか」が画面のボタンで
     *   決まるので、描画器は state だけでは組めない)。ここは**出し入れだけ**。
     * ⚠ 面の描画(下)は止めない ── 隠すだけなので、戻ったとき指紋が合っていれば
     *   触らずに済む(5000 行を作り直さない)。
     */
    const commandMode = commandQueryOf(state.filterQuery) !== null;
    if (this.host.hidden !== commandMode) this.host.hidden = commandMode;
    if (this.commandList !== null && this.commandList.hidden !== !commandMode)
      this.commandList.hidden = !commandMode;
    /**
     * 🔴 **`>` の間は、タブ・並び順・作る帯も出さない**(#1206 D2)。⚠ 直す前は残っていて、
     *   押すとタブの色だけ動くのに**一覧は操作のまま**(壊れたと読む)だった ── 種類の札
     *   (`kind-bar.ts`)が `>` で隠れるのと**同じ作法**で、`hidden` を付けるだけ(戻すと復帰)。
     *   「+ ノート」の代わりは `>ノート`(操作の一覧から作れる)。
     */
    for (const el of this.hideWhileCommand) if (el.hidden !== commandMode) el.hidden = commandMode;
    // ⚠ 非 active な面には render を呼ばない(裏で毎 state 仕事をしない)
    if (mode === 'filer') this.filer.render(state);
    else if (mode === 'schedule') this.schedule.render(state);
    else if (mode === 'contacts') this.contacts.render(state);
    else if (mode === 'captures') this.captures.render(state);
    else if (mode === 'graph') this.graph.render(state);
    else if (mode === 'timers') this.timers.render(state);
    else if (mode === 'pc') this.pc.render();
    else this.launcher.render(state);
    /*
     * 🔴 **面を描き終えてから理由を添える**(#791 ②)── 「1 件も無い一覧の作る」は
     *   この render の中で**作り直される**ので、先に添えると**古い要素**に付いて
     *   新しい要素は素のまま出る(1 稿目で実際に踏んだ:test が「押せる見た目のまま」で落ちた)。
     */
    const why = blockedActionNote(state.phase);
    for (const el of this.blockables()) setBlocked(el, why);
    /**
     * 🔴 **指で触る端末にも、なぜ薄いのかを届ける**(#791 ③)。
     *
     * ⚠ `setBlocked` が置くのは `title`(hover 専用)と `data-pkc-blocked`
     *   (鍵とパレットが読む)だけなので、**指で触る人には薄さしか届かない**。
     * 🔑 字は**上の `why` をそのまま**使う ── ここで `blockedActionNote` を
     *   呼び直すと、同じ問いに答える口が 2 つになる(§7)。
     * ⚠ 出し分けは CSS(`@media (hover: none) and (pointer: coarse)`)── ここは
     *   端末を見ない。**見えるかどうかは 1 か所**で決める。
     */
    if (this.createBlockedNote !== null) {
      const text = why ?? '';
      if (this.createBlockedNote.textContent !== text) this.createBlockedNote.textContent = text;
      if (this.createBlockedNote.hidden !== (why === null)) this.createBlockedNote.hidden = why === null;
    }
    // 🔑 **中身を入れ終わってから**位置を合わせる(空の器に書いても丸められる)。
    // ⚠ 面 = 探し方 × 「絞り込み中かどうか」── 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    // ② 🔴 **中身を入れ終わってから**戻す(空の器に書いても丸められる)
    this.scroll.use(key);
    /**
     * 🔴 **開いているノートの行が見えない所にあれば、見える所まで送る**(依頼 277)。
     * ⚠ 位置を戻した**後**にやる(戻した位置が上書きする)。⚠ 行の位置を読むと配置が要るので、
     *   次の描画の直前(`requestAnimationFrame`)に 1 回だけ ── 描き直しの途中で強制レイアウトを払わない
     *   (`ScrollMemory` の注記と同じ理由)。
     */
    if (mode === 'filer' && state.selectedLid !== this.lastRevealed) {
      this.lastRevealed = state.selectedLid;
      if (state.selectedLid !== null) this.revealRow(state.selectedLid);
    }
  }

  private revealRow(lid: string): void {
    const token = ++this.revealToken;
    const win = this.host.ownerDocument.defaultView;
    if (win === null) return;
    win.requestAnimationFrame(() => {
      if (token !== this.revealToken) return;
      const row = this.panes.filer.querySelector<HTMLElement>(
        `[data-pkc-region="filer-table"] [data-pkc-entry="${CSS.escape(lid)}"]`,
      );
      if (row === null) return;
      const view = this.host.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const delta = revealDelta(r.top, r.bottom, view.top, view.bottom);
      if (delta !== 0) this.host.scrollTop += delta;
    });
  }
}
