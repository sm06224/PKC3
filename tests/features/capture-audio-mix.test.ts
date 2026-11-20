import { describe, expect, it } from 'vitest';
import {
  MIC_UNAVAILABLE_NO_AUDIO_NOTICE,
  MIC_UNAVAILABLE_NOTICE,
  NO_MIX_NOTICE,
  NO_MIX_NO_AUDIO_NOTICE,
  NO_SHARED_AUDIO_NOTICE,
  planScreenAudio,
  screenShareGuide,
} from '@features/capture/audio-mix';

const base = { displayAudio: true, mic: 'ok', hasContext: true, hasStream: true } as const;

describe('planScreenAudio', () => {
  it('共有の音 + マイク = 混ぜる(知らせなし)', () => {
    expect(planScreenAudio(base)).toEqual({ use: 'mix', notice: null });
  });
  it('設定で切ると共有の音だけ(マイクは見ない)', () => {
    expect(planScreenAudio({ ...base, mic: 'off' })).toEqual({ use: 'display', notice: null });
    expect(planScreenAudio({ ...base, mic: 'off', displayAudio: false })).toEqual({ use: 'none', notice: null });
  });
  it('マイク拒否・無し = 共有の音だけ + 知らせ', () => {
    for (const mic of ['denied', 'unavailable'] as const) {
      expect(planScreenAudio({ ...base, mic })).toEqual({ use: 'display', notice: MIC_UNAVAILABLE_NOTICE });
      expect(planScreenAudio({ ...base, mic, displayAudio: false })).toEqual({
        use: 'none',
        notice: MIC_UNAVAILABLE_NO_AUDIO_NOTICE,
      });
    }
  });
  it('共有に音が無ければマイクだけ(音声共有の案内つき)', () => {
    expect(planScreenAudio({ ...base, displayAudio: false })).toEqual({ use: 'mic', notice: NO_SHARED_AUDIO_NOTICE });
  });
  it('AudioContext が無ければ共有の音のまま(従来どおり)', () => {
    expect(planScreenAudio({ ...base, hasContext: false })).toEqual({ use: 'display', notice: NO_MIX_NOTICE });
  });
  it('MediaStream を組めなければ混ぜない', () => {
    expect(planScreenAudio({ ...base, hasStream: false })).toEqual({ use: 'display', notice: NO_MIX_NOTICE });
    expect(planScreenAudio({ ...base, hasStream: false, displayAudio: false })).toEqual({
      use: 'none',
      notice: NO_MIX_NO_AUDIO_NOTICE,
    });
  });
  it('案内は音声共有とタブ共有に触れ、マイク入のときだけマイクに触れる', () => {
    expect(screenShareGuide(true)).toContain('音声を共有');
    expect(screenShareGuide(true)).toContain('タブ');
    expect(screenShareGuide(true)).toContain('マイク');
    expect(screenShareGuide(false)).not.toContain('マイク');
  });
});
