/**
 * 🔴 **起動のたびに、軽く検める ── 判断の側**(#1007 段①)。
 *
 * ⚠ ここで pin するのは**数**である ── 「7 日ごと」を散文で持つと、次に触る人が
 *   最適化で 30 日にしても誰も気づかない(CLAUDE.md「数で持つ」)。
 */
import { describe, expect, it } from 'vitest';
import {
  INTEGRITY_CHECK_INTERVAL_DAYS,
  INTEGRITY_CHECK_INTERVAL_MS,
  INTEGRITY_START_DELAY_MS,
  INTEGRITY_STAMP_KEY,
  INTEGRITY_STAMP_SCOPE,
  mergeQuickCheckRows,
  shouldStartupCheck,
  startupIntegrityNotice,
} from '../../src/features/storage/integrity-schedule';
import { integritySummary, parseQuickCheck } from '../../src/features/storage/db-rescue';
import { CONTAINER_REBUILD_LABEL } from '../../src/features/storage/rescue-labels';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-20T03:00:00Z');

describe('いつ検めるか(#1007 段①)', () => {
  it('🔴 間隔は 7 日(数で pin)', () => {
    expect(INTEGRITY_CHECK_INTERVAL_DAYS).toBe(7);
    expect(INTEGRITY_CHECK_INTERVAL_MS).toBe(7 * DAY);
  });

  it('🔴 boot の刻印から待つ長さ(起動を遅くしない)', () => {
    expect(INTEGRITY_START_DELAY_MS).toBe(5_000);
  });

  it('印の置き場は DB 全体の scope(cid ではない)', () => {
    expect(INTEGRITY_STAMP_SCOPE).toBe('__integrity__');
    expect(INTEGRITY_STAMP_KEY).toBe('checked_at');
  });

  it('🔴 1 度も検めていないなら、必ず検める', () => {
    expect(shouldStartupCheck({ lastCheckedAt: null, now: NOW })).toBe(true);
  });

  it('前回から 7 日未満なら検めない / 7 日ちょうどで検める', () => {
    const fresh = new Date(NOW - 7 * DAY + 1).toISOString();
    expect(shouldStartupCheck({ lastCheckedAt: fresh, now: NOW })).toBe(false);
    const due = new Date(NOW - 7 * DAY).toISOString();
    expect(shouldStartupCheck({ lastCheckedAt: due, now: NOW })).toBe(true);
    const old = new Date(NOW - 30 * DAY).toISOString();
    expect(shouldStartupCheck({ lastCheckedAt: old, now: NOW })).toBe(true);
  });

  it('⚠ 印が読めない / 未来なら、検める側へ倒す', () => {
    expect(shouldStartupCheck({ lastCheckedAt: 'こわれた字', now: NOW })).toBe(true);
    const future = new Date(NOW + DAY).toISOString();
    expect(shouldStartupCheck({ lastCheckedAt: future, now: NOW })).toBe(true);
  });
});

describe('表ごとの結果を畳む', () => {
  it('🔴 全部 ok なら ok の 1 行(parseQuickCheck が健全と読む形)', () => {
    const merged = mergeQuickCheckRows([['ok'], ['ok'], ['ok']]);
    expect(merged).toEqual(['ok']);
    expect(parseQuickCheck(merged, []).ok).toBe(true);
  });

  it('🔴 1 表でも壊れていれば、その行だけ残す(ok に埋もれない)', () => {
    const merged = mergeQuickCheckRows([['ok'], ['*** in database main ***\nTree 3 page 3 cell 1: bad'], ['ok']]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toContain('Tree 3');
    const report = parseQuickCheck(merged, [{ type: 'index', name: 'idx', rootpage: 3 }]);
    expect(report.ok).toBe(false);
    expect(report.brokenIndexes).toEqual(['idx']);
  });

  it('⚠ 説明文の中の ok は落とさない(等値で見る)', () => {
    expect(mergeQuickCheckRows([['ok'], ['row 1 missing from index ok_idx']])).toEqual([
      'row 1 missing from index ok_idx',
    ]);
  });

  it('表が 0 件でも ok(空を壊れと読まない)', () => {
    expect(mergeQuickCheckRows([])).toEqual(['ok']);
  });
});

describe('見つけたときの字', () => {
  const broken = parseQuickCheck(['Tree 3 page 3 cell 1: bad'], [{ type: 'index', name: 'idx', rootpage: 3 }]);

  it('🔴 何が起きたかを先に言い、次の一手は integritySummary から引く', () => {
    const text = startupIntegrityNotice(broken);
    expect(text).toContain('起動のときに');
    expect(text).toContain('自動で調べた');
    // 🔑 ボタン名を 2 か所に書かない ── 押した検めと**同じ字**が続く
    expect(text).toContain(integritySummary(broken));
    expect(text).toContain(CONTAINER_REBUILD_LABEL);
  });

  it('⚠ 健全なのに呼んだら落とす(出す字が無い)', () => {
    expect(() => startupIntegrityNotice(parseQuickCheck(['ok'], []))).toThrow();
  });
});
