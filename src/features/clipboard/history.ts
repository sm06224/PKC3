/**
 * コピーした物の履歴(#678)。**純粋な層** ── ここは「何を・何件・どんな順で
 * 持つか」だけを決める。実際に写すのも、置き場へ書くのも adapter の仕事である。
 *
 * > user 要望 2026-09-03「**コピーをアプリ内で履歴する機能**」
 *
 * ## いま何が起きているか(実地調査 2026-09-09)
 *
 * コピーすると **OS のクリップボードが上書きされる** ── 前にコピーした物は
 * アプリの中に 1 つも残らない。物語:ノート A から表をコピー → ノート B を開く
 * 途中でリンクをコピー → **表が消えている**。
 *
 * ## 🔑 積む場所は「コピーの口」1 か所(CLAUDE.md §7)
 *
 * コピーの口は `adapter/platform/clipboard.ts` の **2 つだけ**で、そこに
 * **13 か所**が集まっている。⚠ 呼び側を 1 つずつ拾う形にすると、
 * **次に増えた 1 か所を必ず数え漏らす** ── だから口の中で積む。
 */

/** 1 件。⚠ **原文の Markdown を持つ**(貼り先で崩れないため。issue の推薦)。 */
export interface CopiedItem {
  /** 積んだ時刻(epoch ms)。⚠ **並び順の鍵**でもある。 */
  readonly at: number;
  /** 原文(text/plain として写した物)。 */
  readonly text: string;
  /** 貼り先が rich のときに使う形。無ければ空文字。 */
  readonly html: string;
  /** どこからコピーしたか(ノートの題名など)。無ければ空文字。 */
  readonly from: string;
}

/**
 * 🔴 **残す件数**(issue の推薦)。
 *
 * ⚠ 多すぎると「消したい物が残り続ける」側へ倒れる ── コピーは打鍵と同じ頻度で
 * 起きるので、**user が忘れた頃の中身**まで持ち続けることになる。
 * ⚠ 少なすぎると、この機能そのものが要らない(1 つ前は OS が持っている)。
 */
export const COPY_HISTORY_MAX = 20;

/**
 * 🔴 **総量の上限**(2026-09-09 に足した)。
 *
 * ⚠ 件数だけで切ると、**1 件が大きい**ときに破れる ── 表や長い本文をコピーすると
 * 1 件で 100 KB を超えることがあり、20 件で 2 MB になる。置き場(localStorage)は
 * **origin 全体で 5 MB 程度**しか無く、しかも他の物と分け合う ── 溢れると
 * `setItem` が投げ、**書けなかったことに誰も気づかない**。
 * 🔑 だから件数と**総量の両方**で切る。⚠ 切る向きは**古いものから**
 * (新しいほうが「いま貼りたい物」である)。
 */
export const COPY_HISTORY_BYTES_MAX = 1_000_000;

/**
 * 履歴に載せない中身か。
 *
 * 🔴 **空とただの空白は積まない** ── 押し間違いで履歴が埋まると、
 *   本当に要る 20 件が押し出される(容量そのものが user の損になる)。
 */
export function isRecordableCopy(text: string): boolean {
  return text.trim() !== '';
}

/**
 * 1 件積む(新しいものが先頭)。
 *
 * 🔑 **同じ中身は積み直す** ── 「さっきの表をもう一度コピーした」は
 *   *2 件*ではなく *いちばん新しい 1 件* である。⚠ 重複を許すと、
 *   20 件の枠が**同じ物**で埋まって、古い別の物が押し出される。
 * ⚠ 判定は **text だけ**で見る ── 同じ字を、描き方(html)違いで
 *   2 件持つ意味は無い(貼り先が選ぶのは新しいほうでよい)。
 */
export function pushCopied(
  list: readonly CopiedItem[],
  item: CopiedItem,
  max: number = COPY_HISTORY_MAX,
  bytesMax: number = COPY_HISTORY_BYTES_MAX,
): CopiedItem[] {
  if (!isRecordableCopy(item.text)) return [...list];
  const rest = list.filter((c) => c.text !== item.text);
  return fitCopied([item, ...rest].slice(0, max), bytesMax);
}

/** 1 件の重さ(おおよそ)。⚠ UTF-16 の符号単位で数える ── 置き場が持つ形と揃える。 */
export function copyWeight(item: CopiedItem): number {
  return item.text.length + item.html.length + item.from.length;
}

/**
 * 総量に収まるまで**古いものから**落とす。
 *
 * 🔴 **先頭の 1 件だけは、単独で超えていても残す** ── 落とすと
 * 「いまコピーしたばかりの物が履歴に無い」形になり、user から見て
 * **機能が壊れている**。⚠ 置き場が受け取れない大きさなら、そこで初めて断る
 * (断り方は adapter 側の仕事)。
 */
export function fitCopied(
  list: readonly CopiedItem[],
  bytesMax: number = COPY_HISTORY_BYTES_MAX,
): CopiedItem[] {
  const out: CopiedItem[] = [];
  let total = 0;
  for (const c of list) {
    const w = copyWeight(c);
    if (out.length > 0 && total + w > bytesMax) break;
    out.push(c);
    total += w;
  }
  return out;
}

/**
 * 一覧に出す 1 行の字(⚠ **改行を畳み、長すぎるものは切る**)。
 *
 * ⚠ 切らないと、表や長い本文をコピーしたときに**一覧が縦に伸びて**
 *   ほかの候補が画面から出る(選べなくなる)。
 * 🔑 切った印(`…`)を出す ── 出さないと「短い物をコピーした」と読める。
 */
export function copyLabel(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 1 件消す(text で名指す)。 */
export function dropCopied(list: readonly CopiedItem[], text: string): CopiedItem[] {
  return list.filter((c) => c.text !== text);
}
