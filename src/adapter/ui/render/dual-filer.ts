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
import { archetypeLabel } from './sidebar';
import { formatListDate } from '@features/datetime/stored-date';
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
  /** 印の指紋(内容で見る ── 配列は毎回作り直される)。 */
  marks: string;
  /**
   * 🔴 **いま表に出ている印の数**(着地前レビュー R5)。
   * ⚠ 真ん中の操作の文言もここから読む ── 生の `selection.length` を使うと、
   *   「1 件を…入れます」と書いてあるのに押すと「移すものを選んでください」に
   *   なる(絞り込みで消えた印がそのまま数に入る)。**同じ問いに 3 つ目の口を作らない。**
   */
  shownMarks: number;
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
  private lastHits: AppState['searchHits'] = null;

  constructor(region: HTMLElement) {
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
      state.searchHits === this.lastHits
    )
      return;
    this.lastDual = state.dual;
    this.lastMetas = state.entryMetas;
    this.lastRelations = state.relations;
    this.lastFilter = state.filterQuery;
    this.lastSort = state.entrySort;
    this.lastHits = state.searchHits;
    const frame = this.ensureFrame();
    for (const side of SIDES) {
      const pane = paneOf(state.dual, side);
      const rows = filerRows(paneScope(pane), state.entryMetas, state.relations, {
        filterQuery: state.filterQuery,
        searchHits: state.searchHits,
        sort: state.entrySort,
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
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = '2 ペインで整理';
    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'dual-body');
    const left = this.buildPane('left');
    const commands = document.createElement('div');
    commands.setAttribute('data-pkc-region', 'dual-commands');
    const right = this.buildPane('right');
    body.append(left.root, commands, right.root);
    this.region.append(title, body);
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
      marks: '',
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
    const signature = [
      filtered ? 'q' : '-',
      ...rows.map((m) =>
        [m.lid, m.title, m.archetype, formatListDate(m.updatedAt, year)].join(SEP),
      ),
    ].join(SEP);
    if (signature !== frame.signature) {
      frame.signature = signature;
      frame.marks = '';
      this.renderTable(frame, side, rows, filtered);
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
     * 🔴 **数えるのは「いま表に出ている印」だけ**(#240 の着地前レビュー 2)。
     * ⚠ 素で数えると、画面に印が 1 つも無いのに「3 件を選んでいます」と出る。
     */
    const shown = pane.selection.filter((lid) => frame.rows.has(lid)).length;
    frame.shownMarks = shown;
    const text = shown > 0 ? `${rows.length} 件(${shown} 件を選んでいます)` : `${rows.length} 件`;
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
    const tbody = document.createElement('tbody');
    for (const m of rows) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-pkc-entry', m.lid);
      tr.setAttribute('data-pkc-side', side);
      tr.setAttribute('data-pkc-action', 'dual-row');
      tr.tabIndex = -1;
      const name = document.createElement('td');
      name.append(
        iconSpan(ARCHETYPE_ICONS[m.archetype] ?? 'page'),
        document.createTextNode(m.title),
      );
      const kind = document.createElement('td');
      kind.textContent = archetypeLabel(m.archetype);
      const date = document.createElement('td');
      date.textContent = formatListDate(m.updatedAt, year);
      tr.append(name, kind, date);
      tbody.append(tr);
      frame.rows.set(m.lid, tr);
    }
    table.append(tbody);
    frame.table.append(table);
  }

  /**
   * 🔴 **真ん中の操作は「向き」を字で言う**(user 指示 2026-08-03「同じものが常に
   * 同じ場所にある」)。⚠ 「移す」だけでは、どちらへ動くのか画面から読めない ──
   * 焦点のある側が**元**である。
   */
  private renderCommands(host: HTMLElement, frame: PaneFrame, state: AppState): void {
    const from = state.dual.focus;
    // ⚠ 数えるのは**いま表に出ている印**だけ(件数の行・移す対象と同じ規則)
    const count = frame.shownMarks;
    const label = from === 'left' ? '→ 右へ移す' : '← 左へ移す';
    const sig = `${label}${SEP}${count}`;
    if (sig === this.lastCommands) return;
    this.lastCommands = sig;
    host.textContent = '';
    const move = document.createElement('button');
    move.type = 'button';
    move.setAttribute('data-pkc-action', 'dual-move');
    move.setAttribute('data-pkc-field', 'dual-move');
    move.textContent = label;
    move.title =
      count > 0
        ? `${SIDE_LABEL[from]}で選んだ ${count} 件を、反対側の場所へ入れます`
        : '移すものを選んでから押してください';
    host.append(move);
    const hint = document.createElement('p');
    hint.setAttribute('data-pkc-field', 'dual-hint');
    hint.textContent = `元は${SIDE_LABEL[from]}のペインです`;
    host.append(hint);
  }
}
