/**
 * 🔴 **予定の札の正体は「チェック項目」である**(#277 段② / #292 段⑤。
 * user 裁定 2026-08-19 / 2026-08-23)。
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
 * ## ⚠ 名前が 2 度替わっている(`features/kanban/kanban-data.ts` → ここ)
 *
 * #292 段⑤(2026-08-23)で**面がカンバンから「予定」へ引っ越した**ので、
 * この module も `features/schedule/` へ移した ── **規則は 1 行も変えていない**。
 * ⚠ 同時に、面と一緒に死んだ物(`KANBAN_COLUMNS` / `groupTasksByStatus` /
 * `KanbanStatus`)は**落とした** ── 呼んでいたのは test だけで、
 * 「実行するのが test だけの分岐は、製品の何も守らない」(CLAUDE.md §2)。
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
import { listTaskItems, type TaskItem } from '@features/markdown/task-count';
import { readLineDate, stripLineDate } from '@features/schedule/line-date';
import type { RepeatUnit } from '@features/schedule/repeat';

/**
 * 札 1 枚。⚠ **題名は持たない** ── 主スレッドの `entryMetas` に在るので、
 * 運ぶと同じ字が 2 か所に出る(片方だけ古くなる)。
 */
export interface TaskCard extends TaskItem {
  /** どのノートの行か。⚠ **押す先はこの lid** ── 開いているノートではない。 */
  readonly lid: string;
  /**
   * 🔴 **その行に書かれた日付**(`@2026-08-25`)。無ければ `null`
   * (user 指示 2026-08-23「**日付を入れたチェックリスト、これが予定として機能する**」)。
   * ⚠ **`null` の札は既定で画面に出さない** ── 出す / 出さないを決めるのは
   *   描画側で、ここは**在るものを全部運ぶ**(切替のたびに worker を叩かないため)。
   */
  readonly date: string | null;
  /** 時刻(`14:00`)。書いていなければ `null`。⚠ 日付が `null` なら必ず `null`。 */
  readonly time: string | null;
  /**
   * 🔴 **期間の終わり**(`@2026-08-25..2026-08-28`)。期間でなければ `null`(#344 段①)。
   * ⚠ **`date` が期間の開始**である ── 期間の札は `date` から `until` まで
   *   **すべての日の束に出る**(`buildAgenda`)。
   * ⚠ 期間に時刻は無い(`time` は必ず `null`)── 理由は `line-date.ts`。
   */
  readonly until: string | null;
  /**
   * 🔴 **刻み**(`@2026-08-31 毎週`)。繰り返しでなければ `null`(#344 段②)。
   * ⚠ **札 1 枚が「その日の回」になるのは束ねる側**(`buildAgenda`)である ──
   *   ここは**規則の行**をそのまま運ぶ(展開は窓を知っている側の仕事)。
   * ⚠ このとき `until` は**期間の終わりではなく繰り返しの終わり**を意味する
   *   (`repeat.ts` の頭 ── 終了条件の記法を新しく作らない)。
   */
  readonly repeat: RepeatUnit | null;
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
  /**
   * **日付を持つ札**の数。
   * 🔴 **日付の無い札とは別に数える**(2026-08-23)。⚠ 1 本の上限にすると、
   *   体裁のチェックリストが 1000 行あるノートが 1 件在るだけで
   *   **予定が 1 つも入らなくなる**(いちばん要る物が、いちばん要らない物に
   *   押し出される)── しかも `truncated` は立つので「切れた」としか読めない。
   */
  items: 1000,
  /**
   * **日付を持たない札**の数(「日付のない項目も出す」を入れたときだけ意味を持つ)。
   * ⚠ ここが埋まっても、上の `items` は 1 枚も減らない。
   */
  undated: 1000,
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
 * 札を一意に指す鍵。⚠ **lid だけでは足りない**(1 つのノートに複数の項目が在る)。
 * 🔑 描画側の再利用の鍵でもあるので、**行番号まで含める**。
 */
export function taskCardKey(card: { lid: string; line: number }): string {
  return `${card.lid} ${card.line}`;
}

/**
 * 🔴 **本文 1 本を札に変える口は、ここ 1 つだけ**(2026-08-23。CLAUDE.md §7)。
 *
 * ⚠ 呼ぶのは **2 か所**で、走る場所がまるで違う ──
 * ① `runTaskScan`(**storage worker の中**。面を開いたとき全件を舐める)
 * ② `replaceTaskCards`(**reducer の中**。押した札の 1 件だけを組み直す)
 * 🔴 直す前はこの 2 つが**別々に札を組んでいた**ので、日付を足すと
 *   「面を開くと日付が出るのに、チェックを押した瞬間に消える」形になる ──
 *   ⚠ しかも**押したノートの札だけ**なので、原因が結果から遠い。
 *
 * 🔑 だから「行 → 札」はこの関数だけが知っている。
 * ⚠ **絞り込みはここでやらない** ── 日付の無い札も**運ぶ**。出す / 出さないは
 *   描画側が決める(切替のたびに worker を叩き直さないため)。
 */
export function taskCardsOf(lid: string, body: string): TaskCard[] {
  return listTaskItems(body).map((item) => {
    const when = readLineDate(item.text);
    return {
      lid,
      line: item.line,
      // 🔑 記法そのものは**札の字から外す** ── 日付は札の日付欄に出るので、
      //    残すと同じ日付が 1 枚の札に 2 回出る
      text: clipTaskText(when === null ? item.text : stripLineDate(item.text)),
      done: item.done,
      date: when === null ? null : when.date,
      time: when === null ? null : when.time,
      until: when === null ? null : when.until,
      repeat: when === null ? null : when.repeat,
    };
  });
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
 * 🔴 **元々 1 枚も無かった lid も受ける**(#499、2026-08-28 に直した)。
 * ⚠ 直す前は「どこへ入れるべきか分からないので入れない。次に面を開けば出る」と
 *   書いてあったが、**それが user 指摘の実体だった** ── 予定の面から「足す」を
 *   押しても、本文には書かれるのに**面には 3 秒経っても出てこない**
 *   (実ブラウザで実測)。「次に面を開けば出る」は、**面を開いたままの user**には
 *   届かない理屈である。
 * 🔑 入れる位置は**末尾**でよい ── 束ね方(`agenda.ts`)は日で並べ直すので、
 *   この配列の並びは見え方に影響しない。
 * ⚠ 触る札が無いときは**同じ配列を返す** ── 呼び側(`refreshTaskCards`)が
 *   それを見て `TaskScan` ごと据え置くので、描画側の指紋が無駄に壊れない。
 * 🔴 **中身が変わっていないときも同じ配列を返す**(2026-08-20)。
 *   ⚠ 直す前は `from >= 0` なら**必ず新しい配列**を組んでいた。同じ日に
 *   「本文が state に入る所は全部組み直す」へ広げたので、**ノートを押すだけで**
 *   (`BODY_LOADED`)盤面の指紋が壊れ、そのノートの札が毎回描き直される形になった。
 *   🔑 値で突き合わせて据え置く ── 実費は札 1000 枚の 1 走査で、DOM を作り直す
 *   より桁で安い。
 */
export function replaceTaskCards(
  cards: readonly TaskCard[],
  lid: string,
  body: string,
): readonly TaskCard[] {
  const from = cards.findIndex((c) => c.lid === lid);
  /**
   * 🔴 **1 枚も持っていなかったノートも受ける**(#499。実測 2026-08-28)。
   *
   * ⚠ 直す前はここに `if (from < 0) return cards;` が在り、**そのノートの札が
   *   1 枚も無いと何もしなかった** ── つまり
   *   🔴 **予定を「新しく書いた」回だけ、画面に出てこない**。
   *
   * 実測(実ブラウザ):予定の面から「足す」を押すと、本文には
   *   `- [ ] きょうの用事 @2026-08-28` が確かに書かれるのに、面は
   *   **3 秒経っても「チェックの付いた行がまだありません」**のままだった
   *   ── user 指摘「**カレンダー表示してるのに…意味不明**」の実体である。
   *
   * 🔑 直しは**差し込む位置**だけ ── 持っていなければ**末尾**へ足す
   *   (束ね方は `agenda.ts` が日で並べ直すので、並びは見え方に影響しない)。
   * ⚠ 何も増えない回は `sameCards` が同じ参照を返すので、**描き直しは増えない**。
   */
  const others = from < 0 ? cards : cards.filter((c) => c.lid !== lid);
  // ⚠ `from` は**元の並び**での最初の位置 ── 抜いた後の配列でも、そこより前に
  //    この lid の札は 1 枚も無いので、そのまま差し込み位置として使える
  const at = from < 0 ? others.length : from;
  // 🔑 組み立ては `taskCardsOf` 1 本(上の docstring)── ここで組み直さない
  const merged = [...others.slice(0, at), ...taskCardsOf(lid, body), ...others.slice(at)];
  return sameCards(merged, cards) ? cards : merged;
}

/**
 * 値で見て同じか。⚠ **参照では見ない** ── `next` は毎回作り直すので、
 * 参照比較だと「変わっていない」を一度も検出できない。
 */
function sameCards(a: readonly TaskCard[], b: readonly TaskCard[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    // ⚠ **日付と時刻も見る**(2026-08-23)── 見ないと、本文の `@…` だけを
    //    書き換えたときに「同じ」と判定され、**画面の日付が古いまま**残る
    if (
      x.lid !== y.lid ||
      x.line !== y.line ||
      x.done !== y.done ||
      x.text !== y.text ||
      x.date !== y.date ||
      x.time !== y.time ||
      // ⚠ **期間も見る**(#344)── 見ないと、`..` の終わりだけを書き換えたときに
      //    「同じ」と判定され、**画面の期間が古いまま**残る(日付・時刻と同じ穴)
      x.until !== y.until ||
      // ⚠ **刻みも見る**(#344 段②)── 見ないと「毎週」を消した瞬間に
      //    **札が繰り返しのまま**残る(消したのに毎週出続ける = 同じ穴)
      x.repeat !== y.repeat
    )
      return false;
  }
  return true;
}
