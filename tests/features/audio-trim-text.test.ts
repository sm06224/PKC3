/**
 * 🔴 **切り出しの字**(#683 段②a。user 裁定 2026-09-14 の A)。
 *
 * ⚠ 見るのは **user が読む物**だけ ── 名前の付け方と、印の出方。
 */
import { describe, expect, it } from 'vitest';
import { trimmedCaptureName, trimMarkText, trimNoteFirst } from '../../src/features/audio/trim-text';
import { canTrimCapture, trimUnavailableText } from '../../src/features/capture/capture-trim-gate';
import type { CaptureItem } from '../../src/features/capture/capture-item';

describe('切り出したものの名前(裁定 A)', () => {
  it('🔴 元の名前 + 範囲。⚠ 拡張子の前に入れる', () => {
    expect(trimmedCaptureName('録音-2026-09-12-143000.webm', 12_000, 65_000)).toBe(
      '録音-2026-09-12-143000 (0:12〜1:05).webm',
    );
  });

  it('⚠ 拡張子が無い名前でも壊れない', () => {
    expect(trimmedCaptureName('録音', 0, 5_000)).toBe('録音 (0:00〜0:05)');
  });

  it('⚠ 先頭の点は拡張子ではない', () => {
    expect(trimmedCaptureName('.gitignore', 0, 1_000)).toBe('.gitignore (0:00〜0:01)');
  });

  it('🔴 1 時間を超えたら時も出る(elapsedText の 1 本から出ている)', () => {
    expect(trimmedCaptureName('a.webm', 3_723_000, 3_784_000)).toBe('a (1:02:03〜1:03:04).webm');
  });

  it('⚠ もう一度切ったら括弧が 2 つ並ぶ(古いほうを捨てない)', () => {
    const once = trimmedCaptureName('録音.webm', 12_000, 65_000);
    expect(trimmedCaptureName(once, 3_000, 20_000)).toBe(
      '録音 (0:12〜1:05) (0:03〜0:20).webm',
    );
  });
});

describe('🔴 1 秒未満だけを切ったときの名前(裁定 B。2026-10-01)', () => {
  it('🔴 0.1〜0.9 秒 → 小数つき(いままでは `(0:00〜0:00)` で見分けられなかった)', () => {
    expect(trimmedCaptureName('録音.webm', 100, 900)).toBe('録音 (0:00.1〜0:00.9).webm');
  });

  it('🔴 1 秒以上の名前はいまと同じ(小数を出さない)', () => {
    expect(trimmedCaptureName('録音.webm', 2_000, 5_000)).toBe('録音 (0:02〜0:05).webm');
    // ⚠ 小数の端数があっても、別の秒に落ちるなら今までどおり(切り捨て)
    expect(trimmedCaptureName('録音.webm', 2_300, 5_700)).toBe('録音 (0:02〜0:05).webm');
  });

  it('🔴 境目 0.9〜1.1 秒(別の秒に落ちる)→ 今までどおり', () => {
    expect(trimmedCaptureName('録音.webm', 900, 1_100)).toBe('録音 (0:00〜0:01).webm');
  });

  it('🔴 同じ秒の中(1.2〜1.8)→ 小数つき', () => {
    expect(trimmedCaptureName('録音.webm', 1_200, 1_800)).toBe('録音 (0:01.2〜0:01.8).webm');
  });

  it('⚠ 拡張子の前に入る・1 時間を超えても同じ形(小数は 0.1 秒きざみで切り捨て)', () => {
    expect(trimmedCaptureName('a.webm', 3_723_250, 3_723_990)).toBe('a (1:02:03.2〜1:02:03.9).webm');
  });

  it('⚠ 帯の時間表示は触らない(裁定 C の却下)── 小数は名前だけ', () => {
    expect(trimMarkText(100, 900)).toBe('0:00〜0:00(0:00)');
  });
});

describe('🔴 説明文を前に出すか(裁定 C。2026-10-01)', () => {
  it('目印が 1 つも無いときだけ前', () => {
    expect(trimNoteFirst(null, null)).toBe(true);
    expect(trimNoteFirst(0, null), '0 ミリ秒の印も「付いている」').toBe(false);
    expect(trimNoteFirst(null, 5_000)).toBe(false);
    expect(trimNoteFirst(1_000, 5_000)).toBe(false);
  });
});

describe('印の出方', () => {
  it('🔴 印が無いときは押し方を書く(印だけ出しても次が分からない)', () => {
    expect(trimMarkText(null, null)).toContain('「ここを始まりにする」');
    expect(trimMarkText(null, null)).toContain('「ここを終わりにする」');
  });

  it('🔴 片方だけのときは、もう片方を押せと書く', () => {
    expect(trimMarkText(12_000, null)).toBe('ここから 0:12 ── 「ここを終わりにする」も押してください');
    expect(trimMarkText(null, 65_000)).toBe('ここまで 1:05 ── 「ここを始まりにする」も押してください');
  });

  it('🔴 両方そろったら、範囲と切り出した後の長さが出る', () => {
    expect(trimMarkText(12_000, 65_000)).toBe('0:12〜1:05(0:53)');
  });
});

const item = (p: Partial<CaptureItem>): CaptureItem => ({
  lid: 'a',
  title: 'a',
  name: 'a.webm',
  mime: 'audio/webm',
  size: 1024,
  assetKey: 'k-1',
  kind: 'audio',
  ...p,
});

describe('切り出せる形か(押し所を出す前の門)', () => {
  it('🔴 音の webm なら切り出せる(引数つきの mime も)', () => {
    expect(canTrimCapture(item({}))).toBe(true);
    expect(canTrimCapture(item({ mime: 'audio/webm;codecs=opus' }))).toBe(true);
    expect(canTrimCapture(item({ mime: 'AUDIO/WEBM' })), '大文字で落ちている').toBe(true);
  });

  it('🔴 それ以外は出さない ── 押しても断るだけの口を作らない', () => {
    expect(canTrimCapture(item({ mime: 'audio/mp4' }))).toBe(false);
    expect(canTrimCapture(item({ kind: 'video', mime: 'video/webm' }))).toBe(false);
    expect(canTrimCapture(item({ assetKey: null }))).toBe(false);
  });

  it('🔴 出せない理由は、音のときだけ書く', () => {
    // ⚠ 動画と、中身の無い行には**字も出さない**(切り出しの話が画面に無い)
    expect(trimUnavailableText(item({ kind: 'video', mime: 'video/webm' }))).toBeNull();
    expect(trimUnavailableText(item({ assetKey: null }))).toBeNull();
    // 🔑 音なのに切り出せない形 = ここだけ理由を出す
    expect(trimUnavailableText(item({ mime: 'audio/mp4' }))).toBe(
      'この形の録音はまだ切り出せません。',
    );
    expect(trimUnavailableText(item({})), '切り出せるのに理由が出ている').toBeNull();
  });
});
