/** @vitest-environment happy-dom */
/**
 * 本文のアイコン(`:home:`)を Word に画像で埋める(#853)。
 *
 * 守る主張(対照群を同じ it に置く):
 * 1. 描画した本文の `:home:` は Word の段落の中に画像の預かりとして出る(黙って消えない)
 * 2. 解いた預かりは、字の間に画像(`<w:pict>`)として入る
 * 3. 解けなかった預かりは、その場に理由が出て、注意の件数に数えられる
 * 4. PowerPoint(`inlineImages` を渡さない)は今までどおり入れない
 * 5. 名前が `[a-z0-9-]` でないものは預けない
 * 6. 焼く側: `glyphOfContent` は引用符つきの content から字を取り、none/空は `null`
 */
import { describe, expect, it } from 'vitest';
import { exportEntryDocx, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { buildDocx } from '../../src/features/export/docx';
import { htmlToDocxBlocks } from '../../src/adapter/platform/export/html-blocks';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { glyphOfContent, rasterizeIcon } from '../../src/adapter/platform/export/icon-raster';

const parse = (html: string): Document => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
const docXml = (r: ReturnType<typeof htmlToDocxBlocks>): string =>
  buildDocx(r.blocks, '', '2026-10-18T00:00:00Z', undefined, r.inlineSkipped).parts.find((p) => p.name === 'word/document.xml')!.text;

describe('Word: 本文のアイコン(#853)', () => {
  const html = renderMarkdown('前 :home: 後 :star:');

  it('🔴 描いた本文のアイコンが、段落の中の画像の預かりになる(名前つき)', () => {
    // 前提の検算: 描画はアイコンの器を出している
    expect(html).toContain('data-pkc-symbol="home"');
    const r = htmlToDocxBlocks(parse(html), { inlineImages: true });
    expect(r.blocks.map((b) => b.kind)).toEqual(['p']);
    expect(r.inlineIcons.map((x) => x.name)).toEqual(['home', 'star']);
    expect(r.inlineImages).toEqual([]);
  });

  it('🔴 解いた預かりは、字の間に画像として入る', () => {
    const r = htmlToDocxBlocks(parse(html), { inlineImages: true });
    for (const ref of r.inlineIcons) {
      ref.holder.media = `media/icon-${ref.name}.png`;
      ref.holder.widthPx = 18;
      ref.holder.heightPx = 18;
    }
    const xml = docXml(r);
    expect(xml.match(/<w:pict>/g)).toHaveLength(2);
    expect(xml.indexOf('前')).toBeLessThan(xml.indexOf('<w:pict>'));
    expect(xml.indexOf('<w:pict>')).toBeLessThan(xml.indexOf('後'));
  });

  it('🔴 解けなかった預かりは黙って消えず、その場に理由が出る', () => {
    const r = htmlToDocxBlocks(parse(html), { inlineImages: true });
    r.inlineIcons[0]!.holder.failWhy = 'アイコンを画像にできませんでした';
    const xml = docXml(r);
    expect(xml).toContain('アイコンを画像にできませんでした');
    expect(xml).not.toContain('<w:pict>');
  });

  it('対照: 渡さなければ(PowerPoint)預けない', () => {
    const r = htmlToDocxBlocks(parse(html));
    expect(r.inlineIcons).toEqual([]);
  });

  it('名前が不正な器は預けない', () => {
    const r = htmlToDocxBlocks(
      parse('<p>a <span data-pkc-icon data-pkc-symbol="Bad Name"></span> b</p>'),
      { inlineImages: true },
    );
    expect(r.inlineIcons).toEqual([]);
  });
});

describe('書き出しの配線(#853): exportEntryDocx が renderIcon を呼んで .docx に入れる', () => {
  async function run(renderIcon: ExportDeps['renderIcon']): Promise<{ text: string; calls: string[] }> {
    const calls: string[] = [];
    const got: Blob[] = [];
    const src = {
      cid: 'c1',
      title: 'T',
      listEntryMetas: async () => [
        { lid: 'n1', title: 'ノート', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 },
      ],
      listBodies: async () => ({ rows: [{ lid: 'n1', body: 'x' }], done: true }),
      getBody: async () => '家 :home: と :home: と :star:',
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listRevisionLids: async () => [],
      getRevisionChain: async () => [],
    } as unknown as ArchiveSource;
    const d = {
      source: src,
      download: (_n: string, b: Blob) => got.push(b),
      report: () => {},
      settle: async () => {},
      renderFigureVector: async () => null,
      renderFigure: async () => null,
      renderIcon: async (name: string) => {
        calls.push(name);
        return renderIcon(name);
      },
      askSql: async () => ({ columns: [], rows: [], truncated: false }),
      renderBody: async (t: string) => renderMarkdown(t),
      now: () => new Date('2026-10-25T00:00:00Z'),
    } as unknown as ExportDeps;
    const disp = { getState: () => ({ phase: 'ready' }), dispatch: () => {} } as unknown as Dispatcher;
    expect(await exportEntryDocx(disp, d, 'n1')).toBe(true);
    return { text: await got[0]!.text(), calls };
  }

  it('🔴 焼けた絵は media に入り、同じ絵は 1 回だけ焼く', async () => {
    (globalThis as unknown as Record<string, unknown>).createImageBitmap = async () => ({
      width: 72,
      height: 72,
      close: () => {},
    });
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const { text, calls } = await run(async () => ({ blob: png, px: 18 }));
    expect(calls.slice().sort(), 'home が 2 回、star が 1 回 = 名前ごと 1 回').toEqual(['home', 'star']);
    expect(text).toContain('word/media/icon-home.png');
    expect(text).toContain('word/media/icon-star.png');
  });

  it('対照: 焼けなければ media に入らない(その場に理由が出る)', async () => {
    const { text } = await run(async () => null);
    expect(text).not.toContain('word/media/icon-home.png');
    expect(text).toContain('<w:document');
  });
});

describe('アイコンを焼く側(#853)', () => {
  it('glyphOfContent: 引用符つきの content から字を取る / none・空は null', () => {
    expect(glyphOfContent('""')).toBe('');
    expect(glyphOfContent("''")).toBe('');
    expect(glyphOfContent('none')).toBeNull();
    expect(glyphOfContent('normal')).toBeNull();
    expect(glyphOfContent('""')).toBeNull();
    expect(glyphOfContent('')).toBeNull();
  });

  it('rasterizeIcon は不正な名前を断り、器の span を残さない', async () => {
    expect(await rasterizeIcon('Bad Name')).toBeNull();
    // 書体も CSS も無い環境では符号位置が読めず null。器は手放されている
    expect(await rasterizeIcon('home')).toBeNull();
    expect(document.querySelectorAll('[data-pkc-icon]').length).toBe(0);
  });
});
