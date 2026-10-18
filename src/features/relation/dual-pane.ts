/**
 * 🔴 **2 ペインタブファイラの持ち物**(#241 段⑥。user 指示 2026-08-17)。
 *
 * > 「アプリに 2 ペインタブファイラ(PKC 内の整理高度化のため)を組み込みで提供すること」
 *
 * ## なぜ state を別に持つか
 *
 * `AppState` の `scopeLid` / `selection` / `selectionAnchor` は **1 組しか無い**。
 * 2 ペインはその名のとおり「別の場所を 2 つ同時に見る」面なので、そのままでは
 * **左右が同じ場所を指す**。かといって既存の 1 組を「いま焦点のあるペインのもの」に
 * すると、左の列・かんばん・カレンダー・集計まで巻き込む大改造になる。
 *
 * 🔑 だから **この面だけが持つ state** を足す。⚠ CLAUDE.md §7「同じ問いに答える口を
 * 2 つ作らない」に一見触れるが、**規則(`filerRows`)は 1 本のまま**で、増えるのは
 * *state* だけである ── ファイラの窓を 2 枚開くのと同じで、「どのフォルダを見て
 * いるか」は窓ごとに違って当然である。
 *
 * ⚠ **pure module**。browser API も dispatch も触らない。
 */

/**
 * 1 枚のタブ = 1 つの場所。⚠ `null` はルート。
 *
 * 🔴 **行った先の履歴もタブが持つ**(#273 残件)。⚠ **ペインではなくタブ**である ──
 * ペインに持たせると、タブを切り替えてから「戻る」を押したときに
 * **別のタブで見ていた場所へ飛ぶ**(user は「このタブの 1 つ前」を期待している)。
 * 🔑 ブラウザのタブと同じ意味論にする、が判断の根拠である。
 */
export interface DualTab {
  readonly scopeLid: string | null;
  /** 手前に見ていた場所(新しいものが末尾)。 */
  readonly past: readonly (string | null)[];
  /** 「戻る」で退けた場所(次に「進む」で戻ってくるものが末尾)。 */
  readonly future: readonly (string | null)[];
  /**
   * 🔴 **裏に回ったタブが憶えている選び**(台帳 #1852 N1 / 依頼 97-1 B。Gemini 回答 = 推薦どおり)。
   * ⚠ **開いているタブは持たない**(選びはペインの `selection` / `anchor` / `cursor` が持つ)── 離れるときにここへ移し、
   *   戻ったときにペインへ返して消す。ここが二重の持ち主になると、どちらが新しいか読めない。
   * ⚠ 空のときは**欄ごと置かない**(選びを持たないタブの形を変えない)。
   */
  readonly selection?: readonly string[];
  readonly anchor?: string | null;
  readonly cursor?: string | null;
}

/**
 * 1 枚のタブが憶える履歴の上限。
 * ⚠ 上限は**手違いの検出**ではなく**常駐メモリ**のためである(不可侵指示
 * 「効くのは定常」)── フォルダを往復するだけで際限なく伸びる配列を作らない。
 */
export const MAX_HISTORY = 50;

/**
 * 🔴 **下見に載せる文字数の上限**(#273 残件)。
 *
 * ⚠ **読んだ側で切る**(state に入る前に)── 切らずに持つと、10 万字のノートに
 *   カーソルを合わせただけで**その 10 万字が常駐する**(不可侵指示「効くのは定常」)。
 * ⚠ 下見は「これで合っているか」を見るためのもので、読むためのものではない。
 */
export const PREVIEW_CHARS = 2000;

/** 下見に載せる分だけ切る。⚠ 切ったことが分かる形にする(黙って途中で終わらせない)。 */
export function clipPreview(body: string): string {
  return body.length <= PREVIEW_CHARS ? body : `${body.slice(0, PREVIEW_CHARS)}…`;
}

/** 場所を 1 つ足す(古いほうから捨てる)。 */
const pushHistory = (
  list: readonly (string | null)[],
  lid: string | null,
): readonly (string | null)[] => [...list, lid].slice(-MAX_HISTORY);

/** タブを 1 枚新しく作る(履歴は持たない ── そのタブはまだどこへも行っていない)。 */
const freshTab = (scopeLid: string | null): DualTab => ({ scopeLid, past: [], future: [] });

