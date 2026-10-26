/**
 * 🔴 **打ちながら補完の候補を出すか**(#1449 `/` / #1450 `@`)。既定は入。
 * ⚠ 説明は hover に置く(`inline-code-copy` と同じ ── visible の note を足すと段落数を動かす)。
 * ⚠ 字は「何が起きるか」で書く。
 */
import type { InlineCompleteStore } from '../inline-complete-setting';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createInlineCompleteSection(
  region: HTMLElement,
  store: InlineCompleteStore,
): SettingsSection {
  return {
    id: 'inline-complete',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '入力中の補完',
        action: 'set-inline-complete',
        field: 'inline-complete',
        label: ' 入力中に補完の候補を出す(行頭の / で記法、@ でノートと日付)',
        title:
          '本文を打っている最中に、行頭の / で記法の候補、@ でノートと日付の候補をカーソルの下に出します。' +
          'オフにすると候補は出ません(書式バーのボタン・Ctrl+/・Ctrl+Shift+K・Ctrl+; からは今までどおり入れられます)。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'inline-complete', () => store.enabled());
    },
  };
}
