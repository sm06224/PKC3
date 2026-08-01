/**
 * P6c 段④: batch(複数 entry を 1 ZIP)3 形式の受理。
 *
 * fixture は PKC2 の writer が実際に吐く形をなぞる(2026-08-01 の read-only 調査):
 * 外側は flat / 内側 ZIP は単体 export とまったく同じ構造 / `compact`(外側)と
 * `compacted`(内側)は別綴り / texts・textlogs は `entry_count` で `archetype` を
 * 持たず、mixed は `text_count` + `textlog_count` で `archetype` を持つ。
 */
import { describe, expect, it } from 'vitest';
import { readContainerBundle } from '../../src/features/import/pkc2-container-bundle';
import { readAssetSource } from '../../src/features/import/zip-reader';
import { buildZip, bytesOf, type FixtureEntry } from './zip-fixture';

type Synth = { entries: Array<{ lid: string; title: string; archetype: string; body: string }> };

/** 内側の `.text.zip` を 1 個組む(単体 export と同じ構造)。 */
async function textBundle(
  o: {
    lid?: string;
    title?: string;
    body?: string;
    assets?: Record<string, { name: string; mime: string }>;
    files?: FixtureEntry[];
    compacted?: boolean;
    over?: Record<string, unknown>;
  } = {},
): Promise<Uint8Array> {
  const zip = await buildZip([
    {
      name: 'manifest.json',
      bytes: bytesOf(
        JSON.stringify({
          format: 'pkc2-text-bundle',
          version: 1,
          source_lid: o.lid ?? 'n1',
          source_title: o.title ?? 'ノート',
          body_length: 10,
          asset_count: Object.keys(o.assets ?? {}).length,
          missing_asset_count: 0,
          missing_asset_keys: [],
          assets: o.assets ?? {},
          compacted: o.compacted ?? false,
          ...(o.over ?? {}),
        }),
      ),
    },
    { name: 'body.md', bytes: bytesOf(o.body ?? '# ノート\n') },
    ...(o.files ?? []),
  ]);
  return new Uint8Array(await zip.arrayBuffer());
}

/** 内側の `.textlog.zip` を 1 個組む。 */
async function textlogBundle(
  o: { lid?: string; title?: string; rows?: number } = {},
): Promise<Uint8Array> {
  const n = o.rows ?? 2;
  const header = '"log_id","timestamp_iso","text_markdown","flags"\r\n';
  const rows = Array.from(
    { length: n },
    (_, i) => `"l${i + 1}","2026-07-0${i + 1}T00:00:00Z","行 ${i + 1}",""\r\n`,
  ).join('');
  const zip = await buildZip([
    {
      name: 'manifest.json',
      bytes: bytesOf(
        JSON.stringify({
          format: 'pkc2-textlog-bundle',
          version: 1,
          source_lid: o.lid ?? 'g1',
          source_title: o.title ?? 'ログ',
          entry_count: n,
          asset_count: 0,
          missing_asset_count: 0,
          missing_asset_keys: [],
          assets: {},
          compacted: false,
        }),
      ),
    },
    { name: 'textlog.csv', bytes: bytesOf(header + rows) },
  ]);
  return new Uint8Array(await zip.arrayBuffer());
}

const outer = (manifest: Record<string, unknown>, files: FixtureEntry[]): Promise<Blob> =>
  buildZip([
    { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifest, null, 2)) },
    ...files,
  ]);

