/**
 * バックアップ zip の読み取りの穴(B3 / B4 / B8)。
 *
 * - B3: 壊れた zip(CRC 不一致・途中で切れた)を「PKC の zip ではない」と言わない
 * - B4: フォルダごと zip にし直したバックアップ(`X/manifest.json`)を peek と read の両方で読む
 * - B8: 警告に内部の部品名(manifest / container.json / ast-…)を出さない
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_FORMAT,
  readArchive,
} from '../../src/features/export/pkc3-archive';
import { peekZipFormat, readPkc2Package } from '../../src/features/import/pkc2-package';
import { peekArchivePreview } from '../../src/features/import/archive-preview';
import { ZipReadError, unwrapSingleTopDir, readZipDirectory } from '../../src/features/import/zip-reader';
import { buildZip, bytesOf, type FixtureEntry } from './zip-fixture';

const ARCHIVE_ENTRY = {
  lid: 'n1',
  title: 'ノート一',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  body: '本文',
};

function archiveEntries(
  over: { counts?: Record<string, number>; container?: unknown; prefix?: string } = {},
): FixtureEntry[] {
  const p = over.prefix ?? '';
  return [
    {
      name: `${p}manifest.json`,
      bytes: bytesOf(
        JSON.stringify({
          format: ARCHIVE_FORMAT,
          version: 2,
          counts: over.counts ?? { entries: 1, relations: 0, revisions: 0, assets: 0 },
        }),
      ),
    },
    {
      name: `${p}container.json`,
      bytes: bytesOf(
        JSON.stringify(over.container ?? { entries: [ARCHIVE_ENTRY], relations: [], revisions: [], assets: [] }),
      ),
    },
  ];
}

const PKC2_CONTAINER = {
  meta: { container_id: 'c-old', title: '旧' },
  entries: [{ lid: 'n1', title: 'ノート', archetype: 'text', body: '# 本文\n' }],
  relations: [],
  revisions: [],
  assets: {},
};

function pkc2Entries(prefix = ''): FixtureEntry[] {
  return [
    {
      name: `${prefix}manifest.json`,
      bytes: bytesOf(JSON.stringify({ format: 'pkc2-package', version: 1, entry_count: 1 })),
    },
    { name: `${prefix}container.json`, bytes: bytesOf(JSON.stringify(PKC2_CONTAINER)) },
    { name: `${prefix}assets/ast-x1.bin`, bytes: bytesOf('bytes') },
  ];
}

describe('B3: 壊れた zip を「PKC の zip ではない」にしない', () => {
  it('manifest の CRC が合わない zip は、形式を判別する段で「途中で切れた」と断る(null にしない)', async () => {
    const zip = await buildZip(archiveEntries().map((e) => (e.name === 'manifest.json' ? { ...e, corruptCrc: true } : e)));
    await expect(peekZipFormat(zip)).rejects.toBeInstanceOf(ZipReadError);
    await expect(peekZipFormat(zip)).rejects.toThrow(/ダウンロードが途中で切れた可能性/);
  });

  it('取り込み前の中身の確認(peekArchivePreview)も同じく断る(確認なしで素通しにしない)', async () => {
    const zip = await buildZip(archiveEntries().map((e) => (e.name === 'manifest.json' ? { ...e, corruptCrc: true } : e)));
    await expect(peekArchivePreview(zip)).rejects.toThrow(/ダウンロードが途中で切れた可能性/);
  });

  it('対照群: manifest が JSON として読めない zip は、従来どおり null(形式不明)', async () => {
    const zip = await buildZip([{ name: 'manifest.json', bytes: bytesOf('これは JSON ではない') }]);
    expect(await peekZipFormat(zip)).toBeNull();
    expect(await peekArchivePreview(zip)).toBeNull();
  });

  it('対照群: manifest が無い zip は null、正常なバックアップは形式を返す', async () => {
    expect(await peekZipFormat(await buildZip([{ name: 'a.txt', bytes: bytesOf('x') }]))).toBeNull();
    expect(await peekZipFormat(await buildZip(archiveEntries()))).toBe(ARCHIVE_FORMAT);
  });
});

describe('B4: フォルダごと zip にし直したバックアップ', () => {
  it('PKC3 のバックアップ: 共通のフォルダの下でも、形式の判別・中身の確認・読み込みが通る', async () => {
    const zip = await buildZip(archiveEntries({ prefix: 'my-backup/' }));
    expect(await peekZipFormat(zip)).toBe(ARCHIVE_FORMAT);
    expect((await peekArchivePreview(zip))?.noteCount).toBe(1);
    const got = await readArchive(zip);
    expect(got.entries.map((e) => e.lid)).toEqual(['n1']);
  });

  it('PKC2 のバックアップ: 共通のフォルダの下でも、判別と読み込み(添付の在り処を含む)が通る', async () => {
    const zip = await buildZip(pkc2Entries('pkg/'));
    expect(await peekZipFormat(zip)).toBe('pkc2-package');
    const got = await readPkc2Package(zip);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
  });

  it('Mac の付属物(__MACOSX/ と .DS_Store)は無いものとして扱う', async () => {
    const zip = await buildZip([
      ...archiveEntries({ prefix: 'b/' }),
      { name: '__MACOSX/b/._manifest.json', bytes: bytesOf('junk') },
      { name: '.DS_Store', bytes: bytesOf('junk') },
      { name: 'b/.DS_Store', bytes: bytesOf('junk') },
    ]);
    expect(await peekZipFormat(zip)).toBe(ARCHIVE_FORMAT);
    expect((await readArchive(zip)).entries).toHaveLength(1);
  });

  it('フォルダが 2 つ以上あるとき(入れ物が複数)は読み替えない', async () => {
    const zip = await buildZip([...archiveEntries({ prefix: 'a/' }), { name: 'b/other.txt', bytes: bytesOf('x') }]);
    expect(await peekZipFormat(zip)).toBeNull();
    await expect(readArchive(zip)).rejects.toThrow(/バックアップの概要が入っていません/);
  });

  it('最上位に manifest がある普通の zip は、名前を 1 つも変えない', async () => {
    const dir = await readZipDirectory(await buildZip(archiveEntries()));
    const r = unwrapSingleTopDir(dir);
    expect(r.prefix).toBe('');
    expect(r.entries.map((e) => e.name)).toEqual(['manifest.json', 'container.json']);
  });

  it('読み手がフォルダ付きに対応していない形式(PKC2 のほかの書き出し)は、従来どおり判別しない', async () => {
    const zip = await buildZip([
      { name: 'x/manifest.json', bytes: bytesOf(JSON.stringify({ format: 'pkc2-text-bundle', version: 1 })) },
    ]);
    expect(await peekZipFormat(zip)).toBeNull();
  });
});

describe('B8: 警告に内部の名前を出さない', () => {
  const FORBIDDEN = /manifest|container\.json|ast-[0-9a-f]|entries|relations|revisions/;

  it('件数の食い違い: ノート・つながり・履歴を日本語で言う', async () => {
    const zip = await buildZip(
      archiveEntries({ counts: { entries: 9, relations: 4, revisions: 3 } }),
    );
    const w = (await readArchive(zip)).warnings;
    expect(w).toEqual([
      'バックアップに記録されたノートの数と、実際に入っている数が合いません(記録 9 件 / 実際 1 件)',
      'バックアップに記録されたつながりの数と、実際に入っている数が合いません(記録 4 件 / 実際 0 件)',
      'バックアップに記録された履歴の数と、実際に入っている数が合いません(記録 3 件 / 実際 0 件)',
    ]);
    for (const m of w) expect(m).not.toMatch(FORBIDDEN);
  });

  it('入っていない添付: ID ではなく、その添付を持つノートの題名で言う', async () => {
    const zip = await buildZip(
      archiveEntries({
        container: {
          entries: [{ ...ARCHIVE_ENTRY, archetype: 'attachment', title: '写真', body: 'asset_key: ast-0123abcd' }],
          assets: [{ key: 'ast-0123abcd', mime: 'image/png', size: 1, hash: null }],
        },
      }),
    );
    const w = (await readArchive(zip)).warnings;
    expect(w).toEqual(['バックアップに入っていない添付があります: 「写真」の添付']);
    expect(w[0]).not.toMatch(FORBIDDEN);
  });

  it('入っていない添付: 持ち主のノートが分からないときも ID は出さない', async () => {
    const zip = await buildZip(
      archiveEntries({
        container: {
          entries: [ARCHIVE_ENTRY],
          assets: [{ key: 'ast-0123abcd', mime: 'image/png', size: 1, hash: null }],
        },
      }),
    );
    expect((await readArchive(zip)).warnings).toEqual([
      'バックアップに入っていない添付があります: 題名の分からないノートの添付',
    ]);
  });

  it('本体が無い zip は「container.json」ではなく「バックアップの本体」と言う', async () => {
    const zip = await buildZip([archiveEntries()[0]!]);
    const e = await readArchive(zip).then(
      () => null,
      (x: unknown) => x as Error,
    );
    expect(e?.message).toBe('バックアップの本体が入っていません(この zip は読み取れません)');
  });
});
