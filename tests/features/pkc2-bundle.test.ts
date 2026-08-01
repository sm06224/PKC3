/**
 * P6c 段③: `.text.zip`(単体 entry バンドル)の受理。
 *
 * package(段②)と違い `container.json` が無いので、**合成 container** を組む。
 * fixture は PKC2 の writer が実際に吐く形をなぞる(2026-08-01 の read-only 調査
 * ── manifest.assets が key→{name,mime} の正本 / body.md は verbatim /
 * `assets/<key><ext>` の ext は空になりうる)。
 */
import { describe, expect, it } from 'vitest';
import { readTextBundle, readTextlogBundle } from '../../src/features/import/pkc2-bundle';
import { readAssetSource } from '../../src/features/import/zip-reader';
import { buildZip, bytesOf, type FixtureEntry } from './zip-fixture';

const manifestOf = (over: Record<string, unknown> = {}) => ({
  format: 'pkc2-text-bundle',
  version: 1,
  exported_at: '2026-07-31T00:00:00.000Z',
  source_cid: 'c-old',
  source_lid: 'n1',
  source_title: '旧ノート',
  body_length: 10,
  asset_count: 1,
  missing_asset_count: 0,
  missing_asset_keys: [],
  assets: { 'ast-x1': { name: 'dot.png', mime: 'image/png' } },
  compacted: false,
  ...over,
});

const bundle = (over: { manifest?: Record<string, unknown>; body?: string; extra?: FixtureEntry[] } = {}) =>
  buildZip([
    { name: 'manifest.json', bytes: bytesOf(JSON.stringify(over.manifest ?? manifestOf(), null, 2)) },
    { name: 'body.md', bytes: bytesOf(over.body ?? '# 旧ノート\n![図](asset:ast-x1)\n') },
    ...(over.extra ?? [{ name: 'assets/ast-x1.png', bytes: bytesOf('PNG の bytes') }]),
  ]);

type Synth = { entries: Array<{ lid: string; title: string; archetype: string; body: string }> };