describe('readContainerBundle — texts', () => {
  it('内側 ZIP を再入して 1 個の合成 container にまとめる', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        source_cid: 'c-old',
        source_title: '旧 container',
        entry_count: 2,
        compact: false,
        // ⚠ texts は entries[] に archetype を持たない(format から決まる)
        entries: [
          { lid: 'n1', title: 'A', filename: 'a-20260731.text.zip', body_length: 3, asset_count: 0, missing_asset_count: 0 },
          { lid: 'n2', title: 'B', filename: 'b-20260731.text.zip', body_length: 3, asset_count: 0, missing_asset_count: 0 },
        ],
      },
      [
        { name: 'a-20260731.text.zip', bytes: await textBundle({ lid: 'n1', title: 'A', body: '# A\n' }) },
        { name: 'b-20260731.text.zip', bytes: await textBundle({ lid: 'n2', title: 'B', body: '# B\n' }) },
      ],
    );
    const got = await readContainerBundle(zip);
    const c = got.container as Synth;
    // 🔑 **本体が 2 件とも入る**(1 件目だけ返す実装は review M-5 で生存していた)
    expect(c.entries.map((e) => e.lid)).toEqual(['n1', 'n2']);
    expect(c.entries.map((e) => e.body)).toEqual(['# A\n', '# B\n']);
    expect(c.entries.every((e) => e.archetype === 'text')).toBe(true);
    expect(got.warnings).toEqual([]);
  });

  it('🔑 同じ添付を 2 ノートが参照していても attachment は 1 件に畳む', async () => {
    // PKC2 は内側 ZIP それぞれに同じバイナリを丸ごと複製する。取込側で畳まないと
    // attachment entry が 2 個・asset が 2 本になる(PKC2 の実際の挙動)
    const assets = { 'ast-x1': { name: 'dot.png', mime: 'image/png' } };
    const png = bytesOf('PNG の bytes');
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entry_count: 2,
        entries: [
          { lid: 'n1', title: 'ノート', filename: 'a.text.zip' },
          { lid: 'n2', title: 'ノート', filename: 'b.text.zip' },
        ],
      },
      [
        {
          name: 'a.text.zip',
          bytes: await textBundle({
            lid: 'n1',
            body: '![図](asset:ast-x1)\n',
            assets,
            files: [{ name: 'assets/ast-x1.png', bytes: png }],
          }),
        },
        {
          name: 'b.text.zip',
          bytes: await textBundle({
            lid: 'n2',
            body: 'こちらも ![図](asset:ast-x1)\n',
            assets,
            files: [{ name: 'assets/ast-x1.png', bytes: png }],
          }),
        },
      ],
    );
    const got = await readContainerBundle(zip);
    const c = got.container as Synth;
    // attachment 1 件 + 本体 2 件 = 3(attachment が 2 件になったら畳めていない)
    expect(c.entries.map((e) => e.archetype)).toEqual(['attachment', 'text', 'text']);
    expect([...got.assetSources.keys()]).toEqual(['ast-x1']);
    // 在り処は**内側 ZIP の view** ── 外側から読むと壊れる位置を指している
    expect(await (await readAssetSource(got.assetSources.get('ast-x1')!)).text()).toBe(
      'PNG の bytes',
    );
    expect(got.warnings).toEqual([]);
  });

  it('🔴 同じ key が違う中身で入っていたら断る(片方を黙って捨てない)', async () => {
    const assets = { 'ast-x1': { name: 'dot.png', mime: 'image/png' } };
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [
          { lid: 'n1', filename: 'a.text.zip' },
          { lid: 'n2', filename: 'b.text.zip' },
        ],
      },
      [
        {
          name: 'a.text.zip',
          bytes: await textBundle({
            lid: 'n1',
            assets,
            files: [{ name: 'assets/ast-x1.png', bytes: bytesOf('AAAA') }],
          }),
        },
        {
          name: 'b.text.zip',
          bytes: await textBundle({
            lid: 'n2',
            assets,
            files: [{ name: 'assets/ast-x1.png', bytes: bytesOf('BBBB') }], // 別の中身
          }),
        },
      ],
    );
    // 畳むと「n2 が n1 の画像を表示する」= 見て気づけない破損になる
    await expect(readContainerBundle(zip)).rejects.toThrow(/違う中身/);
  });

  it('同じ中身で name/mime だけ違うときは畳んだうえで warning', async () => {
    const png = bytesOf('same');
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [
          { lid: 'n1', filename: 'a.text.zip' },
          { lid: 'n2', filename: 'b.text.zip' },
        ],
      },
      [
        {
          name: 'a.text.zip',
          bytes: await textBundle({
            lid: 'n1',
            assets: { k: { name: 'first.png', mime: 'image/png' } },
            files: [{ name: 'assets/k.png', bytes: png }],
          }),
        },
        {
          name: 'b.text.zip',
          bytes: await textBundle({
            lid: 'n2',
            assets: { k: { name: 'second.png', mime: 'image/webp' } },
            files: [{ name: 'assets/k.png', bytes: png }],
          }),
        },
      ],
    );
    const got = await readContainerBundle(zip);
    expect([...got.assetSources.keys()]).toEqual(['k']);
    expect(got.warnings).toEqual([
      'b.text.zip: 添付 k の名前/種別が bundle ごとに違います(first.png を採ります)',
    ]);
  });
});

