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
    expect(captureFileName('audio', at, 'audio/webm', null)).toBe('録音-2026-08-27-030102.webm');
    expect(captureFileName('screen', at, 'video/webm', null)).toBe('画面収録-2026-08-27-030102.webm');
  });

  it('🔴 `;codecs=…` が付いていても拡張子を引ける', () => {
    expect(captureFileName('audio', at, 'audio/webm;codecs=opus', null)).toBe(
      '録音-2026-08-27-030102.webm',
    );
    expect(captureFileName('screen', at, 'video/mp4; codecs="avc1"', null)).toBe(
      '画面収録-2026-08-27-030102.mp4',
    );
  });

  it('⚠ 知らない型は webm に倒す(拡張子なしにしない)', () => {
    expect(captureFileName('audio', at, '', null)).toBe('録音-2026-08-27-030102.webm');
    expect(captureFileName('audio', at, 'audio/flac', null)).toBe('録音-2026-08-27-030102.webm');
  });

  it('🔴 日時の形が、貼り付けた画像と同じ(一覧で並びが揃う)', () => {
    // ⚠ **綴りを写して比べない** ── 同じ関数から出ていることを、実物どうしで見る
    const shot = pastedImageName({ type: 'image/png' }, at);
    const rec = captureFileName('audio', at, 'audio/webm', null);
    expect(shot).toContain('2026-08-27-030102');
    expect(rec.slice(rec.indexOf('-') + 1, rec.lastIndexOf('.'))).toBe(
      shot.slice(shot.indexOf('-') + 1, shot.lastIndexOf('.')),
    );
  });
});

describe('帯の 1 行(#413)', () => {
  // ⚠ **経過の形そのもの**(`1:02:03`)は `tests/features/elapsed-text.test.ts` が
  //    見る(#279 で `features/elapsed-text.ts` へ出した)── 2 か所で pin しない。

  it('🔴 何を録っているか・どれだけ経ったか・どれだけ積んだか・あと何分かが 1 行で読める', () => {
    expect(captureBarLine('audio', 65_000, '2KB', 43_135_000, 1)).toBe(
      '録音中 1:05(約 2KB・残り 11:58:55)',
    );
    expect(captureBarLine('screen', 3_723_000, '45.2MB', 39_477_000, 1)).toBe(
      '画面収録中 1:02:03(約 45.2MB・残り 10:57:57)',
    );
  });

  it('🔴 2 本目からは「何本目か」が出る(#771)', () => {
    expect(captureBarLine('screen', 3_723_000, '45.2MB', 39_477_000, 3)).toBe(
      '画面収録中 1:02:03(約 45.2MB・3 本目・残り 10:57:57)',
    );
  });

  it('⚠ 1 本目には「1 本目」と出さない(分かれたと思わせない)', () => {
    expect(captureBarLine('audio', 0, '0B', 1_000, 1)).not.toContain('本目');
    // ⚠ 対照群 ── 2 本目なら出る(上の主張が「常に出ない」ではないこと)
    expect(captureBarLine('audio', 0, '0B', 1_000, 2)).toContain('2 本目');
  });

  it('⚠ 残りは負にしない(止まる直前に「残り -0:01」を出さない)', () => {
    expect(captureBarLine('audio', 0, '0B', -5_000, 1)).toContain('残り 0:00');
  });

  it('⚠ 呼び名は 1 か所(名前と帯で綴りが割れない)', () => {
    expect(captureFileName('audio', at, 'audio/webm', null).startsWith(CAPTURE_LABEL.audio)).toBe(
      true,
    );
    expect(captureBarLine('screen', 0, '0B', 0, 1).startsWith(CAPTURE_LABEL.screen)).toBe(true);
  });
});

describe('🔴 分かれた収録の名前(#771)', () => {
  it('🔴 分かれた回は末尾に連番が付く(同じ時刻なので一覧で隣どうしに並ぶ)', () => {
    expect(captureFileName('audio', at, 'audio/webm', 1)).toBe('録音-2026-08-27-030102-1.webm');
    expect(captureFileName('audio', at, 'audio/webm', 2)).toBe('録音-2026-08-27-030102-2.webm');
  });

  it('🔴 分かれていない回は連番を付けない(大多数の名前を変えない)', () => {
    expect(captureFileName('audio', at, 'audio/webm', null)).toBe('録音-2026-08-27-030102.webm');
  });

  it('⚠ 連番は拡張子の**前**に付く(種類を失わない)', () => {
    expect(captureFileName('screen', at, 'video/mp4', 12).endsWith('.mp4')).toBe(true);
  });
});