describe('readTextBundle', () => {
  it('合成 container を組む(attachment × N + text × 1)', async () => {
    const zip = await bundle();
    const got = await readTextBundle(zip);

    const c = got.container as Synth;
    expect(c.entries.map((e) => e.archetype)).toEqual(['attachment', 'text']);
    // text は body.md verbatim(source_lid / source_title を引き継ぐ)
    const text = c.entries[1]!;
    expect(text.lid).toBe('n1');
    expect(text.title).toBe('旧ノート');
    expect(text.body).toBe('# 旧ノート\n![図](asset:ast-x1)\n');
    // attachment は **PKC2 入力の写し**(保存されるのは fromPkc2 後の PKC-Markdown)
    const att = JSON.parse(c.entries[0]!.body) as Record<string, unknown>;
    expect(att).toMatchObject({ name: 'dot.png', mime: 'image/png', asset_key: 'ast-x1' });
    // manifest に size は無いので**展開後のバイト長**を使う(PKC2 と同じ)
    expect(att.size).toBe(bytesOf('PNG の bytes').length);

    expect([...got.assetEntries.keys()]).toEqual(['ast-x1']);
    expect(await (await readAssetSource(got.assetEntries.get('ast-x1')!)).text()).toBe(
      'PNG の bytes',
    );
    expect(got.warnings).toEqual([]);
  });

  it('🔑 拡張子を剥がさない ── key に `.` や非 ASCII が入っても引ける', async () => {
    // PKC2 の読み側は `^([A-Za-z0-9_-]+)\.[A-Za-z0-9]{1,8}$` で剥がしており、
    // この key は**マッチせず無言で落ちていた**
    const key = 'thumb-2026.07.31-添付';
    const zip = await bundle({
      manifest: manifestOf({ assets: { [key]: { name: 'x.png', mime: 'image/png' } } }),
      extra: [{ name: `assets/${key}.png`, bytes: bytesOf('x') }],
    });
    expect([...(await readTextBundle(zip)).assetEntries.keys()]).toEqual([key]);
  });

  it('拡張子が無い実体(未知 mime)も引ける', async () => {
    const zip = await bundle({
      manifest: manifestOf({ assets: { k: { name: 'blob', mime: 'application/x-unknown' } } }),
      extra: [{ name: 'assets/k', bytes: bytesOf('bytes') }],
    });
    expect([...(await readTextBundle(zip)).assetEntries.keys()]).toEqual(['k']);
  });

  it('key が別 key の prefix でも取り違えない', async () => {
    const zip = await bundle({
      manifest: manifestOf({
        assets: { k1: { name: 'a', mime: 'image/png' }, k1x: { name: 'b', mime: 'image/png' } },
      }),
      extra: [
        { name: 'assets/k1.png', bytes: bytesOf('AAA') },
        { name: 'assets/k1x.png', bytes: bytesOf('BBBBB') },
      ],
    });
    const got = await readTextBundle(zip);
    expect(got.assetEntries.get('k1')!.entry.uncompressedSize).toBe(3);
    expect(got.assetEntries.get('k1x')!.entry.uncompressedSize).toBe(5);
  });

  it('実体が複数ある key は ambiguous として断る', async () => {
    const zip = await bundle({
      extra: [
        { name: 'assets/ast-x1.png', bytes: bytesOf('A') },
        { name: 'assets/ast-x1.jpg', bytes: bytesOf('B') },
      ],
    });
    await expect(readTextBundle(zip)).rejects.toThrow(/複数あります/);
  });

  it('manifest にあって実体が無い / 実体があって manifest に無い を両方警告する', async () => {
    const zip = await bundle({
      manifest: manifestOf({
        assets: { 'ast-x1': { name: 'dot.png', mime: 'image/png' }, gone: { name: 'g', mime: 'x' } },
      }),
      extra: [
        { name: 'assets/ast-x1.png', bytes: bytesOf('x') },
        { name: 'assets/stowaway.bin', bytes: bytesOf('密航') },
      ],
    });
    const got = await readTextBundle(zip);
    expect(got.warnings.some((w) => w.includes('gone'))).toBe(true);
    expect(got.warnings.some((w) => w.includes('stowaway.bin'))).toBe(true);
    expect([...got.assetEntries.keys()]).toEqual(['ast-x1']); // 取り込むのは実体のある 1 件
  });

  it('書出し時点の監査証跡(missing / compacted)を黙って捨てない', async () => {
    const zip = await bundle({
      manifest: manifestOf({
        assets: {},
        missing_asset_keys: ['lost-1', 'lost-2'],
        compacted: true,
      }),
      extra: [],
    });
    const got = await readTextBundle(zip);
    expect(got.warnings.filter((w) => w.includes('既に失われていた'))).toHaveLength(2);
    expect(got.warnings.some((w) => w.includes('compact mode'))).toBe(true);
  });

  it('形が違えば理由付きで断る(manifest / body.md / 別形式 / 未対応版 / 重複)', async () => {
    await expect(
      readTextBundle(await buildZip([{ name: 'body.md', bytes: bytesOf('x') }])),
    ).rejects.toThrow(/manifest\.json が入っていません/);
    await expect(
      readTextBundle(
        await buildZip([{ name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifestOf())) }]),
      ),
    ).rejects.toThrow(/body\.md が入っていません/);
    await expect(
      readTextBundle(await bundle({ manifest: manifestOf({ format: 'pkc2-textlog-bundle' }) })),
    ).rejects.toThrow(/pkc2-text-bundle のみ/);
    await expect(
      readTextBundle(await bundle({ manifest: manifestOf({ version: 2 }) })),
    ).rejects.toThrow(/未対応の bundle version/);
    await expect(
      readTextBundle(
        await buildZip([
          { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifestOf())) },
          { name: 'body.md', bytes: bytesOf('a') },
          { name: 'body.md', bytes: bytesOf('b') },
        ]),
      ),
    ).rejects.toThrow(/body\.md が 2 個/);
  });

  it('source_lid / source_title が無くても落ちない(fallback を持つ)', async () => {
    const zip = await bundle({
      manifest: manifestOf({ source_lid: '', source_title: '', assets: {} }),
      extra: [],
    });
    const c = (await readTextBundle(zip)).container as Synth;
    expect(c.entries[0]!.lid).toBe('bundle-text');
    expect(c.entries[0]!.title).toBe('(無題)');
  });

  it('Office 文書は名指しで断る', async () => {
    const zip = await buildZip([{ name: '[Content_Types].xml', bytes: bytesOf('<Types/>') }]);
    await expect(readTextBundle(zip)).rejects.toThrow(/Office 文書/);
  });
});

