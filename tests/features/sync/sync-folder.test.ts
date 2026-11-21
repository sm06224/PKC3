/**
 * 端末間の同期(#2000)段 3 ── 同期フォルダの回の決め(純関数)。
 * 実物の worker で通す test は `tests/adapter/sync-folder.test.ts`。ここは境目(名前の読み方・変わったファイルだけ読む・全件の頼み・書く中身)。
 */
import { describe, expect, it } from 'vitest';
import {
  backoffMinutes,
  deviceOfFileName,
  emptyFolderRecord,
  folderFileName,
  normalizeFolderRecord,
  planFolderRound,
  updateWant,
  wantedByOf,
} from '../../../src/features/sync/sync-folder';
import { planFolderExport } from '../../../src/features/sync/sync-export';
import { entryFp } from '../../../src/features/sync/sync-fp';
import type { KeyedState } from '../../../src/features/sync/change-set';

const A = '0123456789abcdef';
const B = 'fedcba9876543210';
const C = 'aaaaaaaaaaaaaaaa';
const st = (lid: string, body: string): KeyedState => ({ key: lid, ...entryFp({ title: lid, archetype: 'text', parentLid: null, body }) });

describe('ファイル名', () => {
  it('端末 id のファイルだけを読む(大文字・余計な字・別の拡張子は読まない)', () => {
    expect(deviceOfFileName(folderFileName(A))).toBe(A);
    expect(deviceOfFileName(`pkc3-${A.toUpperCase()}.pkc3-diff.zip`)).toBeNull();
    expect(deviceOfFileName(`pkc3-${A}.pkc3-full.zip`)).toBeNull();
    expect(deviceOfFileName(`pkc3-${A} (1).pkc3-diff.zip`), 'クラウドドライブの競合コピーは読まない').toBeNull();
    expect(deviceOfFileName('メモ.md')).toBeNull();
  });
});

describe('回の計画', () => {
  it('前の回から変わったファイルだけを読み、自分のファイルは読まない。手で同期したら全部読み直す', () => {
    const files = [
      { name: folderFileName(B), size: 10, mtime: 5 },
      { name: folderFileName(C), size: 20, mtime: 6 },
      { name: folderFileName(A), size: 30, mtime: 7 },
      { name: 'ほかのファイル.txt', size: 1, mtime: 1 },
    ];
    const rec = emptyFolderRecord();
    rec.seen[folderFileName(B)] = { size: 10, mtime: 5, want: [] };
    rec.seen[folderFileName('bbbbbbbbbbbbbbbb')] = { size: 1, mtime: 1, want: [] };
    const p = planFolderRound(A, files, rec);
    expect(p.toRead.map((f) => f.name)).toEqual([folderFileName(C)]);
    expect(p.others).toEqual([C, B].sort());
    expect(p.ownFilePresent).toBe(true);
    expect(p.vanished, 'フォルダから消えた端末は記録から外す').toEqual([folderFileName('bbbbbbbbbbbbbbbb')]);
    expect(planFolderRound(A, files, rec, true).toRead.map((f) => f.name)).toEqual([folderFileName(C), folderFileName(B)].sort());
    // 大きさが同じでも更新日時が違えば読む
    expect(planFolderRound(A, [{ name: folderFileName(B), size: 10, mtime: 9 }], rec).toRead).toHaveLength(1);
  });

  it('全件の頼み: 本文が足りなければ頼み、全件を取り込めたら下ろす。頼まれた相手を拾う', () => {
    expect(updateWant([], B, { needFull: true, complete: false })).toEqual([B]);
    expect(updateWant([B], B, { needFull: false, complete: false }), '差分だけでは下ろさない').toEqual([B]);
    expect(updateWant([B], B, { needFull: false, complete: true })).toEqual([]);
    const rec = emptyFolderRecord();
    rec.seen[folderFileName(B)] = { size: 1, mtime: 1, want: [A] };
    rec.seen[folderFileName(C)] = { size: 1, mtime: 1, want: [B] };
    expect(wantedByOf(A, rec)).toEqual([B]);
  });

  it('壊れた記録は空から', () => {
    expect(normalizeFolderRecord(null)).toEqual(emptyFolderRecord());
    expect(normalizeFolderRecord({ seen: { 'x.zip': { size: 1, mtime: 1 } }, want: ['nope', A], lastKey: 3 })).toEqual({ seen: {}, want: [A], lastKey: null });
  });

  it('失敗が続くと間隔を延ばす(上限 60 分)', () => {
    expect(backoffMinutes(5, 0)).toBe(5);
    expect(backoffMinutes(5, 1)).toBe(10);
    expect(backoffMinutes(5, 10)).toBe(60);
  });
});

