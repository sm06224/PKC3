/**
 * 🔴 **添付の改名は、題名とダウンロードのファイル名を 1 本で揃える**(#1220 F2)。
 *
 * 添付の画面の改名欄(`rename-attachment`)と、一覧の `F2` / 右クリックの「名前を変える」は
 * **同じ関数**を通る(§7 ── 判定・書き換えを 2 か所に書かない)。
 * ⚠ 直す前は後者が題名だけを変えたので、ファイル名(拡張子を除く部分)が旧いまま残っていた。
 *
 * 🔑 撃つのは 2 本を**この順**で:題名(`RENAME_ENTRY_TITLE`、本文に触らない)→ ファイル名
 *   (`SET_ATTACHMENT_NAME`、書く直前に disk から読み直してその 1 行だけを差し替える)。
 *   1 本にまとめると、題名の改名が本文の書込の衝突に巻き込まれる。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { renameOfferingUndo } from '@adapter/ui/render/rename-undo';

/** 題名を変え、同じ字からファイル名も揃える(拡張子は効果層が元のまま足す)。 */
export function renameAttachmentAndFile(dispatcher: Dispatcher, lid: string, title: string): void {
  // 🔴 変わった回だけ画面の下に「元に戻す」を出す(#1657、依頼 45 の 2)
  renameOfferingUndo(
    dispatcher,
    lid,
    () => {
      dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title });
      // ⚠ 題名を先に撃つ ── 後ろの書換は更新済みの題名を持って本文を書く(古い題名で戻さない)
      dispatcher.dispatch({ type: 'SET_ATTACHMENT_NAME', lid, name: title });
    },
    true,
  );
}

/**
 * 一覧の `F2` / 右クリックの改名の確定。
 *
 * ⚠ **添付だけ**ファイル名も揃える。添付でないノートは今までどおり題名だけ。
 * ⚠ 空白だけ / 変わっていない、の判定は reducer が持つ(`RENAME_ENTRY_TITLE`)── ここで 2 本目を
 *   書かない。ただし**題名が動かない回はファイル名も撃たない**(動かない改名で本文を書かせない)。
 */
export function renameEntryFromRow(dispatcher: Dispatcher, lid: string, title: string): void {
  const meta = dispatcher.getState().entryMetas.get(lid);
  const next = title.trim();
  if (meta?.archetype === 'attachment' && next !== '' && next !== meta.title) {
    renameAttachmentAndFile(dispatcher, lid, title);
    return;
  }
  renameOfferingUndo(dispatcher, lid, () => {
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title });
  });
}

/**
 * 「元に戻す」で題名を戻す(#1657)。添付ならファイル名も同じ字へ戻す ── 撃つ口はここ 1 本に寄せる
 * (binder が `SET_ATTACHMENT_NAME` を直に撃たない)。⚠ 戻す操作では「元に戻す」をもう一度出さない。
 */
export function restoreRenamedTitle(
  dispatcher: Dispatcher,
  lid: string,
  title: string,
  withFile: boolean,
): void {
  dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title });
  if (withFile) dispatcher.dispatch({ type: 'SET_ATTACHMENT_NAME', lid, name: title });
}
