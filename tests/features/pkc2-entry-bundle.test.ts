/**
 * P6c 段⑥: `pkc2-entry-bundle`(`.entry.zip`)── **P6c の最後の形式**。
 *
 * PKC2 に**読む実装が無い**唯一の形式(書きっぱなし)。folder-export v2 が同梱するが
 * PKC2 の batch importer は無言で skip していた。
 *
 * 🔑 実物で確認した非互換(`tests/fixtures/pkc2/attachment.entry.zip`):
 * `assets/<key>` に **base64 テキスト**が入る ── text/textlog bundle が同じ
 * `assets/` に**生バイト**を書くのと逆。取り違えると base64 の文字列が添付として
 * 保存され、**開けないのに壊れて見えない**。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  readEntryBundle,
  assetsForSynthesis,
  droppedFieldsWarning,
} from '../../src/features/import/pkc2-entry-bundle';
import { readAssetSource } from '../../src/features/import/zip-reader';
import { buildZip, bytesOf, type FixtureEntry } from './zip-fixture';

const real = (name: string): Blob =>
  new Blob([readFileSync(`${process.cwd()}/tests/fixtures/pkc2/${name}`)]);

type Synth = { entries: Array<{ lid: string; title: string; archetype: string; body: string }> };

const bundle = (
  o: { manifest?: Record<string, unknown>; entry?: Record<string, unknown>; extra?: FixtureEntry[] } = {},
): Promise<Blob> =>
  buildZip([
    {
      name: 'manifest.json',
      bytes: bytesOf(
        JSON.stringify(
          o.manifest ?? {
            format: 'pkc2-entry-bundle',
            version: 1,
            archetype: 'todo',
            lid: 't1',
            title: 'やること',
            asset_count: 0,
            missing_asset_count: 0,
          },
        ),
      ),
    },
    {
      name: 'entry.json',
      bytes: bytesOf(
        JSON.stringify(
          o.entry ?? { lid: 't1', title: 'やること', archetype: 'todo', body: '{"status":"open"}' },
        ),
      ),
    },
    ...(o.extra ?? []),
  ]);

describe('readEntryBundle — 実物', () => {
  it('🔴 todo の `.entry.zip` を受理する(PKC2 は読めない形式)', async () => {
    const got = await readEntryBundle(real('single.entry.zip'));
    const c = got.container as Synth;
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]).toMatchObject({ lid: 't-1', title: 'やること', archetype: 'todo' });
    expect(JSON.parse(c.entries[0]!.body)).toMatchObject({ status: 'open', date: '2026-08-10' });
    expect(got.warnings).toEqual([]);
  });

  it('🔑 `assets/<key>` の **base64 テキスト**を復号して扱う', async () => {
    const got = await readEntryBundle(real('attachment.entry.zip'));
    const src = got.assetSources.get('ast-shared')!;
    // 在り処に「base64 である」印が付いている ── これが無いと adapter が
    // base64 の文字列そのものを添付として保存する
    expect(src.base64).toBe(true);
    // ZIP から読んだ生の中身は **base64 の文字列**(PNG のバイトではない)
    const raw = await (await readAssetSource(src)).text();
    expect(raw.startsWith('iVBORw0KGgo')).toBe(true);
  });

  it('🔑 entry 自身が attachment なら attachment を二重に作らない', async () => {
    const got = await readEntryBundle(real('attachment.entry.zip'));
    const c = got.container as Synth;
    // entry.json が attachment そのもの ── synthesize が同じ key で作ると 2 件になる
    expect(c.entries.filter((e) => e.archetype === 'attachment')).toHaveLength(1);
    // bytes の在り処は返る(添付を復元するのに要る)
    expect([...got.assetSources.keys()]).toEqual(['ast-shared']);
  });

  it('🔴 PKC3 に受け皿が無い field は**落ちると言う**', async () => {
    // text-meta.entry.zip は created_at / tags / color_tag を持つ実物
    const got = await readEntryBundle(real('text-meta.entry.zip'));
    expect(got.warnings.join('\n')).toMatch(/取り込めませんでした.*created_at.*tags.*color_tag/);
    // ただし本文と添付は入る(落ちるのはメタだけ)
    const c = got.container as Synth;
    expect(c.entries.find((e) => e.archetype === 'text')!.body).toContain('asset:ast-shared');
  });
});

describe('readEntryBundle — 形の検査', () => {
  it('format / version を名指しで断る', async () => {
    await expect(
      readEntryBundle(await bundle({ manifest: { format: 'pkc2-package', version: 1 } })),
    ).rejects.toThrow(/pkc2-entry-bundle のみ/);
    await expect(
      readEntryBundle(await bundle({ manifest: { format: 'pkc2-entry-bundle', version: 9 } })),
    ).rejects.toThrow(/version/);
  });

  it('entry.json が無い / 壊れていれば断る', async () => {
    const noEntry = await buildZip([
      {
        name: 'manifest.json',
        bytes: bytesOf(JSON.stringify({ format: 'pkc2-entry-bundle', version: 1 })),
      },
    ]);
    await expect(readEntryBundle(noEntry)).rejects.toThrow(/entry\.json/);
  });

  it('archetype が無ければ断る(「たぶん text」で通さない)', async () => {
    const zip = await bundle({
      manifest: { format: 'pkc2-entry-bundle', version: 1 },
      entry: { lid: 'x', title: 'x', body: 'x' },
    });
    await expect(readEntryBundle(zip)).rejects.toThrow(/archetype/);
  });

  it('目次と中身が食い違えば言う(正は entry.json)', async () => {
    const zip = await bundle({
      manifest: {
        format: 'pkc2-entry-bundle',
        version: 1,
        archetype: 'todo',
        lid: 'ちがう',
        title: 'ちがう題',
      },
      entry: { lid: 't1', title: '本当の題', archetype: 'todo', body: '{}' },
    });
    const got = await readEntryBundle(zip);
    expect(got.warnings).toEqual([
      '目次と中身で lid が違います(ちがう ≠ t1)── 中身を採ります',
      '目次と中身で タイトル が違います(ちがう題 ≠ 本当の題)── 中身を採ります',
    ]);
    expect((got.container as Synth).entries[0]!.lid).toBe('t1');
  });

  it('asset 件数の不一致を言う(manifest に assets 索引が無い形式)', async () => {
    const zip = await bundle({
      manifest: { format: 'pkc2-entry-bundle', version: 1, archetype: 'todo', asset_count: 3 },
      extra: [{ name: 'assets/k1', bytes: bytesOf('YWJj') }],
    });
    const got = await readEntryBundle(zip);
    expect(got.warnings).toContain('manifest の asset 件数が中身と違います(3 ≠ 1)');
  });

  it('assets/ の下のディレクトリ様の名前は無視して言う', async () => {
    const zip = await bundle({ extra: [{ name: 'assets/sub/k1', bytes: bytesOf('YWJj') }] });
    const got = await readEntryBundle(zip);
    expect(got.warnings[0]).toMatch(/想定外のファイルを無視/);
    expect(got.assetSources.size).toBe(0);
  });
});

describe('assetsForSynthesis / droppedFieldsWarning', () => {
  const A = (key: string) => ({
    source: { zip: new Blob(), entry: {} as never },
    name: key,
    mime: 'application/octet-stream',
  });

  it('attachment 本体が宣言している key は attachment を作らない', () => {
    const assets = new Map([['k1', A('k1')], ['k2', A('k2')]]);
    const out = assetsForSynthesis(assets, [
      { archetype: 'attachment', body: JSON.stringify({ asset_key: 'k1' }) },
    ]);
    expect([...out.keys()]).toEqual(['k2']);
  });

  it('body が JSON でない attachment でも落ちない', () => {
    const assets = new Map([['k1', A('k1')]]);
    const out = assetsForSynthesis(assets, [{ archetype: 'attachment', body: '# markdown' }]);
    expect([...out.keys()]).toEqual(['k1']);
  });

  it('落ちる field が無ければ何も言わない', () => {
    expect(droppedFieldsWarning([])).toEqual([]);
    expect(droppedFieldsWarning(['tags', 'tags'])).toHaveLength(1);
  });
});
