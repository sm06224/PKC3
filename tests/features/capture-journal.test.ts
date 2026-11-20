/**
 * 🔴 途中保存の判断(#1985 項目 2)── 復元の計画・文言。
 */
import { describe, expect, it } from 'vitest';
import {
  journalBarNote,
  journalOffNotice,
  planRecovery,
  recoveryLine,
  recoveryMessage,
  type JournalChunkInfo,
  type JournalMeta,
} from '../../src/features/capture/capture-journal';

const meta = (id: string, startedAt = 1000, over: Partial<JournalMeta> = {}): JournalMeta => ({
  id,
  kind: 'audio',
  startedLid: 'n1',
  startedAt,
  ...over,
});
const ch = (rec: string, seg: number, idx: number, elapsedMs = (idx + 1) * 1000, size = 10): JournalChunkInfo => ({
  rec,
  seg,
  idx,
  elapsedMs,
  size,
});
const never = (): boolean => false;

describe('planRecovery', () => {
  it('0 番から続く断片を数え、長さは最後に使う断片の経過', () => {
    const p = planRecovery([meta('r')], [ch('r', 0, 2), ch('r', 0, 0), ch('r', 0, 1)], never);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]).toMatchObject({ rec: 'r', seg: 0, chunks: 3, bytes: 30, elapsedMs: 3000, part: null, startedLid: 'n1' });
  });

  it('0 番が無い区間は復元できない(見出しが無い)── 掃除の対象に回る', () => {
    const p = planRecovery([meta('r')], [ch('r', 0, 1), ch('r', 0, 2)], never);
    expect(p.segments).toEqual([]);
    expect(p.unrestorable).toEqual([{ rec: 'r', seg: 0 }]);
  });

  it('穴が在れば、穴の手前までを使う', () => {
    const p = planRecovery([meta('r')], [ch('r', 0, 0), ch('r', 0, 1), ch('r', 0, 3)], never);
    expect(p.segments[0]).toMatchObject({ chunks: 2, bytes: 20, elapsedMs: 2000 });
  });

  it('区間が複数 / 2 本目以降は連番が付く。並びは始まり順 → 区間順', () => {
    const p = planRecovery(
      [meta('b', 2000), meta('a', 1000)],
      [ch('b', 0, 0), ch('a', 1, 0), ch('a', 0, 0)],
      never,
    );
    expect(p.segments.map((s) => [s.rec, s.seg, s.part])).toEqual([
      ['a', 0, 1],
      ['a', 1, 2],
      ['b', 0, null],
    ]);
  });

  it('控えが 1 区間だけ残っていても、それが 2 本目なら連番を付ける(1 本目は取り込み済み)', () => {
    const p = planRecovery([meta('r')], [ch('r', 1, 0)], never);
    expect(p.segments[0]!.part).toBe(2);
  });

  it('別のタブがいま録っている収録は出さない(対照群: isLive が偽なら出る)', () => {
    const infos = [ch('r', 0, 0)];
    expect(planRecovery([meta('r')], infos, (id) => id === 'r').segments).toEqual([]);
    expect(planRecovery([meta('r')], infos, never).segments).toHaveLength(1);
  });

  it('断片の無い身元は掃除の対象 / 身元の無い断片は復元できない', () => {
    const p = planRecovery([meta('empty')], [ch('orphan', 0, 0)], never);
    expect(p.emptyRecs).toEqual(['empty']);
    expect(p.unrestorable).toEqual([{ rec: 'orphan', seg: 0 }]);
    expect(p.segments).toEqual([]);
  });

  it('何も無ければ空', () => {
    expect(planRecovery([], [], never)).toEqual({ segments: [], unrestorable: [], emptyRecs: [] });
  });
});

describe('文言', () => {
  it('復元できる物が無ければ状態の行は空(0 件で出さない)', () => {
    expect(recoveryLine(0)).toBe('');
    expect(recoveryLine(2)).toContain('2 件');
  });
  it('メッセージは題名・ノート名を含まず、入口を言う', () => {
    expect(recoveryMessage(1)).toContain('復元する');
    expect(recoveryMessage(1)).toContain('捨てる');
  });
  it('守られていない状態だけ帯に字が出る', () => {
    expect(journalBarNote('active')).toBe('');
    for (const s of ['off-cap', 'off-error', 'off-space'] as const) {
      expect(journalBarNote(s)).toBe('途中保存できていません');
      expect(journalOffNotice(s)).toContain('録音・録画は続けます');
    }
    expect(journalOffNotice('active')).toBe('');
  });
});
