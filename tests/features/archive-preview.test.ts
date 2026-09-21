/**
 * #1017 段④b 追補: 取込前に中身を言う(「3 か所で中身を言う」の 3 つ目)。
 *
 * 🔑 **manifest だけを読んで判定し、旧 `.pkc3.zip` でも同じ表が出ることを見る**
 * (`archive-kind.ts` と同じ規律 ── file 名は一切見ない)。
 */
import { describe, expect, it } from 'vitest';
import {
  writeArchive,
  type ArchiveSource,
} from '../../src/features/export/pkc3-archive';
import {
  peekArchivePreview,
  formatArchivePreviewMessage,
} from '../../src/features/import/archive-preview';

const enc = new TextEncoder();
const NOW = '2026-09-21T00:00:00.000Z';

/** `tests/features/pkc3-archive.test.ts` の fixture と同じ形の最小版。 */
function source(f: {
  entries: Array<{ lid: string; body: string }>;
  relations?: Array<{ id: string; from_lid: string; to_lid: string; kind: string }>;
  assets?: Array<{ key: string; mime: string; size: number; hash: string | null; bytes: string }>;
  revisions?: Record<string, Array<{ id: string; rev_order: number; kind: string; snapshot: string }>>;
}): ArchiveSource {
  const entries = f.entries.map((e, i) => ({
    lid: e.lid,
    title: e.lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  const revs = f.revisions ?? {};
  return {
    cid: 'c1',
    title: 'テスト container',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    listBodies: async () => ({
      rows: entries.map((e) => ({ lid: e.lid, body: e.body })),
      done: true,
    }),
    listRelations: async () =>
      (f.relations ?? []).map((r) => ({ ...r, created_at: null, updated_at: null })),
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({ key: a.key, mime: a.mime, size: a.size, hash: a.hash })),
    getAssetBlob: async (key) => {
      const a = (f.assets ?? []).find((x) => x.key === key);
      return a === undefined ? null : new Blob([enc.encode(a.bytes)]);
    },
    listRevisionLids: async () => Object.keys(revs),
    getRevisionChain: async (lid) =>
      (revs[lid] ?? []).map((r) => ({
        revOrder: r.rev_order,
        createdAt: null,
        title: null,
        archetype: null,
        kind: r.kind,
        snapshot: r.snapshot,
        contentHash: null,
      })),
  };
}

describe('peekArchivePreview ── 3 つの file 型 + 旧形式', () => {
  it('🔑 全部入り(ノート・添付・つながり・履歴)── 「full」相当', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: '本文1' }, { lid: 'n2', body: '本文2' }],
      relations: [{ id: 'r1', from_lid: 'n1', to_lid: 'n2', kind: 'structural' }],
      assets: [{ key: 'k1', mime: 'image/png', size: 8, hash: 'h1', bytes: 'PNGBYTES' }],
      revisions: { n1: [{ id: 'rv1', rev_order: 1, kind: 'full', snapshot: 'v1' }] },
    });
    const blob = (await writeArchive(src, NOW)).blob;
    const preview = await peekArchivePreview(blob);
    expect(preview).toEqual({
      noteCount: 2,
      assetCount: 1,
      hasRelations: true,
      hasRevisions: true,
    });
  });

  it('🔴 対照群: つながり無し・履歴無し(「-notes」相当)は両方「無」', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: '本文' }],
      assets: [{ key: 'k1', mime: 'image/png', size: 8, hash: 'h1', bytes: 'PNGBYTES' }],
      // relations / revisions を渡さない
    });
    const blob = (await writeArchive(src, NOW)).blob;
    const preview = await peekArchivePreview(blob);
    expect(preview).toEqual({
      noteCount: 1,
      assetCount: 1,
      hasRelations: false,
      hasRevisions: false,
    });
  });

  it('添付・つながり・履歴が 0 件(「-part」の最小形に近い)', async () => {
    const src = source({ entries: [{ lid: 'n1', body: '本文だけ' }] });
    const blob = (await writeArchive(src, NOW)).blob;
    const preview = await peekArchivePreview(blob);
    expect(preview).toEqual({
      noteCount: 1,
      assetCount: 0,
      hasRelations: false,
      hasRevisions: false,
    });
  });

  it('🔑 旧 `.pkc3.zip` でも同じ表が出る(判定は manifest.format だけ、file 名は見ない)', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: '本文1' }, { lid: 'n2', body: '本文2' }],
      relations: [{ id: 'r1', from_lid: 'n1', to_lid: 'n2', kind: 'structural' }],
    });
    // ⚠ 中身の形式は full/notes/part/旧形式で完全に同一(`archive-kind.ts` の
    // 設計コメントどおり)── file 名を変えても中身は 1 バイトも変わらないので、
    // ここでは「File 名を持たせずに Blob のまま渡しても同じ結果になる」ことで
    // 「file 名を見ていない」ことを確かめる(見ていれば、この Blob には
    // どんな名前も無いので判定できないはず)。
    const blob = (await writeArchive(src, NOW)).blob;
    const preview = await peekArchivePreview(blob);
    expect(preview).toEqual({
      noteCount: 2,
      assetCount: 0,
      hasRelations: true,
      hasRevisions: false,
    });
  });

  it('PKC3 のアーカイブでない ZIP は null(確認を出さずに素通しする合図)', async () => {
    // manifest.json は無い(通常の zip)── `pkc2-package.test.ts` 等と同型の断り方
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const w = new ZipWriter();
    await w.add('readme.txt', ['hello']);
    const preview = await peekArchivePreview(w.finish());
    expect(preview).toBeNull();
  });
});

describe('formatArchivePreviewMessage', () => {
  it('🔑 ノート件数・添付件数・つながり・履歴を画面の言葉で書く', () => {
    const msg = formatArchivePreviewMessage({
      noteCount: 3,
      assetCount: 2,
      hasRelations: true,
      hasRevisions: false,
    });
    expect(msg).toContain('ノート 3 件');
    expect(msg).toContain('添付 2 件');
    expect(msg).toContain('つながり 有');
    expect(msg).toContain('履歴 無');
  });
});
