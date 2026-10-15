/** @vitest-environment happy-dom */
/**
 * 全体印刷で見出し・脚注の id を振り直すとき、ノート内の `#slug` リンクも振り直した id へ
 * 向け直す(#1087)。向け直さないと「別のノートの同名の見出し」へ飛ぶか、どこにも飛ばない。
 */
import { describe, expect, it } from 'vitest';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const NOW = '2026-08-02T00:00:00.000Z';

function source(bodies: Array<{ lid: string; title: string; body: string }>): ArchiveSource {
  const entries = bodies.map((e, i) => ({
    lid: e.lid,
    title: e.title,
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
    listBodies: async () => ({
      rows: entries.map((e) => ({ lid: e.lid, body: e.body })),
      done: true,
    }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
  } as unknown as ArchiveSource;
}

async function open(blob: Blob): Promise<void> {
  const html = await blob.text();
  const dataJson = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const viewer = /<script>\n([\s\S]*?)\n<\/script>$/.exec(html)![1]!;
  const markup = /<\/script>([\s\S]*?)<script>/.exec(html.slice(html.indexOf('</script>')))![1]!;
  document.body.innerHTML = markup;
  document.body.removeAttribute('data-print');
  const data = document.createElement('script');
  data.id = 'pkc-data';
  data.type = 'application/json';
  data.textContent = dataJson;
  document.body.appendChild(data);
  new Function(viewer)();
  await new Promise((r) => setTimeout(r, 0));
}

const BODY = (tail: string): string =>
  `:::toc\n:::\n\n# 概要\n[概要へ](#概要)\n\n## 詳細\n本文[^1]\n\n[^1]: 脚注の本文 ${tail}\n`;

async function printAll(): Promise<void> {
  const src = source([
    { lid: 'n1', title: '一つ目', body: BODY('A') },
    { lid: 'n2', title: '二つ目', body: BODY('B') },
  ]);
  await open((await writePortableHtml(src, NOW, (t) => Promise.resolve(renderMarkdown(t)))).blob);
  document.getElementById('printall')!.click();
}

describe('可搬 HTML — 全体印刷のノート内リンク(#1087)', () => {
  it('🔴 #slug リンク(本文・:::toc)が、振り直した自分のノートの見出しを指す', async () => {
    await printAll();
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('#all .b'));
    expect(boxes, '前提:2 件のノートが組まれていない').toHaveLength(2);
    let checked = 0;
    for (const box of boxes) {
      const links = Array.from(box.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')).filter(
        (a) => !a.hasAttribute('data-pkc-entry-ref') && !/fn/.test(a.getAttribute('href')!),
      );
      expect(links.length, '前提:本文に #リンクが無い(空振り)').toBeGreaterThanOrEqual(2);
      for (const a of links) {
        const id = decodeURIComponent(a.getAttribute('href')!.slice(1));
        const target = document.getElementById(id);
        expect(target, `${id} が document に無い`).not.toBeNull();
        expect(box.contains(target), `${id} が別のノートを指している`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('🔴 脚注の id がノートごとに別になり、脚注リンクが自分のノートの脚注を指す', async () => {
    await printAll();
    const ids = Array.from(document.querySelectorAll('#all [id]')).map((el) => el.id);
    expect(new Set(ids).size, `id が重複: ${ids.join()}`).toBe(ids.length);
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('#all .b'));
    for (const box of boxes) {
      const fnLinks = Array.from(box.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')).filter((a) =>
        /fn/.test(a.getAttribute('href')!),
      );
      expect(fnLinks.length, '前提:脚注のリンクが描かれていない').toBeGreaterThanOrEqual(2);
      for (const a of fnLinks) {
        const t = document.getElementById(decodeURIComponent(a.getAttribute('href')!.slice(1)));
        expect(t, `${a.getAttribute('href')} の行き先が無い`).not.toBeNull();
        expect(box.contains(t), '別のノートの脚注を指している').toBe(true);
      }
    }
  });
});
