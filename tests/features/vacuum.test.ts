/**
 * 🔴 **保存領域を縮める**(#999。Gemini 裁定 A)── 押す前に出す字・押せるかの門・終わった後の字。
 *
 * 守っているもの:
 * - 見込みの字の 3 段(50 MB / 150 MB / 300 MB)と、縮める分が無いとき・空きが足りないときの字
 * - 門: 空き不足 → 押せない / 縮む分なし → 押せない / 両方 OK → 押せる / 空きが読めない端末は押せる
 * - 境界は**以上で通す**(空きがちょうど `fileBytes` / `freeBytes` がちょうど 1 MiB)
 * - 引き算の向き(縮めた**後**の大きさ = `fileBytes − freeBytes`)
 * - 結果の字(「→」と秒)/ 失敗の字(例外の字をそのまま出さない)
 * - 空きの判定は `quotaRoom` の 1 本(増やす書き込みの門と同じ向き)
 */
import { describe, expect, it } from 'vitest';
import {
  VACUUM_MIN_FREE_BYTES,
  VACUUM_NOTHING_TEXT,
  VACUUM_NO_ROOM_TEXT,
  vacuumBlock,
  vacuumDoneText,
  vacuumEstimateText,
  vacuumFailReason,
  vacuumFailedText,
} from '../../src/features/storage/vacuum';
import { CORRUPT_REFUSAL } from '../../src/features/storage/db-corruption';
import { DB_CHECK_LABEL } from '../../src/features/storage/rescue-labels';
import {
  quotaRoom,
  refuseWrite,
  WRITE_FLOOR_BYTES,
  WRITE_QUOTA_REFUSAL,
} from '../../src/features/storage/write-quota';

const MiB = 1024 * 1024;
/** 空きが十分在る端末(使用量は小さく、上限は大きい)。 */
const ROOMY = { usage: 10 * MiB, quota: 10_000 * MiB };

describe('vacuumEstimateText(押す前に出す字)', () => {
  it('🔴 50 MB 段: 「1 秒ほど」・縮めた後の大きさは fileBytes − freeBytes', () => {
    const text = vacuumEstimateText({ fileBytes: 40 * MiB, freeBytes: 10 * MiB }, ROOMY);
    expect(text).toBe('いま 40.0 MB、縮めると約 30.0 MB になる見込み。1 秒ほど保存できません。');
  });

  it('🔴 150 MB 段: 「1〜5 秒ほど」', () => {
    const text = vacuumEstimateText({ fileBytes: 150 * MiB, freeBytes: 30 * MiB }, ROOMY);
    expect(text).toBe('いま 150.0 MB、縮めると約 120.0 MB になる見込み。1〜5 秒ほど保存できません。');
  });

  it('🔴 300 MB 段: 「数秒〜十数秒」', () => {
    const text = vacuumEstimateText({ fileBytes: 300 * MiB, freeBytes: 60 * MiB }, ROOMY);
    expect(text).toBe('いま 300.0 MB、縮めると約 240.0 MB になる見込み。数秒〜十数秒保存できません。');
  });

  it('🔴 段の境目は「以下」(50 MiB ちょうどは 1 秒ほど / 1 バイト超えたら次の段)', () => {
    const at = (file: number): string =>
      vacuumEstimateText({ fileBytes: file, freeBytes: 5 * MiB }, ROOMY);
    expect(at(50 * MiB)).toContain('1 秒ほど');
    expect(at(50 * MiB + 1)).toContain('1〜5 秒ほど');
    expect(at(200 * MiB)).toContain('1〜5 秒ほど');
    expect(at(200 * MiB + 1)).toContain('数秒〜十数秒');
  });

  it('🔴 空きページが 0 のとき: 見込みではなく「縮める分がありません」', () => {
    expect(vacuumEstimateText({ fileBytes: 100 * MiB, freeBytes: 0 }, ROOMY)).toBe(
      VACUUM_NOTHING_TEXT,
    );
    expect(VACUUM_NOTHING_TEXT).toBe('縮める分がありません');
  });

  it('🔴 空きが足りないとき: その理由(必要な空きの意味まで言う)', () => {
    const text = vacuumEstimateText(
      { fileBytes: 100 * MiB, freeBytes: 20 * MiB },
      { usage: 950 * MiB, quota: 1000 * MiB },
    );
    expect(text).toBe(VACUUM_NO_ROOM_TEXT);
    expect(VACUUM_NO_ROOM_TEXT).toBe(
      '空きが足りないので縮められません(縮めるには、いまの大きさと同じだけの空きが要ります)',
    );
  });
});

