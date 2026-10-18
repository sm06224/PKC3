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
  archiveSourceLine,
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
      exportedAt: NOW,
      partial: false,
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
      exportedAt: NOW,
      partial: false,
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
      exportedAt: NOW,
      partial: false,
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
      exportedAt: NOW,
      partial: false,
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
      exportedAt: NOW,
      partial: false,
    });
    expect(msg).toContain('ノート 3 件');
    expect(msg).toContain('添付 2 件');
    expect(msg).toContain('つながり 有');
    expect(msg).toContain('履歴 無');
    // 🔑 置き換えではなく足すことを、押す前に言う(#1087)
    expect(msg).toContain('いまのノートはそのまま残り、これが追加されます。取り込んだ後でも取り消せます');
  });

  it('🔴 窓の頭に、ファイル名と取った日時を出す(#1643 依頼 38-3)', () => {
    const msg = formatArchivePreviewMessage(
      { noteCount: 1, assetCount: 0, hasRelations: false, hasRevisions: false, exportedAt: '2026-10-10T09:20:00.000Z', partial: false },
      'メモ-20261010.pkc3-full.zip',
    );
    const head = msg.split('\n')[0]!;
    // 時刻は端末の時刻 ── 期待値も同じ端末の Date で組む(環境の時差に依らない)
    const d = new Date('2026-10-10T09:20:00.000Z');
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(head).toBe(`メモ-20261010.pkc3-full.zip(${d.getMonth() + 1}月${d.getDate()}日 ${hm} に取りました)`);
    expect(msg.split('\n')[1]).toBe('このバックアップには、次が入っています。');
  });

  it('名前だけ・日時だけ・どちらも無い、を壊さずに言う(読めない日時は黙って省く)', () => {
    const base = { noteCount: 1, assetCount: 0, hasRelations: false, hasRevisions: false, partial: false };
    expect(archiveSourceLine('a.zip', null)).toBe('a.zip');
    expect(archiveSourceLine(undefined, null)).toBeNull();
    expect(archiveSourceLine('', 'でたらめ')).toBeNull();
    expect(archiveSourceLine('a.zip', 'でたらめ')).toBe('a.zip');
    expect(archiveSourceLine(undefined, '2026-10-10T09:20:00.000Z')).toMatch(/月.*日 \d\d:\d\d に取りました$/);
    expect(formatArchivePreviewMessage({ ...base, exportedAt: null }).split('\n')[0]).toBe(
      'このバックアップには、次が入っています。',
    );
  });
});

describe('🔴 拾えた分だけのバックアップを、ファイルの中の印で言う(依頼 119-4)', () => {
  const base = { noteCount: 2, assetCount: 0, hasRevisions: false, exportedAt: null };

  it('partial の zip は、名前に依らず peek が partial を返す(対照群: 通常の zip は false)', async () => {
    const part = await writeArchive({ ...source({ entries: [{ lid: 'a', body: 'A' }] }), partial: true }, NOW);
    const full = await writeArchive(source({ entries: [{ lid: 'a', body: 'A' }] }), NOW);
    // ⚠ peek は Blob だけを受ける ── ファイル名は渡せない(= 名前を変えても同じ)
    expect((await peekArchivePreview(part.blob))!.partial).toBe(true);
    expect((await peekArchivePreview(full.blob))!.partial).toBe(false);
  });

  it('作り直しの保険の zip(rebuildArchiveSource)は partial を書く', async () => {
    const { rebuildArchiveSource } = await import('../../src/features/storage/container-rebuild');
    const { source: src } = rebuildArchiveSource({
      cid: 'c1',
      title: 't',
      rows: [{ lid: 'a', title: 'A', archetype: 'text', body: 'x', entryOrder: 1, createdAt: null, updatedAt: null }],
      skipped: 0,
      empty: 0,
    });
    expect((await peekArchivePreview((await writeArchive(src, NOW)).blob))!.partial).toBe(true);
  });

  it('つながりが入っていないときは「フォルダの入り方は入っていません」と言う', () => {
    const msg = formatArchivePreviewMessage({ ...base, hasRelations: false, partial: true });
    expect(msg).toContain('壊れたときに拾えた分だけのバックアップです。フォルダの入り方は入っていません。');
  });

  it('つながりが入っているときは、嘘になる「入っていません」を言わない', () => {
    const msg = formatArchivePreviewMessage({ ...base, hasRelations: true, partial: true });
    expect(msg).toContain('壊れたときに拾えた分だけのバックアップです。読めなかったノート・つながり・履歴は入っていません。');
    expect(msg).not.toContain('フォルダの入り方は入っていません');
  });

  it('通常のバックアップには出さない', () => {
    expect(formatArchivePreviewMessage({ ...base, hasRelations: false, partial: false })).not.toContain('拾えた分だけ');
  });
});
