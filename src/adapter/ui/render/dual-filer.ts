/**
 * 🔴 **2 ペインタブファイラ**(#241 段⑥-a。user 指示 2026-08-17
 * 「アプリに 2 ペインタブファイラ(PKC 内の整理高度化のため)を組み込みで提供すること」)。
 *
 * ## この面が引き受けるもの
 *
 * 左の列のフォルダ面(#240)は**主動線**で、片手間の整理をする所である。
 * こちらは「腰を据えて整理する」ための面 ── **別の場所を 2 つ同時に開き、
 * 間で移す**という、ファイラの古典的な形をそのまま持ってくる。
 *
 * ## 借りるものと、借りないもの
 *
 * | 何 | どこから | なぜ |
 * |---|---|---|
 * | **行の並び** | `features/relation/filer-list.ts` の `filerRows` | 規則は 1 本(見た並びと選ばれる範囲を食い違わせない) |
 * | **範囲の採り方** | 同 `rangeInRows`(reducer 経由) | 同上 |
 * | **移す実体** | `binder` の `moveEntries` | 断り方・「付いていく」の規則を経路で変えない |
 * | 現在地・印 | 借りない(`state.dual` を持つ) | 左の列と共有すると**左を動かすたびに 2 ペインが飛ぶ** |
 *
 * ## 描き直しの規律
 *
 * ⚠ **器を捨てない。** 押す寸前のボタンを作り直すと dead click になる
 * (2026-08-07 に情報ペイン・ファイラ・本文の 3 面で踏んだ形)。
 * 表だけは指紋が変わったときに組み直し、**印は属性の付け替え**で塗る。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';
import type { DualPaneState, DualSide } from '@features/relation/dual-pane';
import { MAX_TABS, paneOf, paneScope } from '@features/relation/dual-pane';
import { filerRows } from '@features/relation/filer-list';
import { normalizeQuery } from '@features/filter/title-filter';
import { getAncestorFolders } from '@features/relation/tree';
import { formatListDate } from '@features/datetime/stored-date';
import { chordLabel, findCommand } from '@features/keymap';
import { appKeymap, type KeymapStore } from './keymap';
import { ARCHETYPE_ICONS, iconSpan } from './icons';

/**
 * 指紋の区切り。⚠ **題名に現れない字**でなければ、別々の行が同じ指紋になり
 * 「変わったのに描き直さない」が作れる(`ab|c` と `a|bc` が同じに見える)。
 * ⚠ 生バイトでは書かない ── `tests/repo-hygiene.test.ts` が機械的に止める
 * (CLAUDE.md §9。`render/filer.ts` の `metaSignature` と同じ作法)。
 */
const SEP = '\u0000';

const SIDES: readonly DualSide[] = ['left', 'right'];

/** 側の呼び名。⚠ **画面に出る字**なので features には置かない(層規約)。 */
const SIDE_LABEL: Readonly<Record<DualSide, string>> = { left: '左', right: '右' };

/**
 * 🔴 **列の定義**(2026-08-19 の作り直し)。
 *
 * ⚠ **名前の列にだけ幅を書かない** ── 残りを全部食わせる(Total Commander が
 *   まさにそう作られており、Double Commander の実数も 250:70:140 と名前が最大)。
 *   幅は CSS 側(`app.css`)で `td:last-child` にだけ与える。
 * ⚠ **種類の列は持たない**(行頭の図案が示す ── 左の「フォルダ」タブと同じ)。
 * 🔑 `sort` が `null` の列は押せない(並べ替えの規則を持たない列を押させない)。
 */
const COLUMNS: readonly { key: string; label: string; sort: AppState['entrySort'] | null }[] = [
  { key: 'name', label: '名前', sort: 'title' },
  { key: 'size', label: '大きさ', sort: 'size' },
  { key: 'updated', label: '更新', sort: 'updated' },
];

/**
 * 並べている列に付ける印。⚠ **向きを字で出す**(2026-08-19)── 出さないと
 * 「押すたびに何かが変わるが、いまどちら向きか分からない」になる。
 * 🔑 古典 4 実装とも矢印 1 つで示す。
 */
const SORT_MARK: Readonly<Record<'asc' | 'desc', string>> = { asc: ' ▲', desc: ' ▼' };

/**
 * 🔴 **大きさの見せ方**(2026-08-19)。単位は**文字**で、桁は 1000 区切り。
 *
 * ⚠ **バイトではない** ── PKC3 の中身は本文(PKC-Markdown)なので、
 *   user が判断に使うのは「どれくらい書いてあるか」である。`formatSize`
 *   (添付のバイト数)とは**別の量**なので、同じ関数を使い回さない。
 * ⚠ `null` = **まだ数えていない**(旧ビルドが書いた行)。`0`(空のノート)と
 *   区別して出す ── 潰すと「空なのか未計算なのか」が読めない。
 */
