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
          '効くのは PKC3 の中で鳴らすときだけです(音と動画、本文に出るプレーヤー、添付の下見)。' +
          'お使いのブラウザがこの仕組みを持っていない場合は、整わずにそのまま鳴ります。',
        notes: [
          '再生する声を聞き取りやすく整えます(録った音そのものは変わりません)。',
        ],
      });
      /**
       * 🔴 **同じ節に切り替えを 2 つ足す**(#952 B2・B3)── 新しい場所も、行ごとのボタンも作らない。
       * ⚠ 3 つは**互いに独立**(どれか 1 つでも入っていれば、再生の鎖を通る)。
       * ⚠ どれも**再生のときだけ**で、録った音も書き出した file も変わらない。
       */
      const level = buildCheckboxRow({
        term: '音量をそろえる',
        action: 'set-voice-level',
        field: 'voice-level',
        label: ' 再生するとき、小さい声と大きい声の差を縮める',
        notes: [
          '小さい声を持ち上げ、大きい声を抑えて聞きます(録った音そのものは変わりません)。',
        ],
      });
      const cross = buildCheckboxRow({
        term: '頭の中で鳴る感じを和らげる',
        action: 'set-voice-crossfeed',
        field: 'voice-crossfeed',
        label: ' ヘッドホンで聞くとき、左右を少し混ぜる',
        notes: [
          '左右が極端に分かれた録音を、ヘッドホンで聞きやすくします(録った音そのものは変わりません)。',
        ],
      });
      return [row.dt, row.dd, level.dt, level.dd, cross.dt, cross.dd];
    },
    sync(): void {
      syncCheckbox(region, 'voice-boost', () => store.enabled());
      syncCheckbox(region, 'voice-level', () => store.levelEnabled());
      syncCheckbox(region, 'voice-crossfeed', () => store.crossfeedEnabled());
    },
  };
}
