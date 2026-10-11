/**
 * 🔴 **予定の時刻に知らせるか**(#280。user 指示 2026-08-19「アラートは
 * 組み込みアプリでリリースしたい」)。
 * ⚠ **既定は切** ── 音は割り込みであり、入にすると起動のたびに予定を数える。
 * ⚠ **できないことを先に書く**(#280 の本文)── 「開いている間だけ」を
 *   曖昧にすると、user は**鳴る前提で予定を任せて失う**。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { AlarmEnabledStore } from '../alarm-enabled';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createAlarmEnabledSection(
  region: HTMLElement,
  store: AlarmEnabledStore,
): SettingsSection {
  return {
    id: 'alarm-enabled',
    group: 'notify',
    build(): Node[] {
      // ⚠ **できないことを先に書く**(#280)── 鳴る前提で予定を任せて失わせない
      const row = buildCheckboxRow({
        term: '予定の知らせ',
        action: 'set-alarm-enabled',
        field: 'alarm-enabled',
        label: ' 予定の時刻になったら音で知らせる',
        title:
          '本文の行に時刻まで書いた予定が対象です。押すとそのノートを開きます。' +
          '起動したときに予定を数えます(オフのままなら数えません)。',
        notes: [
          'PKC3 を開いている間だけ鳴ります(閉じている間は鳴りません)。',
        ],
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'alarm-enabled', () => store.enabled());
    },
  };
}
