/**
 * 収録の名前と、帯に出す 1 行(#413)。
 *
 * ⚠ ここは純関数なので**全部ここで確かめる** ── 実ブラウザでしか見られない形に
 *   しておくと、「60 秒が 1:00 になるか」のような当たり前の性質が
 *   間欠の赤でしか出てこない。
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_LABEL,
  captureBarLine,
  captureFileName,
} from '../../src/features/asset/capture-text';
import { pastedImageName } from '../../src/features/asset/pasted-image-name';

const at = new Date(2026, 7, 27, 3, 1, 2);

describe('収録の名前(#413)', () => {
  it('🔴 何を録ったかが名前で分かる', () => {
    expect(captureFileName('audio', at, 'audio/webm')).toBe('録音-2026-08-27-030102.webm');
    expect(captureFileName('screen', at, 'video/webm')).toBe('画面収録-2026-08-27-030102.webm');
  });

  it('🔴 `;codecs=…` が付いていても拡張子を引ける', () => {
    expect(captureFileName('audio', at, 'audio/webm;codecs=opus')).toBe(
      '録音-2026-08-27-030102.webm',
    );
    expect(captureFileName('screen', at, 'video/mp4; codecs="avc1"')).toBe(
      '画面収録-2026-08-27-030102.mp4',
    );
  });

  it('⚠ 知らない型は webm に倒す(拡張子なしにしない)', () => {
    expect(captureFileName('audio', at, '')).toBe('録音-2026-08-27-030102.webm');
    expect(captureFileName('audio', at, 'audio/flac')).toBe('録音-2026-08-27-030102.webm');
  });

  it('🔴 日時の形が、貼り付けた画像と同じ(一覧で並びが揃う)', () => {
    // ⚠ **綴りを写して比べない** ── 同じ関数から出ていることを、実物どうしで見る
    const shot = pastedImageName({ type: 'image/png' }, at);
    const rec = captureFileName('audio', at, 'audio/webm');
    expect(shot).toContain('2026-08-27-030102');
    expect(rec.slice(rec.indexOf('-') + 1, rec.lastIndexOf('.'))).toBe(
      shot.slice(shot.indexOf('-') + 1, shot.lastIndexOf('.')),
    );
  });
});

describe('帯の 1 行(#413)', () => {
  // ⚠ **経過の形そのもの**(`1:02:03`)は `tests/features/elapsed-text.test.ts` が
  //    見る(#279 で `features/elapsed-text.ts` へ出した)── 2 か所で pin しない。

  it('🔴 何を録っているか・どれだけ経ったか・どれだけ積んだかが 1 行で読める', () => {
    expect(captureBarLine('audio', 65_000, '2KB')).toBe('録音中 1:05(約 2KB)');
    expect(captureBarLine('screen', 3_723_000, '45.2MB')).toBe('画面収録中 1:02:03(約 45.2MB)');
  });

  it('⚠ 呼び名は 1 か所(名前と帯で綴りが割れない)', () => {
    expect(captureFileName('audio', at, 'audio/webm').startsWith(CAPTURE_LABEL.audio)).toBe(true);
    expect(captureBarLine('screen', 0, '0B').startsWith(CAPTURE_LABEL.screen)).toBe(true);
  });
});
