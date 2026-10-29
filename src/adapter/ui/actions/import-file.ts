/**
 * 取込の**振り分け**(P7 段②)。UI からはここ 1 本だけを呼ぶ。
 *
 * 🔑 振り分けを main.ts に置かない ── 「どの経路が受けるか」は取込の規則であって
 * 起動の配線ではない。ここに集めておけば、段③(`launchQueue`)も同じ規則で
 * ファイルを流せる。
 *
 * ⚠ **md は拡張子で決める**(中身では決めない)。どんなテキストも markdown として
 * 妥当なので、中身判定は必ず誤る。`manifest.webmanifest` の `file_handlers` も
 * 拡張子で宣言しており、**宣言と実体を同じ規則で揃える**のが要点
 * (`tests/features/plain-markdown.test.ts` の parity test)。
 */
import { failImport } from './import-failure';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { isMarkdownFileName, isPlainTextFileName } from '@features/import/plain-markdown';
import { isVcfFileName } from '@features/contact/vcard';
import { isPptxFileName } from '@features/import/pptx-board';
import { isIcsFileName } from '@features/schedule/ics-import';
import { importPkc2File, type ImportDeps } from './import-pkc2';
import { importMarkdownFiles } from './import-markdown';
import { importVcfFiles } from './import-vcf';
import { importPptxFiles } from './import-pptx';
import { importIcsFiles } from './import-ics';
import type { CancelToken } from '@features/job-cancel';

/**
 * 選ばれたファイルを取り込む。
 *
 * - 全部 md → 1 件ずつ entry にする(段②)
 * - 全部 .vcf → 連絡先を 1 枚ずつノートにする(#278 段③)
 * - 全部 .ics → 予定の一覧を 1 ノートにする(#855 段 D)
 * - 全部 .pptx → スライド 1 枚ずつ板のノートにする(#530 C)
 * - それ以外 → PKC2 経路(1 件ずつしか受けない)
 *
 * ⚠ 混在は**断る**。「md だけ入って PKC2 が黙って落ちた」を作らない ──
 * 部分成功を成功の顔で返すのが、この repo でいちばん避けたい形である。
 */
export async function importFiles(
  dispatcher: Dispatcher,
  deps: ImportDeps,
  files: readonly File[],
): Promise<number | null> {
  if (files.length === 0) return null;
  // 🔴 `.txt` も md と同じ道(依頼 171)。窓へ落としたときの振り分け(binder の `routeFiles`)も同じ判定を見る
  const md = files.filter((f) => isMarkdownFileName(f.name) || isPlainTextFileName(f.name));
  const vcf = files.filter((f) => isVcfFileName(f.name));
  const pptx = files.filter((f) => isPptxFileName(f.name));
  const ics = files.filter((f) => isIcsFileName(f.name));
  /**
   * 🔴 **読んでいる間・書いている間にタブを閉じたら、「離れますか」を出す**(#1852 束 F1、「見え方を変えずに直す物」)。
   * ⚠ PKC2 の道(`importPkc2File`)は自分で出し入れしている(ここで包むと同じ持ち主を二重に外す)── 残りの 4 本をここで包む。
   * ⚠ 出口は 1 本ではない(断り・失敗・成功・例外)ので `finally` で必ず戻す。
   */
  const guarded = async (run: (token: CancelToken | undefined) => Promise<number | null>): Promise<number | null> => {
    deps.onWriting?.(true);
    /**
     * 🔴 **少し長引いたら「取り込みをやめる」を出す**(台帳 #1852 の F2・依頼 253 の残り。バックアップ・PKC2 の道と同じ `job-control.ts`)。
     * ⚠ 読み込みの区切り(ファイル 1 本・スライド 1 枚ごと)と書く直前で印を見る。書き込みは 1 回で、途中で割り込まない。
     */
    const token = deps.job?.start('import');
    try {
      return await run(token);
    } finally {
      if (token !== undefined) deps.job?.finish(token);
      deps.onWriting?.(false);
    }
  };
  if (vcf.length === files.length) return guarded((t) => importVcfFiles(dispatcher, deps, files, t));
  if (md.length === files.length) return guarded((t) => importMarkdownFiles(dispatcher, deps, files, t));
  if (pptx.length === files.length) return guarded((t) => importPptxFiles(dispatcher, deps, files, t));
  if (ics.length === files.length) return guarded((t) => importIcsFiles(dispatcher, deps, files, t));
  if (md.length > 0 || vcf.length > 0 || pptx.length > 0 || ics.length > 0) {
    return failImport(dispatcher, deps, '種類の違うファイル(Markdown・テキスト / vCard / カレンダー形式 / PowerPoint / PKC2 の書き出し)は分けて取り込んでください');
  }
  if (files.length > 1) {
    return failImport(dispatcher, deps, 'バックアップや PKC2 の書き出しは 1 つずつ取り込んでください');
  }
  return importPkc2File(dispatcher, deps, files[0]!);
}
