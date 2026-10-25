/**
 * 🔴 **手元の Office ファイルを、選んで(PC タブの行 / 「Office のファイルを開く…」)Office の窓で開く**(#432)。
 *
 * 従来は OS から起動したとき(`launchQueue`)だけ、控えて(`stage`)→ Office のタイルで開いていた。
 * ここは**押した操作の中で**同じ控えに入れ、そのまま Office のタイルと同じ口(`openTile`)で開く ──
 * 開き方・保存の書き戻し・控えの突き合わせは、既存の道(`LocalOfficeFiles` / `openOfficeTile`)をそのまま使う。
 *
 * ## 書き込みの許可
 *
 * 開く操作の中で `requestWritePermission`(`requestPermission`)を訊く。断られても**開く**
 * (`stage` の `canWrite = false` ── 保存はダウンロードに保存される。`LocalOfficeFiles.writeBack`)。
 * handle が無いブラウザ(`<input type=file>` で選んだ file)も同じ。
 *
 * 🔑 `main.ts` に書かない(原文を読む test しか無い面)。
 */
import type { LocalFileItem } from '../local-folder';
import { requestWritePermission, type LocalOfficeFiles } from './local-office-files';

export interface OpenLocalOfficeDeps {
  /** Office が使える環境か(一式が入っていて、ブラウザが対応している)。 */
  usable(): boolean;
  local: Pick<LocalOfficeFiles, 'stage'>;
  /** Office のタイルを押したときと同じ口。 */
  openTile(): void;
}

/** @returns 窓へ渡したら `true`。Office が使えない環境では何もせず `false`(呼び手が添付にする)。 */
export async function openLocalOffice(deps: OpenLocalOfficeDeps, item: LocalFileItem): Promise<boolean> {
  if (!deps.usable()) return false;
  const canWrite = await requestWritePermission(item.handle);
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  deps.local.stage(item.handle, item.file.name, bytes, item.file.lastModified, canWrite);
  deps.openTile();
  return true;
}
