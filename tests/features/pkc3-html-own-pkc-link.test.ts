/** @vitest-environment happy-dom */
/**
 * 閲覧用 HTML の書き出し: 自分の入れ物宛の `pkc://<自分>/entry/<lid>` は、ほかのノートへのリンクと
 * 同じに押せる形で焼く(#1087)。入れ物の id を描画に渡さないと、全部が「別の PKC のノート」の札
 * (押せない)に降り、「入っていないノートへのリンク」の注意にも数えられなかった。
 */
import { describe, expect, it } from 'vitest';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const NOW = '2026-08-02T00:00:00.000Z';

function source(bodies: Array<{ lid: string; body: string }>): ArchiveSource {
  const entries = bodies.map((e, i) => ({
    lid: e.lid,
    title: e.lid,
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
    title: 'テスト',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    listBodies: async () => ({ rows: entries.map((e) => ({ lid: e.lid, body: e.body })), done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
  } as unknown as ArchiveSource;
}

describe('可搬 HTML — 自分宛の pkc:// リンク(#1087)', () => {
  it('🔴 自分の入れ物宛は押せるノート間リンクになり、入っていないノート宛は注意に数えられる', async () => {
    const src = source([
      { lid: 'n1', body: '[入っている](pkc://c1/entry/n2) と [入っていない](pkc://c1/entry/gone)\n' },
      { lid: 'n2', body: '本文\n' },
    ]);
    const out = await writePortableHtml(src, NOW, (t, o) => renderMarkdown(t, o));
    const html = await out.blob.text();
    const data = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const n1 = (JSON.parse(data) as { entries: Array<{ lid: string; html: string }> }).entries.find(
      (e) => e.lid === 'n1',
    )!;
    // 押せる形(閲覧側が拾う属性)で焼かれている ── 以前は「別の PKC」の札(`pkc-portable-reference-placeholder`)
    expect(n1.html).toContain('data-pkc-entry-ref="entry:n2"');
    expect(n1.html).not.toContain('pkc-portable-reference-placeholder');
    // 入っていないノートへのリンクも数えられる(以前は札に降りていたので 0 件のまま黙っていた)
    expect(out.warnings.some((w) => w.includes('入っていないノートへのリンク 1 件'))).toBe(true);
  });
});
