/**
 * 🔴 **書き出す前に確かめるタグ**の節(#1966 4-5。🟣 Gemini の裁定 = 案 ①)── 「表示」の中、タグの節の下。
 *
 * 外へ書き出す前の点検(`features/export/export-check.ts`)が、ここで決めたタグの付いたノートを一覧に出す。
 * 初期値は `private, 社外秘`。空にすると、タグは確かめない(リンクと添付の点検は残る)。
 * ⚠ 打っている途中は保存しない(欄を離れたとき / Enter で保存)。⚠ 打っている途中の欄は、映し直しで書き換えない。
 */
import type { ExportWatchTagsStore } from '../export-watch-tags';
import type { SettingsSection } from './section';

export function createExportWatchTagsSection(region: HTMLElement, store: ExportWatchTagsStore): SettingsSection {
  return {
    id: 'export-watch-tags',
    group: 'display',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = '書き出す前に確かめるタグ';
      const dd = document.createElement('dd');
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('data-pkc-field', 'export-watch-tags');
      input.setAttribute('aria-label', '書き出す前に確かめるタグ(読点またはカンマで区切る)');
      input.placeholder = '例: private, 社外秘';
      input.title =
        '閲覧用 HTML・Markdown・Word などで外へ書き出す前に、ここのタグが付いたノートが入っていれば確認を出します。' +
        '読点かカンマで区切ります。空にすると、タグは確かめません。';
      const save = (): void => {
        store.set(input.value);
        input.value = store.text();
      };
      input.addEventListener('change', save);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing) save();
      });
      dd.append(input);
      return [dt, dd];
    },
    sync(): void {
      const input = region.querySelector<HTMLInputElement>('[data-pkc-field="export-watch-tags"]');
      if (input === null || input.ownerDocument.activeElement === input) return;
      const want = store.text();
      if (input.value !== want) input.value = want;
    },
  };
}
