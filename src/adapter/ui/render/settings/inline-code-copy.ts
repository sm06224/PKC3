/**
 * 🔴 **文中の短いコードを押すとコピーするか**(#1087)。「長いコードブロック」の次に置く
 *   (説明は hover に置く ── `code-collapse` と同じ)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { InlineCodeCopyStore } from '../inline-code-copy';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createInlineCodeCopySection(
  region: HTMLElement,
  store: InlineCodeCopyStore,
): SettingsSection {
  return {
    id: 'inline-code-copy',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '文中の短いコード',
        action: 'set-inline-code-copy',
        field: 'inline-code-copy',
        label: ' 本文の `code` を押すとコピーする',
        title:
          '本文の中の `code` のように書いた短いコードを押すと、その字をコピーします。' +
          'オフにすると、押しても何も起きず、ふつうの字として選べます(コードブロックのコピーは変わりません)。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'inline-code-copy', () => store.enabled());
    },
  };
}
