/**
 * 🔴 **書き込みの最中にタブを閉じる・読み直すときだけ、「離れますか」と確認する**(#1056)。
 *
 * ## user の物語
 *
 * 大きな書き込み(取り込み / 索引の片づけ / 本文の保存)の最中にタブを閉じると、書き込みが
 * **途中で切れる**(巻き戻しは #1218 で直したが、書いた分は届かない)。user は「保存されたつもり」で
 * 閉じるので、**次に開くまで気づけない**。
 *
 * ## 何をするか
 *
 * **飛んでいる書き込みが 1 件以上のときだけ**、ブラウザの「このページを離れますか」を出す。
 * 🔑 **0 件なら何もしない** ── 普段の閉じるに確認を出すと鬱陶しい(出すのは「いま書いている」ときだけ)。
 *
 * ⚠ 判断をここへ置くのは、`main.ts` が**どの test からも実行されない**からである
 * (CLAUDE.md §2)── あちらは `setWriting` へ**渡すだけ**にする(書込の出入りは `onWriting`)。
 *
 * ⚠ **登録は書き込みが始まってから・終わったら外す**(普段は `beforeunload` の持ち主にならない ──
 *   持ち主がいるだけで戻る / 進むの高速化(bfcache)を失う環境がある)。⚠ **二重に登録しない**
 *   (飛んでいる書込が続いている間は `setWriting(true)` が何度来ても 1 回)。
 */

/** `window` のうち、ここで使う口だけ(test から差せるようにする)。 */
export interface UnloadTarget {
  addEventListener(type: 'beforeunload', listener: (ev: BeforeUnloadEvent) => void): void;
  removeEventListener(type: 'beforeunload', listener: (ev: BeforeUnloadEvent) => void): void;
}

export interface UnloadGuard {
  /** 書込が始まった(`true`)/ 飛んでいる分がすべて終わった(`false`)。 */
  setWriting(writing: boolean): void;
}

export function createUnloadGuard(target: UnloadTarget): UnloadGuard {
  let writing = false;
  let registered = false;
  const onBeforeUnload = (ev: BeforeUnloadEvent): void => {
    // ⚠ 外し忘れの保険 ── 書いていなければ何もしない(確認を出さない)
    if (!writing) return;
    ev.preventDefault();
    // ⚠ 古いブラウザは `returnValue` に字が入っていることを「確認する」の合図にする
    ev.returnValue = '';
  };
  return {
    setWriting(next: boolean): void {
      writing = next;
      if (next && !registered) {
        target.addEventListener('beforeunload', onBeforeUnload);
        registered = true;
      } else if (!next && registered) {
        target.removeEventListener('beforeunload', onBeforeUnload);
        registered = false;
      }
    },
  };
}
