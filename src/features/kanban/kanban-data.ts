/**
 * 🔴 **カンバンの正体は「チェック項目」である**(#277 段②。user 裁定 2026-08-19)。
 *
 * ## 何が変わったか
 *
 * 封印前(PKC2 由来)のカンバンは **`todo` アーキタイプのノート 1 件 = 札 1 枚**
 * だった。⚠ これは PKC3 の方針(「全 body = PKC-Markdown、アーキタイプは
 * フレーバー」)と噛み合わない ── `todo` は封印中(`features/sealed.ts`)なので
 * **新しく作れず、盤面は永久に空**である。しかも「やること」を書く場所は
 * 実際には**普通のノートの中のチェックリスト**になっていた。
 *
 * 🔑 だから札の単位を **本文の 1 行(チェック項目)**へ移す ──
 * user が既に書いている物がそのまま盤面に出る(新しい記法を足さない)。
 *
 * ## 🔴 なぜ「本文を読む」のに面を開くたびの全文走査にならないか
 *
 * 抽出列 `entries.task_total`(#277 段②-a)で**先に絞る**。読むのは
 * 「チェック項目を持つノート」だけで、しかも読むのは **storage worker の中**
 * ── 主スレッドへ運ぶのは**札(項目)だけ**である(#184 と同じ型)。
 * ⚠ 全件の本文を主スレッドへ運ぶのは不可侵指示(2026-07-27)に正面から当たる。
 *
 * 🔑 **pure module**。DB も DOM も知らない ── 「何を・どの列に・どの順で」だけ。
 */
import type { TaskItem } from '@features/markdown/task-count';

export type KanbanStatus = 'open' | 'done';

/** 列の定義(表示順)。 */
export const KANBAN_COLUMNS: readonly { status: KanbanStatus; label: string }[] = [
  { status: 'open', label: '未完了' },
  { status: 'done', label: '完了' },
] as const;

/**
 * 札 1 枚。⚠ **題名は持たない** ── 主スレッドの `entryMetas` に在るので、
 * 運ぶと同じ字が 2 か所に出る(片方だけ古くなる)。
 */
export interface TaskCard extends TaskItem {
  /** どのノートの行か。⚠ **押す先はこの lid** ── 開いているノートではない。 */
  readonly lid: string;
}

/**
 * 上限。⚠ どれも「画面に出して意味がある量」で決めてある ── 大きくすると
 * 盤面が読めなくなり、小さくすると user の項目が**黙って消える**。
 * 🔑 だから**切ったことは必ず画面に出す**(`TaskScan` の `truncated`)。
 */
export const TASK_LIMITS = {
  /**
   * 1 回の走査で本文を読むノートの数。⚠ **いちばん重い次元**である
   * (項目と違い、ノート 1 件につき本文 1 本を worker の heap に載せる)。
   */
  notes: 500,
  /** 盤面に出す札の数。 */
  items: 1000,
  /** 札に出す字数。⚠ 長い項目は**丸める**が、丸めたことが判る形にする。 */
  textChars: 200,
} as const;

/** 走査の結果。⚠ **切ったかどうかを一緒に運ぶ**(黙って切らない)。 */
export interface TaskScan {
  readonly cards: readonly TaskCard[];
  /** 候補になったノートの総数(切る前)。 */
  readonly totalNotes: number;
  /** 実際に本文を読んだノートの数。 */
  readonly scannedNotes: number;
  /** 🔴 上限で切ったか。⚠ 切ったなら**画面にそう出す**(「無い」と読ませない)。 */
  readonly truncated: boolean;
}

/** 長い項目を丸める。⚠ 丸めたことが判る形にする(末尾に印を付ける)。 */
export function clipTaskText(text: string): string {
  return text.length <= TASK_LIMITS.textChars
    ? text
    : `${text.slice(0, TASK_LIMITS.textChars)}…`;
}

/**
 * 札を列へ振り分ける。⚠ **入力の順を保つ** ── 呼び側が
 * (ノートの並び, 行番号)順で渡すこと。
 */
export function groupTasksByStatus(cards: readonly TaskCard[]): Record<KanbanStatus, TaskCard[]> {
  const result: Record<KanbanStatus, TaskCard[]> = { open: [], done: [] };
  for (const card of cards) result[card.done ? 'done' : 'open'].push(card);
  return result;
}

/**
 * 札を一意に指す鍵。⚠ **lid だけでは足りない**(1 つのノートに複数の項目が在る)。
 * 🔑 描画側の再利用の鍵でもあるので、**行番号まで含める**。
 */
export function taskCardKey(card: { lid: string; line: number }): string {
  return `${card.lid} ${card.line}`;
}

/**
 * 🔴 **1 件のノートの札だけを差し替える**(#277 段②-b)。
 *
 * 押した札は**往復を待たずに動かす** ── 書換の ack(`BODY_REWRITTEN`)は
 * 新しい本文を持っているので、そのノートの札はその場で組み直せる。
 * ⚠ 盤面ぜんぶを集め直さない ── 他のノートまで並び直すと、
 * 押した瞬間に無関係な札が動く(しかも DB を舐め直す)。
 *
 * 🔑 **並びは保つ**。⚠ **「同じ lid の札は連続している」を前提にしない**
 * (2026-08-19 のレビュー D-3)── 前提が崩れると**札が 1 枚黙って消える**
 * (同じ鍵が 2 回現れ、DOM が 1 個だけ置かれる)。その lid の札を**全部抜いて**、
 * **最初に居た位置へ**まとめて差し込む ── 連続でも飛んでいても同じ結果になる。
 * ⚠ 元々 1 枚も無かった lid は**入れない**(どこへ入れるべきか、ここでは
 * 分からない ── ノートの並びを知っているのは worker である)。次に面を開けば出る。
 * ⚠ 触る札が無いときは**同じ配列を返す** ── 呼び側(`refreshTaskCards`)が
 *   それを見て `TaskScan` ごと据え置くので、描画側の指紋が無駄に壊れない。
 */
export function replaceTaskCards(
  cards: readonly TaskCard[],
  lid: string,
  items: readonly TaskItem[],
): readonly TaskCard[] {
  const from = cards.findIndex((c) => c.lid === lid);
  if (from < 0) return cards;
  // ⚠ `from` は**元の並び**での最初の位置 ── 抜いた後の配列でも、そこより前に
  //    この lid の札は 1 枚も無いので、そのまま差し込み位置として使える
  const others = cards.filter((c) => c.lid !== lid);
  const next = items.map((i) => ({
    lid,
    line: i.line,
    text: clipTaskText(i.text),
    done: i.done,
  }));
  return [...others.slice(0, from), ...next, ...others.slice(from)];
}
