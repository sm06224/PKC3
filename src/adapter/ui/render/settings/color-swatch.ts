/**
 * 🔴 **バッククォートで囲んだ色コードの左に、色の見本を出すか**(#1224)。
 *
 * ⚠ **既定は入**(`relative-days` と同じ ── 見え方が変わるので切れる)。
 * ⚠ 説明は hover に置く(visible の note を足すと `settings-notes.test.ts` の段落数を動かす)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { ColorSwatchStore } from '../color-swatch';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createColorSwatchSection(
  region: HTMLElement,
  store: ColorSwatchStore,
): SettingsSection {
  return {
    id: 'color-swatch',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '色コードの見本',
        action: 'set-color-swatch',
        field: 'color-swatch',
        label: ' 本文の `#3b82f6` のような色コードの左に、色の見本を出す',
        title:
          'バッククォート(`)で囲んだ色コードの左に、その色の小さな四角が出ます(コードの字は変わらず、コピーにも入りません)。' +
          '囲んでいない字、書き出した HTML・Word・印刷には出ません。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'color-swatch', () => store.enabled());
    },
  };
}