describe('vacuumBlock(押せるかの門)', () => {
  const g = { fileBytes: 100 * MiB, freeBytes: 20 * MiB };

  it('🔴 両方 OK → 押せる(null)', () => {
    expect(vacuumBlock(g, ROOMY)).toBeNull();
  });

  it('🔴 空き不足 → 押せない(no-room)', () => {
    expect(vacuumBlock(g, { usage: 950 * MiB, quota: 1000 * MiB })).toBe('no-room');
  });

  it('🔴 縮む分が 1 MiB 未満 → 押せない(nothing)', () => {
    expect(vacuumBlock({ fileBytes: 100 * MiB, freeBytes: VACUUM_MIN_FREE_BYTES - 1 }, ROOMY)).toBe(
      'nothing',
    );
  });

  it('🔴 境界は以上で通す: 空きがちょうど fileBytes / freeBytes がちょうど 1 MiB', () => {
    expect(vacuumBlock(g, { usage: 0, quota: 100 * MiB }), '空きがちょうど足りるのに断った').toBeNull();
    expect(vacuumBlock(g, { usage: 0, quota: 100 * MiB - 1 })).toBe('no-room');
    expect(vacuumBlock({ fileBytes: 100 * MiB, freeBytes: VACUUM_MIN_FREE_BYTES }, ROOMY)).toBeNull();
  });

  it('🔴 両方 NG のときは「縮める分が無い」を先に言う(空きを作らせても意味が無い)', () => {
    expect(
      vacuumBlock({ fileBytes: 100 * MiB, freeBytes: 0 }, { usage: 99 * MiB, quota: 100 * MiB }),
    ).toBe('nothing');
  });

  it('🔴 空きが読めない端末では断らない(測れないことを理由に使えなくしない)', () => {
    expect(vacuumBlock(g, {})).toBeNull();
    expect(vacuumBlock(g, { usage: 1 })).toBeNull();
    expect(vacuumBlock(g, { usage: Number.NaN, quota: 100 })).toBeNull();
    expect(vacuumBlock(g, { usage: 0, quota: 0 })).toBeNull();
  });
});

describe('空きの判定は quotaRoom の 1 本', () => {
  it('🔴 quota − usage を返し、読めなければ null(増やす書き込みの門と同じ向き)', () => {
    expect(quotaRoom({ usage: 30, quota: 100 })).toBe(70);
    expect(quotaRoom({})).toBeNull();
    expect(quotaRoom({ usage: 1, quota: 0 })).toBeNull();
    // 増やす書き込みの門(床 64 MB)は、同じ関数の値で決まる
    expect(refuseWrite({ usage: 0, quota: WRITE_FLOOR_BYTES - 1 })).toBe(true);
    expect(refuseWrite({ usage: 0, quota: WRITE_FLOOR_BYTES })).toBe(false);
    expect(refuseWrite({})).toBe(false);
  });
});

describe('終わった後の字', () => {
  it('🔴 「保存領域を縮めました(前 → 後、秒)」', () => {
    expect(vacuumDoneText(211 * MiB, 180 * MiB, 2100)).toBe(
      '保存領域を縮めました(211.0 MB → 180.0 MB、2.1 秒)',
    );
  });

  it('🔴 0.05 秒未満は「0.0 秒」と書かない', () => {
    expect(vacuumDoneText(2 * MiB, 1 * MiB, 10)).toBe(
      '保存領域を縮めました(2.0 MB → 1.0 MB、0.1 秒未満)',
    );
  });

  it('🔴 失敗の字: 「縮められませんでした(理由)」。例外の字をそのまま出さない', () => {
    expect(vacuumFailedText('Error: SQLITE_ERROR: 本文は 秘密 です')).toBe(
      '縮められませんでした(保存領域に書けませんでした)',
    );
    expect(vacuumFailReason(`Error: ${WRITE_QUOTA_REFUSAL}`)).toBe('空きが足りませんでした');
    expect(vacuumFailReason('SQLITE_FULL: database or disk is full')).toBe('空きが足りませんでした');
  });

  it('🔴 問題が見つかっている DB の断りは、次の一手(点検)を画面の字から引いて言う', () => {
    const reason = vacuumFailReason(`Error: ${CORRUPT_REFUSAL}(vacuum で検出: x)`);
    expect(reason).toContain(`「${DB_CHECK_LABEL}」`);
  });
});