describe('readContainerBundle — mixed', () => {
  it('entries[].archetype で内側の読み方を決める', async () => {
    const zip = await outer(
      {
        format: 'pkc2-mixed-container-bundle',
        version: 1,
        // ⚠ mixed は entry_count を持たない ── text_count + textlog_count
        text_count: 1,
        textlog_count: 1,
        compact: false,
        entries: [
          { lid: 'n1', title: 'A', archetype: 'text', filename: 'a.text.zip', body_length: 3 },
          { lid: 'g1', title: 'ログ', archetype: 'textlog', filename: 'g.textlog.zip', log_entry_count: 2 },
        ],
      },
      [
        { name: 'a.text.zip', bytes: await textBundle({ lid: 'n1', title: 'A' }) },
        { name: 'g.textlog.zip', bytes: await textlogBundle({ lid: 'g1', title: 'ログ' }) },
      ],
    );
    const got = await readContainerBundle(zip);
    const c = got.container as Synth;
    expect(c.entries.map((e) => e.archetype)).toEqual(['text', 'textlog']);
    // textlog は CSV → TextlogBody JSON へ逆写像されている
    expect(JSON.parse(c.entries[1]!.body)).toMatchObject({
      entries: [
        { id: 'l1', text: '行 1' },
        { id: 'l2', text: '行 2' },
      ],
    });
    expect(got.warnings).toEqual([]);
  });

  it('archetype が text / textlog でなければ断る(たぶん text で通さない)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-mixed-container-bundle',
        version: 1,
        entries: [{ lid: 'x', archetype: 'todo', filename: 'x.entry.zip' }],
      },
      [{ name: 'x.entry.zip', bytes: await textBundle() }],
    );
    await expect(readContainerBundle(zip)).rejects.toThrow(/archetype/);
  });

  it('件数の照合は形式ごとに違う field を見る(mixed は text_count / textlog_count)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-mixed-container-bundle',
        version: 1,
        text_count: 5, // 実際は 1
        textlog_count: 0, // 実際は 1
        entries: [
          { lid: 'n1', archetype: 'text', filename: 'a.text.zip' },
          { lid: 'g1', archetype: 'textlog', filename: 'g.textlog.zip' },
        ],
      },
      [
        { name: 'a.text.zip', bytes: await textBundle({ lid: 'n1' }) },
        { name: 'g.textlog.zip', bytes: await textlogBundle({ lid: 'g1' }) },
      ],
    );
    const got = await readContainerBundle(zip);
    expect(got.warnings).toEqual([
      'manifest の text 件数が中身と違います(5 ≠ 1)',
      'manifest の textlog 件数が中身と違います(0 ≠ 1)',
    ]);
  });
});

describe('readContainerBundle — textlogs', () => {
  it('format から archetype を決める(entries[] に archetype は無い)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-textlogs-container-bundle',
        version: 1,
        entry_count: 1,
        entries: [{ lid: 'g1', title: 'ログ', filename: 'g.textlog.zip', log_entry_count: 3 }],
      },
      [{ name: 'g.textlog.zip', bytes: await textlogBundle({ lid: 'g1', rows: 3 }) }],
    );
    const got = await readContainerBundle(zip);
    expect((got.container as Synth).entries.map((e) => e.archetype)).toEqual(['textlog']);
  });

  it('内側 format が宣言と違えば断る(texts の中に textlog bundle)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [{ lid: 'g1', filename: 'g.text.zip' }],
      },
      [{ name: 'g.text.zip', bytes: await textlogBundle({ lid: 'g1' }) }],
    );
    // どの内側ファイルで落ちたのかを必ず言う
    await expect(readContainerBundle(zip)).rejects.toThrow(/g\.text\.zip: .*pkc2-text-bundle/);
  });
});