/** 開いているタブが離れるとき、ペインの選びをそのタブへ憶えさせる(空なら欄を置かない)。 */
const stashSelection = (tab: DualTab, pane: DualPaneState): DualTab => {
  // 前の控えは捨てて、いまの選びで置き直す(欄を持たない形に戻してから足す)
  const rest: DualTab = { scopeLid: tab.scopeLid, past: tab.past, future: tab.future };
  if (pane.selection.length === 0 && pane.cursor === null) return rest;
  return { ...rest, selection: pane.selection, anchor: pane.anchor, cursor: pane.cursor };
};

/** 開くタブが憶えていた選びを返し、タブからは消す(開いているタブは持たない)。 */
const takeSelection = (
  tab: DualTab,
): { tab: DualTab; selection: readonly string[]; anchor: string | null; cursor: string | null } => {
  const rest: DualTab = { scopeLid: tab.scopeLid, past: tab.past, future: tab.future };
  return { tab: rest, selection: tab.selection ?? [], anchor: tab.anchor ?? null, cursor: tab.cursor ?? null };
};

/** 片側のペイン。タブを複数持ち、そのうち 1 枚が開いている。 */
export interface DualPaneState {
  readonly tabs: readonly DualTab[];
  /** 開いているタブの添字。⚠ 常に `tabs` の範囲内(この module が保つ)。 */
  readonly active: number;
  /** 印を付けたもの。⚠ **開いているノート(`selectedLid`)とは別**(#240 段②と同じ意味論)。 */
  readonly selection: readonly string[];
  /** 範囲選択の起点。 */
  readonly anchor: string | null;
  /**
   * 🔴 **カーソル(いま指している 1 行)**(2026-08-19 の作り直し。設計 doc §3 行 H)。
   *
   * ⚠ **印(`selection`)とは別物である。** 直す前は `↑↓` が印ごと動かしていたので、
   *   「見て回る」ことと「選ぶ」ことが同じ操作になっていた ── 古典 4 実装
   *   (Total Commander / Double Commander / FAR / Krusader)は例外なく分けており、
   *   **カーソルで見て回り、`Space` で印を付ける**。
   * 🔑 **印が 1 つも無いときは、カーソルの行が操作の相手になる**
   *   (`operationTargets`)── これが無いと、カーソルだけ動かして F6 を押した user は
   *   「移すものを選んでください」と断られ続ける(= カーソルが飾りになる)。
   * ⚠ 場所が変わったら外す(印・起点と同じ規則)。
   */
  readonly cursor: string | null;
  /**
   * 🔴 **このペインだけの絞り込み**(#273 残件)。`''` = 絞っていない。
   *
   * ⚠ 直す前は器ぜんぶに 1 本(`state.filterQuery`)だったので、**左右で別の絞りが
   *   できなかった** ── 2 ペインは「別の場所を 2 つ同時に見る」面なのに、
   *   探すときだけ 1 つに戻っていた。
   * 🔑 **打ってある側だけがこの語で絞る。** 空のペインはこれまでどおり
   *   器の絞り込みに従う(挙動を黙って変えない)。
   * ⚠ **題名だけで絞る**(本文の全文検索は使わない)── `searchHits` は
   *   **器の語で引いた結果**なので、別の語と混ぜると
   *   「打った語に当たっていないものが出る」という読めない形になる。
   */
  readonly filter: string;
}

export type DualSide = 'left' | 'right';

export interface DualState {
  readonly left: DualPaneState;
  readonly right: DualPaneState;
  /** いま操作している側。⚠ 「移す」の向き(移す元)を決めるのはこれ。 */
  readonly focus: DualSide;
  /**
   * 🔴 **いま名前を打ち替えている行**(#273 段④)。`null` = 誰も打っていない。
   *
   * ⚠ **state に持つ**(DOM を直に差し替えない)── この面は state が変わるたびに
   * 行を組み直すので、DOM 側で `<input>` に挿げ替えても**次の描画で消える**
   * (打っている最中に別タブの保存が届くだけで入力が飛ぶ)。
   */
  readonly renaming: { readonly side: DualSide; readonly lid: string } | null;
  /**
   * 🔴 **下見を出すか**(#273 残件)。⚠ 既定は **off** ── 下見は**本文を読む**ので、
   *   出しっぱなしにすると行を送るたびに storage を叩く。
   * 🔑 憶えるのは端末側(`DualPrefsStore`)。ここは**いま効いている値**である。
   */
  readonly previewOn: boolean;
  /**
   * いま下見に映しているもの。`null` = まだ読めていない / 相手がいない。
   * ⚠ **lid を必ず持つ** ── 持たないと、送った先の本文が**前の行のまま**出ていても
   *   見分けられない(読みは非同期なので、追い越しは必ず起きる)。
   */
  readonly preview: { readonly lid: string; readonly body: string } | null;
}

