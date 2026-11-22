/**
 * 🔴 **ログの並び**(#2018 1。user 裁定 2026-11-22「降順の記憶は端末の設定 1 つ」)。既定は古い順。
 * ⚠ ログの読む面の上の「古い順 / 新しい順」のボタンと**同じ 1 つ**(`appLogOrder`)を読み書きする ── どちらで変えても
 *   もう片方に映る(読む面は描き直しで、この列は `sync` で)。
 * ⚠ 字は「何が起きるか」で書く。説明は hover に置く。
 */
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import type { LogOrderStore } from '../log-order-setting';
import type { SettingsSection } from './section';

export const LOG_ORDER_SELECT_FIELD = 'log-order-select';
export const LOG_ORDER_VALUE_ATTR = 'data-pkc-log-order-value';

export function createLogOrderSection(region: HTMLElement, store: LogOrderStore): SettingsSection {
  return {
    id: 'log-order',
    group: 'display',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = 'ログの並び';
      const dd = document.createElement('dd');
      const row = buildChoiceRow({
        field: LOG_ORDER_SELECT_FIELD,
        ariaLabel: 'ログの並び',
        action: 'set-log-order',
        dataAttr: LOG_ORDER_VALUE_ATTR,
        choices: [
          { id: 'asc', label: '古い順' },
          { id: 'desc', label: '新しい順' },
        ],
        currentId: '', // render 末尾の sync が必ず映す
      });
      row.title =
        'ログを読むときの並びです。新しい順にすると、新しい記録(と、その中の追いログ)が上に来ます。' +
        '本文の中身は変わりません(見え方だけ)。ログの上の「古い順 / 新しい順」のボタンでも切り替えられます。この端末だけの設定です。';
      dd.append(row);
      return [dt, dd];
    },
    sync(): void {
      syncChoiceRow(region, LOG_ORDER_SELECT_FIELD, LOG_ORDER_VALUE_ATTR, store.order());
    },
  };
}