describe('readContainerBundle — 黙って落とさない', () => {
  it('manifest にあるファイルが ZIP に無ければ断る', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [{ lid: 'n1', filename: 'missing.text.zip' }],
      },
      [],
    );
    await expect(readContainerBundle(zip)).rejects.toThrow(/ZIP に入っていません/);
  });

  it('filename が無い entry は断る(PKC2 は preview で無言 skip していた)', async () => {
    const zip = await outer(
      { format: 'pkc2-texts-container-bundle', version: 1, entries: [{ lid: 'n1' }] },
      [],
    );
    await expect(readContainerBundle(zip)).rejects.toThrow(/filename がありません/);
  });

  it('manifest が同じファイルを 2 回並べたら断る(PKC2 は 2 回取り込んでいた)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [
          { lid: 'n1', filename: 'a.text.zip' },
          { lid: 'n2', filename: 'a.text.zip' },
        ],
      },
      [{ name: 'a.text.zip', bytes: await textBundle() }],
    );
    await expect(readContainerBundle(zip)).rejects.toThrow(/2 回並べています/);
  });

  it('ZIP に同名ファイルが 2 つあれば断る(PKC2 は後勝ちで片方を捨てていた)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [{ lid: 'n1', filename: 'a.text.zip' }],
      },
      [
        { name: 'a.text.zip', bytes: await textBundle({ body: '# 1\n' }) },
        { name: 'a.text.zip', bytes: await textBundle({ body: '# 2\n' }) },
      ],
    );
    await expect(readContainerBundle(zip)).rejects.toThrow(/同じ名前のファイルが 2 つ/);
  });

  it('manifest に無いファイルは warning(PKC2 は無言で捨てていた)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [{ lid: 'n1', filename: 'a.text.zip' }],
      },
      [
        { name: 'a.text.zip', bytes: await textBundle() },
        { name: 'stowaway.txt', bytes: bytesOf('密航') },
      ],
    );
    expect((await readContainerBundle(zip)).warnings).toEqual([
      'manifest に無いファイルを無視しました: stowaway.txt',
    ]);
  });

  it('内側の warning は**どのファイルか**を冠して出す', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [{ lid: 'n1', filename: 'a.text.zip' }],
      },
      [
        {
          name: 'a.text.zip',
          // 実体の無い添付を宣言している
          bytes: await textBundle({ assets: { 'ast-gone': { name: 'x.png', mime: 'image/png' } } }),
        },
      ],
    );
    expect((await readContainerBundle(zip)).warnings).toEqual([
      'a.text.zip: 添付の中身が bundle に入っていません: ast-gone',
    ]);
  });

  it('compact は export 単位なので**内側の件数ぶん繰り返さない**', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        compact: true,
        entries: [
          { lid: 'n1', filename: 'a.text.zip' },
          { lid: 'n2', filename: 'b.text.zip' },
          { lid: 'n3', filename: 'c.text.zip' },
        ],
      },
      [
        { name: 'a.text.zip', bytes: await textBundle({ lid: 'n1', compacted: true }) },
        { name: 'b.text.zip', bytes: await textBundle({ lid: 'n2', compacted: true }) },
        { name: 'c.text.zip', bytes: await textBundle({ lid: 'n3', compacted: true }) },
      ],
    );
    const got = await readContainerBundle(zip);
    expect(got.warnings).toEqual([
      '書出し時に壊れた添付参照が本文から除かれています(compact mode)',
    ]);
  });

  it('目次と中身で lid / タイトルが食い違えば warning(正は中身)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [{ lid: 'ちがう', title: 'ちがう題', filename: 'a.text.zip' }],
      },
      [{ name: 'a.text.zip', bytes: await textBundle({ lid: 'n1', title: '本当の題' }) }],
    );
    const got = await readContainerBundle(zip);
    expect(got.warnings).toEqual([
      'a.text.zip: 目次と中身で lid が違います(ちがう ≠ n1)',
      'a.text.zip: 目次と中身でタイトルが違います(ちがう題 ≠ 本当の題)',
    ]);
    // 採るのは**中身**
    expect((got.container as Synth).entries[0]!.lid).toBe('n1');
  });

  it('texts なのに entries[].archetype が食い違えば warning(採るのは format)', async () => {
    const zip = await outer(
      {
        format: 'pkc2-texts-container-bundle',
        version: 1,
        entries: [{ lid: 'n1', archetype: 'textlog', filename: 'a.text.zip' }],
      },
      [{ name: 'a.text.zip', bytes: await textBundle({ lid: 'n1' }) }],
    );
    const got = await readContainerBundle(zip);
    expect(got.warnings).toEqual([
      '1 件目: 目次の archetype(textlog)は形式(text)と違います ── 形式を採ります',
    ]);
    expect((got.container as Synth).entries[0]!.archetype).toBe('text');
  });

  it('batch でない format は断る / entries が配列でなければ断る', async () => {
    const a = await outer({ format: 'pkc2-package', version: 1, entries: [] }, []);
    await expect(readContainerBundle(a)).rejects.toThrow(/batch 形式のみ/);
    const b = await outer({ format: 'pkc2-texts-container-bundle', version: 1 }, []);
    await expect(readContainerBundle(b)).rejects.toThrow(/entries の配列/);
    const c = await outer(
      { format: 'pkc2-texts-container-bundle', version: 2, entries: [] },
      [],
    );
    await expect(readContainerBundle(c)).rejects.toThrow(/version/);
  });

  it('Office 文書は名指しで断る', async () => {
    const zip = await buildZip([
      { name: '[Content_Types].xml', bytes: bytesOf('<Types/>') },
      { name: 'manifest.json', bytes: bytesOf('{}') },
    ]);
    await expect(readContainerBundle(zip)).rejects.toThrow(/Office 文書/);
  });
});
