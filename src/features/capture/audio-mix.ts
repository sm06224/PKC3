/**
 * 🔴 **画面録画の音を何で録るか**(#1985 項目 3。user 裁定 2026-11-20 案 A)。
 *
 * 会議メモの画面録画では、**相手の声(共有された音)と自分の声(マイク)の両方**が要る。
 * 既定でマイクも混ぜ、設定で切れる。決めること(どの音を使うか・黙って減らした理由をどう言うか)は
 * ここ 1 か所の純関数に寄せ、ブラウザの口(`getUserMedia` / `AudioContext`)は adapter が持つ。
 *
 * ⚠ pure module。DOM もブラウザ API も知らない。
 */

/** マイクの取れ方。`off` = 設定で混ぜない。 */
export type MicState = 'off' | 'ok' | 'denied' | 'unavailable';

/** 録る音の組み合わせ。`mix` = 共有の音 + マイク、`display` = 共有の音だけ、`mic` = マイクだけ、`none` = 映像だけ。 */
export type AudioUse = 'mix' | 'display' | 'mic' | 'none';

export interface AudioPlanInput {
  /** 共有に音声の track が含まれているか。 */
  readonly displayAudio: boolean;
  readonly mic: MicState;
  /** `AudioContext` を作れるか。 */
  readonly hasContext: boolean;
  /** 録る用の `MediaStream` を組み立てられるか。 */
  readonly hasStream: boolean;
}

export interface AudioPlan {
  readonly use: AudioUse;
  /** 録り始めに 1 度だけ出す短い知らせ。`null` = 言うことは無い。 */
  readonly notice: string | null;
}

/** 共有を選ぶ前に出す案内。⚠ 共有の選択で音声にチェックを入れないと、相手の声は録れない。 */
export function screenShareGuide(micOn: boolean): string {
  return (
    '相手の声も録るには、共有を選ぶ画面で「音声を共有」(タブの音声・システム音声)にチェックを入れてください。' +
    'ブラウザで開いた会議(Teams など)は、そのタブを共有すると確実に録れます。' +
    (micOn ? 'あなたの声(マイク)は自動で一緒に録ります。' : '')
  );
}

export const MIC_UNAVAILABLE_NOTICE = 'マイクが使えないので、画面と共有された音だけを録ります';
export const MIC_UNAVAILABLE_NO_AUDIO_NOTICE =
  'マイクが使えず、共有にも音声が含まれていないので、映像だけを録ります';
export const NO_MIX_NOTICE = 'このブラウザではマイクの音を混ぜられないので、共有された音だけを録ります';
export const NO_MIX_NO_AUDIO_NOTICE = 'このブラウザではマイクの音を録れないので、映像だけを録ります';
export const NO_SHARED_AUDIO_NOTICE =
  '共有に音声が含まれていないので、マイクの音だけを録ります。相手の声も録るには、共有を選ぶ画面で「音声を共有」にチェックを入れてください';

export function planScreenAudio(i: AudioPlanInput): AudioPlan {
  if (i.mic === 'off') return { use: i.displayAudio ? 'display' : 'none', notice: null };
  if (i.mic === 'denied' || i.mic === 'unavailable') {
    return i.displayAudio
      ? { use: 'display', notice: MIC_UNAVAILABLE_NOTICE }
      : { use: 'none', notice: MIC_UNAVAILABLE_NO_AUDIO_NOTICE };
  }
  // マイクは取れた
  if (i.displayAudio) {
    return i.hasContext && i.hasStream
      ? { use: 'mix', notice: null }
      : { use: 'display', notice: NO_MIX_NOTICE };
  }
  return i.hasStream
    ? { use: 'mic', notice: NO_SHARED_AUDIO_NOTICE }
    : { use: 'none', notice: NO_MIX_NO_AUDIO_NOTICE };
}
