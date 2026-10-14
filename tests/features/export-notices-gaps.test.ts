/** @vitest-environment happy-dom */
/**
 * 🔴 **書き出した先で起きることを、書き出した人に言う**(#1087)。
 *
 * 守る主張:
 * 3. Markdown の書き出し(zip)は、ノートへのリンク(`entry:…`)が外では開けないことを**件数で言う**。
 *    本文は 1 バイトも書き換えない(fence・行内コードの中は数えない)。
 * 4. 表に無い種類の添付の拡張子は、添付ノートの元のファイル名から借りる(英数字・長さに上限)。無ければ `bin`。
 * 5. 閲覧用 HTML は、図・グラフ・数式・外部画像が開いた先で原文の字・空の枠になることを件数で言う。
 *    焼いて見せる物(「常にオン」の外部画像)は数えない。
 */
import { describe, expect, it } from 'vitest';
import {
  writeMarkdownZip,
  extFromFileName,
  extForAsset,
} from '../../src/features/export/pkc3-markdown-zip';
import { countNoteLinks, noteLinkNotice } from '../../src/features/export/note-link-notice';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import { readZipDirectory, readZipText } from '../../src/features/import/zip-reader';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const NOW = '2026-10-14T00:00:00.000Z';

interface Fake {
  entries: Array<{ lid: string; title?: string; body: string }>;
  assets?: Array<{ key: string; mime: string | null }>;
}
function source(f: Fake): ArchiveSource {
  const entries = f.entries.map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: 'text',
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
    title: 'T',
    listEntryMetas: async () => entries.map(({ body, ...m }) => (void body, m)),
    listBodies: async () => ({
      rows: entries.map((e) => ({ lid: e.lid, body: e.body })),
      done: true,
      next: { entryOrder: entries.length, lid: entries[entries.length - 1]!.lid },
    }),
    listRelations: async () => [],
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({ key: a.key, mime: a.mime, size: 3, hash: null })),
    getAssetBlob: async () => new Blob([new Uint8Array([1, 2, 3])]),
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  } as unknown as ArchiveSource;
}

describe('3. ノートへのリンクは外では開けない ── 件数で言う', () => {
  const body = [
    '[議事録](entry:n2) と [もう一つ](entry:n3#h/見出し)',
    '',
    '![埋め込み](entry:n2)',
    '',
    '`[コードの中](entry:n9)`',
    '',
    '```',
    '[fence の中](entry:n8)',
    '```',
    '',
    '[外](https://example.com) [添付](asset:ast-1)',
  ].join('\n');

  it('数えるのは本物のリンクだけ(行内コード・fence の中・外向きのリンクは数えない)', () => {
    expect(countNoteLinks(body)).toBe(3);
    expect(countNoteLinks('[x](https://e.com)')).toBe(0);
  });

  it('0 件なら何も言わない / 1 件以上は件数を入れた文', () => {
    expect(noteLinkNotice(0)).toBeNull();
    expect(noteLinkNotice(3)).toBe('ノートへのリンク 3 件は、書き出した先では開けません(リンクの字のまま残ります)');
  });

  it('zip: 注意が 1 本だけ出て、本文のリンクは書き換わらない', async () => {
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', title: 'a', body }, { lid: 'n2', title: 'b', body: '[x](entry:n1)' }] }),
      NOW,
    );
    const hits = out.warnings.filter((w) => w.includes('ノートへのリンク'));
    expect(hits).toEqual(['ノートへのリンク 4 件は、書き出した先では開けません(リンクの字のまま残ります)']);
    const dir = await readZipDirectory(out.blob);
    const a = dir.find((e) => e.name === 'a.md')!;
    const text = await readZipText(out.blob, a);
    expect(text).toContain('[議事録](entry:n2)');
    expect(text).toContain('![埋め込み](entry:n2)');
  });

  it('対照群: リンクが無ければ注意は出ない', async () => {
    const out = await writeMarkdownZip(source({ entries: [{ lid: 'n1', body: 'ただの本文' }] }), NOW);
    expect(out.warnings.some((w) => w.includes('ノートへのリンク'))).toBe(false);
  });
});

