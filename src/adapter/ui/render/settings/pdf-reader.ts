/**
 * 🔴 **PDF を PKC の画面で開くか**(#275 段①。裁定: **選んだ人だけ**・既定は切)。
 * ⚠ 切のままなら、添付の「別のウィンドウで見る」はブラウザ内蔵の表示のまま(見え方は変わらない)。
 * ⚠ 説明は hover に置く(`missing-links` と同じ ── visible の note を足すと段落数を動かす)。
 * ⚠ 字は「何が起きるか」で書く(内部の部品名を出さない)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { PdfReaderStore } from '../pdf-reader-setting';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createPdfReaderSection(
  region: HTMLElement,
  store: PdfReaderStore,
): SettingsSection {
  return {
    id: 'pdf-reader',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: 'PDF',
        action: 'set-pdf-reader',
        field: 'pdf-reader',
        label: ' PDF を PKC3 の PDF ビューアで開く(字を選んでノートへ引用できる)',
        title:
          '添付の PDF の「別のウィンドウで見る」を、PKC3 の PDF ビューア(別ウィンドウ)で開きます。' +
          '字を選んで「ノートへ引用する」を押すと、ページ番号つきで添付のノートの末尾に引用として足せます。' +
          'オフにすると、ブラウザ内蔵の表示で開きます(読めない PDF のときも自動でそちらになります)。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'pdf-reader', () => store.enabled());
    },
  };
}
