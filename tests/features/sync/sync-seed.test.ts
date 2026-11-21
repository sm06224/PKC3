/**
 * 🔴 端末間の同期(#2000 段 2)── バックアップに添える種の指紋(設計 doc §12.1 の約束 2)。
 * 実物の worker を通す往復(2 台)は `tests/adapter/sync-diff-roundtrip.test.ts` の「バックアップの種」。
 */
import { describe, expect, it } from 'vitest';
import { readArchive, writeArchive, type ArchiveSource } from '../../../src/features/export/pkc3-archive';
import { parseSyncSeed, seedFromBackup, type SyncSeed } from '../../../src/features/sync/sync-seed';

const DEV = 'abcdef0123456789';
const seed: SyncSeed = { device: DEV, fingerprints: [{ key: 'a', c: 'ca', p: 'pa' }, { key: 'b', c: 'cb', p: '' }, { key: 'rel:a|b|semantic', c: 'rc' }, { key: 'rel:a|zzz|semantic', c: 'rc' }] };

function source(withSeed: SyncSeed | null | undefined): ArchiveSource {
  return {
    cid: 'c',
    title: 't',
    listEntryMetas: async () => [{ lid: 'a', title: '日本語', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 }],
    listBodies: async () => ({ rows: [{ lid: 'a', body: '本文' }], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
    ...(withSeed === undefined ? {} : { syncSeed: async () => withSeed }),
  };
}

describe('syncSeed(バックアップに添える種)', () => {
  it('書いて読むと戻る(空の place も落とさない)。無い・null のときは、キーごと書かない(今までと同じ)', async () => {
    const a = await readArchive((await writeArchive(source(seed), '2026-11-21T00:00:00Z')).blob);
    expect(a.syncSeed).toEqual(seed);
    for (const s of [undefined, null]) {
      const out = await writeArchive(source(s), '2026-11-21T00:00:00Z');
      expect((await readArchive(out.blob)).syncSeed).toBeNull();
      expect(await out.blob.text()).not.toContain('syncSeed');
    }
    // 書いた物と書かない物で、ほかの内容は同じ
    const withSeed = await readArchive((await writeArchive(source(seed), '2026-11-21T00:00:00Z')).blob);
    const without = await readArchive((await writeArchive(source(undefined), '2026-11-21T00:00:00Z')).blob);
    expect(withSeed.entries).toEqual(without.entries);
  });
  it('parseSyncSeed: 形が違う・端末 id が壊れていれば null(取り込み全体は失敗させない)', () => {
    expect(parseSyncSeed(seed)).toEqual(seed);
    expect(parseSyncSeed({ device: 'zz', fingerprints: [] })).toBeNull();
    expect(parseSyncSeed({ device: DEV, fingerprints: [{ key: 'a' }] })).toBeNull();
    expect(parseSyncSeed({ device: DEV, fingerprints: 'x' })).toBeNull();
    expect(parseSyncSeed(null)).toBeNull();
    expect(parseSyncSeed([])).toBeNull();
  });
  it('seedFromBackup: lid が変わらずに入ったノートと、両端が入ったつながりだけ。空の place は残す', () => {
    const b = seedFromBackup(seed, new Set(['a', 'b']));
    expect(Object.keys(b).sort()).toEqual(['a', 'b', 'rel:a|b|semantic']);
    expect(b.b).toEqual({ content: 'cb', place: '' });
    expect(seedFromBackup(seed, new Set(['a']))).toEqual({ a: { content: 'ca', place: 'pa' } });
    expect(seedFromBackup(seed, new Set())).toEqual({});
  });
});
