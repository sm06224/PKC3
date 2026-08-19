/**
 * 🔴 **チェック項目の「候補」を数える**(#277 段②。user 裁定 2026-08-19「推薦 A」)。
 *
 * ## これは何の値か ── **絞り込みの鍵**であって、表示する数ではない
 *
 * カンバンは「チェック項目を持つノート」だけを集める。全ノートの本文を読むと
 * **面を開くたびの全文走査**になる(#212 と同じ穴)ので、保存時に 1 度だけ数えて
 * entries の列に置き、面は**まず列で絞ってから**候補の本文だけ読む。
 *
 * ## 🔴 だから「多め」に数える(少なく数えない)
 *
 * ⚠ ここは markdown-it と**完全一致しない**。一致させようとすると、
 *   リストの入れ子・字下げコード・引用を**自前で構文解析し直す**ことになり、
 *   「同じ問いに答える口が 2 つ」になる(CLAUDE.md §7)。
 * 🔑 代わりに **superset(多め)**であることだけを保証する:
 *   - **多く数える**のは無害 ── 候補に余分なノートが入り、本文を読んで
 *     項目 0 件と分かるだけ(1 往復ぶんの無駄)
 *   - 🔴 **少なく数えるのは害** ── そのノートが候補から漏れ、
 *     **チェック項目がカンバンに永久に出ない**(しかも誰も気づけない)
 * ⚠ この関係は `tests/features/task-count.test.ts` が**描く側と突き合わせて**pin する。
 *
 * ## ⚠ 表示に使わないこと
 *
 * 多めに数える値なので、「3/7」のように**画面に出すと嘘になる**ことがある。
 * 画面に出す項目は、候補の本文から**描く側の規則で**取り直すこと。
 *
 * 🔑 **markdown-it を持ち込まない**(行走査だけ)。理由は 2 つ:
 * ① 保存のたびに走るので軽い方がよい(実測: 16KB の本文で parse 0.76ms /
 *   行走査 0.04ms)② **storage worker が migration で既存行を埋める**ときに
 *   ここを呼ぶので、worker の束に markdown-it を引き込みたくない。
 */

/** 行頭の引用記号(`>` の連なり)を剥がす。⚠ markdown-it は引用の中の task も拾う。 */
const QUOTE = /^(\s*>)+\s?/;

/**
 * チェック項目の行。⚠ `body-rewrite.ts` の `TASK_LINE` と**同じ形**
 * (書き換える側と数える側で「何が項目か」が割れないように)。
 */
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](\s|$)/;

/**
 * fence の開き。⚠ ``` と ~~~ の両方(閉じは同じ文字で同じ数以上)。
 *
 * 🔴 **字下げは 3 まで**(2026-08-19 のレビューで判明)。CommonMark では
 * **字下げ 4 以上はコードブロックの中身**であって fence ではない。
 * ⚠ 直す前は `^\s*` だったので、`    ``` ` のような**説明のための例示**を
 * fence の開きと読み、**そこから後ろの項目を全部落としていた** ──
 * つまり「行頭に ``` と書きます」と字下げで例示したノートは、
 * `task_total = 0` で保存されて**候補に入らず、盤面に二度と出ない**。
 * 🔑 これは docstring が「**少なく数えるのは害**」と名指しで禁じた向きである。
 * ⚠ 逆に、この形を fence と見なさなくなると中の `- [ ]` を拾う = **多め側**に倒れる
 *   ── 宣言した誤差の向きと一致する。
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface TaskCandidates {
  /** チェック項目**らしい**行の数(多め)。0 なら「このノートに項目は無い」。 */
  readonly total: number;
  /** そのうち印が付いている数(多め)。 */
  readonly done: number;
}

export const NO_TASKS: TaskCandidates = Object.freeze({ total: 0, done: 0 });

/**
 * 🔴 **走査は 1 か所**(CLAUDE.md §7「同じ判定が 2 か所にある」)。
 *
 * 数える側(`countTaskCandidates`。保存のたびに走る)と取り出す側
 * (`listTaskItems`。カンバンが開いたときに走る)で**別々に行を読むと、
 * 片方だけ直したときに「候補に入るのに札が出ない」ノートができる** ──
 * しかも数が合わないだけなので、誰も気づかない。
 *
 * ⚠ だから走査はここだけに置き、外は `visit` で受ける。
 * ⚠ 数える側は**物を作らない**(visitor に値を渡すだけ)── 保存のたびに
 *   項目の配列を組むと、長い本文で無駄な確保が出る。
 */
function walkTaskLines(
  body: string,
  visit: (index: number, done: boolean, rest: string) => void,
): void {
  if (body === '' || !body.includes('[')) return;
  /** 開いている fence の文字と長さ。`null` = fence の外。 */
  let fence: { readonly ch: string; readonly len: number } | null = null;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const f = FENCE.exec(raw);
    if (f !== null) {
      const mark = f[1]!;
      if (fence === null) fence = { ch: mark[0]!, len: mark.length };
      // ⚠ 閉じは**同じ文字で同じ数以上**(短い ``` では ```` は閉じない)
      else if (mark[0] === fence.ch && mark.length >= fence.len) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const line = raw.replace(QUOTE, '');
    const m = TASK.exec(line);
    if (m === null) continue;
    // ⚠ `m[0]` は末尾の 1 字(空白 or 行末)まで含む ── その次から先が中身
    visit(i, m[1] !== ' ', line.slice(m[0].length));
  }
}

/**
 * 数える。⚠ **fence の中は数えない** ── markdown-it も拾わないので、
 * 飛ばしても superset は保たれる(むしろ無駄な候補が減る)。
 */
export function countTaskCandidates(body: string): TaskCandidates {
  let total = 0;
  let done = 0;
  walkTaskLines(body, (_i, isDone) => {
    total += 1;
    if (isDone) done += 1;
  });
  return total === 0 ? NO_TASKS : { total, done };
}

/** 1 件のチェック項目(カンバンの札 1 枚ぶん)。 */
export interface TaskItem {
  /**
   * 🔴 **原文の行番号**(0 始まり)。⚠ これは `TOGGLE_TASK` /
   * `applyBodyRewrite` が指す番号と**同じもの**である ── 索引(何番目の項目か)
   * にすると、数え方がずれた瞬間に**別の行を書き換える**。
   */
  readonly line: number;
  /** 印を除いた中身(前後の空白は落とす)。⚠ markdown の記法はそのまま。 */
  readonly text: string;
  readonly done: boolean;
}

/**
 * 取り出す。⚠ **カンバンの面が呼ぶ**(候補列で絞ったノートの本文だけ)。
 *
 * ⚠ ここも `countTaskCandidates` と同じく **markdown-it と完全一致ではない**
 * (字下げコードの中の `- [ ] x` を拾う)。⚠ ただし**書き換える側
 * (`body-rewrite.ts` の `TASK_LINE`)も同じ規則**なので、
 * **札に出た物は必ず押せる**(押しても何も起きない札を出さない)。
 * 🔑 この向き ── 「出すぎるが、出た物は動く」── を選んでいるのは、
 *   逆(狭く取る)にすると**入れ子のリストの中の項目が丸ごと落ちて
 *   カンバンから消える**からである(user の動線が減る)。
 */
export function listTaskItems(body: string): TaskItem[] {
  const items: TaskItem[] = [];
  walkTaskLines(body, (line, done, rest) => {
    items.push({ line, text: rest.trim(), done });
  });
  return items;
}
