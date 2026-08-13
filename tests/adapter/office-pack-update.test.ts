/** @vitest-environment happy-dom */
/**
 * 手元の一式と配布元が**別の版**であることを知らせる(user 裁定 2026-08-13
 * 「**通知のみで OK / 文言もまかせた**」)。
 *
 * 守りたい主張:
 *  ① **一式(77MB)を勝手に取りに行かない** ── 読むのは目録だけ
 *  ② **入っていないなら配布元へ触りにも行かない**(使わない user の起動を汚さない)
 *  ③ 🔴 **「新しい」と言わない** ── 版に順序が無い(sha は時刻ではない)
 *  ④ 取得に失敗したら**黙る**(オフラインは正常)
 *  ⑤ 設定の面と起動時の知らせが、**同じ判定 1 つ**から出る
 */
import { describe, expect, it } from 'vitest';
import {
  checkPackUpdate,
  comparePackVersion,
  packUpdateNotice,
  packUpdateText,
} from '../../src/adapter/platform/office/office-pack-update';

describe('版の突き合わせ', () => {
  it('同じなら黙る', () => {
    expect(comparePackVersion('lo-abc-run1', 'lo-abc-run1').kind).toBe('quiet');
  });

  it('🔴 違えば両方の版を持って返す', () => {
    const d = comparePackVersion('unknown', 'lo-abc-run1');
    expect(d).toEqual({ kind: 'differs', installed: 'unknown', available: 'lo-abc-run1' });
  });

  it('入っていなければ黙る(「入っていません」は別の面が言っている)', () => {
    expect(comparePackVersion(null, 'lo-abc-run1').kind).toBe('quiet');
  });

  it('配布元が読めなければ黙る', () => {
    expect(comparePackVersion('lo-abc-run1', null).kind).toBe('quiet');
  });

  it('⚠ 空文字は「版が無い」であって「違う」ではない', () => {
    expect(comparePackVersion('', 'lo-abc-run1').kind).toBe('quiet');
    expect(comparePackVersion('lo-abc-run1', '').kind).toBe('quiet');
  });
});

describe('文言', () => {
  const diff = comparePackVersion('unknown', 'lo-abc-run1');

  it('🔴 「新しい」「古い」と言わない(版に順序が無い)', () => {
    for (const text of [packUpdateText(diff), packUpdateNotice(diff)]) {
      expect(text).not.toBeNull();
      expect(text, '順序を主張している').not.toMatch(/新し|古い|最新|更新があ/);
    }
  });

  it('設定の面には、両方の版と次の一歩が出る', () => {
    const text = packUpdateText(diff)!;
    expect(text).toContain('unknown');
    expect(text).toContain('lo-abc-run1');
    // 🔑 次の一歩 ── 押す物の名前で書く(状態だけ言わない)
    expect(text).toContain('取得して入れる');
  });

  it('起動時の知らせには、どこへ行けばよいかが出る', () => {
    const text = packUpdateNotice(diff)!;
    expect(text).toContain('Office');
    expect(text).toContain('設定');
  });

  it('黙るときは、どちらも null(空の行を出さない)', () => {
    const quiet = comparePackVersion('same', 'same');
    expect(packUpdateText(quiet)).toBeNull();
    expect(packUpdateNotice(quiet)).toBeNull();
  });
});

describe('🔴 取りに行き方', () => {
  it('入っていなければ、配布元へ触りにも行かない', async () => {
    let touched = 0;
    const d = await checkPackUpdate({
      installedVersion: () => null,
      fetchAvailable: async () => { touched += 1; return 'lo-abc-run1'; },
    });
    expect(d.kind).toBe('quiet');
    expect(touched, '使わない user の起動で要求を出している').toBe(0);
  });

  it('入っていれば読み、違えば返す', async () => {
    const d = await checkPackUpdate({
      installedVersion: () => 'unknown',
      fetchAvailable: async () => 'lo-abc-run1',
    });
    expect(d).toEqual({ kind: 'differs', installed: 'unknown', available: 'lo-abc-run1' });
  });

  it('⚠ 取得が投げても黙って quiet(オフラインは正常)', async () => {
    const d = await checkPackUpdate({
      installedVersion: () => 'unknown',
      fetchAvailable: async () => { throw new Error('offline'); },
    });
    expect(d.kind).toBe('quiet');
  });
});
