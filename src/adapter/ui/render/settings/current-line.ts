/**
 * 🔴 **いま打っている行を、左端の線で示すか**(#2001 段 4)。既定は入。
 * ⚠ 説明は hover に置く(`inline-complete` と同じ)。⚠ 字は「何が起きるか」で書く。
 */
import type { CurrentLineStore } from '../current-line-setting';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createCurrentLineSection(region: HTMLElement, store: CurrentLineStore): SettingsSection {
  return {
    id: 'current-line',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '現在行の強調',
        action: 'set-current-line',
        field: 'current-line',
        label: ' 打っている行の左端に線を出す',
        title:
          '本文を打っている最中、カーソルのある行(折り返した行はまとめて 1 行)の左端に細い線を出します。' +
          'カーソルに合わせて動きます。オフにすると線は出ません。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'current-line', () => store.enabled());
    },
  };
}
