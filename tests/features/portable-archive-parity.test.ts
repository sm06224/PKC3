/**
 * 🔴 **PKC3 入り HTML の取り込みは、zip を作らずに `Pkc3Archive` を直に組む**(#1416)。
 *
 * 以前の道(`writeArchive` で zip を作る → `readArchive` で読み戻す)を**ここに写しておき**、
 * 同じ材料から両方の道を通して、取り込みの本体が受け取る物(`Pkc3Archive`)と、その先の
 * `restoreArchive` の結果が**同じ**であることを縛る。── 以前の道は製品から消えたので、
 * この test の中の写しだけが「前と同じ」を言える唯一の物差しである。
 */
import { describe, expect, it } from 'vitest';
import {
  readArchive,
  restoreArchive,
  writeArchive,
  type ArchiveSource,
  type Pkc3Archive,
} from '../../src/features/export/pkc3-archive';
import { archivePreviewOf, peekArchivePreview } from '../../src/features/import/archive-preview';
import {
  assetSourceSize,
  readAssetSource,
} from '../../src/features/import/zip-reader';
import { portableArchive } from '../../src/adapter/ui/actions/import-portable';
import type { ImageArchiveData } from '../../src/adapter/platform/storage/protocol';

const NOW = new Date('2026-10-12T01:02:03.000Z');

/** 以前の `portableArchiveSource`(`writeArchive` に嵌める口)の写し。 */
function oldSource(data: ImageArchiveData, assets: ReadonlyMap<string, Blob>): ArchiveSource {
  const chainOf = new Map(data.chains.map((c) => [c.lid, c.rows]));
  return {
    cid: data.cid,
    title: data.title,
    listEntryMetas: async () => data.metas,
    listBodies: async () => ({ rows: data.bodies, done: true }),
    listRelations: async () => data.relations,
    listAssetMetas: async () => data.assets,
    getAssetBlob: async (key) => assets.get(key) ?? null,
    listTagColors: async () => data.tagColors,
    listRevisionLids: async () => data.chains.map((c) => c.lid),
    getRevisionChain: async (lid) => chainOf.get(lid) ?? [],
  };
}

async function oldPath(data: ImageArchiveData, assets: ReadonlyMap<string, Blob>): Promise<{
  archive: Pkc3Archive;
  zip: Blob;
}> {
  const out = await writeArchive(oldSource(data, assets), NOW.toISOString());
  return { archive: await readArchive(out.blob), zip: out.blob };
}

const meta = (
  lid: string,
  order: number,
  over: Partial<ImageArchiveData['metas'][number]> = {},
): ImageArchiveData['metas'][number] => ({
  lid,
  title: `題名 ${lid}`,
  archetype: 'text',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-02T00:00:00Z',
  entry_order: order,
  status: null,
  date: null,
  archived: 0,
  body_chars: null,
  ...over,
});

/** 全部の field が埋まった材料 ── 落とした field が差になって見えるように、null ばかりにしない。 */
function fixture(): { data: ImageArchiveData; assets: Map<string, Blob>; bytes: Map<string, Uint8Array> } {
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>([
    ['ast-a', new Uint8Array([1, 2, 3, 250, 251, 0, 77])],
    ['ast-b', new Uint8Array([9, 9, 9])],
  ]);
  const assets = new Map([...bytes].map(([k, v]) => [k, new Blob([v])]));
  const data: ImageArchiveData = {
    cid: 'cid-1',
    title: 'コレクション',
    metas: [
      meta('n1', 1, { status: 'open', date: '2026-03-04', archived: 1 }),
      meta('n2', 2),
      meta('n3', 3, { archetype: 'todo' }),
    ],
    bodies: [
      { lid: 'n1', body: '# 一\nasset:ast-a\n' },
      { lid: 'n2', body: '二\n' },
      { lid: 'n3', body: '{"status":"open"}' },
      // 一覧に無い本文は取り込まれない(書き出しと同じ)
      { lid: 'ghost', body: '幽霊' },
    ],
    relations: [
      {
        id: 'r1',
        from_lid: 'n1',
        to_lid: 'n2',
        kind: 'semantic',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
      },
    ],
    assets: [
      { key: 'ast-a', mime: 'image/png', size: 7, hash: 'sha256:aa' },
      // mime / size が NULL ── 書き出しと同じ既定に正規化される
      { key: 'ast-b', mime: null, size: null, hash: null },
      // 目録に在って実体が無い ── 「バックアップに入っていない添付」の注意が出る
      { key: 'ast-gone', mime: 'text/plain', size: 1, hash: null },
    ],
    // 1 つ目は有効、2 つ目は色の形が不正(落とす注意が出る)
    tagColors: [
      { tag: '赤', color: '#aa3300' },
      { tag: '青', color: 'blue' },
    ],
    chains: [
      {
        lid: 'n2',
        rows: [
          {
            revOrder: 2,
            createdAt: '2026-02-02T00:00:00Z',
            title: '題名 n2',
            archetype: 'text',
            kind: 'full',
            snapshot: '二(新)',
            contentHash: 'h2',
          },
          {
            revOrder: 1,
            createdAt: '2026-01-02T00:00:00Z',
            title: null,
            archetype: null,
            kind: 'patch',
            snapshot: '@@ -1 +1 @@',
            contentHash: null,
          },
        ],
      },
    ],
  };
  return { data, assets, bytes };
}

