/** @vitest-environment happy-dom */
/**
 * P8 段㉑: **GC が keep する添付は、書き出しにも必ず入る**。
 *
 * 🔴 直す前は「どの添付を含めるか」の判定が **3 実装**あった ──
 * 正本(`features/asset/asset-ref-scan.ts`。GC と 1 ノート書出しが使う)と、
 * md ZIP / 可搬 HTML が持つ**自前の狭い正規表現**。後者は unescape をしないので、
 * `![図](asset:ast\-abc)`(markdown の escape 済み宛先。**画面には正しく画像が
 * 出る**)を取りこぼしていた。しかも注意欄には
 * 「どの本文からも参照されていない添付 1 件は含めませんでした」と
 * **事実と逆のこと**が出る。GC は同じ参照を keep するので、
 * 「消されはしないが、外に出すと必ず欠ける」という食い違いが残っていた。
 *
 * ⚠ CLAUDE.md「同じ判定が 2 か所に生えたら規則を 1 つに寄せ、
 *   **A が keep するものは B にも必ず入る** parity test を置く」。
 */
import { describe, expect, it } from 'vitest';
import { scanAssetRefsInto } from '../../src/features/asset/asset-ref-scan';
import { writeMarkdownZip } from '../../src/features/export/pkc3-markdown-zip';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const NOW = '2026-08-04T00:00:00.000Z';
const KEY = 'ast-abc';

/**
 * 🔴 **画面では生きている参照**を並べる。どれも markdown-it が宛先を unescape
 * してから解決するので、アプリでは画像が出る ── 書出しだけが落としていた形。
 */
const BODIES: ReadonlyArray<{ what: string; body: string }> = [
  { what: '素の参照', body: `![図](asset:${KEY})\n` },
  { what: 'backslash escape', body: `![図](asset:ast\\-abc)\n` },
  { what: '数値実体', body: `![図](asset:ast&#45;abc)\n` },
  { what: '文末の句読点つき', body: `本文 asset:${KEY}。\n` },
  { what: 'frontmatter だけ(添付 entry)', body: `---\nattachment.asset_key: ${KEY}\n---\n` },
];

function source(body: string): ArchiveSource {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      {
        lid: 'n1',
        title: 'ノート',
        archetype: 'text',
        created_at: NOW,
        updated_at: NOW,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ],
    getBody: async () => body,
    listBodies: async () => ({ rows: [{ lid: 'n1', body }], done: true, next: undefined }),
    listRelations: async () => [],
    listAssetMetas: async () => [{ key: KEY, mime: 'image/png', size: bytes.length, hash: null }],
    getAssetBlob: async () => new Blob([bytes as unknown as BlobPart]),
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  } as unknown as ArchiveSource;
}

/** 正本が keep するか(GC と同じ判定)。 */
function keptByScanner(body: string): boolean {
  const remaining = new Set([KEY]);
  let kept = false;
  scanAssetRefsInto(body, remaining, () => (kept = true));
  return kept;
}

describe('添付を含める判定の一致', () => {
  it.each(BODIES)('🔴 「$what」は 正本 / md ZIP / 可搬 HTML の**全部**が含める', async ({ body }) => {
    // ① 正本(= GC が keep する)
    expect(keptByScanner(body), '正本が拾っていない(前提が崩れている)').toBe(true);

    // ② md ZIP: 添付が実体として入り、「参照されていない」と言わない
    const md = await writeMarkdownZip(source(body), NOW);
    expect(md.counts.assets, 'md ZIP に添付が入っていない').toBe(1);
    expect(
      md.warnings.join('\n'),
      'md ZIP が「参照されていない」と嘘を言っている',
    ).not.toContain('参照されていない');

    // ③ 可搬 HTML: `assetData` に bytes が入る(開いて画像が出る)
    const html = await writePortableHtml(source(body), NOW);
    expect(html.counts.assets, '可搬 HTML に添付が入っていない').toBe(1);
    const text = await html.blob.text();
    const data = JSON.parse(
      /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(text)![1]!,
    ) as { assetData: Record<string, string> };
    expect(Object.keys(data.assetData), '可搬 HTML の実体が入っていない').toContain(KEY);
  });

  /**
   * ⚠ **逆向きも見る** ── 「全部入れる」実装でも上は通る。参照が 1 つも無い
   * 添付は**入らない**こと(人に配るファイルに、消したつもりの添付を混ぜない)。
   */
  it('⚠ どこからも参照されていない添付は入らない(広げすぎていない)', async () => {
    const body = '何も参照していない本文\n';
    expect(keptByScanner(body), '正本が拾ってしまっている').toBe(false);

    const md = await writeMarkdownZip(source(body), NOW);
    expect(md.counts.assets).toBe(0);
    expect(md.warnings.join('\n')).toContain('参照されていない');

    const html = await writePortableHtml(source(body), NOW);
    expect(html.counts.assets).toBe(0);
  });
});
