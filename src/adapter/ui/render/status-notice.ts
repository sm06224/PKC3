/**
 * 🔴 **画面下の知らせを、メッセージにも残す**(#1017 C5 段 b1。設計 doc
 * `docs/development/ui-total-design-2026-09.md` §3.1 / §7)。
 *
 * ## 何が変わるか
 *
 * 直す前は、`showStatus`(「コピーしました」「取り込みました」「保存が効きません」等)の字は
 * **画面下の 1 行にだけ**出て、次の知らせが来ると**跡形もなく消えた**(読み直す口も、
 * バグ報告に取り出す口も無い)。いまは同じ字をメッセージ(結果 / 注意 / 問題)にも残す。
 *
 * ⚠ **画面下の見え方は 1 つも変えない** ── 居座り方・寿命・色は別の裁定である。
 * ⚠ **未読は増やさない側が既定** ── 未読になるのは `caution` / `problem` だけ
 *   (`message-log.ts` の `countUnread`)。操作の結果(`result`)で未読が増え続けない。
 *
 * ## ⚠ なぜ main.ts に書かないか
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)。「積むか / 積まないか」の判断は
 * ここに置き、`main.ts` は渡すだけにする(`status-line.ts` / `status-open.ts` と同じ作法)。
 */
import type { MessageKind } from '@features/message/message-log';

/** `showStatus` が積める種類(配信 / 処理は別の口が持つ)。 */
export type StatusKind = 'result' | 'caution' | 'problem';

export interface StatusOptions {
  /** 既定 `result`。⚠ 断り・エラーだけ `caution` / `problem` を渡す。 */
  readonly kind?: StatusKind;
  /**
   * `false` = **この字は呼び側が既に積んだ**(二重に積まない)。
   * ⚠ 画面下の 1 行へ出すのは変わらない ── 積むかどうかだけを切る。
   */
  readonly post?: boolean;
}

/**
 * 🔴 **進行中の字か** ── 進行中は**結果ではない**ので積まない。
 *
 * ⚠ 直す前は「別のウィンドウを開いています…」が `OP_NOTICE` 経由で結果として積まれ、
 *   続く `notify('')` で**空の結果も 1 件**積まれていた。
 * 🔑 形で見分ける:字が `…` で終わる(「書き出しています…」)か、`…` の後ろに括弧で補足が付く
 *   (「取込中…(ファイルを読んでいます)」「文字にしています…(○○の部品)」)。
 *   ⚠ 進行中の字を足す人は**この形で書く** ── 外れると結果として積まれる
 *   (`status-notice.test.ts` が今ある進行中の字を全部名指しで見ている)。
 */
const PROGRESS_RE = /…$|…[(（][^)）]*[)）]$/;

export function isProgressNotice(text: string): boolean {
  return PROGRESS_RE.test(text.trim());
}

/**
 * 積んでよい字か(空でなく、進行中でもない)。
 * ⚠ `OP_NOTICE` の枝(`main.ts`)もここを通す ── 判定を 2 か所に置かない(CLAUDE.md §7)。
 */
export function shouldPostNotice(text: string): boolean {
  return text.trim() !== '' && !isProgressNotice(text);
}

/** 同じセッション内で積んだ「注意 / 問題」の字を憶える数(古い順に忘れる)。 */
const REMEMBER_CAP = 64;

/**
 * 🔴 **`showStatus` の字を積む関数を作る**(アプリで 1 個)。
 *
 * ⚠ **同じ「注意 / 問題」の字は 1 回しか積まない**(同じセッションの中で)── 未読は
 *   注意 / 問題だけが増やすので、同じ警告が繰り返し来るたびに「未読 N 件」が増え続けて
 *   **本当に新しい警告が埋もれる**。`main.ts` の `lastPostedError`(`state.error` の枝)と
 *   同じ向きである。⚠ 結果は積み直す(操作 1 回 = 出来事 1 件。同じ「コピーしました」でも別の操作)。
 * 🔴 **既読にしたら、憶えた字を空にする**(着地後レビュー ⚠2)。⚠ 1 稿目は「同じセッションの間ずっと」
 *   憶えていたので、**Office が固まった 10:00 の警告を読んだ後、14:00 にもう一度固まっても積まれず**、
 *   未読も増えなかった(2 回目は**新しい出来事**なのに、画面にも記録にも出ない)。
 *   🔑 重複を防ぎたいのは「読む前に同じ警告が積み重なる」ことだけなので、**読んだ後は忘れる**。
 *   読んだ合図は呼び側が渡す(`subscribeRead`。`main.ts` は未読が 0 になったとき撃つ)。
 * ⚠ 起動をまたぐ重複(同じ警告が毎回の起動で出る)は**ここでは数えない** ── 起動のたびに
 *   新しく起きた出来事なので 1 件ずつ積む(disk の本文を読んで比べると、押すたびに本文全体を
 *   読むことになる)。
 */
export function createStatusPoster(
  post: (input: { kind: MessageKind; source: string; text: string }) => void,
  /** 「既読になった」を聞く口(`appMessagePost.onUnreadChanged` で 0 のとき撃つ)。省けば憶えたまま。 */
  subscribeRead?: (onRead: () => void) => void,
): (text: string, opts?: StatusOptions) => void {
  const remembered = new Set<string>();
  subscribeRead?.(() => remembered.clear());
  return (text, opts) => {
    if (opts?.post === false) return;
    if (!shouldPostNotice(text)) return;
    const kind: StatusKind = opts?.kind ?? 'result';
    if (kind !== 'result') {
      if (remembered.has(text)) return;
      remembered.add(text);
      if (remembered.size > REMEMBER_CAP) {
        const oldest = remembered.values().next().value;
        if (oldest !== undefined) remembered.delete(oldest);
      }
    }
    post({ kind, source: 'status', text });
  };
}