/** ⚠ タブは**必ず 1 枚以上**(0 枚のペインは「場所が無い」= 何も描けない)。 */
export const MIN_TABS = 1;
/**
 * 1 ペインが持てるタブの上限。
 * ⚠ 上限を置くのは**手違いの検出**であって、user の動線を縛るためではない
 * (押し続けて 100 枚作られると、帯が版面を食い尽くす)。
 */
export const MAX_TABS = 12;

const emptyPane = (): DualPaneState => ({
  tabs: [freshTab(null)],
  active: 0,
  selection: [],
  anchor: null,
  cursor: null,
  filter: '',
});

/** 起動時の姿 ── 左右ともルートを 1 枚ずつ、焦点は左。 */
export const initialDual: DualState = {
  left: emptyPane(),
  right: emptyPane(),
  focus: 'left',
  renaming: null,
  previewOn: false,
  preview: null,
};

/** 開いているタブの場所。⚠ 添字が壊れていてもルートに落ちる(描けない状態を作らない)。 */
export function paneScope(pane: DualPaneState): string | null {
  return pane.tabs[pane.active]?.scopeLid ?? null;
}

export const otherSide = (side: DualSide): DualSide => (side === 'left' ? 'right' : 'left');

/** 片側だけ差し替える(`DualState` の書き換えを 1 か所に寄せる)。 */
export function withPane(
  state: DualState,
  side: DualSide,
  next: DualPaneState,
): DualState {
  return side === 'left' ? { ...state, left: next } : { ...state, right: next };
}

export const paneOf = (state: DualState, side: DualSide): DualPaneState =>
  side === 'left' ? state.left : state.right;

/**
 * 🔴 **そのペインの行を引くときの絞り込み条件**(#273 残件)。**規則はここ 1 本**。
 *
 * ⚠ 描く側と**範囲選択**(`Shift`)は同じ並びを見なければならない ── 別々に組むと
 *   「目で見た範囲と選ばれる範囲が違う」という、いちばん気づけない食い違いになる
 *   (`filer-list.ts` の冒頭がまさにこれを戒めている)。
 * 🔑 **ペインに打ってあればそれだけで絞る。** 空なら器の絞り込みに従う
 *   (これまでの挙動を黙って変えない)。
 * ⚠ ペインの語では **`searchHits` を渡さない** ── あれは**器の語で引いた結果**で
 *   あって、別の語に付けると「打った語に当たっていないものが出る」ことになる。
 */
export function paneFilterOptions(
  pane: DualPaneState,
  appQuery: string,
  searchHits: ReadonlySet<string> | null,
): { filterQuery: string; searchHits: ReadonlySet<string> | null } {
  return pane.filter !== ''
    ? { filterQuery: pane.filter, searchHits: null }
    : { filterQuery: appQuery, searchHits };
}

/**
 * 開いているタブの場所を変える(= そのペインだけ移動する)。
 * ⚠ **印は外す** ── 場所が変われば、そこに見えていないものが選ばれたままになる
 * (#240 の着地前レビュー 2 と同じ理由。起点も一緒に外す)。
 */
export function withScope(pane: DualPaneState, lid: string | null): DualPaneState {
  const from = paneScope(pane);
  if (from === lid) return pane;
  /**
   * 🔴 **手前の場所を憶える**(#273 残件)。⚠ **「進む」は捨てる** ── 戻ってから
   *   別の所へ入ったら、退けてあった枝はもう辿れない(ブラウザと同じ意味論)。
   */
  const tabs = pane.tabs.map((t, i) =>
    i === pane.active ? { scopeLid: lid, past: pushHistory(t.past, from), future: [] } : t,
  );
  return { ...pane, tabs, selection: [], anchor: null, cursor: null };
}

/** このペインだけの絞り込みを差し替える。⚠ **印は外す**(見えていないものが選ばれたままになる)。 */
export function withFilter(pane: DualPaneState, filter: string): DualPaneState {
  if (pane.filter === filter) return pane;
  return { ...pane, filter, selection: [], anchor: null, cursor: null };
}

/** 開いているタブ。⚠ 添字が壊れていても 1 枚目に落ちる(描けない状態を作らない)。 */
const activeTab = (pane: DualPaneState): DualTab => pane.tabs[pane.active] ?? freshTab(null);

