/**
 * 🔴 **手元の Office ファイルを、選んで(PC タブの行 / 「Office のファイルを開く…」)Office のウィンドウで開く**(#432)。
 *
 * 従来は OS から起動したとき(`launchQueue`)だけ、控えて(`stage`)→ Office のタイルで開いていた。
 * ここは**押した操作の中で**同じ控えに入れ、既存の開き方(`open` → `provideDocument` の 2 段)で開く。
 *
 * ## 🔴 順序: ウィンドウが先、許可と読み込みは後
 *
 * 一覧の行を押したら、**最初の `await` より前に**ウィンドウを確保する(`LocalFolder.open` が `reserve` を呼ぶ ──
 * 呼ぶ場所と順序は `local-folder` の test が pin)。`requestPermission` も読み込みも `await` で、その後では
 * user activation が切れて `window.open` がポップアップ遮断に遭うため。確保済み(`item.reserved`)なら、
 * ここは許可 → 読み込み → 文書を渡す、の順で進める。
 *
 * ⚠ 書き込みの許可も activation を使うので、ウィンドウの**後**になる。取れなかったとき(断られた / activation が切れていた)は、
 * **開いて、保存はダウンロード**になる(`stage` の `canWrite = false` → `LocalOfficeFiles.writeBack` の代わり)。
 * 「Office のファイルを開く…」はファイルを選ぶ操作で activation を使うため確保できない(選んだ後に開く ──
 * 遮断されても控えは残り、Office のタイルから開ける)。
 *
 * 🔑 `main.ts` に書かない(原文を読む test しか無い面)。
 */
import { largeDocNotice } from '@features/office/office-entry';
import { openingNotice } from '@features/office/office-launch';
import type { LocalFileItem } from '../local-folder';
import { provideStagedLocal, requestWritePermission, type LocalOfficeFiles } from './local-office-files';
import type { OfficeWindow } from './office-window';

export interface OpenLocalOfficeDeps {
  /** Office が使える環境か(一式が入っていて、ブラウザが対応している)。 */
  usable(): boolean;
  local: Pick<LocalOfficeFiles, 'stage' | 'take' | 'reread'>;
  /** 確保済みのウィンドウへ文書を渡す口。 */
  officeWindow: Pick<OfficeWindow, 'provideDocument'>;
  /** Office のタイルを押したときと同じ口(確保していない回の開き方)。 */
  openTile(): void;
  /**
   * 確保済みの窓に、影(保存していない編集の控え)の確認を通して文書を渡す口(`openReservedLocal`)。
   * `openPlain` = 影を使わないとき(無い / 保存済みの版を選んだ)に、確保済みの窓へファイルを渡す処理。
   */
  openReserved(openPlain: () => void): void;
  /** 画面の下の 1 行。 */
  notify(text: string): void;
}

/** @returns 窓へ渡した(または渡す手配をした)なら `true`。Office が使えない環境では何もせず `false`(呼び手が添付にする)。 */
export async function openLocalOffice(deps: OpenLocalOfficeDeps, item: LocalFileItem): Promise<boolean> {
  if (!deps.usable()) return false;
  const canWrite = await requestWritePermission(item.handle);
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  const staged = deps.local.stage(item.handle, item.file.name, bytes, item.file.lastModified, canWrite);
  if (item.reserved !== true) {
    deps.openTile();
    return true;
  }
  // 窓は押した瞬間に開いてある。🔴 影(保存していない編集の控え)の確認を通してから渡す(依頼 367 A ── 通常のタイルと同じ判断)
  const plain = (): void => {
    const taken = deps.local.take() ?? staged;
    provideStagedLocal(deps.officeWindow, deps.local, taken);
    deps.notify(openingNotice(taken.name, taken.writable));
    const large = largeDocNotice(taken.name, taken.bytes.byteLength);
    if (large !== null) deps.notify(large);
  };
  deps.openReserved(plain);
  return true;
}
