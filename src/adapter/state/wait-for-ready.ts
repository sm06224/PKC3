/**
 * 「アプリが受け取れる状態になるまで待つ」(P7 段③ review H2)。
 *
 * 🔴 **断れない経路のために在る**。OS からの `launchQueue` は一発限りで、
 * 断っても user には picker が出ない ── 編集中に md をダブルクリックすると
 * 「編集を終了してから取り込んでください」と言われて**ファイルが失われる**。
 * user のクリック起点の操作は今までどおり断る(そちらは選び直せる)。
 *
 * 🔴 **章の欄は、もう「断れない経路」の対象にしない**(#1044 段2 3巡目の修理、S1)。
 *
 * ⚠ 2 巡目の修理は「章の欄は `phase` を `ready` のまま保つので、`phase === 'ready'`
 *   だけでは章の下書きが在る間に取込・多重タブの再読込を通してしまう」と考え、
 *   ここに `sectionDraft === null` を足していた。
 * 🔑 **その先送りの理由が、この 3 巡目で消えた**:
 * ① `SYS_BOOTED` は「**同じ container なら選択を保つ**」(`app-state.ts` の
 *   `SYS_BOOTED` reducer、`keepLid`)── 章の欄が指す lid は entryMetas に残っている
 *   限り選択も残るので、`SYS_BOOTED` が飛んでも章の欄は孤児化しない。
 * ② `SYS_BOOTED` → `REQUEST_BODY` → `BODY_LOADED` が `openBody` を差し替えても、
 *   `render()`(`detail.ts`)は章の欄が開いている間**箱の描画を差し替えない**
 *   (boxKey が変わらない限り早期 return する)── だから disk の値が本文の
 *   裏側で追いついても、打ちかけの箱は 1px も揺れない。
 * ③ **ノートが消えた回は、外側の門(`guardSectionDraftTransition`)の system 分岐が
 *   章の欄を閉じて知らせる**(entryGone を見て `sectionDraft: null` + notice)──
 *   ここで先送りしなくても、消えた回は別の場所で正しく畳まれる。
 * 🔑 **先送りを外した結果**、章の欄を開いている間も一覧・(選択が保たれる限り)本文が
 *   別タブの書込に追随する(`reload-snapshot.test.ts` の「章の欄が開いている間」の
 *   群を参照)。⚠ 章の保存自体はもう `openBody` を見ない(`SAVE_SECTION_DRAFT` の
 *   docstring)ので、これは正しさに影響しない ── むしろ user から見える一覧の遅れが
 *   1 つ減る。
 */
import { hasUnsavedTyping, type AppState } from './app-state';
import type { Dispatcher } from './dispatcher';

/** `phase === 'ready'`。⚠ 章の欄は対象外(上のコメント参照)。 */
export function isFullyReady(state: { phase: string }): boolean {
  return state.phase === 'ready';
}

/**
 * `phase === 'ready'` になるまで待つ。すでにその状態なら即座に解決。
 *
 * @param onWait 待ちに入るときに 1 度だけ呼ぶ(user に「保留した」と伝えるため)。
 *   ⚠ 無言で待つと「md を開いたのに何も起きない」に見える
 */
export function whenPhaseReady(dispatcher: Dispatcher, onWait?: () => void): Promise<void> {
  if (isFullyReady(dispatcher.getState())) return Promise.resolve();
  onWait?.();
  return new Promise((resolve) => {
    // ⚠ 購読は必ず解く(`onState` は unsubscribe を返す ── 短命購読の規約)
    const off = dispatcher.onState((state) => {
      if (!isFullyReady(state)) return;
      off();
      resolve();
    });
  });
}

/**
 * 🔴 **「先送りの判定」と「断れない取込が待つ判定」は別物である**(#1044 段2
 *   4巡目の修理、T3)。
 *
 * ⚠ 直す前は `importLaunchFiles`(OS からの `launchQueue`。断れない経路)が
 *   `isFullyReady`(= 上の `whenPhaseReady`。**`phase` だけ**を見る)で
 *   待っていた ── 3巡目の修理(S1)が `isFullyReady` から `sectionDraft` を
 *   外したのは「**再読込(`reloadSnapshot`)の先送り**」を早めるためで正しいが、
 *   `importLaunchFiles` はそれに便乗して**章の欄が開いている間も即座に
 *   `importMarkdownFiles` を呼んでしまい**、3巡目で足した
 *   `hasUnsavedTyping` の断り(S3)にそのまま弾かれてファイルを失っていた
 *   (OS の launch は一発限りで picker が出ない ── 断った時点で消える)。
 * 🔑 判定を 2 つに分ける:①`isFullyReady`(`phase` のみ。**reload の先送り**用、
 *   変えない)②ここの `canAcceptUnrefusedImport`(`phase` **+** 書きかけ無し。
 *   **断れない取込**用)。
 */
export function canAcceptUnrefusedImport(state: AppState): boolean {
  return isFullyReady(state) && !hasUnsavedTyping(state);
}

/**
 * `canAcceptUnrefusedImport` になるまで待つ(章の欄が閉じるまで含む)。
 * すでにその状態なら即座に解決。
 *
 * @param onWait 待ちに入るときに 1 度だけ呼ぶ。
 */
export function whenAcceptingUnrefusedImport(
  dispatcher: Dispatcher,
  onWait?: () => void,
): Promise<void> {
  if (canAcceptUnrefusedImport(dispatcher.getState())) return Promise.resolve();
  onWait?.();
  return new Promise((resolve) => {
    const off = dispatcher.onState((state) => {
      if (!canAcceptUnrefusedImport(state)) return;
      off();
      resolve();
    });
  });
}
