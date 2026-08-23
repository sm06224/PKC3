/**
 * 🔴 **紙に出す(= PDF にする)**(#187 の PDF 側、2026-08-23)。
 *
 * ## なぜ「口が無い」と読んでいたか
 *
 * 台帳(#180)は「PDF は**閲覧のみ**(書き出し口が無い)」と書いていたが、
 * ⚠ **探し方が狭かった** ── `app.css` には `@media print` が在り(器をほどく /
 * 一覧と操作子を落とす / `+++` を改頁にする)、`Ctrl+P` を**わざと奪っていない**
 * (`features/keymap.ts`「再読込と印刷はページが横取りできる。奪うと user は
 * 戻し道を見失う」)。つまり**紙は最初から出せた**。
 *
 * 🔑 **無かったのは道ではなく、道しるべである。** 出す口の一覧(書き出す / Word)に
 * PDF が並んでいないので、user は「対応していない」と読んで探すのをやめる ──
 * これは動線の欠落であって、機能の欠落ではない(user 指示 2026-08-22
 * 「その場その場でユーザーが同線をどう捉えるのか…を考えて欲しい」)。
 *
 * ## だからここがやるのは 3 つだけ
 *
 * ① そのノートを**中央の面に開く**(別の面を見ていたら戻す)
 * ② 本文が**届くまで待つ**(届く前に刷ると白紙が出る)
 * ③ ブラウザの印刷を**呼ぶだけ**(PDF にするかは user が印刷画面で選ぶ)
 *
 * ⚠ **依存は 0、配る量の増分も 0** ── PKC2 が同じ判断をしている
 * (「開いて user 操作で印刷確定。0 KB のバンドル増、依存 0」)。
 *
 * ⚠ **`main.ts` に判断を置かない**(CLAUDE.md §2「どの test からも実行されない
 * file に、判断を書かない」)── だから待ちも分岐もここに在り、`main.ts` は
 * 1 行の配線しか持たない。
 */
import type { AppState, Dispatchable } from '@adapter/state/app-state';

export interface PrintNoteDeps {
  getState(): AppState;
  dispatch(action: Dispatchable): void;
  /** state が動くたびに呼ぶ。解除の関数を返す(`Dispatcher.onState` と同じ形)。 */
  onState(cb: (s: AppState) => void): () => void;
  /** ブラウザの印刷を開く(既定は `window.print`)。 */
  print(): void;
  /** 待ちの上限(ms)。既定 5000。 */
  timeoutMs?: number;
  /** 待ちの時計(test から差せる)。 */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export type PrintNoteResult = 'printed' | 'not-ready' | 'timeout';

/** 印刷できる状態か ── ここが唯一の判定(2 か所で数えない。CLAUDE.md §7)。 */
function ready(s: AppState, lid: string): boolean {
  return (
    s.phase === 'ready' &&
    s.viewMode === 'detail' &&
    s.selectedLid === lid &&
    s.openBody !== null &&
    s.openBody.lid === lid
  );
}

/**
 * ノートを紙に出す。
 *
 * @returns `printed` = 印刷を呼んだ / `not-ready` = 編集中などで呼べない /
 *   `timeout` = 本文が来なかった(**黙って白紙を刷らない**)
 */
export async function printNote(deps: PrintNoteDeps, lid: string): Promise<PrintNoteResult> {
  /**
   * 🔴 **編集中は刷らない。** 編集の面は textarea なので、刷ると
   * **見えている 1 画面ぶんの箱**しか紙に出ない(本文が切れる)。
   * ⚠ 情報ペインのボタンは編集中 `disabled` なので普通は届かないが、
   *   近道や別経路から来ることがある ── **判定はここに持つ**。
   */
  if (deps.getState().phase !== 'ready') {
    // ⚠ **黙って何もしない口を作らない**(P8 段⑲ と同じ ── 押しても 1 ドットも
    //    変わらないと、user には「壊れている」としか見えない)
    deps.dispatch({
      type: 'OP_FAILED',
      error: '編集中は印刷できません(確定するか取り消してください)',
    });
    return 'not-ready';
  }

  if (deps.getState().viewMode !== 'detail') deps.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
  if (deps.getState().selectedLid !== lid) deps.dispatch({ type: 'SELECT_ENTRY', lid });

  if (!ready(deps.getState(), lid)) {
    const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const waited = await new Promise<boolean>((resolve) => {
      /**
       * ⚠ **後片づけの手を、張る前に宣言しておく。**
       * 時計が**同期に**発火する形(test の差し替え)だと、`done` が
       * まだ代入されていない変数を掴んで落ちる ── 実装が「そう呼ばれない」
       * 前提に乗っていた(実際に test で落ちた)。
       */
      let settled = false;
      let off: (() => void) | null = null;
      let timer: unknown = null;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        // ⚠ **どちらの出口でも外す** ── 残すと state が動くたびに刷りにいく
        off?.();
        if (timer !== null) clearTimer(timer);
        resolve(ok);
      };
      timer = setTimer(() => done(false), deps.timeoutMs ?? 5000);
      off = deps.onState((s) => {
        if (ready(s, lid)) done(true);
      });
      // ⚠ 張った**直後にもう一度見る** ── 張る前に届いていたら二度と来ない
      if (settled) off();
      else if (ready(deps.getState(), lid)) done(true);
    });
    // 🔴 **来なかったら刷らない**(白紙を配らない)
    if (!waited) {
      deps.dispatch({
        type: 'OP_FAILED',
        error: '本文が届かないので印刷を中止しました(ノートを開き直してください)',
      });
      return 'timeout';
    }
  }
  deps.print();
  return 'printed';
}
