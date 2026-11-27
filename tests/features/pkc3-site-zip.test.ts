/**
 * 配布パッケージ(`*.pkc3-site.zip`、v4.1 Phase 2 / PR-6、#2098 後半)。
 *
 * 🔑 **書いた zip を既存の読み手(`zip-reader.ts`)で展開して**中身を確かめる(作った側の自己申告を信じない)。
 * 🔴 閲覧側(`index.html` の script)は happy-dom で**実際に走らせる** ── `<script src="./data/note-0.js">` の読み込みは
 *   zip の中の実物を評価して `onload` を返す(作り物の payload を渡さない)。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import {
  writePortableSiteZip,
  SITE_FORMAT,
  SITE_INLINE_ASSET_MAX_BYTES,
  SITE_TOOL_FRAME_PREFIX,
  siteAssetFileName,
  toneOverrideCss,
  headingTexts,
  htmlToPlainText,
} from '../../src/features/export/pkc3-site-zip';
import { readZipDirectory, readZipEntry, readZipText, type ZipEntry } from '../../src/features/import/zip-reader';
import { SITE_PACKAGE_SUFFIX, isBackupFileName, ARCHIVE_SUFFIXES } from '../../src/features/export/archive-kind';
import { folderSource } from '../../src/features/export/folder-source';
import { selectionSource } from '../../src/features/export/selection-source';
import { buildStandaloneWidgetHtml, STANDALONE_WIDGET_FRAME_ID } from '../../src/features/markdown/widget-export';

const enc = new TextEncoder();
const NOW = '2026-11-27T00:00:00.000Z';

interface Fake {
  entries: Array<{ lid: string; title?: string; archetype?: string; body: string }>;
  assets?: Array<{ key: string; mime: string; bytes: Uint8Array }>;
  tree?: Array<[string, string]>;
  batch?: number;
}

function source(f: Fake): ArchiveSource {
  const entries = f.entries.map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: e.archetype ?? 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  return {
    cid: 'c1',
    title: '配布テスト',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    getBody: async (lid) => entries.find((e) => e.lid === lid)?.body ?? null,
    listBodies: async (after) => {
      const rest = after ? entries.filter((e) => e.entry_order > after.entryOrder) : entries;
      const slice = rest.slice(0, Math.max(1, f.batch ?? entries.length));
      const last = slice[slice.length - 1];
      return {
        rows: slice.map((e) => ({ lid: e.lid, body: e.body })),
        done: slice.length >= rest.length,
        ...(last ? { next: { entryOrder: last.entry_order, lid: last.lid } } : {}),
      };
    },
    listRelations: async () =>
      (f.tree ?? []).map(([from, to], i) => ({
        id: `s${i}`,
        from_lid: from,
        to_lid: to,
        kind: 'structural',
        created_at: null,
        updated_at: null,
      })),
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({ key: a.key, mime: a.mime, size: a.bytes.length, hash: null })),
    getAssetBlob: async (key) => {
      const a = (f.assets ?? []).find((x) => x.key === key);
      return a ? new Blob([a.bytes as unknown as BlobPart]) : null;
    },
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

interface Unzipped {
  names: string[];
  text(name: string): Promise<string>;
  blob(name: string): Promise<Blob>;
}

async function unzip(blob: Blob): Promise<Unzipped> {
  const dir = await readZipDirectory(blob);
  const by = new Map<string, ZipEntry>(dir.map((e) => [e.name, e]));
  const get = (n: string): ZipEntry => {
    const e = by.get(n);
    if (!e) throw new Error(`zip に ${n} が無い`);
    return e;
  };
  return {
    names: dir.map((e) => e.name).sort(),
    text: (n) => readZipText(blob, get(n)),
    blob: (n) => readZipEntry(blob, get(n)),
  };
}

/** `window.<名前>=…;` / `window.<名前>(…);` を評価して受け取った物を返す(閲覧側と同じ読み方)。 */
function evalScript(code: string): Record<string, unknown> {
  const got: Record<string, unknown> = {};
  const win: Record<string, unknown> = {
    __PKC_SITE_NOTE__: (i: number, p: unknown) => {
      got[`note-${i}`] = p;
    },
    __PKC_SITE_ASSET__: (k: string, b: string) => {
      got[`asset:${k}`] = b;
    },
  };
  new Function('window', code)(win);
  if (win['__PKC_SITE_MANIFEST__']) got['manifest'] = win['__PKC_SITE_MANIFEST__'];
  return got;
}

