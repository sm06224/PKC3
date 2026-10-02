/**
 * 添付ノートの編集で、**設定の行(`attachment.*`)を編集欄に出さない**(#1220 穴②)。
 *
 * > 何が起きていたか:添付ノートの本文は `attachment.name / mime / size / asset_key` の
 * > 設定の行だけで(ファイルの bytes は本文に入らない)、編集を開くとその行が**そのまま
 * > 編集欄に出ていた**。1 文字消す / 打つだけで種類(mime)が変わり、画面の見せ方が
 * > 変わる(穴①の入り口)── 手で壊せる場所だった。
 *
 * 🔑 直し方は「触らせない」ではなく **「畳む」**:編集欄に出すのは**説明だけ**で、
 * 保存のときは**畳んだ設定の行を 1 byte も変えずに前へ戻す**。
 * ⚠ 切り方は `frontmatterLineCount` の 1 本(§7)── 描く側・書き戻す側と数え方を揃える。
 * ⚠ 畳むのは**先頭の情報の塊まるごと**(`attachment.*` だけを選り分けない)── 選り分けると
 *   「畳んだ行を元の位置へ戻す」規則が要り、**行の順番が静かに入れ替わる**側へ倒れる。
 *
 * ⚠ **pure module**。DOM も state も触らない(呼び側が描く・書き戻す)。
 */
import { frontmatterLineCount, frontmatterProblem } from '../markdown/frontmatter';

/**
 * 畳んだ設定の行を、**編集欄の `data-` 属性**へ持たせる名前。
 *
 * ⚠ 置く側(`detail.ts`)と読む側(`binder.ts` の `input`)が**別の file**なので、
 *   綴りをここ 1 か所に置く(割れると、書き戻しが黙って落ちて**設定の行が消える**)。
 */
export const HIDDEN_HEAD_ATTR = 'data-pkc-hidden-head';

/** 畳んだことを言う 1 行の印(`data-pkc-field`)。 */
export const ATTACHMENT_FOLD_FIELD = 'attachment-fold-note';

/**
 * 添付の画面の**改名欄**の名前(`aria-label`)。
 *
 * 🔑 畳みの 1 行(下)が**この字で**欄を指す ── 実在しない押し所を案内しない
 *   (`tests/adapter/attachment-edit-fold.test.ts` が描いた欄の `aria-label` と突き合わせる)。
 */
export const ATTACHMENT_RENAME_LABEL = 'この添付の名前';

/**
 * 畳んだことを言う 1 行。
 *
 * ⚠ 言い方は**起きること**で書く ── 「設定」は画面では「この端末の好み」の名前なので
 *   使わない(`ui-terms.ts`)。🔴 ファイル名は**ここでは変えられないが、変えられる場所は在る**
 *   (添付の画面の改名欄 ── 題名と一緒に変わる。#1220 裁定 A)ので、そこを指す。
 *   種類と大きさは中身から決まる(どこからも変えられない)ことと、ここで書けるのは
 *   **説明**であることを言う。
 */
export const ATTACHMENT_FOLD_NOTE = `ファイル名は、添付の画面の「${ATTACHMENT_RENAME_LABEL}」の欄で変えられます。種類と大きさは変わりません。ここでは説明だけ書けます`;

export interface AttachmentFold {
  /** 畳んだ側(先頭の情報の塊)。**原文のまま**(CRLF・空行・順番を含む)。 */
  head: string;
  /** 編集欄に出す側(説明)。 */
  rest: string;
}

/**
 * 添付ノートの本文を「畳んだ側 / 出す側」に割る。
 *
 * @returns 畳めないとき `null`(情報の塊が無い / **読めていない**)
 *
 * ⚠ **読めていない塊は畳まない** ── 閉じの `---` が足りない等で `unreadable` のときは、
 *   user が**その場で直せる**ように今までどおり出す(畳むと壊れた設定へ手が届かなくなる)。
 * ⚠ 切るのは**文字位置**で、`head + rest` は**常に原文と一致**する(行を数え直して繋ぎ直す
 *   ことはしない ── 閉じの直後の空行・CRLF が 1 byte も動かない)。
 */
export function foldAttachmentHead(body: string): AttachmentFold | null {
  const n = frontmatterLineCount(body);
  if (n === 0) return null;
  if (frontmatterProblem(body)?.kind === 'unreadable') return null;
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = body.indexOf('\n', at);
    // 最後の行に改行が無い(情報の塊で本文が終わる)── 全部が畳む側
    if (nl === -1) return { head: body, rest: '' };
    at = nl + 1;
  }
  return { head: body.slice(0, at), rest: body.slice(at) };
}

/**
 * 畳んだ側と編集欄の字を**繋いで原文へ戻す**。
 *
 * ⚠ 編集欄が空なら**畳んだ側そのまま**(閉じの直後に改行が無い原文で、説明を書かないまま
 *   保存しても、**改行 1 つ分も変わらない** ── 「変わっていないなら書かない」が効く)。
 * ⚠ 畳んだ側の末尾に改行が無いまま説明を書いたときだけ、改行を 1 つ足す
 *   (足さないと閉じの `---` に説明がくっついて、**設定が読めなくなる**)。
 */
export function joinHiddenHead(head: string, text: string): string {
  if (text === '') return head;
  return (head.endsWith('\n') ? head : `${head}\n`) + text;
}
