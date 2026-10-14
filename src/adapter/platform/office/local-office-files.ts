/**
 * 🔴 **手元のファイルを Office で開き、元のファイルへ書き戻す**(#432)。
 *
 * > 「**LibreOffice を単独で普通にローカルファイルを開いて編集できる動線欲しいよね**」
 *
 * ## ⚠ ここは**このセッションだけ**の記憶(どこにも保存しない)
 *
 * `launched-files.ts` と**同じ判断を継ぐ** ── handle は IndexedDB に入れられるが
 * **入れない**:保存すると「昔どこかで開いたファイル」への書込権をアプリが黙って
 * 持ち続けることになる(user が意識していない同意の延命)。
 * 読み直したら紐づけが消えるのが**正直な寿命**である。
 *
 * ## 🔴 なぜ「控えてから、押してもらう」形なのか
 *
 * ⚠ OS からの起動(`launchQueue`)は **user の操作ではない**ので、そこから
 * `window.open` を呼ぶと**ポップアップ遮断で消える**。
 * ⚠ 確認ダイアログを挟んでも駄目である ── `<dialog>` の `close` は**別の回**で
 * 起きるので、`await` した後にはもう「user の操作の続き」ではない
 * (実装を読んで確かめた:`app-dialog.ts` の `onOk` → `close()` → `close` event → resolve)。
 *
 * 🔑 だから **①受け取ったら控えておく ②user が Office を押したときに渡す** の 2 段にする。
 * ⚠ **押すのは user なので、遮断されない。**
 */
import type { LaunchedHandle } from '@adapter/platform/launched-files';
import { localFileToken, type LocalWriteFailure } from '@features/office/office-launch';

/** 控えてあるファイル 1 件。 */
export interface StagedLocalFile {
  readonly token: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  /** 元のファイルへ書き戻せるか(受け取った時点の handle で決まる)。知らせの言い分けに使う。 */
  readonly writable: boolean;
}

interface Held {
  readonly handle: LaunchedHandle;
  readonly name: string;
}

export class LocalOfficeFiles {
  /** 合言葉 → handle。⚠ **session 限り**(上の注記)。 */
  private readonly byToken = new Map<string, Held>();
  /** まだ Office へ渡していないもの。⚠ **1 件だけ持つ**(下の注記)。 */
  private pending: (StagedLocalFile & { readonly handle: LaunchedHandle }) | null = null;
  private seq = 0;
  /**
   * 🔴 **この読み込み固有の値**(合言葉に混ぜる)。連番だけだと読み込み直すたびに `local:1` へ戻り、
   * 窓を残したまま読み込み直して別のファイルを開くと、**残った窓の保存が別のファイルへ書き込まれる**。
   */
  private readonly session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /**
   * OS から来たファイルを控える。
   *
   * ⚠ **1 件だけ持つ**(複数来たら最後の 1 件)── Office の窓は 1 枚しか無いので、
   *   2 件目を積んでも**開けるのは 1 件**である。積むと「押したら違うほうが開いた」
   *   になるので、**最後に来たものを開く**と決める(呼び手が name を画面に出す)。
   */
  stage(handle: LaunchedHandle, name: string, bytes: Uint8Array): StagedLocalFile {
    this.seq += 1;
    const token = localFileToken(`${this.session}-${this.seq}`);
    const writable = typeof handle.createWritable === 'function';
    this.pending = { token, name, bytes, handle, writable };
    return { token, name, bytes, writable };
  }

  /** 控えてあるものの名前(無ければ `null`)。⚠ 画面に出すためだけ。 */
  pendingName(): string | null {
    return this.pending?.name ?? null;
  }

  /**
   * 控えてあるものを取り出して、**合言葉と handle を結ぶ**。
   *
   * ⚠ **取り出したら控えは空にする** ── 残すと、次に Office を押したときに
   *   **もう一度同じファイルが開く**(user は「閉じたのに戻ってくる」と読む)。
   */
  take(): StagedLocalFile | null {
    const p = this.pending;
    if (p === null) return null;
    this.pending = null;
    this.byToken.set(p.token, { handle: p.handle, name: p.name });
    return { token: p.token, name: p.name, bytes: p.bytes, writable: p.writable };
  }

  /** その合言葉のファイル名(無ければ `null`)。 */
  nameOf(token: string): string | null {
    return this.byToken.get(token)?.name ?? null;
  }

  /**
   * 🔴 **元のファイルへ書き戻す**(#432 段②)。
   *
   * @returns 書けたら `true`。書けなかったら `false`、理由を区別できたときは理由。
   *   ⚠ **失敗を黙らせない** ── 呼び手が user に伝える
   *   (書けなかったのに「保存しました」と出すのが、いちばん取り返しがつかない)。
   */
  async writeBack(token: string, bytes: Uint8Array): Promise<true | false | LocalWriteFailure> {
    const held = this.byToken.get(token);
    if (held === undefined) return false;
    const { handle } = held;
    if (typeof handle.createWritable !== 'function') return 'unsupported';
    /**
     * ⚠ **権限を確かめ直す**(`launched-files.ts` と同じ作法)── OS 起動で来た
     *   handle も、書くときに改めて許可が要ることがある。
     * ⚠ `requestPermission` は **user の操作の中でないと拒否される**ことがあるが、
     *   保存は user が Office で `Ctrl+S` を押した結果なので**その中に居る**。
     */
    try {
      if (typeof handle.queryPermission === 'function') {
        const state = await handle.queryPermission({ mode: 'readwrite' });
        if (state !== 'granted' && typeof handle.requestPermission === 'function') {
          const asked = await handle.requestPermission({ mode: 'readwrite' });
          if (asked !== 'granted') return 'denied';
        }
      }
      const w = await handle.createWritable();
      /**
       * ⚠ **`write` は文字列しか受けない型にしてある**(`WritableLike`)が、
       *   実物は `BufferSource` も受ける ── ここは bytes を渡す必要があるので
       *   1 か所だけ広げる。⚠ 型を緩めるのではなく、この行に閉じ込める。
       */
      await (w as unknown as { write(d: Uint8Array): Promise<void> }).write(bytes);
      await w.close();
      return true;
    } catch (e) {
      // ⚠ 握り潰さない ── 呼び手が失敗を見て user に伝える。
      //   名前で言い分けられるものだけ区別する(それ以外は理由を作らず `false`)
      const name = (e as { name?: unknown } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
      if (name === 'NotFoundError' || name === 'InvalidStateError') return 'reopen';
      return false;
    }
  }
}