interface Manifest {
  format: string;
  version: number;
  title: string;
  notes: Array<{ i: number; lid: string; title: string; headings: string[]; tags: string[]; excerpt: string }>;
  tools: Array<{ i: number; key: string; name: string; path: string; frameId: string }>;
  assets: Array<{ key: string; name: string; mime: string; size: number; path: string; inline?: string; kind?: string }>;
}

const TOOL_HTML = '<!doctype html><html><body><input id="v" value=""><a id="dl" download="out.csv" href="data:text/csv,a">保存</a><script>window.ok=1</script></body></html>';
const attachNote = (key: string, name: string, mime: string): string =>
  `---\nattachment.name: ${name}\nattachment.mime: ${mime}\nattachment.asset_key: ${key}\n---\n`;

/** 手順書 + 表 + 添付 CSV + 添付 HTML ツール + ウィジェット入りのノート。 */
function richFake(): Fake {
  return {
    entries: [
      {
        lid: 'n-guide',
        title: '手順書',
        body:
          '---\ntags: [手順, 配布]\n---\n# 作業の流れ\n\n## 準備\n\n本文には `</script>` と <!-- の字が入る。HTML のコメントは `<!--` で始まる。\n\n' +
          '[データ](entry:n-table) を見る。[外のノート](entry:n-outside)\n\n![](asset:ast-img)\n',
      },
      { lid: 'n-table', title: '集計表', body: '| 名前 | 数 |\n|---|---|\n| りんご | 3 |\n| みかん | 10 |\n' },
      { lid: 'n-csv', title: 'data.csv', archetype: 'attachment', body: attachNote('ast-csv', 'data.csv', 'text/csv') },
      { lid: 'n-tool', title: 'convert.html', archetype: 'attachment', body: attachNote('ast-tool', 'convert.html', 'text/html') },
      {
        lid: 'n-widget',
        title: 'ウィジェット',
        body:
          '---\ncustomer: 山田\nattachment.name: input.csv\nattachment.asset_key: ast-in\n---\n' +
          '| a | b |\n|---|---|\n| 1 | 2 |\n\n```html\n<script>window.x=1</script>\n```\n\n![big](asset:ast-big)\n\n![small](asset:ast-small)\n\n' +
          // 🔑 コードブロックが指す HTML の添付もツールになる(前書きの添付とは別の道)
          '```html asset:ast-fence id="fence-tool"\n```\n',
      },
    ],
    assets: [
      { key: 'ast-img', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
      { key: 'ast-csv', mime: 'text/csv', bytes: enc.encode('a,b\n1,2\n') },
      { key: 'ast-tool', mime: 'text/html', bytes: enc.encode(TOOL_HTML) },
      { key: 'ast-in', mime: 'text/csv', bytes: enc.encode('x,y\n3,4\n') },
      // ⚠ ウィジェットのノートが参照していても、上限を超える添付は data/asset-*.js にしない
      { key: 'ast-big', mime: 'image/png', bytes: new Uint8Array(SITE_INLINE_ASSET_MAX_BYTES + 1) },
      // ウィジェットのノートが本文で参照する小さな添付 → data/asset-*.js の候補(前書きの添付とは別の道)
      { key: 'ast-small', mime: 'text/plain', bytes: enc.encode('small') },
      { key: 'ast-fence', mime: 'text/html', bytes: enc.encode('<p id="fence">fence tool</p>') },
      // どの本文からも参照されない添付は入らない
      { key: 'ast-orphan', mime: 'text/plain', bytes: enc.encode('orphan') },
    ],
  };
}

describe('配布パッケージ ── zip の形', () => {
  it('🔴 index.html / manifest.js / data/note-*.js / tools / assets が揃い、data/asset-*.js は要る物にだけできる', async () => {
    const out = await writePortableSiteZip(source(richFake()), NOW);
    const z = await unzip(out.blob);
    const m = evalScript(await z.text('manifest.js'))['manifest'] as Manifest;
    expect(m.format).toBe(SITE_FORMAT);
    expect(m.title).toBe('配布テスト');
    expect(m.notes.map((n) => n.title)).toEqual(['手順書', '集計表', 'data.csv', 'convert.html', 'ウィジェット']);
    // 添付: 参照された 5 件だけ(孤児は入らない)
    expect(m.assets.map((a) => a.key).sort()).toEqual(['ast-big', 'ast-csv', 'ast-fence', 'ast-img', 'ast-in', 'ast-small', 'ast-tool']);
    expect(out.warnings.join('\n')).toContain('参照されていない添付 1 件');
    // 🔴 data/asset-*.js はウィジェットのノートが参照する 10 MB 以下の物だけ(前書きの ast-in・本文の ast-small。ast-big は超える)
    const inline = m.assets.filter((a) => a.inline !== undefined).map((a) => a.key).sort();
    expect(inline).toEqual(['ast-fence', 'ast-in', 'ast-small']);
    expect(out.counts.inlineAssets).toBe(3);
    const dataAssets = z.names.filter((n) => n.startsWith('data/asset-'));
    expect(dataAssets).toHaveLength(3);
    // ツール: 添付ノートの HTML と、コードブロックが指す HTML の 2 件
    expect(m.tools.map((t) => [t.key, t.path, t.frameId])).toEqual([
      ['ast-tool', 'tools/convert.html', `${SITE_TOOL_FRAME_PREFIX}0`],
      ['ast-fence', 'tools/ast-fence.html', `${SITE_TOOL_FRAME_PREFIX}1`],
    ]);
    // 揃っている物の全体
    const expected = [
      'index.html',
      'manifest.js',
      ...m.notes.map((n) => `data/note-${n.i}.js`),
      ...m.assets.map((a) => a.path),
      ...dataAssets,
      ...m.tools.map((t) => t.path),
    ].sort();
    expect(z.names).toEqual(expected);
    // 添付は生ファイル(base64 にしない)── 中身がそのまま一致する
    const csv = m.assets.find((a) => a.key === 'ast-csv')!;
    expect(await (await z.blob(csv.path)).text()).toBe('a,b\n1,2\n');
    expect(csv.path).toMatch(/^assets\/\d+-data\.csv$/);
    const big = m.assets.find((a) => a.key === 'ast-big')!;
    expect((await z.blob(big.path)).size).toBe(SITE_INLINE_ASSET_MAX_BYTES + 1);
    // data/asset-*.js の base64 は元の bytes に戻る
    const inAsset = m.assets.find((a) => a.key === 'ast-in')!;
    const got = evalScript(await z.text(inAsset.inline!));
    expect(atob(got['asset:ast-in'] as string)).toBe('x,y\n3,4\n');
  });

  it('🔴 manifest.js と data/note-*.js は構文エラーなく読め、`</script>` / `<!--` を含む本文でも壊れない', async () => {
    const out = await writePortableSiteZip(source(richFake()), NOW);
    const z = await unzip(out.blob);
    for (const n of z.names.filter((x) => x.endsWith('.js'))) {
      const code = await z.text(n);
      expect(code, `${n} に生の < がある`).not.toMatch(/<\/script|<!--/i);
      expect(() => evalScript(code), n).not.toThrow();
    }
    const guide = evalScript(await z.text('data/note-0.js'))['note-0'] as { html: string; lid: string };
    expect(guide.lid).toBe('n-guide');
    expect(htmlToPlainText(guide.html)).toContain('</script>');
    expect(htmlToPlainText(guide.html)).toContain('<!--');
  });

  it('🔑 目録は検索用の軽い字(題名・見出し・タグ・抜き出し)を持ち、本文の HTML は持たない', async () => {
    const out = await writePortableSiteZip(source(richFake()), NOW);
    const m = evalScript(await (await unzip(out.blob)).text('manifest.js'))['manifest'] as Manifest & {
      notes: Array<Record<string, unknown>>;
    };
    const g = m.notes[0]!;
    expect(g['headings']).toEqual(['作業の流れ', '準備']);
    expect(g['tags']).toEqual(['手順', '配布']);
    expect(String(g['excerpt'])).toContain('本文には');
    expect(g).not.toHaveProperty('html');
  });

  it('🔴 ウィジェットの在るノートだけが「同じノートのデータ」(ctx)を持つ', async () => {
    const z = await unzip((await writePortableSiteZip(source(richFake()), NOW)).blob);
    const w = evalScript(await z.text('data/note-4.js'))['note-4'] as { ctx?: { frontmatter: Record<string, unknown>; tables: unknown[] } };
    expect(w.ctx?.frontmatter['customer']).toBe('山田');
    expect(w.ctx?.tables).toHaveLength(1);
    const plain = evalScript(await z.text('data/note-1.js'))['note-1'] as { ctx?: unknown };
    expect(plain.ctx).toBeUndefined();
  });

  it('🔴 入っていないノートへのリンクは注意に数える', async () => {
    const out = await writePortableSiteZip(source(richFake()), NOW);
    expect(out.warnings.join('\n')).toContain('入っていないノートへのリンク 1 件');
  });

  it('ノートが 0 件なら断る', async () => {
    await expect(writePortableSiteZip(source({ entries: [] }), NOW)).rejects.toThrow('1 件もありません');
  });

  it('本文を小分けに読んでも(バッチ 1 件)同じ数のノートが入る', async () => {
    const out = await writePortableSiteZip(source({ ...richFake(), batch: 1 }), NOW);
    expect(out.counts.entries).toBe(5);
  });
});

describe('配布パッケージ ── 安全の境界', () => {
  it('🔴 ツールは厳格な CSP の単体 HTML で、箱の名乗りが index.html の iframe と同じ字', async () => {
    const z = await unzip((await writePortableSiteZip(source(richFake()), NOW)).blob);
    const tool = await z.text('tools/convert.html');
    expect(tool.startsWith('<!DOCTYPE html><html lang="ja"')).toBe(true);
    expect(tool).toContain("connect-src 'none'");
    expect(tool).not.toMatch(/script-src[^;"]*https?:/);
    expect(tool).toContain(`${SITE_TOOL_FRAME_PREFIX}0`);
    expect(tool).not.toContain(STANDALONE_WIDGET_FRAME_ID);
    // 元の中身は残る
    expect(tool).toContain('id="dl"');
  });

  it('🔴 index.html の箱は sandbox="allow-scripts" だけ(allow-same-origin / allow-downloads を出さない)', async () => {
    const z = await unzip((await writePortableSiteZip(source(richFake()), NOW)).blob);
    const html = await z.text('index.html');
    expect(html).toContain("f.setAttribute('sandbox','allow-scripts')");
    expect(html).not.toMatch(/allow-same-origin|allow-downloads|allow-top-navigation|allow-popups/);
    // シェル自身も外へ出ない
    expect(html).toMatch(/connect-src 'self' data: blob:/);
    // ⚠ 焼いた本文の CSS には `a[href^='http://']` の選択子が在る ── 見るのは外へ取りに行く属性だけ
    expect(html).not.toMatch(/\b(?:src|href|data)=["']?https?:/i);
    expect(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1]).not.toContain('http');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!;
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('unsafe-eval');
    // 確認バーの親(portable-widget-bridge)が入っている
    expect(html).toContain('pkc-widget-dl-req');
    expect(html).toContain('data-pkc-html-render-id');
  });

  it('🔴 index.html のインラインの script は構文エラーが無い', async () => {
    const z = await unzip((await writePortableSiteZip(source(richFake()), NOW)).blob);
    const html = await z.text('index.html');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBe(1);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });

  it('🔴 隠したタブのパネルは、ツールのパネル(display:flex)でも隠れる(!important ── 実ブラウザで踏んだ)', async () => {
    const html = await (await unzip((await writePortableSiteZip(source(richFake()), NOW)).blob)).text('index.html');
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toContain('.panel.tool{padding:0;display:flex');
    expect(css).toContain('.panel[hidden]{display:none!important}');
  });

  it('外部の画像は「常にオン」のときだけシェルの CSP で許す', async () => {
    const off = await (await unzip((await writePortableSiteZip(source(richFake()), NOW)).blob)).text('index.html');
    const cspOf = (h: string): string => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(h)![1]!;
    expect(cspOf(off)).not.toContain('https:');
    expect(cspOf(off)).toContain("img-src 'self' data: blob:;");
    const on = await (
      await unzip((await writePortableSiteZip(source(richFake()), NOW, { allowExternalImages: true })).blob)
    ).text('index.html');
    expect(on).toContain("img-src 'self' data: blob: https:");
  });
});

describe('配布パッケージ ── 絞り込んだ書き出し', () => {
  const tree: Fake = {
    entries: [
      { lid: 'f1', title: '案件A', archetype: 'folder', body: '' },
      { lid: 'a', title: '中のメモ', body: '![](asset:ast-a)\n' },
      { lid: 't', title: 'tool.html', archetype: 'attachment', body: attachNote('ast-t', 'tool.html', 'text/html') },
      { lid: 'o', title: '外のメモ', body: '![](asset:ast-o)\n' },
    ],
    assets: [
      { key: 'ast-a', mime: 'image/png', bytes: new Uint8Array([1]) },
      { key: 'ast-t', mime: 'text/html', bytes: enc.encode('<p>tool</p>') },
      { key: 'ast-o', mime: 'image/png', bytes: new Uint8Array([2]) },
    ],
    tree: [
      ['f1', 'a'],
      ['f1', 't'],
    ],
  };

  it('🔴 フォルダから書き出すと、その中のノートと参照している添付・ツールだけが入る', async () => {
    const { source: src } = await folderSource(source(tree), 'f1');
    const out = await writePortableSiteZip(src, NOW);
    const z = await unzip(out.blob);
    const m = evalScript(await z.text('manifest.js'))['manifest'] as Manifest;
    expect(m.notes.map((n) => n.lid).sort()).toEqual(['a', 'f1', 't']);
    expect(m.assets.map((a) => a.key).sort()).toEqual(['ast-a', 'ast-t']);
    expect(m.tools.map((t) => t.path)).toEqual(['tools/tool.html']);
    expect(z.names.some((n) => n.includes('ast-o'))).toBe(false);
  });

  it('🔴 選んだノートから書き出すと、選んだ物だけが入る(フォルダを選べば中身ごと)', async () => {
    const { source: src } = await selectionSource(source(tree), ['o'], 'archive');
    const m = evalScript(await (await unzip((await writePortableSiteZip(src, NOW)).blob)).text('manifest.js'))[
      'manifest'
    ] as Manifest;
    expect(m.notes.map((n) => n.lid)).toEqual(['o']);
    expect(m.assets.map((a) => a.key)).toEqual(['ast-o']);
    expect(m.tools).toEqual([]);
    const { source: src2 } = await selectionSource(source(tree), ['f1'], 'archive');
    const m2 = evalScript(await (await unzip((await writePortableSiteZip(src2, NOW)).blob)).text('manifest.js'))[
      'manifest'
    ] as Manifest;
    expect(m2.notes.map((n) => n.lid).sort()).toEqual(['a', 'f1', 't']);
  });
});

describe('配布パッケージ ── ツールの名前', () => {
  it('🔴 同じ名前(大文字小文字違いを含む)のツールはぶつからず、種類の無い HTML は名前で拾う', async () => {
    const fake: Fake = {
      entries: [
        { lid: 'a', archetype: 'attachment', body: attachNote('k1', 'Tool.html', 'text/html') },
        { lid: 'b', archetype: 'attachment', body: attachNote('k2', 'tool.html', 'text/html') },
        { lid: 'c', archetype: 'attachment', body: '---\nattachment.name: nomime.html\nattachment.asset_key: k3\n---\n' },
        { lid: 'd', archetype: 'attachment', body: '---\nattachment.name: data.bin\nattachment.asset_key: k4\n---\n' },
      ],
      assets: [
        { key: 'k1', mime: 'text/html', bytes: enc.encode('<p>1</p>') },
        { key: 'k2', mime: 'text/html', bytes: enc.encode('<p>2</p>') },
        { key: 'k3', mime: '', bytes: enc.encode('<p>3</p>') },
        { key: 'k4', mime: '', bytes: enc.encode('bin') },
      ],
    };
    const m = evalScript(await (await unzip((await writePortableSiteZip(source(fake), NOW)).blob)).text('manifest.js'))[
      'manifest'
    ] as Manifest;
    expect(m.tools.map((t) => t.path)).toEqual(['tools/Tool.html', 'tools/tool-2.html', 'tools/nomime.html']);
  });
});

describe('配布パッケージ ── 部品', () => {
  it('🔴 .pkc3-site.zip はバックアップに数えない(落としても取り込みの道へ送らない)', () => {
    expect(SITE_PACKAGE_SUFFIX).toBe('.pkc3-site.zip');
    expect(isBackupFileName('資料-20261127.pkc3-site.zip')).toBe(false);
    expect(ARCHIVE_SUFFIXES).not.toContain(SITE_PACKAGE_SUFFIX);
    // 対照: バックアップは当たる(この検査が空振りしていない)
    expect(isBackupFileName('資料.pkc3-full.zip')).toBe(true);
  });

  it('添付のファイル名は番号つきで、拡張子を残して無害化する', () => {
    expect(siteAssetFileName(0, 'a/b:c.csv', 'k')).toBe('assets/0-a-b-c.csv');
    expect(siteAssetFileName(3, '', 'ast-xyz')).toBe('assets/3-ast-xyz');
    expect(siteAssetFileName(1, 'CON.txt', 'k')).toBe('assets/1-CON-file.txt');
  });

  it('見出しと本文の字', () => {
    expect(headingTexts('<h1 id="x">A <em>b</em></h1><h4>no</h4><h3>C &amp; D</h3>')).toEqual(['A b', 'C & D']);
    expect(htmlToPlainText('<p>a&lt;b</p><script>x</script>')).toBe('a<b');
  });

  it('🔴 本物の焼いた本文の CSS からも明暗の 2 層が写せて、index.html に入る(配色の切り替えが CSS に届く)', async () => {
    const html = await (await unzip((await writePortableSiteZip(source(richFake()), NOW)).blob)).text('index.html');
    expect(html).toMatch(/:root\[data-pkc-tone=dark\]\{--surface:#[0-9a-f]+/);
    expect(html).toMatch(/:root\[data-pkc-tone=light\]\{--surface:#[0-9a-f]+/);
  });

  it('明暗の切り替えは焼いた本文の CSS の 2 層から写す', () => {
    const css = ':root{--surface:#fff;--fg:#000}:root{--radius:3px}@media (prefers-color-scheme:dark){:root{--surface:#111;--fg:#eee}}';
    expect(toneOverrideCss(css)).toBe(
      ':root[data-pkc-tone=light]{--surface:#fff;--fg:#000;color-scheme:light}:root[data-pkc-tone=dark]{--surface:#111;--fg:#eee;color-scheme:dark}',
    );
    expect(toneOverrideCss(':root{--x:1}')).toBe('');
  });

  it('🔴 単体 HTML の箱の名乗りを差し替えられる(安全な字だけ)', () => {
    const base = { content: '<p>x</p>', title: 't', widgetId: null, seed: {}, theme: { tone: 'light' as const, tokens: {} } };
    const a = buildStandaloneWidgetHtml({ ...base, frameId: 'pkc-site-tool-3' });
    expect(a).toContain('pkc-site-tool-3');
    expect(a).not.toContain(STANDALONE_WIDGET_FRAME_ID);
    const b = buildStandaloneWidgetHtml({ ...base, frameId: 'bad id!<x>' });
    expect(b).toContain(STANDALONE_WIDGET_FRAME_ID);
    expect(b).not.toContain('bad id!');
  });
});

/**
 * 🔴 閲覧側を happy-dom で実際に走らせる。`<script src>` の読み込みだけは、zip の中の実物を評価して `onload` を返す。
 */
describe('配布パッケージ ── 閲覧側(index.html)', () => {
  async function boot(fake: Fake): Promise<{ z: Unzipped; m: Manifest }> {
    const out = await writePortableSiteZip(source(fake), NOW);
    const z = await unzip(out.blob);
    const manifestJs = await z.text('manifest.js');
    const html = await z.text('index.html');
    const files = new Map<string, string>();
    for (const n of z.names) if (n.endsWith('.js')) files.set(`./${n}`, await z.text(n));
    /**
     * ⚠ happy-dom は iframe の src を取りに行き、読めずに stderr へ 1 行出す(全スイートの stderr は 0 行に保つ)。
     *   作った iframe の `src` だけを、読み込まずに値として持つ形に替える(閲覧側が入れた値はそのまま観測できる)。
     */
    const realCreate = document.createElement.bind(document);
    document.createElement = ((tag: string, o?: ElementCreationOptions) => {
      const el = realCreate(tag, o);
      if (tag.toLowerCase() === 'iframe') {
        // ⚠ getter は空を返す(happy-dom は繋いだときに src を読んで取りに行く)── 入れた値は別の名前で持つ
        Object.defineProperty(el, 'src', {
          get: () => '',
          set: (x: string) => {
            (el as unknown as { pkcTestSrc: string }).pkcTestSrc = String(x);
          },
          configurable: true,
        });
      }
      return el;
    }) as typeof document.createElement;
    document.head.innerHTML = '';
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
    // 🔑 動的 script の読み込みを zip の実物で返す(happy-dom はファイルを読まない)
    const realAppend = document.head.appendChild.bind(document.head);
    document.head.appendChild = (<T extends Node>(node: T): T => {
      const el = node as unknown as HTMLScriptElement;
      if (el.tagName === 'SCRIPT' && el.getAttribute('src')) {
        const code = files.get(el.getAttribute('src')!);
        // ⚠ 本物の head には繋がない(happy-dom は script の読み込みを断る)── 繋がなくても閲覧側は parentNode を確かめて外す
        setTimeout(() => {
          if (code === undefined) {
            el.onerror?.(new Event('error'));
            return;
          }
          new Function(code)();
          el.onload?.(new Event('load'));
        }, 0);
        return node;
      }
      return realAppend(node);
    }) as typeof document.head.appendChild;
    new Function(manifestJs)();
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    new Function(inline)();
    await new Promise((r) => setTimeout(r, 20));
    const m = (window as unknown as { __PKC_SITE_MANIFEST__: Manifest }).__PKC_SITE_MANIFEST__;
    return { z, m };
  }

  it('🔴 最初のノートがタブで開き、本文と添付(./assets/…)が据わる', async () => {
    const { m } = await boot(richFake());
    const tabs = document.querySelectorAll('#pkc-tabs .tab');
    expect(tabs).toHaveLength(1);
    const box = document.querySelector<HTMLElement>('.panel:not([hidden]) .b')!;
    expect(box.querySelector('h1')?.textContent).toBe('作業の流れ');
    const img = box.querySelector('img')!;
    const file = m.assets.find((a) => a.key === 'ast-img')!.path;
    expect(img.getAttribute('src')).toBe(`./assets/${encodeURIComponent(file.slice('assets/'.length))}`);
    // 入っていないノートへのリンクは字だけ / 入っているノートへのリンクは押せる
    expect(box.querySelector('[data-pkc-outside-note]')).not.toBeNull();
    const link = box.querySelector<HTMLAnchorElement>('a[data-pkc-entry-ref]')!;
    link.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelectorAll('#pkc-tabs .tab')).toHaveLength(2);
    expect(document.querySelector('.panel:not([hidden]) h2')?.textContent).toBe('集計表');
  });

  it('🔴 複数タブ: 手順書とツールを往復しても、ツールのパネル(iframe)は作り直されない', async () => {
    await boot(richFake());
    const toolBtn = document.querySelector<HTMLButtonElement>('[data-pkc-tool-index="0"]')!;
    toolBtn.click();
    const frame = document.querySelector<HTMLIFrameElement>('.panel.tool iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('data-pkc-html-render-id')).toBe(`${SITE_TOOL_FRAME_PREFIX}0`);
    expect(frame.hasAttribute('data-pkc-widget-frame')).toBe(true);
    expect((frame as unknown as { pkcTestSrc: string }).pkcTestSrc).toBe('./tools/convert.html');
    // 手順書へ戻って、またツールへ
    document.querySelector<HTMLButtonElement>('[data-pkc-note-index="0"]')!.click();
    expect(frame.closest('.panel')!.hasAttribute('hidden')).toBe(true);
    toolBtn.click();
    expect(document.querySelectorAll('.panel.tool iframe')).toHaveLength(1);
    expect(document.querySelector('.panel.tool iframe')).toBe(frame);
    expect(frame.closest('.panel')!.hasAttribute('hidden')).toBe(false);
    // × で閉じるとパネルごと消える
    const tab = document.querySelector<HTMLElement>('.tab[data-pkc-tab-kind="tool"]')!;
    tab.querySelector<HTMLButtonElement>('.x')!.click();
    expect(document.querySelector('.panel.tool')).toBeNull();
  });

  it('🔴 横断検索は目録の字(見出し・タグ・抜き出し)で絞り込み、本文を読まない', async () => {
    await boot(richFake());
    const q = document.getElementById('pkc-q') as HTMLInputElement;
    const visible = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('#pkc-notes li')]
        .filter((li) => !li.hidden)
        .map((li) => li.querySelector('button')!.getAttribute('title') ?? '');
    q.value = '準備';
    q.dispatchEvent(new Event('input'));
    expect(visible()).toEqual(['手順書']);
    q.value = '配布';
    q.dispatchEvent(new Event('input'));
    expect(visible()).toEqual(['手順書']);
    q.value = 'りんご';
    q.dispatchEvent(new Event('input'));
    expect(visible()).toEqual(['集計表']);
    q.value = '該当なしの語';
    q.dispatchEvent(new Event('input'));
    expect(visible()).toEqual([]);
    expect(document.getElementById('pkc-empty')!.hidden).toBe(false);
  });

  it('🔴 ツールのタブはどのノートのデータも読めない(対照: ウィジェットのノートの箱は自分のノートの分だけ読める)', async () => {
    await boot(richFake());
    type Hooks = {
      getFrameContext(f: Element): { frontmatter: Record<string, unknown> } | null;
      getFrameAssets(f: Element): Array<{ key: string }>;
      readAssetBytes(k: string): Promise<ArrayBuffer | null>;
    };
    const site = (window as unknown as { __pkcSite: { hooks: Hooks; go(i: number, h: string): void; openTool(i: number): void } }).__pkcSite;
    // 開いているノートが手順書だけのとき、ツールの箱は何も読めない
    site.openTool(0);
    const tool = document.querySelector('.panel.tool iframe')!;
    expect(site.hooks.getFrameContext(tool)).toBeNull();
    expect(site.hooks.getFrameAssets(tool)).toEqual([]);
    // ウィジェットのノートを開いても、ツールの箱は読めないまま
    site.go(4, '');
    await new Promise((r) => setTimeout(r, 20));
    expect(site.hooks.getFrameContext(tool)).toBeNull();
    expect(site.hooks.getFrameAssets(tool)).toEqual([]);
    // 対照群: ウィジェットのノートの本文の中の要素なら、そのノートの前書きと添付が返る
    const inNote = document.querySelector('.panel:not([hidden]) .b[data-pkc-ei="4"]')!.firstElementChild!;
    expect(site.hooks.getFrameContext(inNote)?.frontmatter['customer']).toBe('山田');
    const keys = site.hooks.getFrameAssets(inNote).map((a) => a.key);
    expect(keys).toContain('ast-in');
    expect(keys).not.toContain('ast-csv');
    // 添付の bytes は data/asset-*.js から読める(閲覧側の読み込みの道を通す)
    const buf = await site.hooks.readAssetBytes('ast-in');
    expect(new TextDecoder().decode(buf!)).toBe('x,y\n3,4\n');
  });

  it('🔴 # や % を含む名前のツールでも、そのファイルを指す(相対 URL の名前の部分を符号化する)', async () => {
    const fake = richFake();
    fake.entries.push({ lid: 'n-hash', archetype: 'attachment', body: attachNote('ast-hash', 'C# a%41.html', 'text/html') });
    fake.assets!.push({ key: 'ast-hash', mime: 'text/html', bytes: enc.encode('<p>h</p>') });
    const { m } = await boot(fake);
    const t = m.tools.find((x) => x.key === 'ast-hash')!;
    expect(t.path).toBe('tools/C#-a%41.html');
    (window as unknown as { __pkcSite: { openTool(i: number): void } }).__pkcSite.openTool(t.i);
    const f = document.querySelector<HTMLIFrameElement>('.panel.tool:not([hidden]) iframe')!;
    expect((f as unknown as { pkcTestSrc: string }).pkcTestSrc).toBe('./tools/C%23-a%2541.html');
    expect(document.querySelector('.panel.tool:not([hidden]) [data-pkc-field="site-tool-open"]')!.getAttribute('href')).toBe(
      './tools/C%23-a%2541.html',
    );
  });

  it('🔴 再読み込みは箱を作り直し、他のノートの確認バーを巻き込まない(sweep)', async () => {
    await boot(richFake());
    const site = (window as unknown as { __pkcSite: { openTool(i: number): void } }).__pkcSite;
    site.openTool(0);
    const before = document.querySelector('.panel.tool iframe');
    document.querySelector<HTMLButtonElement>('[data-pkc-field="site-tool-reload"]')!.click();
    const after = document.querySelector('.panel.tool iframe');
    expect(after).not.toBe(before);
    expect(document.querySelectorAll('.panel.tool iframe')).toHaveLength(1);
    expect(after!.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('🔴 複数タブで同じ見出しが並んでも、#見出しのリンクは自分のノートの本文の中へ飛ぶ', async () => {
    const fake: Fake = {
      entries: [
        { lid: 'p', title: '一つ目', body: '## 概要\n\n一つ目の本文\n' },
        { lid: 'q', title: '二つ目', body: '## 概要\n\n[概要へ](#概要)\n' },
      ],
    };
    await boot(fake);
    const site = (window as unknown as { __pkcSite: { go(i: number, h: string): void } }).__pkcSite;
    site.go(1, '');
    await new Promise((r) => setTimeout(r, 20));
    const box2 = document.querySelector<HTMLElement>('.b[data-pkc-ei="1"]')!;
    const link = box2.querySelector<HTMLAnchorElement>('a[href^="#"]')!;
    expect(link).not.toBeNull();
    // 前提: 同じ id の見出しが 2 つのタブに在る(ブラウザ任せなら 1 つ目 = 隠れたタブへ飛ぶ)
    const id = box2.querySelector('h2')!.id;
    expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(2);
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    let target: Element | null;
    try {
      link.click();
      target = (spy.mock.contexts[0] as Element | undefined) ?? null;
    } finally {
      spy.mockRestore();
    }
    expect(target, '#見出しへ移らない').not.toBeNull();
    expect(box2.contains(target), '別のノートの見出しへ飛んだ').toBe(true);
  });

  it('配色の切り替えは OS に合わせる → ライト → ダーク の順に data-pkc-tone を変える', async () => {
    await boot(richFake());
    const b = document.getElementById('pkc-tone')!;
    expect(document.documentElement.hasAttribute('data-pkc-tone')).toBe(false);
    b.click();
    expect(document.documentElement.getAttribute('data-pkc-tone')).toBe('light');
    b.click();
    expect(document.documentElement.getAttribute('data-pkc-tone')).toBe('dark');
    b.click();
    expect(document.documentElement.hasAttribute('data-pkc-tone')).toBe(false);
  });

  it('添付ノートの HTML がツールなら「ツールとして開く」が出る', async () => {
    await boot(richFake());
    (window as unknown as { __pkcSite: { go(i: number, h: string): void } }).__pkcSite.go(3, '');
    await new Promise((r) => setTimeout(r, 20));
    const ob = document.querySelector<HTMLButtonElement>('.panel:not([hidden]) [data-pkc-field="site-open-tool"]')!;
    expect(ob.textContent).toContain('convert');
    ob.click();
    expect(document.querySelector('.panel.tool:not([hidden]) iframe')).not.toBeNull();
  });
});
