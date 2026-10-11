/**
 * 🔴 **聞くときだけ音を整える**(#772 段① B)。
 * ⚠ **録った音そのものは変わらない** ── 変えているのは出口だけなので、
 *   切れば元の聞こえ方へ戻る。⚠ ここを曖昧にすると「録り直さないと戻せない」と
 *   読まれるので、字で言い切る。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { VoiceBoostStore } from '../voice-boost';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createVoiceBoostSection(
  region: HTMLElement,
  store: VoiceBoostStore,
): SettingsSection {
  return {
    id: 'voice-boost',
    group: 'notify',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '音を聞きやすくする',
        action: 'set-voice-boost',
        field: 'voice-boost',
        label: ' 再生するとき、声を聞き取りやすく整える',
        title:
          '効くのは PKC3 の中で鳴らすときだけです(音と動画、本文に出る再生機、添付の下見)。' +
          'お使いのブラウザがこの仕組みを持っていない場合は、整わずにそのまま鳴ります。',
        notes: [
          '再生する声を聞き取りやすく整えます(録った音そのものは変わりません)。',
        ],
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'voice-boost', () => store.enabled());
    },
  };
}