export function formatBodyChars(chars: number | null): string {
  if (chars === null) return '—';
  if (chars < 1000) return String(chars);
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}K`;
  return `${(chars / 1_000_000).toFixed(1)}M`;
}

/**
 * 🔴 **操作行の並び**(2026-08-19 の作り直し)。
 *
 * ⚠ **並びは固定**(不可侵指示「同じものが常に同じ場所にある」)── 焦点が
 *   変わっても**位置も文言も動かない**。変わるのは説明(`title`)だけ。
 * 🔑 割当は古典 4 実装(Total Commander / Double Commander / FAR / Krusader)で
 *   一致している **F5 写す / F6 移す / F7 作る / F8 消す**。⚠ ただし**鍵は
 *   ここに書かない** ── `command` から `keymap` を引く(user が変えたら追従する)。
 */
const COMMAND_ITEMS: readonly {
  /** 押しボタンの口(`data-pkc-action`)。 */
  readonly action: string;
  /** その操作の鍵を引くコマンド id(⚠ `action` とは**別物**)。 */
  readonly command: string;
  readonly label: string;
  /** 説明。⚠ 「元」と「先」の呼び名は**焦点で入れ替わる**ので、関数で受ける。 */
  readonly hint: (from: string, to: string) => string;
  /**
   * 印が 1 つも無いときの断り。`null` = 印を要らない操作。
   *
   * ⚠ **呼び名から機械的に組まない**(2026-08-19)── 1 稿目は
   *   `${label}ものを選んでから` と書いていたので、ゴミ箱だけ
   *   **「ゴミ箱ものを選んでから押してください」**という日本語になっていた
   *   (入れ物の名と、動作の名が混ざる)。文言は**押した場所と対で pin する**
   *   (CLAUDE.md §1)。
   */
  readonly empty: string | null;
}[] = [
  {
    action: 'dual-copy',
    command: 'dual-copy-to-other',
    label: '写す',
    hint: (from, to) => `${from}で選んだものを、${to}のペインへ写します(元は残ります)`,
    empty: '写すものを選んでから押してください',
  },
  {
    action: 'dual-move',
    command: 'dual-move-to-other',
    label: '移す',
    hint: (from, to) => `${from}で選んだものを、${to}のペインへ移します`,
    empty: '移すものを選んでから押してください',
  },
  {
    action: 'dual-rename-begin',
    command: 'dual-rename',
    label: '名前',
    hint: () => '選んだ 1 件の名前を、その場で打ち替えます',
    empty: null,
  },
  {
    action: 'dual-mkdir',
    command: 'dual-new-folder',
    label: 'フォルダ',
    hint: (from) => `${from}のペインが開いている場所に、新しいフォルダを作ります`,
    empty: null,
  },
  {
    action: 'dual-delete',
    command: 'filer-trash',
    label: 'ゴミ箱',
    hint: (from) => `${from}で選んだものを、ゴミ箱へ入れます(あとで戻せます)`,
    empty: 'ゴミ箱へ入れるものを選んでから押してください',
  },
];

const otherSideLabel = (side: DualSide): string =>
  SIDE_LABEL[side === 'left' ? 'right' : 'left'];

/** 1 つのペインの部品(器は 1 度だけ作る)。 */
interface PaneFrame {
  root: HTMLElement;
  tabs: HTMLElement;
  crumbs: HTMLElement;
  table: HTMLElement;
  foot: HTMLElement;
  rows: Map<string, HTMLElement>;
  /**
   * 表の指紋 ── 変わったときだけ組み直す。
   * ⚠ **`null` は「まだ 1 度も描いていない」** ── `''` を初期値にすると、
   *   **空のフォルダ**(行 0 件 = 指紋も `''`)が「変わっていない」と読まれ、
   *   1 度も描かれない(2026-08-18 の着地前 test が実際に突いた)。
   */
  signature: string | null;
  /**
   * 🔴 **日付だけの指紋**(#270)。本体の指紋と**別に**持つ ── 混ぜると
   * 「日付が入っただけで表を建て直す」に戻り、**掴もうとしている手の下で
   * 行が動く**(1 面のファイラと同じ穴。`render/filer.ts` に実測を書いた)。
   */
  dates: string | null;
  /** 印の指紋(内容で見る ── 配列は毎回作り直される)。 */
  marks: string;
  /**
   * 🔴 **いまカーソルが在る行**(2026-08-19)。⚠ 印と**別に持つ** ── 同じ変数に
   * 詰めると、印を塗り直すたびにカーソルまで動く(分けた意味が消える)。
   */
  cursor: string;
  /**
   * 🔴 **いま表に出ている印の数**(着地前レビュー R5)。
   * ⚠ 真ん中の操作の文言もここから読む ── 生の `selection.length` を使うと、
   *   「1 件を…入れます」と書いてあるのに押すと「移すものを選んでください」に
   *   なる(絞り込みで消えた印がそのまま数に入る)。**同じ問いに 3 つ目の口を作らない。**
   */
  shownMarks: number;
}

/**
 * 🔴 **操作行に出す鍵は、割当の表から引く**(2026-08-19。Krusader 方式)。
 *
 * ⚠ 直書きすると、user が設定画面で割当を変えた瞬間に**画面が嘘をつく**
 *   (「F6 移す」と書いてあるのに F6 では動かない)。
 * 🔑 **関数キーを優先**する ── ここは古典の「ファンクションキー行」であって、
 *   `Delete` のような別名まで拾うと帯の意味が変わる。関数キーが 1 つも
 *   割り当てられていなければ、素直に先頭の割当を出す(無い、とは書かない)。
 */
function barKey(id: string, keymap: KeymapStore): string {
  const list = keymap.getBindings()[id] ?? findCommand(id)?.defaults ?? [];
  const fn = list.find((c) => /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(c));
  const pick = fn ?? list[0];
  return pick === undefined ? '' : chordLabel(pick);
}

export class DualFilerRenderer {
  private readonly region: HTMLElement;
  private frame: { panes: Record<DualSide, PaneFrame>; commands: HTMLElement } | null = null;
  private lastFocus: DualSide | null = null;
  private lastCommands = '';
  /** 入力の断面(参照で見る)。⚠ 下の門の材料 ── 増やしたらここにも足す。 */
  private lastDual: AppState['dual'] | null = null;
  private lastMetas: AppState['entryMetas'] | null = null;
  private lastRelations: AppState['relations'] | null = null;
  private lastFilter: string | null = null;
  private lastSort: AppState['entrySort'] | null = null;
  /**
   * 🔴 **向きも門の材料**(2026-08-19、足したその日に test が捕まえた)。
   * ⚠ 入れないと、`▲` を押して state は反転するのに**この面が 1 度も描き直さない**
   *   ── 矢印も行順も古いまま(「押しても何も起きない」に見える)。
   */
  private lastSortDesc: boolean | null = null;
  private lastHits: AppState['searchHits'] = null;

  constructor(
    region: HTMLElement,
    /** ⚠ 差し替えられるようにしておく(test が保存を持たない store を渡す)。 */
    private readonly keymap: KeymapStore = appKeymap,
  ) {
    this.region = region;
  }

  render(state: AppState): void {
    /**
     * 🔴 **入力が 1 つも変わっていないなら描かない**(着地前レビュー R4)。
     *
     * ⚠ `main.ts` は state が動くたび**無条件に** `center.render(state)` を呼ぶので、
     * 門が無いと 2 ペインを開いている間じゅう、**あらゆる state 変化**(別タブの
     * 保存 ack / 検索の着弾 / 一時の知らせ)で `filerRows` を 2 回 ──
     * `resolveCanonicalParents` = 全 relation 走査 ── 回すことになる。
     * 🔑 同じ計算をする `render/filer.ts` は**既にこの門を持っている**
     * (対称の反対側が守られていなかった、が指摘の中身である)。
     * ⚠ `state.dual` は不変更新なので、**参照 1 本**でこの面の state 変化を全部拾える。
     */
    if (
      this.frame !== null &&
      state.dual === this.lastDual &&
      state.entryMetas === this.lastMetas &&
      state.relations === this.lastRelations &&
      state.filterQuery === this.lastFilter &&
      state.entrySort === this.lastSort &&
      state.entrySortDesc === this.lastSortDesc &&
      state.searchHits === this.lastHits
    )
      return;
    this.lastDual = state.dual;
    this.lastMetas = state.entryMetas;
    this.lastRelations = state.relations;
    this.lastFilter = state.filterQuery;
    this.lastSort = state.entrySort;
    this.lastSortDesc = state.entrySortDesc;
    this.lastHits = state.searchHits;
    const frame = this.ensureFrame();
    for (const side of SIDES) {
      const pane = paneOf(state.dual, side);
      const rows = filerRows(paneScope(pane), state.entryMetas, state.relations, {
        filterQuery: state.filterQuery,
        searchHits: state.searchHits,
        sort: state.entrySort,
        sortDesc: state.entrySortDesc,
      });
      this.renderPane(frame.panes[side], side, state, pane, rows);
    }
    /**
     * 🔴 **焦点の側は「移す向き」そのもの**なので、必ず画面に出す
     * (出さないと user は**どちらが元か分からないまま**押すことになる)。
     */
    if (state.dual.focus !== this.lastFocus) {
      this.lastFocus = state.dual.focus;
      for (const side of SIDES) {
        const el = frame.panes[side].root;
        if (side === state.dual.focus) el.setAttribute('data-pkc-focused', '');
        else el.removeAttribute('data-pkc-focused');
      }
    }
    this.renderCommands(frame.commands, frame.panes[state.dual.focus], state);
  }

  private ensureFrame(): NonNullable<DualFilerRenderer['frame']> {
    if (this.frame) return this.frame;
    /**
     * ⚠ **`<h2>` にしない**(2026-08-19 の実測で 上下に 9.13px の UA margin が
     *   入り、面の題名だけが浮いていた)。他の 4 面は `div` で作っている。
     */
    const title = document.createElement('div');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = '2 ペインで整理';
    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'dual-body');
    const left = this.buildPane('left');
    const right = this.buildPane('right');
    /**
     * 🔴 **操作は最下段の全幅・1 行**(2026-08-19 の作り直し。市井の調査)。
     *
     * ⚠ 直す前は**左右ペインの間に縦積み**で、文字数なりの幅だったので
     *   **端が 1 つも揃わず**、狭い版面でも 110.8px を固定で食っていた
     *   (題名は「2026-08-19 フォル…」と切れているのにボタンは 1 文字も削れない)。
     * 🔑 古典 4 実装(Total Commander / Double Commander / FAR / Krusader)は
     *   **例外なく最下段の全幅**に置き、**等分割**する ── 中央に操作を置く実装は
     *   1 つも無かった。⚠ 近代系(Dolphin / Files / Nemo)は F キー行を捨てて
     *   **右クリック**へ寄せたが、PKC3 に右クリックメニューは 1 つも無いので
     *   その道は採れない(捨てた先が無い)。
     */
    body.append(left.root, right.root);
    const commands = document.createElement('div');
    commands.setAttribute('data-pkc-region', 'dual-commands');
    this.region.append(title, body, commands);
    this.frame = { panes: { left, right }, commands };
    return this.frame;
  }

  private buildPane(side: DualSide): PaneFrame {
    const root = document.createElement('section');
    root.setAttribute('data-pkc-region', 'dual-pane');
    root.setAttribute('data-pkc-side', side);
    // 🔑 押した所へ焦点が移る ── 「移す元」を選ぶのに専用のボタンを作らない
    root.setAttribute('data-pkc-action', 'dual-focus');
    root.setAttribute('aria-label', `${SIDE_LABEL[side]}のペイン`);
    /**
     * 🔴 **器そのものを焦点の受け皿にする**(#273。実ブラウザ smoke で判明)。
     *
     * ⚠ 行に焦点を置く作りだけだと、**空のフォルダへ入った瞬間に焦点の置き場が
     *   消える** ── 次の keydown の的が `body` になり、`[data-pkc-region="dual-pane"]`
     *   の親が無いので**この面の鍵が 1 つも当たらなくなる**(入ったら Backspace すら
     *   効かず、マウスに戻るしかない)。
     * ⚠ `-1` にする(Tab 順には入れない)── 行が在るときの入口は行のままにする。
     */
    root.tabIndex = -1;
    /**
     * 🔴 **ペインの地(行の無い所)も落とし先**(#273 段⑤)── そのペインが
     * 「いま開いている場所」へ入れる。⚠ 行き先の lid は `data-pkc-drop-scope` で
     * 渡す(`data-pkc-entry` を持たせると**そのペイン自身が entry**に見える)。
     */
    root.setAttribute('data-pkc-drop', 'pane');

    const tabs = document.createElement('div');
    tabs.setAttribute('data-pkc-region', 'dual-tabs');
    tabs.setAttribute('role', 'tablist');
    const crumbs = document.createElement('nav');
    crumbs.setAttribute('data-pkc-region', 'dual-crumbs');
    crumbs.setAttribute('aria-label', `${SIDE_LABEL[side]}のペインの現在地`);
    const table = document.createElement('div');
    table.setAttribute('data-pkc-region', 'dual-table');
    const foot = document.createElement('div');
    foot.setAttribute('data-pkc-field', 'dual-count');
    root.append(tabs, crumbs, table, foot);
    return {
      root,
      tabs,
      crumbs,
      table,
      foot,
      rows: new Map(),
      signature: null,
      dates: null,
      marks: '',
      cursor: '',
      shownMarks: 0,
    };
  }

  private renderPane(
    frame: PaneFrame,
    side: DualSide,
    state: AppState,
    pane: DualPaneState,
    rows: readonly EntryMeta[],
  ): void {
    this.renderTabs(frame.tabs, side, state, pane);
    this.renderCrumbs(frame.crumbs, side, state, pane);
    /**
     * ⚠ **落とし先の行き先を、いまの場所に追随させる**(#273 段⑤)。
     * `''` = ルート。⚠ 書き忘れると、フォルダの中を開いていても**ルートへ**落ちる。
     */
    frame.root.setAttribute('data-pkc-drop-scope', paneScope(pane) ?? '');
    /**
     * 指紋には**この面が実際に描くもの**だけを入れる(#240 の filer と同じ規律)。
     * ⚠ 逆に描くものを入れ忘れると**古い値が残る** ── 行が出しているのは
     *   `lid` / 題名 / 種別 / 更新日である。
     */
    /**
     * ⚠ 日付は**画面に出る形**(`MM/DD` へ丸めたもの)で入れる ── 生の
     * `updatedAt` を入れると、同じ日の保存(秒だけ違う)で指紋が変わり、
     * 「見た目は同じなのに作り直す」が復活する(`render/filer.ts` の教訓)。
     */
    const year = new Date().getFullYear();
    /**
     * ⚠ **絞り込みの有無も指紋に入れる**(2026-08-19)。⚠ 入れないと、
     * **0 件 → 0 件**(空のフォルダで語を打った / 語を消した)で指紋が動かず、
     * 空の理由の文言が**古いまま残る**(行が 0 件だと指紋は空文字になる)。
     */
    const filtered = normalizeQuery(state.filterQuery) !== '';
    /**
     * ⚠ **打ち替え中の行も指紋に入れる**(#273 段④)── 入れないと、
     * 打ち始め / やめるで行を組み直さないので、**入力欄が出ない / 消えない**。
     */
    const renaming =
      state.dual.renaming !== null && state.dual.renaming.side === side
        ? state.dual.renaming.lid
        : '';
    const signature = [
      filtered ? 'q' : '-',
      // ⚠ 見出しの印が並びと向きで変わる ── 入れないと印が古いまま残る
      `s:${state.entrySort}${state.entrySortDesc ? '-' : '+'}`,
      `r:${renaming}`,
      ...rows.map((m) =>
        [
          m.lid,
          m.title,
          m.archetype,
          // ⚠ **画面に出る形**で入れる(生の値だと、丸めて同じに見える回で作り直す)
          formatBodyChars(m.bodyChars),
        ].join(SEP),
      ),
    ].join(SEP);
    /**
     * 🔴 **日付は本体の指紋に混ぜない**(#270)。混ぜると、保存の刻み
     * (`ENTRY_STAMPED` ── 非同期の ack)が返っただけで表を建て直し、
     * **掴もうとしている手の下で行が消える / 動く**(実測は `render/filer.ts`)。
     * ⚠ ただし「更新」で並べているときは日付が**並びを変えうる**ので、
     *   そのときは本体の指紋に含めて建て直す。
     */
    const byDate = state.entrySort === 'updated';
    const dates = rows.map((m) => `${m.lid}${SEP}${formatListDate(m.updatedAt, year)}`).join(SEP);
    if (signature !== frame.signature || (byDate && dates !== frame.dates)) {
      frame.dates = dates;
      frame.signature = signature;
      frame.marks = '';
      // ⚠ 行の object ごと入れ替わるので、**カーソルの指紋も捨てる** ──
      //   捨てないと「同じ lid だから塗らない」で **枠が消えたまま**になる
      frame.cursor = '';
      this.renderTable(frame, side, rows, filtered, renaming, state.entrySort, state.entrySortDesc);
    } else if (dates !== frame.dates) {
      /**
       * 🔴 **日付だけ差し替える**(#270)── 行の node は作り直さない。
       * ⚠ ここを建て直しに戻すと、掴もうとしている手の下で行が動く。
       */
      frame.dates = dates;
      for (const m of rows) {
        const cell = frame.rows
          .get(m.lid)
          ?.querySelector<HTMLElement>('[data-pkc-field="dual-updated"]');
        if (cell) cell.textContent = formatListDate(m.updatedAt, year);
      }
    }
    const marks = pane.selection.join(' ');
    if (marks !== frame.marks) {
      frame.marks = marks;
      const set = new Set(pane.selection);
      for (const [lid, el] of frame.rows) {
        if (set.has(lid)) el.setAttribute('data-pkc-marked', '');
        else el.removeAttribute('data-pkc-marked');
      }
    }
    /**
     * 🔴 **カーソルは属性の付け替えで塗る**(印と同じ作法 ── 表を組み直さない)。
     * ⚠ 組み直すと、押す寸前の行が作り直されて dead click になる。
     */
    const cursor = pane.cursor ?? '';
    if (cursor !== frame.cursor) {
      const prev = frame.rows.get(frame.cursor);
      if (prev) prev.removeAttribute('data-pkc-cursor');
      frame.cursor = cursor;
      frame.rows.get(cursor)?.setAttribute('data-pkc-cursor', '');
    }
    /**
     * 🔴 **数えるのは「いま表に出ている印」だけ**(#240 の着地前レビュー 2)。
     * ⚠ 素で数えると、画面に印が 1 つも無いのに「3 件を選んでいます」と出る。
     */
    const shown = pane.selection.filter((lid) => frame.rows.has(lid)).length;
    frame.shownMarks = shown;
    /**
     * 🔴 **「全 N 件中 M 件を選択」**(2026-08-19。市井の情報行に合わせた)。
     * ⚠ 直す前は「N 件(M 件を選んでいます)」で、**選んでいないときは件数だけ**
     *   だった。古典は例外なく「選択 / 全体」を対で出す。
     * 🔑 焦点のある側は**そこが「元」である**ことも言う ── 操作行から向きの字を
     *   外した代わりに、ここが受ける。
     */
    const here = side === state.dual.focus ? '(ここが元)' : '';
    const text = shown > 0 ? `${rows.length} 件中 ${shown} 件を選択${here}` : `${rows.length} 件${here}`;
    if (frame.foot.textContent !== text) frame.foot.textContent = text;
  }

  private renderTabs(host: HTMLElement, side: DualSide, state: AppState, pane: DualPaneState): void {
    const names = pane.tabs.map((t) =>
      t.scopeLid === null ? 'ルート' : (state.entryMetas.get(t.scopeLid)?.title ?? '(無題)'),
    );
    const sig = [String(pane.active), ...names].join(SEP);
    if (host.getAttribute('data-pkc-sig') === sig) return;
    host.setAttribute('data-pkc-sig', sig);
    host.textContent = '';
    names.forEach((name, i) => {
      const tab = document.createElement('span');
      tab.setAttribute('data-pkc-region', 'dual-tab');
      const open = document.createElement('button');
      open.type = 'button';
      open.setAttribute('data-pkc-action', 'dual-tab-activate');
      open.setAttribute('data-pkc-side', side);
      open.setAttribute('data-pkc-tab', String(i));
      open.setAttribute('role', 'tab');
      open.setAttribute('aria-selected', i === pane.active ? 'true' : 'false');
      if (i === pane.active) tab.setAttribute('data-pkc-active', '');
      open.textContent = name;
      open.title = `${name} を開きます`;
      tab.append(open);
      /**
       * ⚠ **最後の 1 枚には閉じる口を出さない** ── 押しても何も起きないボタンは
       * 無言の dead click である(規則は `withTabClosed` 側にも在るが、画面に
       * 出さないことで**押せてしまう経路ごと**塞ぐ)。
       */
      if (pane.tabs.length > 1) {
        const close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('data-pkc-action', 'dual-tab-close');
        close.setAttribute('data-pkc-side', side);
        close.setAttribute('data-pkc-tab', String(i));
        close.setAttribute('aria-label', `${name} のタブを閉じる`);
        close.title = 'このタブを閉じます';
        close.textContent = '×';
        tab.append(close);
      }
      host.append(tab);
    });
    /**
     * ⚠ **上限に達したら口を出さない**(着地前レビュー R2)── 押せて、何も起きず、
     * 理由も出ないボタンは無言の dead click である。⚠ 20 行上で「最後の 1 枚には
     * 閉じる口を出さない」を書いておきながら、**足す側が同型のまま残っていた**
     * (CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
     * 🔑 上限そのものはマニュアルで告知済み ── 足りないのは画面での断りだけ。
     */
    if (pane.tabs.length < MAX_TABS) {
      const add = document.createElement('button');
      add.type = 'button';
      add.setAttribute('data-pkc-action', 'dual-tab-add');
      add.setAttribute('data-pkc-side', side);
      add.setAttribute('aria-label', `${SIDE_LABEL[side]}にタブを足す`);
      add.title = 'いまの場所を、もう 1 枚のタブで開きます';
      add.textContent = '+';
      host.append(add);
    } else {
      const full = document.createElement('span');
      full.setAttribute('data-pkc-field', 'dual-tab-full');
      full.textContent = `タブは ${MAX_TABS} 枚までです`;
      host.append(full);
    }
  }

  private renderCrumbs(
    host: HTMLElement,
    side: DualSide,
    state: AppState,
    pane: DualPaneState,
  ): void {
    const scope = paneScope(pane);
    const chain =
      scope === null
        ? []
        : [
            ...getAncestorFolders(scope, state.entryMetas, state.relations).reverse(),
            state.entryMetas.get(scope),
          ].filter((m): m is EntryMeta => m !== undefined);
    const sig = chain.map((m) => `${m.lid}${SEP}${m.title}`).join(SEP);
    if (host.getAttribute('data-pkc-sig') === sig) return;
    host.setAttribute('data-pkc-sig', sig);
    host.textContent = '';
    const crumb = (lid: string | null, label: string): HTMLElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', 'dual-crumb');
      b.setAttribute('data-pkc-side', side);
      if (lid !== null) b.setAttribute('data-pkc-entry', lid);
      b.textContent = label;
      b.title = `${label} へ移ります`;
      return b;
    };
    host.append(crumb(null, 'ルート'));
    for (const m of chain) host.append(crumb(m.lid, m.title));
  }

  private renderTable(
    frame: PaneFrame,
    side: DualSide,
    rows: readonly EntryMeta[],
    filtered: boolean,
    /** 打ち替え中の行(`''` = 無し)。⚠ その行だけ入力欄になる。 */
    renaming: string,
    /** いまの並び ── 見出しの印に出す。 */
    sort: AppState['entrySort'],
    /** いまの向き ── ▲▼ の向きに出す。 */
    sortDesc: boolean,
  ): void {
    const year = new Date().getFullYear();
    frame.rows.clear();
    frame.table.textContent = '';
    if (rows.length === 0) {
      /**
       * 🔴 **「空」と「絞り込みで消えた」を分ける**(2026-08-19、リリース前監査)。
       * ⚠ 一覧(`filer.ts`)とアプリ(`launcher.ts`)は分けているのに、**この 3 面目だけ
       * 落ちていた** ── 左の列の探す欄はこの面と同時に画面に在り、しかも面を
       * 切り替えても語は消えないので、**語を打ったまま 2 ペインを開くと
       * 両側が「ここには何もありません」**になる。
       */
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'dual-empty');
      empty.textContent = filtered
        ? '探している語に当たるものが、ここにはありません'
        : 'ここには何もありません';
      frame.table.append(empty);
      return;
    }
    const table = document.createElement('table');
    /**
     * 🔴 **列見出しを持つ**(2026-08-19 の作り直し)。
     *
     * ⚠ 直す前は `<thead>` が 1 つも無く、**並べ替えができない / 列の意味が
     *   読めない**状態だった。⚠ しかも**左の「フォルダ」タブは既に見出しを持って
     *   いる**(`filer.ts`)ので、同じ仕事をする 2 面で作法が割れていた。
     * 🔑 古典 4 実装とも見出しを持ち、**押すと並べ替え**る。
     * ⚠ 並び順は**左の列と同じ 1 本**(`state.entrySort`)── 面ごとに別の並びを
     *   持たせない(§7)。だから左の探す帯の `<select>` と**必ず一致**する。
     */
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const col of COLUMNS) {
      const th = document.createElement('th');
      th.setAttribute('data-pkc-field', `col-${col.key}`);
      if (col.sort !== null) {
        th.setAttribute('data-pkc-action', 'dual-sort');
        th.setAttribute('data-pkc-sort', col.sort);
        th.setAttribute('role', 'button');
        th.tabIndex = -1;
        const active = sort === col.sort;
        if (active) th.setAttribute('data-pkc-sorted', sortDesc ? 'desc' : 'asc');
        th.title = active
          ? `${col.label} の${sortDesc ? '大きい' : '小さい'}順です(もう一度押すと逆になります)`
          : `${col.label} で並べ替えます`;
      }
      th.textContent =
        col.label + (sort === col.sort ? SORT_MARK[sortDesc ? 'desc' : 'asc'] : '');
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);
    const tbody = document.createElement('tbody');
    for (const m of rows) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-pkc-entry', m.lid);
      tr.setAttribute('data-pkc-side', side);
      tr.setAttribute('data-pkc-action', 'dual-row');
      /**
       * ⚠ **種別を行そのものに出す**(左の列 `render/filer.ts` と同じ)── これが
       *   無いと、外から「ノートの行」を名指しできるのが `data-pkc-drop` の
       *   **有無**だけになり、落とし先の印を消す変異で**狙う行が入れ替わる**
       *   (検査が別のものを見に行く。指紋には元から種別が入っている)。
       */
      tr.setAttribute('data-pkc-archetype', m.archetype);
      tr.tabIndex = -1;
      /**
       * 🔴 **掴んで運べる**(#273 段⑤。左の列と同じ仕組み ── `PKC_DRAG`)。
       * ⚠ `draggable` は**行そのもの**に置く(セルに置くと掴む場所が読めない)。
       */
      tr.setAttribute('draggable', 'true');
      // ⚠ フォルダは**落とし先**にもなる(その中へ入れる)
      if (m.archetype === 'folder') tr.setAttribute('data-pkc-drop', 'folder');
      const name = document.createElement('td');
      if (m.lid === renaming) {
        /**
         * 🔴 **その場で名前を打ち替える**(#273 段④。OS のファイラの F2)。
         * ⚠ 行そのものの押下(`dual-row`)へ**伝えない** ── 打っている最中に
         *   クリックが行の選択として拾われると、入力が飛ぶ。
         */
        const input = document.createElement('input');
        input.type = 'text';
        input.value = m.title;
        input.setAttribute('data-pkc-field', 'dual-rename');
        input.setAttribute('data-pkc-entry', m.lid);
        input.setAttribute('aria-label', '新しい名前');
        name.append(iconSpan(ARCHETYPE_ICONS[m.archetype] ?? 'page'), input);
      } else {
        name.append(
          iconSpan(ARCHETYPE_ICONS[m.archetype] ?? 'page'),
          document.createTextNode(m.title),
        );
      }
      /**
       * 🔴 **種類の列は持たない**(2026-08-19 の作り直し)。⚠ 直す前は
       *   「ノート」「フォルダ」を**文字の列**で出しており、`table-layout: fixed` で
       *   **名前と同じ幅**(実測 172.1 = 172.1)を食っていた ── 狭い版面では
       *   題名だけが切れ、3 文字の「ノート」に 94.3px が割かれていた。
       * 🔑 種類は**行頭の図案**が示す ── 左の「フォルダ」タブが P9 段③ で
       *   既に決めた形であり、近代系のファイラも拡張子列を畳んでいる。
       */
      /**
       * 🔴 **大きさの列**(2026-08-19)。⚠ **フォルダは `—`** ── フォルダにも
       *   本文は在るが、数を出すと「中に何文字入っているか」と読まれる
       *   (古典が `<DIR>` と書くのは、まさにその誤読を止めるためである)。
       */
      const size = document.createElement('td');
      size.setAttribute('data-pkc-field', 'dual-size');
      size.textContent = m.archetype === 'folder' ? '—' : formatBodyChars(m.bodyChars);
      const date = document.createElement('td');
      // ⚠ 目印を付ける ── 日付だけの変化はここを差し替えて済ませる(#270)
      date.setAttribute('data-pkc-field', 'dual-updated');
      date.textContent = formatListDate(m.updatedAt, year);
      tr.append(name, size, date);
      tbody.append(tr);
      frame.rows.set(m.lid, tr);
    }
    table.append(tbody);
    frame.table.append(table);
    /**
     * ⚠ **描いた直後に焦点と全選択**(#273 段④)── これが無いと、押した直後に
     * user が自分でクリックし直す羽目になる(OS のファイラは打てる状態で出る)。
     */
    if (renaming !== '') {
      const input = frame.table.querySelector<HTMLInputElement>(
        '[data-pkc-field="dual-rename"]',
      );
      input?.focus();
      input?.select();
    }
  }

  /**
   * 🔴 **操作行は「キー + 語」で、常に同じ並び**(2026-08-19 の作り直し)。
   *
   * ⚠ 直す前は「→ 右へ移す」のように**向きを文言に埋めて**いたので、
   *   焦点が変わるたびに字が入れ替わり、幅も変わって端が揃わなかった。
   * 🔑 市井は**キーと語を連結**して出す(Krusader は実際の割当から生成し、
   *   **バー自体がチートシート**になっている ── user が鍵を変えたら表示も追従する)。
   *   FAR / TC / DC の 3 実装で **F5 写す / F6 移す / F7 作る / F8 消す** が一致。
   * 🔑 **向きは操作行ではなく、焦点のあるペインが言う**(そちらが「元」である)。
   */
  private renderCommands(host: HTMLElement, frame: PaneFrame, state: AppState): void {
    const from = state.dual.focus;
    // ⚠ 数えるのは**いま表に出ている印**だけ(件数の行・移す対象と同じ規則)
    const count = frame.shownMarks;
    /**
     * ⚠ **鍵の字も指紋に入れる**(2026-08-19)── 入れないと、設定画面で割当を
     *   変えて戻ってきたときに**古い鍵が出たまま**になる(画面が嘘をつく)。
     */
    const keys = COMMAND_ITEMS.map((it) => barKey(it.command, this.keymap));
    const sig = [from, String(count), ...keys].join(SEP);
    if (sig === this.lastCommands) return;
    this.lastCommands = sig;
    const to = otherSideLabel(from);
    host.textContent = '';
    COMMAND_ITEMS.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', it.action);
      b.setAttribute('data-pkc-field', it.action);
      /**
       * ⚠ **キーと語は別の要素**にする ── CSS でキーだけ弱めるため。
       *   `textContent` で 1 本にすると、字の重みを分けられない。
       */
      const key = document.createElement('span');
      key.setAttribute('data-pkc-field', 'cmd-key');
      key.textContent = keys[i] ?? '';
      const label = document.createElement('span');
      label.setAttribute('data-pkc-field', 'cmd-label');
      label.textContent = it.label;
      b.append(key, label);
      b.title =
        it.empty !== null && count === 0
          ? it.empty
          : `${it.hint(SIDE_LABEL[from], to)}${it.empty !== null ? `(いま ${count} 件)` : ''}`;
      host.append(b);
    });
  }
}
