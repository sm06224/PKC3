/**
 * 🔴 **パソコンのフォルダの行を押したあと、どの取り込みへ渡すか**(#215 段②。
 * 🟣 Gemini 裁定 2026-10-01「押すと取り込んで開く」)。
 *
 * ⚠ **新しい取込経路を作らない** ── 取り込みの本体は全部**既存の口**である。ここは
 *   「どの口へ渡すか」を決めるだけ(振り分けの規則は `features/local-folder/folder-entries.ts`、
 *   取込の振り分けと**同じ関数**)。
 *
 * | 種類 | 渡す先 | 元の file |
 * |---|---|---|
 * | Markdown | OS から開いたときと同じ口(`importLaunchFiles`) | 🟢 結ぶ(「元ファイルへ書き戻す」が効く)。同じ file は増えない |
 * | vCard | いつもの取込(連絡先になる) | 結ばない |
 * | それ以外 | 添付のノートを 1 件作る(`attachOne`) | 結ばない(⚠ 書き戻しの記憶には入れない) |
 *
 * ## ⚠ 添付の「同じ file を 2 回押しても増えない」
 *
 * Markdown は既存の記憶(`LaunchedFiles`)が増やさない。添付は**別の記憶**を持つ ──
 * ⚠ **書き戻しの記憶と混ぜない**: 記憶に入れた lid は `write-back-file` の相手になり、
 * 添付(画像など)へノートの本文を書いて**元のファイルを壊す**。
 * 🔑 同じ file の判定は既存の `splitAlreadyOpen`(`isSameEntry`)。⚠ 持たないブラウザでは
 * 増える側へ倒れる(別の file を取り違えるより安全 ── `launched-files.ts` と同じ)。
 *
 * ⚠ **断る側の gate を使わない** ── user は押した後に選び直せないので、**待つ側**
 *   (`wait` / `queued`)で受ける(`launchQueue` と同じ判断)。
 */
import { LaunchedFiles, splitAlreadyOpen } from '@adapter/platform/launched-files';
import type { LaunchedItem } from '@adapter/platform/launch-queue';
import type { LocalFileItem } from '@adapter/platform/local-folder';
import { fileKindOf } from '@features/local-folder/folder-entries';

export interface OpenLocalFileDeps {
  /** Markdown ── OS から開いたときと同じ口。⚠ 元の file との結びも同じ口がする。 */
  openNote(items: LaunchedItem[]): Promise<void>;
  /** vCard ── いつもの取込(押した流れの中で断られうる = 理由は取込が言う)。 */
  importContact(file: File): Promise<void>;
  /** 編集中などは、終わるまで待つ(`whenAcceptingUnrefusedImport`)。 */
  wait(): Promise<void>;
  /** その lid はいま一覧に居るか(ごみ箱へ入れた後は取り込み直す)。 */
  isPresent(lid: string): boolean;
  /** 既に取り込んであるノートを開く。 */
  select(lid: string): void;
  /** 添付を作る。⚠ **待つ側の gate の中**で走らせる。作れなかったら `null`(理由は取込側が言う)。 */
  attach(file: File): Promise<string | null>;
  /** 画面の下の 1 行。 */
  say(text: string): void;
}

export function createLocalFileOpener(deps: OpenLocalFileDeps): (item: LocalFileItem) => Promise<void> {
  /** 取り込んだ添付の記憶。⚠ 書き戻しの記憶(`launched`)とは**別**にする(上の注記)。 */
  const attached = new LaunchedFiles();
  return async (item) => {
    const kind = fileKindOf(item.file.name);
    if (kind.route === 'note') {
      await deps.openNote([{ file: item.file, handle: item.handle }]);
      return;
    }
    if (kind.route === 'contact') {
      await deps.importContact(item.file);
      return;
    }
    await deps.wait();
    const { fresh, reopened } = await splitAlreadyOpen([item], attached, (lid) => deps.isPresent(lid));
    if (reopened.length > 0) {
      deps.select(reopened[0]!);
      deps.say('すでに取り込んであるファイルを表示しました');
      return;
    }
    if (fresh.length === 0) return;
    const lid = await deps.attach(item.file);
    if (lid !== null) attached.remember(lid, item.handle, item.file.name);
  };
}