const restoreOpts = (existing: string[]) => {
  let n = 0;
  return {
    existingLids: new Set(existing),
    existingRelationIds: new Set<string>(),
    orderBase: 100,
    genLid: () => `gen-${++n}`,
    genRelationId: () => `grel-${++n}`,
  };
};

async function bytesOfAssets(a: Pkc3Archive): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const [k, src] of a.assetSources) {
    out[k] = [...new Uint8Array(await (await readAssetSource(src)).arrayBuffer())];
  }
  return out;
}

describe('PKC3 入り HTML → Pkc3Archive: 以前の zip 経由の道と同じ物が取り込みの本体に届く', () => {
  it('🔴 組んだ Pkc3Archive が、以前の道(writeArchive → readArchive)と中身まで一致する', async () => {
    const { data, assets } = fixture();
    const before = (await oldPath(data, assets)).archive;
    const after = portableArchive(data, assets, NOW);

    // 材料が実際に効いていること(空どうしの一致で通らない)
    expect(after.entries.map((e) => e.lid)).toEqual(['n1', 'n2', 'n3']);
    expect(after.entries[0]!.archived).toBe(true);
    expect(after.revisions).toHaveLength(2);
    expect(after.tagColors).toEqual([{ tag: '赤', color: '#aa3300' }]);
    expect(after.warnings.length, '注意が 1 件も出ない材料では警告の一致を言えない').toBeGreaterThan(0);

    expect(after.manifest).toEqual(before.manifest);
    expect(after.entries).toEqual(before.entries);
    expect(after.relations).toEqual(before.relations);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.assets).toEqual(before.assets);
    expect(after.tagColors).toEqual(before.tagColors);
    expect(after.warnings).toEqual(before.warnings);
    expect([...after.assetSources.keys()].sort()).toEqual([...before.assetSources.keys()].sort());
    expect(await bytesOfAssets(after)).toEqual(await bytesOfAssets(before));
  });

  it('🔴 その先の restoreArchive の結果も同じ(ID が衝突して付け替わる場合も)', async () => {
    const { data, assets } = fixture();
    const before = (await oldPath(data, assets)).archive;
    for (const existing of [[], ['n1', 'n3']]) {
      const a = restoreArchive(portableArchive(data, assets, NOW), restoreOpts(existing));
      const b = restoreArchive(before, restoreOpts(existing));
      expect(a, `既存 ${JSON.stringify(existing)}`).toEqual(b);
    }
    // 対照群: 衝突させると本当に付け替わっている(上の比較が素通りでない)
    const swapped = restoreArchive(portableArchive(data, assets, NOW), restoreOpts(['n1']));
    expect(swapped.entries.map((e) => e.lid)).not.toContain('n1');
  });

  it('取り込み前の確認の件数が、以前の道(manifest + 目録)と一致する', async () => {
    const { data, assets } = fixture();
    const { zip } = await oldPath(data, assets);
    const old = await peekArchivePreview(zip);
    expect(old).not.toBeNull();
    expect(archivePreviewOf(portableArchive(data, assets, NOW))).toEqual(old);
    // 実体の無い添付(ast-gone)は数えない ── 3 件の目録でも 2 件
    expect(old!.assetCount).toBe(2);
    expect(old!.noteCount).toBe(3);
  });

  it('旧い版(version 1)の読み替えや、つながり・履歴・色が無い材料でも以前の道と一致する', async () => {
    const { data, assets } = fixture();
    const bare: ImageArchiveData = { ...data, relations: [], chains: [], tagColors: [], assets: [] };
    const before = (await oldPath(bare, new Map())).archive;
    const after = portableArchive(bare, new Map(), NOW);
    expect(after.relations).toEqual([]);
    expect(after.revisions).toEqual([]);
    expect(after.tagColors).toEqual([]);
    expect(after).toEqual({ ...before, assetSources: after.assetSources });
    expect(archivePreviewOf(after).hasRelations).toBe(false);
    expect(archivePreviewOf(after).hasRevisions).toBe(false);
    void assets;
  });

  it('🔴 断り文は変わらない: ノートが 1 件も無い', () => {
    const { data, assets } = fixture();
    expect(() => portableArchive({ ...data, metas: [], bodies: [] }, assets, NOW)).toThrow(
      'この PKC3 入り HTML には、取り込めるノートが 1 件も入っていません',
    );
  });

  it('添付の在り処は Blob のまま渡る(zip を作らない)── 大きさは読まずに分かる', () => {
    const { data, assets } = fixture();
    const a = portableArchive(data, assets, NOW);
    const src = a.assetSources.get('ast-a')!;
    expect(assetSourceSize(src)).toBe(7);
    // 同じ Blob を指す = コピーしていない
    expect('blob' in src && src.blob).toBe(assets.get('ast-a'));
  });
});