describe('自分のファイルの中身(planFolderExport)', () => {
  const base = (states: KeyedState[]) => Object.fromEntries(states.map((s) => [s.key, { content: s.content, place: s.place }]));
  const now = Date.parse('2026-11-21T00:00:00Z');
  const at = '2026-11-20T00:00:00Z';
  it('自分のファイルが無い / 記録の無い相手が居る / 頼まれた → 全件', () => {
    const states = [st('n1', 'a'), st('n2', 'b')];
    const common = { device: A, seq: 1, states, tombstones: [], nowMs: now };
    expect(planFolderExport({ ...common, bases: {}, others: [], wantedBy: [], ownFilePresent: false }).complete).toBe(true);
    expect(planFolderExport({ ...common, bases: {}, others: [B], wantedBy: [], ownFilePresent: true }).complete).toBe(true);
    const bases = { [B]: { baseline: base(states), at } };
    expect(planFolderExport({ ...common, bases, others: [B], wantedBy: [], ownFilePresent: true }).complete, '対照群').toBe(false);
    expect(planFolderExport({ ...common, bases, others: [B], wantedBy: [B], ownFilePresent: true }).complete).toBe(true);
    expect(planFolderExport({ ...common, bases: { [B]: { baseline: base(states), at: '2025-01-01T00:00:00Z' } }, others: [B], wantedBy: [], ownFilePresent: true }).complete, '古い記録').toBe(true);
  });

  it('相手ごとに要る物の和を入れ、相手ごとの記録を添える。中身が同じなら要約も同じ', () => {
    const old = [st('n1', 'a'), st('n2', 'b'), st('n3', 'c')];
    const now2 = [st('n1', 'a2'), st('n2', 'b'), st('n3', 'c3')];
    const bases = {
      [B]: { baseline: base([old[0]!, now2[1]!, now2[2]!]), at }, // B は n1 だけ古い
      [C]: { baseline: base([now2[0]!, now2[1]!, old[2]!]), at }, // C は n3 だけ古い
    };
    const p = planFolderExport({ device: A, seq: 2, states: now2, tombstones: [], bases, others: [B, C], wantedBy: [], ownFilePresent: true, nowMs: now });
    expect(p.complete).toBe(false);
    expect(p.noteLids).toEqual(['n1', 'n3']);
    expect(Object.keys(p.peerBases).sort()).toEqual([B, C].sort());
    const again = planFolderExport({ device: A, seq: 9, states: now2, tombstones: [], bases, others: [C, B], wantedBy: [], ownFilePresent: true, nowMs: now });
    expect(again.writeKey, '連番・相手の並びに依らない').toBe(p.writeKey);
    const changed = planFolderExport({ device: A, seq: 9, states: [st('n1', 'a3'), now2[1]!, now2[2]!], tombstones: [], bases, others: [B, C], wantedBy: [], ownFilePresent: true, nowMs: now });
    expect(changed.writeKey).not.toBe(p.writeKey);
  });

  it('相手の記録に在ってこちらに無い物は、削除の記録として運ぶ', () => {
    const states = [st('n1', 'a')];
    const bases = { [B]: { baseline: base([st('n1', 'a'), st('gone', 'x')]), at } };
    const p = planFolderExport({ device: A, seq: 3, states, tombstones: [], bases, others: [B], wantedBy: [], ownFilePresent: true, nowMs: now });
    expect(p.tombstones.map((t) => t.key)).toEqual(['gone']);
  });
});