describe('readTextlogBundle', () => {
  const HEADER =
    '"log_id","timestamp_iso","timestamp_display","important","text_markdown","text_plain","asset_keys","flags"';
  const csvOf = (...rows: string[]) => [HEADER, ...rows].join('\r\n');
  const tlManifest = (over: Record<string, unknown> = {}) => ({
    format: 'pkc2-textlog-bundle',
    version: 1,
    source_lid: 'log1',
    source_title: '作業ログ',
    entry_count: 2,
    assets: {},
    missing_asset_keys: [],
    compacted: false,
    ...over,
  });

  it('CSV を PKC2 の TextlogBody JSON へ逆写像して合成 container に載せる', async () => {
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(tlManifest())) },
      {
        name: 'textlog.csv',
        bytes: bytesOf(
          csvOf(
            '"l1","2026-07-01T09:00:00Z","7/1","false","朝の記録","","",""',
            '"l2","2026-07-01T18:00:00Z","7/1","true","夜の記録","","","important"',
          ),
        ),
      },
    ]);

    const got = await readTextlogBundle(zip);
    const c = got.container as { entries: Array<{ lid: string; archetype: string; body: string }> };
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]!.archetype).toBe('textlog');
    expect(c.entries[0]!.lid).toBe('log1');
    // fromPkc2 が取る形(PKC2 入力の写し)── ここは JSON でよい
    const body = JSON.parse(c.entries[0]!.body) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toEqual({
      id: 'l1',
      text: '朝の記録',
      createdAt: '2026-07-01T09:00:00Z',
      flags: [],
    });
    expect(body.entries[1]!.flags).toEqual(['important']);
    expect(got.warnings).toEqual([]);
  });

  it('log_id の無い行と manifest の件数ズレを警告に出す', async () => {
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(tlManifest({ entry_count: 5 }))) },
      {
        name: 'textlog.csv',
        bytes: bytesOf(
          csvOf('"l1","ts","d","false","a","","",""', '"","ts","d","false","壊れた","","",""'),
        ),
      },
    ]);
    const got = await readTextlogBundle(zip);
    expect(got.warnings.some((w) => w.includes('1 行読み飛ばしました'))).toBe(true);
    expect(got.warnings.some((w) => w.includes('entry 件数'))).toBe(true);
  });

  it('壊れた CSV は ZipReadError として理由付きで断る', async () => {
    const zip = await buildZip([
      { name: 'manifest.json', bytes: bytesOf(JSON.stringify(tlManifest())) },
      { name: 'textlog.csv', bytes: bytesOf('"log_id","timestamp_iso"') },
    ]);
    await expect(readTextlogBundle(zip)).rejects.toThrow(/必須列/);
  });

  it('textlog.csv が無い / 形式違いは断る', async () => {
    await expect(
      readTextlogBundle(
        await buildZip([{ name: 'manifest.json', bytes: bytesOf(JSON.stringify(tlManifest())) }]),
      ),
    ).rejects.toThrow(/textlog\.csv が入っていません/);
    await expect(
      readTextlogBundle(
        await buildZip([
          { name: 'manifest.json', bytes: bytesOf(JSON.stringify(tlManifest({ format: 'pkc2-text-bundle' }))) },
          { name: 'textlog.csv', bytes: bytesOf(HEADER) },
        ]),
      ),
    ).rejects.toThrow(/pkc2-textlog-bundle のみ/);
  });

  it('添付の突合・監査証跡の作法は .text.zip と揃っている', async () => {
    const zip = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(
          JSON.stringify(
            tlManifest({
              entry_count: 1,
              assets: { 'ast-k': { name: 'p.png', mime: 'image/png' } },
              missing_asset_keys: ['lost'],
              compacted: true,
            }),
          ),
        ),
      },
      { name: 'textlog.csv', bytes: bytesOf(csvOf('"l1","ts","d","false","![図](asset:ast-k)","","",""')) },
      { name: 'assets/ast-k.png', bytes: bytesOf('PNG') },
    ]);
    const got = await readTextlogBundle(zip);
    expect([...got.assetEntries.keys()]).toEqual(['ast-k']);
    expect(got.warnings.some((w) => w.includes('既に失われていた'))).toBe(true);
    expect(got.warnings.some((w) => w.includes('compact mode'))).toBe(true);
  });
});