describe('4. 表に無い種類の添付の拡張子', () => {
  it.each([
    ['動画.mov', 'mov'],
    ['A.7Z', '7z'],
    ['曲.flac', 'flac'],
    ['写真.HEIC', 'heic'],
    ['x.tar.gz', 'gz'],
    ['拡張子なし', null],
    ['終わりがドット.', null],
    ['記号入り.a b', null],
    ['危険.m/d', null],
    ['長すぎる.abcdefghi', null],
    ['', null],
  ])('extFromFileName(%j) → %j', (name, expected) => {
    expect(extFromFileName(name)).toBe(expected);
  });

  it('extForAsset: 種類の表が先 → ファイル名 → bin', () => {
    expect(extForAsset('image/png', 'x.mov')).toBe('png');
    expect(extForAsset('application/octet-stream', 'x.mov')).toBe('mov');
    expect(extForAsset(null, undefined)).toBe('bin');
    expect(extForAsset('video/quicktime-x', 'x.bad name')).toBe('bin');
  });

  it('zip: 添付ノートの name から .mov になり、本文の参照も同じ相対パスに書き換わる', async () => {
    const att = '---\nattachment.name: 旅行.mov\nattachment.asset_key: ast-mov\n---\n';
    const out = await writeMarkdownZip(
      source({
        entries: [
          { lid: 'n1', title: '添付', body: att },
          { lid: 'n2', title: '本文', body: '[動画](asset:ast-mov)' },
          { lid: 'n3', title: '名前なし', body: '[他](asset:ast-x)' },
        ],
        assets: [
          { key: 'ast-mov', mime: 'application/octet-stream' },
          { key: 'ast-x', mime: 'application/x-unknown' },
        ],
      }),
      NOW,
    );
    const dir = await readZipDirectory(out.blob);
    const names = dir.map((e) => e.name);
    expect(names).toContain('assets/ast-mov.mov');
    expect(names).toContain('assets/ast-x.bin');
    const body = await readZipText(out.blob, dir.find((e) => e.name === '本文.md')!);
    expect(body).toContain('(assets/ast-mov.mov)');
  });
});

describe('5. 閲覧用 HTML: 開いた先で原文・空の枠になる物を件数で言う', () => {
  const warnsOf = async (body: string, allowExternal = false): Promise<string[]> =>
    (await writePortableHtml(source({ entries: [{ lid: 'n1', body }] }), NOW, undefined, allowExternal)).warnings;

  const body = [
    '```mermaid\ngraph TD\nA-->B\n```',
    '```mermaid\ngraph TD\nC-->D\n```',
    '```chart\n{"type":"bar"}\n```',
    '行内の数式 $x^2$ と、',
    '$$\ny=1\n$$',
    '![外](https://example.com/a.png)',
  ].join('\n\n');

  it('図・グラフ・数式・外部画像を、それぞれの件数で言う', async () => {
    const w = await warnsOf(body);
    expect(w).toContain('図(mermaid)2 件は、開いた先では原文の字で出ます');
    expect(w).toContain('グラフ 1 件は、開いた先では原文の字で出ます');
    expect(w).toContain('数式 2 件は、開いた先では打った字のまま出ます');
    expect(w.find((x) => x.startsWith('外部の画像 1 件は、開いた先では空の枠になります'))).toBeTruthy();
  });

  it('対照群: 何も無い本文では 4 種とも出ない', async () => {
    const w = await warnsOf('ふつうの本文');
    expect(w.filter((x) => /原文の字|打った字|空の枠/.test(x))).toEqual([]);
  });

  it('外部画像を焼く設定(常にオン)のときは、空の枠にならないので数えない', async () => {
    const w = await warnsOf('![外](https://example.com/a.png)', true);
    expect(w.some((x) => x.includes('空の枠'))).toBe(false);
  });

  it('コードの中に属性名を書いた文は数えない', async () => {
    const w = await warnsOf('`data-pkc-mermaid-src="x"` と書く\n\n```\n<div data-pkc-math-src="y">\n```');
    expect(w.some((x) => x.includes('原文の字') || x.includes('打った字'))).toBe(false);
  });
});
