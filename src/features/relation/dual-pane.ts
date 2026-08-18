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

/** 1 枚のタブ = 1 つの場所。⚠ `null` はルート。 */
export interface DualTab {
  readonly scopeLid: string | null;
}

/** 片側のペイン。タブを複数持ち、そのうち 1 枚が開いている。 */
export interface DualPaneState {
  readonly tabs: readonly DualTab[];
  /** 開いているタブの添字。⚠ 常に `tabs` の範囲内(この module が保つ)。 */
  readonly active: number;
  /** 印を付けたもの。⚠ **開いているノート(`selectedLid`)とは別**(#240 段②と同じ意味論)。 */
  readonly selection: readonly string[];
  /** 範囲選択の起点。 */
  readonly anchor: string | null;
}

export type DualSide = 'left' | 'right';

export interface DualState {
  readonly left: DualPaneState;
  readonly right: DualPaneState;
  /** いま操作している側。⚠ 「移す」の向き(移す元)を決めるのはこれ。 */
  readonly focus: DualSide;
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
  tabs: [{ scopeLid: null }],
  active: 0,
  selection: [],
  anchor: null,
});

/** 起動時の姿 ── 左右ともルートを 1 枚ずつ、焦点は左。 */
export const initialDual: DualState = {
  left: emptyPane(),
  right: emptyPane(),
  focus: 'left',
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
 * 開いているタブの場所を変える(= そのペインだけ移動する)。
 * ⚠ **印は外す** ── 場所が変われば、そこに見えていないものが選ばれたままになる
 * (#240 の着地前レビュー 2 と同じ理由。起点も一緒に外す)。
 */
export function withScope(pane: DualPaneState, lid: string | null): DualPaneState {
  if (paneScope(pane) === lid) return pane;
  const tabs = pane.tabs.map((t, i) => (i === pane.active ? { scopeLid: lid } : t));
  return { ...pane, tabs, selection: [], anchor: null };
}

/**
 * 添字が使えるか。
 * 🔴 **`Number.isInteger` まで見る**(着地前レビュー M4)。⚠ `NaN` は `< 0` も
 * `>= n` も **false** なので、素の範囲比較を**素通りする** ── `active: NaN` に
 * なると `paneScope` が `?? null` でルートへ落ち、この module が自分で戒めている
 * 「勝手に一番上へ戻った」がそのまま起きる。
 * ⚠ 上流(`binder` の `dualTabIndex`)にも同じ門が在るが、**上流 1 行だけが
 *   守っている形**にすると、その 1 行を消す変異が誰にも殺されない。
 */
const inRange = (pane: DualPaneState, index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < pane.tabs.length;

/** タブを 1 枚足す(いまの場所の隣に、いまの場所を複製して開く)。 */
export function withTabAdded(pane: DualPaneState): DualPaneState {
  if (pane.tabs.length >= MAX_TABS) return pane;
  const at = pane.active + 1;
  const tabs = [
    ...pane.tabs.slice(0, at),
    { scopeLid: paneScope(pane) },
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
  if (!inRange(pane, index)) return pane;
  const tabs = pane.tabs.filter((_, i) => i !== index);
  const active = pane.active > index ? pane.active - 1 : Math.min(pane.active, tabs.length - 1);
  return { ...pane, tabs, active, selection: [], anchor: null };
}

/** 別のタブへ移る。⚠ 範囲外は無視(state を壊さない)。 */
export function withTabActive(pane: DualPaneState, index: number): DualPaneState {
  if (!inRange(pane, index) || index === pane.active) return pane;
  return { ...pane, active: index, selection: [], anchor: null };
}

/**
 * 印の付け方。⚠ 規則は **#240 の左の列と同じ**にする ──
 * `set` = 1 件だけ / `toggle` = 足す・外す / `range` は呼び側が並びを解いて渡す。
 */
export function withSelection(
  pane: DualPaneState,
  selection: readonly string[],
  anchor: string | null,
): DualPaneState {
  return { ...pane, selection: [...selection], anchor };
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
): DualState {
  const prune = (p: DualPaneState): DualPaneState => {
    const dead = p.tabs.some((t) => t.scopeLid !== null && !alive(t.scopeLid));
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
    if (selection.length === p.selection.length && anchor === p.anchor && !dead) return p;
    const tabs = dead
      ? p.tabs.map((t) => (t.scopeLid !== null && !alive(t.scopeLid) ? { scopeLid: null } : t))
      : p.tabs;
    return { ...p, tabs, selection, anchor };
  };
  const left = prune(state.left);
  const right = prune(state.right);
  if (left === state.left && right === state.right) return state;
  return { ...state, left, right };
}