export const canGoBack = (pane: DualPaneState): boolean => activeTab(pane).past.length > 0;
export const canGoForward = (pane: DualPaneState): boolean => activeTab(pane).future.length > 0;

/**
 * 🔴 **1 つ前の場所へ戻る / 進む**(#273 残件)。
 *
 * ⚠ **`withScope` を通さない** ── 通すと「戻る」自体が履歴に積まれ、
 *   戻るたびに枝が伸びて**二度と抜けられなくなる**。
 * ⚠ 印・起点・カーソルは `withScope` と**同じ規則**で外す(場所が変われば
 *   そこに見えていないものが選ばれたままになる)。
 */
function withStep(pane: DualPaneState, dir: 'back' | 'forward'): DualPaneState {
  const cur = activeTab(pane);
  const from = dir === 'back' ? cur.past : cur.future;
  if (from.length === 0) return pane;
  const to = from[from.length - 1]!;
  const rest = from.slice(0, -1);
  const keep = pushHistory(dir === 'back' ? cur.future : cur.past, cur.scopeLid);
  const next: DualTab =
    dir === 'back'
      ? { scopeLid: to, past: rest, future: keep }
      : { scopeLid: to, past: keep, future: rest };
  const tabs = pane.tabs.map((t, i) => (i === pane.active ? next : t));
  return { ...pane, tabs, selection: [], anchor: null, cursor: null };
}

export const withBack = (pane: DualPaneState): DualPaneState => withStep(pane, 'back');
export const withForward = (pane: DualPaneState): DualPaneState => withStep(pane, 'forward');

/**
 * 添字が使えるか。
 * 🔴 **`Number.isInteger` まで見る**(着地前レビュー M4)。⚠ `NaN` は `< 0` も
 * `>= n` も **false** なので、素の範囲比較を**素通りする** ── `active: NaN` に
 * なると `paneScope` が `?? null` でルートへ落ち、この module が自分で戒めている
 * 「勝手に一番上へ戻った」がそのまま起きる。
 * ⚠ 上流(`binder` の `dualTabIndex`)にも同じ門が在るが、**上流 1 行だけが
 *   守っている形**にすると、その 1 行を消す変異が誰にも殺されない。
 */
