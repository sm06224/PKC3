/**
 * P6c 段②: `pkc2-package` の受理。
 *
 * fixture は **PKC2 の writer が実際に吐く形**をなぞって組む(2026-08-01 の
 * read-only 調査で確認した事実 ── manifest の 8 field / container は assets 空 /
 * `assets/<key>.bin` に生バイナリ / method 0 / UTF-8 flag / 本物の CRC)。
 *
 * 網の重点は P6b と同じで **「読めたつもりで 0 件」を作らない**こと ──
 * 形が違う入力はすべて理由付きで断る側を pin する。
 */
import { describe, expect, it } from 'vitest';
import { readPkc2Package } from '../../src/features/import/pkc2-package';
import { readAssetSource } from '../../src/features/import/zip-reader';
import { buildZip, bytesOf, type FixtureEntry } from './zip-fixture';

const CONTAINER = {
  meta: { container_id: 'c-old', title: '旧コンテナ' },
  entries: [
    { lid: 'n1', title: 'ノート', archetype: 'text', body: '# 本文\n' },
    {
      lid: 'a1',
      title: 'dot.png',
      archetype: 'attachment',
      body: JSON.stringify({ name: 'dot.png', mime: 'image/png', asset_key: 'ast-x1' }),
    },
  ],
  relations: [],
  revisions: [],
  assets: {}, // ← PKC2 の writer は assets を空にして container.json を書く
};

const manifestOf = (over: Record<string, unknown> = {}) => ({
  format: 'pkc2-package',
  version: 1,
  exported_at: '2026-07-31T00:00:00.000Z',
  source_cid: 'c-old',
  entry_count: 2,
  relation_count: 0,
  revision_count: 0,
  asset_count: 1,
  ...over,
});

function pkg(
  over: {
    manifest?: Record<string, unknown> | null;
    container?: unknown;
    extra?: FixtureEntry[];
    assets?: Record<string, Uint8Array>;
  } = {},
): Promise<Blob> {
  const entries: FixtureEntry[] = [];
  if (over.manifest !== null) {
    entries.push({
      name: 'manifest.json',
      bytes: bytesOf(JSON.stringify(over.manifest ?? manifestOf(), null, 2)),
    });
  }
  if (over.container !== null) {
    entries.push({
      name: 'container.json',
      bytes: bytesOf(JSON.stringify(over.container ?? CONTAINER, null, 2)),
    });
  }
  for (const [k, v] of Object.entries(over.assets ?? { 'ast-x1': bytesOf('画像の bytes') })) {
    entries.push({ name: `assets/${k}.bin`, bytes: v });
  }
  entries.push(...(over.extra ?? []));
  return buildZip(entries);
}

