/** @vitest-environment happy-dom */
/**
 * 🔴 ノート 1 件の閲覧用 HTML の書き出しに、そのノートのページ設定が届く(v4.0 Phase 1 / PR-03)。
 *
 * - 前書きに `page_format` / `page_margin` / `page_font` があれば、読み幅・`@page`・字体へ焼く
 * - 🔴 指定の無いノートは**従来と 1 バイトも変わらない**(前書きに関係の無いキーがあっても)
 * - 複数件の書き出しは、どれかのノートに指定があっても従来どおり(アプリの設定のまま)
 */
import { describe, expect, it } from 'vitest';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { fontSpec } from '../../src/features/appearance-choice';

function source(bodies: string[]): ArchiveSource {
  const metas = bodies.map((_, i) => ({
    lid: `e${i + 1}`,
    title: `題${i + 1}`,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
  }));
  const rows = bodies.map((body, i) => ({ lid: `e${i + 1}`, body }));
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () => metas,
    listBodies: async () => ({ rows, done: true, next: { entryOrder: rows.length, lid: `e${rows.length}` } }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

const NOW = '2026-11-26T00:00:00.000Z';

async function html(bodies: string[], fmt: Parameters<typeof writePortableHtml>[4] = 'a4-portrait'): Promise<string> {
  const out = await writePortableHtml(source(bodies), NOW, undefined, false, fmt);
  return out.blob.text();
}

/** 閲覧 UI の `<style>` の中身(焼いた規則を探す範囲を絞る)。 */
function viewerStyle(text: string): string {
  const at = text.indexOf('</script>', text.indexOf('<script id="pkc-data"'));
  const s = text.indexOf('<style>', at);
  return text.slice(s, text.indexOf('</style>', s));
}

describe('ノート 1 件の書き出しとページ設定', () => {
  it('🔴 用紙・余白・字体の指定が、読み幅・@page・字体へ焼かれる', async () => {
    const out = await html(['---\npage_format: a3-landscape\npage_margin: narrow\npage_font: mincho\n---\n本文。\n']);
    const style = viewerStyle(out);
    expect(style).toContain("[data-pkc-page-format='a3-landscape']{--read-w:91rem}@page{size:A3 landscape;margin:12mm}");
    expect(style).toContain(`body{--font:${fontSpec('mincho').ui}}.b{font-family:var(--font)}`);
    expect(style).not.toContain("[data-pkc-page-format='a4-portrait']");
    const doc = new DOMParser().parseFromString(out, 'text/html');
    expect(doc.body.getAttribute('data-pkc-page-format')).toBe('a3-landscape');
  });

  it('余白だけの指定は、アプリの用紙のまま @page に余白が入る', async () => {
    const style = viewerStyle(await html(['---\npage_margin: wide\n---\n本文'], 'a4-landscape'));
    expect(style).toContain("[data-pkc-page-format='a4-landscape']{--read-w:62rem}@page{size:A4 landscape;margin:30mm}");
    expect(style).not.toContain('--font:');
  });

  it('🔴 指定の無いノートは従来と 1 バイトも変わらない(関係の無い前書きがあっても)', async () => {
    const plain = await html(['---\ntitle: x\ntags: [あ]\n---\n本文。\n']);
    const style = viewerStyle(plain);
    expect(style).toContain("[data-pkc-page-format='a4-portrait']{--read-w:42rem}@page{size:A4 portrait}\n");
    expect(style).not.toContain('margin:12mm');
    expect(style).not.toContain('--font:');
    // 対照群: 指定のあるノートとは違う出力になる(上の検査が空振りしていない)
    const withLayout = await html(['---\ntitle: x\ntags: [あ]\npage_font: mono\n---\n本文。\n']);
    expect(withLayout).not.toBe(plain);
    // 指定を消した本文は、元の本文と同じ HTML になる
    const again = await html(['---\ntitle: x\ntags: [あ]\n---\n本文。\n']);
    expect(again).toBe(plain);
  });

  it('複数件の書き出しは、ノートの指定を持ち込まない(アプリの設定のまま)', async () => {
    const style = viewerStyle(await html(['---\npage_format: a3-landscape\n---\n本文', '別のノート']));
    expect(style).toContain("[data-pkc-page-format='a4-portrait']{--read-w:42rem}@page{size:A4 portrait}");
    expect(style).not.toContain('a3-landscape');
  });
});