export const isTabIndex = (pane: DualPaneState, index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < pane.tabs.length;

/** タブを 1 枚足す(いまの場所の隣に、いまの場所を複製して開く)。 */
export function withTabAdded(pane: DualPaneState): DualPaneState {
  if (pane.tabs.length >= MAX_TABS) return pane;
  const at = pane.active + 1;
  // ⚠ **新しいタブは履歴を持たない** ── 複製した瞬間に「戻る」が押せると、
  //   user は「まだどこへも行っていないのに戻れる」を見ることになる
  // 🔴 離れるタブは選びを憶える(依頼 97-1 B)。新しいタブは選びを持たない
  const tabs = [
    ...pane.tabs.slice(0, pane.active),
    stashSelection(activeTab(pane), pane),
    freshTab(paneScope(pane)),
    ...pane.tabs.slice(at),
  ];
  return { ...pane, tabs, active: at, selection: [], anchor: null };
}

/**
 * タブを 1 枚閉じる。
 * ⚠ **最後の 1 枚は閉じられない**(場所が無いペインは描けない)。
 * ⚠ 閉じたあとの `active` は**範囲内へ丸める** ── 添字が外れると `paneScope` が
 *   ルートに落ちて「勝手に一番上へ戻った」ように見える。
 */
export function withTabClosed(pane: DualPaneState, index: number): DualPaneState {
  if (pane.tabs.length <= MIN_TABS) return pane;
  if (!isTabIndex(pane, index)) return pane;
  const tabs = pane.tabs.filter((_, i) => i !== index);
  const active = pane.active > index ? pane.active - 1 : Math.min(pane.active, tabs.length - 1);
  /**
   * 🔴 **開いていないタブを閉じても、いまの選びは外れない**(依頼 97-1 B)。⚠ 直す前は何を閉じても選びが外れた。
   * 開いているタブを閉じたときだけ、次に開くタブが憶えていた選びへ替わる。
   */
  if (index !== pane.active) return { ...pane, tabs, active };
  const next = takeSelection(tabs[active]!);
  return {
    ...pane,
    tabs: tabs.map((t, i) => (i === active ? next.tab : t)),
    active,
    selection: next.selection,
    anchor: next.anchor,
    cursor: next.cursor,
  };
}

/** 別のタブへ移る。⚠ 範囲外は無視(state を壊さない)。 */
export function withTabActive(pane: DualPaneState, index: number): DualPaneState {
  if (!isTabIndex(pane, index) || index === pane.active) return pane;
  /**
   * 🔴 **タブごとに選びを憶える**(台帳 #1852 N1 / 依頼 97-1 B。Gemini 回答 = 推薦どおり)。
   * ⚠ 直す前は切り替えるたびに選びが全部外れていた(マニュアルは「選んでいたものも、そのタブのものに戻ります」と書いていた)。
   */
  const next = takeSelection(pane.tabs[index]!);
  const tabs = pane.tabs.map((t, i) =>
    i === pane.active ? stashSelection(t, pane) : i === index ? next.tab : t,
  );
  return {
    ...pane,
    tabs,
    active: index,
    selection: next.selection,
    anchor: next.anchor,
    cursor: next.cursor,
  };
}

/**
 * 印の付け方。⚠ 規則は **#240 の左の列と同じ**にする ──
 * `set` = 1 件だけ / `toggle` = 足す・外す / `range` は呼び側が並びを解いて渡す。
 */
export function withSelection(
  pane: DualPaneState,
  selection: readonly string[],
  anchor: string | null,
  /**
   * カーソルの行き先。⚠ **省略可にしない** ── 押した行にカーソルが来ない経路が
   * 1 つでも在ると、そこだけ「押したのに枠が動かない」になる(印は動くので、
   * 症状は「カーソルが遅れて付いてくる」という読みにくい形で出る)。
   */
  cursor: string | null,
): DualPaneState {
  return { ...pane, selection: [...selection], anchor, cursor };
}

/** カーソルだけを動かす(印には触らない ── `↑↓` の実体)。 */
export function withCursor(pane: DualPaneState, lid: string | null): DualPaneState {
  return pane.cursor === lid ? pane : { ...pane, cursor: lid };
}

/**
 * 🔴 **消えた lid を、印からも現在地からも落とす**(#241 段⑥)。
 *
 * ⚠ 印に残ると「N 件を移す」が**実在しないものを数える**。
 * ⚠ 現在地(タブの行き先)に残ると、消えたフォルダの中身として**空の表**が
 *   出続ける ── しかもそこで作ると、消えた親の子として生まれる
 *   (`SYS_BOOTED` の `keepScope` / 削除の `scopeLid` と**同じ規則**である)。
 * 🔑 だから **1 本の関数**にする ── 印だけ落として現在地を素通りさせると、
 *   同じ「消えたものを指したまま」が片側にだけ残る。
 *
 * @param alive その lid がいま実在するか(`null` = ルートは常に生きている)
 */
export function pruneDual(
  state: DualState,
  alive: (lid: string) => boolean,
  /**
   * 🔴 **見ていたフォルダが消えたとき、行き先にする「まだ残っている親」**(台帳 #1852 G1 / 依頼 228)。
   * ⚠ 直す前は消えたら一律ルート(いちばん上の階層)へ飛び、飛んだことも言わなかった。省略 = 従来どおりルート。
   * 返すのは**生きている**祖先だけ(死んだ lid や `null` = ルート)。履歴 / 裏のタブの行き先は従来どおり落とす。
   */
  fallbackOf?: (lid: string) => string | null,
): DualState {
  /**
   * 🔴 **履歴からも消えた場所を落とす**(#273 残件)。⚠ 残すと「戻る」が
   *   **もう無いフォルダ**へ入ろうとする ── `DUAL_SET_SCOPE` は実在しない lid を
   *   はじくので、症状は「押しても何も起きない」という無言の dead click になる。
   */
  const pruneList = (
    list: readonly (string | null)[],
  ): readonly (string | null)[] => list.filter((lid) => lid === null || alive(lid));

  const prune = (p: DualPaneState): DualPaneState => {
    // 🔴 裏のタブが憶えている選びも、消えた lid を落とす(戻ったときに実在しない物を数えない)
    const staleSaved = (t: DualTab): boolean =>
      (t.selection?.some((l) => !alive(l)) ?? false) ||
      (t.anchor != null && !alive(t.anchor)) ||
      (t.cursor != null && !alive(t.cursor));
    const dead = p.tabs.some(
      (t) =>
        (t.scopeLid !== null && !alive(t.scopeLid)) ||
        pruneList(t.past).length !== t.past.length ||
        pruneList(t.future).length !== t.future.length ||
        staleSaved(t),
    );
    /**
     * 🔴 **見ている場所が変わったら、印も外す** ── `withScope` と**同じ規則**である
     * (2026-08-18 の着地前 test が突いた)。⚠ 片方だけ直すと、ルートへ戻ったのに
     * **消えたフォルダの中身に付けた印**が残り、「N 件を移す」が画面に無いものを数える。
     * ⚠ 外すのは**開いているタブの場所が死んだとき**だけ ── 裏のタブの行き先が
     *   死んでも、いま見えているものは変わっていない。
     */
    const activeDied = (() => {
      const lid = p.tabs[p.active]?.scopeLid ?? null;
      return lid !== null && !alive(lid);
    })();
    const selection = activeDied ? [] : p.selection.filter(alive);
    const anchor =
      !activeDied && p.anchor !== null && alive(p.anchor) ? p.anchor : null;
    /**
     * ⚠ **カーソルも落とす**(2026-08-19)── 残すと、消えた行を指したまま
     *   `F6` を押したときに「印が無いのでカーソルの行」= **実在しない lid** を
     *   動かそうとする(`operationTargets` の入口が汚れる)。
     */
    const cursor =
      !activeDied && p.cursor !== null && alive(p.cursor) ? p.cursor : null;
    if (
      selection.length === p.selection.length &&
      anchor === p.anchor &&
      cursor === p.cursor &&
      !dead
    )
      return p;
    const tabs = dead
      ? p.tabs.map((t) => {
          const scopeDied = t.scopeLid !== null && !alive(t.scopeLid);
          const base: DualTab = {
            scopeLid: scopeDied
              ? (() => {
                  const up = fallbackOf?.(t.scopeLid!) ?? null;
                  return up !== null && alive(up) ? up : null;
                })()
              : t.scopeLid,
            past: pruneList(t.past),
            future: pruneList(t.future),
          };
          // ⚠ 場所が死んだタブの選びは捨てる(開き直した先に無い物を選んだままにしない)。生きている場所の分は消えた lid だけ落とす
          if (scopeDied) return base;
          const selection = (t.selection ?? []).filter(alive);
          const cursor = t.cursor != null && alive(t.cursor) ? t.cursor : null;
          if (selection.length === 0 && cursor === null) return base;
          return {
            ...base,
            selection,
            anchor: t.anchor != null && alive(t.anchor) ? t.anchor : null,
            cursor,
          };
        })
      : p.tabs;
    return { ...p, tabs, selection, anchor, cursor };
  };
  const left = prune(state.left);
  const right = prune(state.right);
  /**
   * ⚠ **打ち替えている相手が消えたら、打つのもやめる** ── 残すと、消えた行の
   * 名前を打ち続けられて、確定した瞬間に**どこにも無い lid へ RENAME が飛ぶ**。
   */
  const renaming =
    state.renaming !== null && !alive(state.renaming.lid) ? null : state.renaming;
  if (left === state.left && right === state.right && renaming === state.renaming) return state;
  return { ...state, left, right, renaming };
}

/**
 * 🔴 **見ていたフォルダが消えたときの知らせの字**(台帳 #1852 G1 / 依頼 228)。親が残っていれば親を、無ければいちばん上の階層を言う。
 * ⚠ 字はここ 1 本 ── 別のタブで消えた回(reducer)と、自分で消した回(ゴミ箱へ移した直後の知らせ)が同じ字を出す。
 */
export function scopeFallbackNote(parentTitle: string | null): string {
  return parentTitle === null
    ? '開いていたフォルダがゴミ箱へ移ったので、いちばん上の階層を見せています'
    : `開いていたフォルダがゴミ箱へ移ったので、親のフォルダ「${parentTitle}」を見せています`;
}

/**
 * 見ていたフォルダが死んだ側があるか(あれば最初の側の行き先 = 親の題名 / `null` = ルート)。無ければ `undefined`。
 * `before` は消える前の状態、`after` は消えた後の 2 ペイン。判定は「前は在って、いまの現在地が前と違い、前の現在地は死んでいる」。
 */
export function scopeFellBack(
  before: DualState,
  after: DualState,
  alive: (lid: string) => boolean,
  titleOf: (lid: string) => string | undefined,
): { readonly parentTitle: string | null } | undefined {
  for (const side of ['left', 'right'] as const) {
    const was = paneScope(before[side]);
    if (was === null || alive(was)) continue;
    const now = paneScope(after[side]);
    return { parentTitle: now === null ? null : (titleOf(now) ?? null) };
  }
  return undefined;
}
