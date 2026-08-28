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
import type { Dispatcher } from '@adapter/state/dispatcher';
import { isMarkdownFileName } from '@features/import/plain-markdown';
import { isVcfFileName } from '@features/contact/vcard';
import { importPkc2File, type ImportDeps } from './import-pkc2';
import { importMarkdownFiles } from './import-markdown';
import { importVcfFiles } from './import-vcf';

/**
 * 選ばれたファイルを取り込む。
 *
 * - 全部 md → 1 件ずつ entry にする(段②)
 * - 全部 .vcf → 連絡先を 1 枚ずつノートにする(#278 段③)
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
  const md = files.filter((f) => isMarkdownFileName(f.name));
  const vcf = files.filter((f) => isVcfFileName(f.name));
  if (vcf.length === files.length) return importVcfFiles(dispatcher, deps, files);
  if (md.length === files.length) return importMarkdownFiles(dispatcher, deps, files);
  if (md.length > 0 || vcf.length > 0) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '種類の違うファイル(Markdown / vCard / PKC2 の書出し)は分けて取り込んでください',
    });
    return null;
  }
  if (files.length > 1) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'PKC2 の書出しは 1 つずつ取り込んでください',
    });
    return null;
  }
  return importPkc2File(dispatcher, deps, files[0]!);
}
