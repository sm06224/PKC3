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
import { blockedActionNote, type AppState } from '@adapter/state/app-state';
import { SidebarRenderer } from './sidebar';
import { ScrollMemory } from './scroll-memory';
import { FilerRenderer } from './filer';
import { LauncherRenderer } from './launcher';
import { ScheduleRenderer } from './schedule';
import { ContactsRenderer } from './contacts';

// 🔑 型と既定は `browse-mode.ts` が持つ(#240 段⑤)── 既定が 4 か所に散っていた
export type { BrowseMode } from './browse-mode';
import { DEFAULT_BROWSE_MODE, type BrowseMode } from './browse-mode';
import { KindBarRenderer } from './kind-bar';
import { setPrimary } from './icons';
import { setBlocked } from './shortcut-hint';

/**
 * タブ。⚠ 文言は「探し方」を表す(「詳細」のような場所の名前にしない)。
 * ⚠ 図案は**ここに持たない** ── `icons.ts` の `BROWSE_ICONS` が正本
 * (P9 段③。絵文字の表が 3 か所に散っていたのを 1 つに寄せた)。
 */
export const BROWSE_TABS: readonly { mode: BrowseMode; label: string }[] = [
  { mode: 'list', label: '一覧' },
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
] as const;

/**
 * 🔴 **編集中に黙って死ぬボタンの名指し**(#791。user 裁定 2026-09-08)。
 *
 * ⚠ **帯のボタン全部にしてはいけない** ── 添付 / 録音 / 画面 / 計る は
 *   **編集中でも動く**(預かる)ので、薄くすると嘘になる。
 * 🔑 ここに足すのは「`phase !== 'ready'` で**無言 return する** handler を持つ物」だけ。
 *   ⚠ `binder.ts` の handler を直したら、この一覧も見直す(§7 ── 判定が 2 か所にある)。
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
];

export class BrowseRouter {
  private readonly panes: Record<BrowseMode, HTMLElement>;
  private readonly list: SidebarRenderer;
  /**
   * 🔴 **種類の札は面ではなく器が描く**(#478)── 帯は左の列(shell)に在り、
   *   面をまたいで居座るので、**開いている面に関係なく毎回**描き直す。
   */
  private readonly kindBar: KindBarRenderer;
  private readonly filer: FilerRenderer;
  private readonly launcher: LauncherRenderer;
  private readonly schedule: ScheduleRenderer;
  private readonly contacts: ContactsRenderer;
  /**
   * 🔑 **面ごとに位置を覚える**(P8 段⑫。user 指示「サイドバーも同じ、
   * スクロールが発生するすべての画面が対象だよ」)。3 つの面が**同じ器**を
   * 使い回しているので、覚えないとタブを行き来しただけで位置が混ざる。
   */
  private readonly scroll: ScrollMemory;
  /** 探す欄(面の外に在る ── どの面でも見えている)。 */
  private readonly filterInput: HTMLInputElement | null;
  /** 左の列の「+ ノート」(主の操作の印を phase で付け外しする)。 */
  private readonly createRun: HTMLElement | null;
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
  ) {
    this.last = initial;
    const pane = (mode: BrowseMode): HTMLElement => {
      const el = document.createElement('div');
      el.setAttribute('data-pkc-browse-pane', mode);
      if (mode !== initial) el.hidden = true;
      host.append(el);
      return el;
    };
    // ⚠ 一覧だけは既存の region(`entry-list`)をそのまま使う ── 行の再利用と
    // 絞り込みの指紋がそこに載っているので、器を作り替えない
    this.panes = {
      list: host.querySelector<HTMLElement>('[data-pkc-region="entry-list"]') ?? pane('list'),
      filer: pane('filer'),
      launcher: pane('launcher'),
      schedule: pane('schedule'),
      contacts: pane('contacts'),
    };
    // ⚠ 一覧は既存の region を使い回すので、`pane()` の hidden 制御を通らない ──
    //    初期が一覧でないときは**ここで隠す**(隠し忘れると 2 面が重なって出る)
    if (initial !== 'list') this.panes.list.hidden = true;
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
    // 押せない理由を添える先を探す範囲 ── 左の列(帯 + 一覧)と、面の器(ファイラ)
    this.roots = [sidebar, host];
    this.list = new SidebarRenderer(sidebar);
    this.kindBar = new KindBarRenderer(sidebar);
    this.filer = new FilerRenderer(this.panes.filer);
    this.launcher = new LauncherRenderer(this.panes.launcher);
    this.schedule = new ScheduleRenderer(this.panes.schedule, now);
    this.contacts = new ContactsRenderer(this.panes.contacts);
  }

  /**
   * 押せない理由を添える先。⚠ **口を 1 つにする**(CLAUDE.md §7)── 面ごとに
   * `setBlocked` を書くと、次に足した面だけ黙って死ぬ。
   */
  private blockables(): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (this.createRun !== null) out.push(this.createRun);
    for (const sel of BLOCKABLE_FIELDS)
      for (const el of this.roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>(sel)]))
        out.push(el);
    return out;
  }

  render(state: AppState, mode: BrowseMode): void {
    // 🔑 面 = 探し方 × 「絞り込み中かどうか」。⚠ 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    // ⚠ **種類の絞りも「絞り込み中」に数える**(#411)── 数えないと、札を押した
    //    ときだけスクロールが前の位置のまま残る(語で絞ったときと振る舞いが違う)
    const filtering = state.filterQuery !== '' || state.kindFilter.size > 0;
    const key = `${mode}|${filtering ? 'q' : ''}`;
    // ① 🔴 **中身を書き換える前に**退避する ── 描いた後だと、縮んで 0 に
    //    丸められた値を保存してしまう(実測でそう外した)
    this.scroll.park();
    if (mode !== this.last) {
      this.panes[this.last].hidden = true;
      this.panes[mode].hidden = false;
      this.last = mode;
    }
    // 🔴 **札の帯は面に関係なく描く**(#478)── 面の中の renderer に持たせると、
    //    その面を開いていない間は**古い DOM のまま**になり、押しても嘘をつく。
    this.kindBar.render(state, mode);
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
     *   構築時ではなく**毎回引き直す**(`empty-start` は list / filer が render 中に作る)。
     */
    /**
     * 🔴 **絞りの字も面に関係なく合わせる**(#536 ②)。
     * ⚠ 打鍵中は `value === filterQuery` なので書き戻しは起きない(caret を壊さない)。
     */
    if (this.filterInput !== null && this.filterInput.value !== state.filterQuery)
      this.filterInput.value = state.filterQuery;
    // ⚠ 非 active な面には render を呼ばない(裏で毎 state 仕事をしない)
    if (mode === 'list') this.list.render(state);
    else if (mode === 'filer') this.filer.render(state);
    else if (mode === 'schedule') this.schedule.render(state);
    else if (mode === 'contacts') this.contacts.render(state);
    else this.launcher.render(state);
    /*
     * 🔴 **面を描き終えてから理由を添える**(#791 ②)── 「1 件も無い一覧の作る」は
     *   この render の中で**作り直される**ので、先に添えると**古い要素**に付いて
     *   新しい要素は素のまま出る(1 稿目で実際に踏んだ:test が「押せる見た目のまま」で落ちた)。
     */
    const why = blockedActionNote(state.phase);
    for (const el of this.blockables()) setBlocked(el, why);
    // 🔑 **中身を入れ終わってから**位置を合わせる(空の器に書いても丸められる)。
    // ⚠ 面 = 探し方 × 「絞り込み中かどうか」── 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    // ② 🔴 **中身を入れ終わってから**戻す(空の器に書いても丸められる)
    this.scroll.use(key);
  }
}