describe('readPkc2Package', () => {
  it('manifest / container / asset entry を取り出す(bytes はまだ読まない)', async () => {
    const zip = await pkg();
    const got = await readPkc2Package(zip);

    expect(got.manifest.format).toBe('pkc2-package');
    expect((got.container as typeof CONTAINER).entries).toHaveLength(2);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
    expect(got.warnings).toEqual([]);

    // bytes は呼び出し側が 1 件ずつ読む(base64 を経由しない)
    const blob = await readAssetSource(got.assetSources.get('ast-x1')!);
    expect(await blob.text()).toBe('画像の bytes');
  });

  it('asset key に `.` が入っていても完全一致で引ける(拡張子を剥がさない)', async () => {
    // bundle 系の「拡張子を剥がす」突合だと、この key はマッチせず無言で欠落する
    const zip = await pkg({ assets: { 'thumb-2026.07.31-a': bytesOf('x') } });
    const got = await readPkc2Package(zip);
    expect([...got.assetSources.keys()]).toEqual(['thumb-2026.07.31-a']);
  });

  it('Office 文書は名指しで断る(不明に混ぜない)', async () => {
    const zip = await buildZip([
      { name: '[Content_Types].xml', bytes: bytesOf('<Types/>') },
      { name: 'xl/workbook.xml', bytes: bytesOf('<workbook/>') },
    ]);
    await expect(readPkc2Package(zip)).rejects.toThrow(/Office 文書/);
  });

  it('manifest が無い / 壊れている / 別形式 / 未対応版 はすべて理由付きで断る', async () => {
    await expect(readPkc2Package(await pkg({ manifest: null }))).rejects.toThrow(
      /manifest\.json が無い/,
    );
    await expect(
      readPkc2Package(await buildZip([{ name: 'manifest.json', bytes: bytesOf('{ 壊れた') }])),
    ).rejects.toThrow(/解釈できません/);
    await expect(
      readPkc2Package(await pkg({ manifest: manifestOf({ format: 'pkc2-text-bundle' }) })),
    ).rejects.toThrow(/pkc2-package のみ/);
    await expect(
      readPkc2Package(await pkg({ manifest: manifestOf({ version: 2 }) })),
    ).rejects.toThrow(/未対応の package version/);
  });

  it('container が無い / 形が違う も断る(「読めるところだけ読む」をしない)', async () => {
    await expect(readPkc2Package(await pkg({ container: null }))).rejects.toThrow(
      /container\.json が入っていません/,
    );
    await expect(readPkc2Package(await pkg({ container: { meta: {} } }))).rejects.toThrow(
      /形が想定と違います/,
    );
    await expect(readPkc2Package(await pkg({ container: [] }))).rejects.toThrow(
      /形が想定と違います/,
    );
  });

  it('manifest / container の重複は断る(どちらが正か決められない)', async () => {
    const dupManifest = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifestOf())) },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(CONTAINER)) },
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifestOf())) },
    ]);
    await expect(readPkc2Package(dupManifest)).rejects.toThrow(/manifest\.json が 2 個/);

    const dupContainer = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifestOf())) },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(CONTAINER)) },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(CONTAINER)) },
    ]);
    await expect(readPkc2Package(dupContainer)).rejects.toThrow(/container\.json が 2 個/);
  });

  it('asset key の重複は断る(どちらの bytes か決められない)', async () => {
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifestOf())) },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(CONTAINER)) },
      { name: 'assets/ast-x1.bin', bytes: bytesOf('A') },
      { name: 'assets/ast-x1.bin', bytes: bytesOf('B') },
    ]);
    await expect(readPkc2Package(zip)).rejects.toThrow(/重複/);
  });

  it('assets/ の中の想定外ファイルは無視するが**警告に出す**', async () => {
    // PKC2 は `.bin` 以外を無警告で無視していた
    const zip = await pkg({
      extra: [{ name: 'assets/README.txt', bytes: bytesOf('メモ') }],
      assets: { 'ast-x1': bytesOf('x') },
    });
    const got = await readPkc2Package(zip);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
    expect(got.warnings.some((w) => w.includes('README.txt'))).toBe(true);
  });

  it('manifest の件数が中身と違えば警告に出す(断りはしない)', async () => {
    const zip = await pkg({ manifest: manifestOf({ entry_count: 99, asset_count: 7 }) });
    const got = await readPkc2Package(zip);
    expect(got.warnings.some((w) => w.includes('entry 件数'))).toBe(true);
    expect(got.warnings.some((w) => w.includes('asset 件数'))).toBe(true);
    // 警告であって失敗ではない ── 中身は読めている
    expect((got.container as typeof CONTAINER).entries).toHaveLength(2);
  });

  it('assets ディレクトリ entry(`assets/`)は asset として数えない', async () => {
    const zip = await pkg({
      extra: [{ name: 'assets/', bytes: bytesOf(''), isDirectory: true }],
    });
    const got = await readPkc2Package(zip);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
    expect(got.warnings).toEqual([]); // ディレクトリは「想定外ファイル」ではない
  });

  it('deflate で再梱包された package も読める(PKC2 自身は読めない形)', async () => {
    // PKC2 の reader は method 0 のみ ── user が ZIP ツールで開いて保存し直すと
    // PKC2 では読めなくなるが、PKC3 は読める
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify(manifestOf({ asset_count: 1 }))),
        method: 8,
      },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(CONTAINER)), method: 8 },
      { name: 'assets/ast-x1.bin', bytes: bytesOf('圧縮された bytes'), method: 8 },
    ]);
    const got = await readPkc2Package(zip);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
    expect(await (await readAssetSource(got.assetSources.get('ast-x1')!)).text()).toBe(
      '圧縮された bytes',
    );
  });

  it('asset key として不正な名前は無視して警告に出す(無害化の担当はここ)', async () => {
    // reader は純機構なので名前を無害化しない ── key として使う側が検査する
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifestOf({ asset_count: 1 }))) },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(CONTAINER)) },
      { name: 'assets/ast-x1.bin', bytes: bytesOf('正しい') },
      { name: 'assets/../../etc/passwd.bin', bytes: bytesOf('悪意') },
      { name: 'assets//absolute/path.bin', bytes: bytesOf('悪意') },
    ]);
    const got = await readPkc2Package(zip);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
    expect(got.warnings.filter((w) => w.includes('不正な名前'))).toHaveLength(2);
  });

  it('Info-ZIP で再梱包された package(bit 11 なしの UTF-8 名)も読める', async () => {
    // Linux / macOS の `zip` は UTF-8 名を bit 11 を立てずに書く ── 拒否していると
    // 「ZIP ツールで開いて保存し直した」という現実の入力が丸ごと通らない
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify(manifestOf({ asset_count: 1 }))),
        flags: 0,
      },
      { name: 'container.json', bytes: bytesOf(JSON.stringify(CONTAINER)), flags: 0 },
      { name: 'assets/ast-x1.bin', bytes: bytesOf('日本語の中身'), flags: 0 },
      { name: '添付メモ.txt', bytes: bytesOf('非 ASCII 名の同梱ファイル'), flags: 0 },
    ]);
    const got = await readPkc2Package(zip);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
  });
});
