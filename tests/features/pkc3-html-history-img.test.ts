/** @vitest-environment happy-dom */
/**
 * 閲覧用 HTML(台帳 #1852 束 U1 残り)
 *  - 依頼 77-4 C: ブラウザの「戻る」「進む」でノートを行き来できる
 *  - 依頼 77-5 B: 画像を押すと、元の大きさで新しいタブに開く
 *
 * 閲覧側のインライン JS を**そのまま実行**して DOM を見る(script 文字列の部分一致では動くかが分からない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const enc = new TextEncoder();
const NOW = '2026-08-02T00:00:00.000Z';

function source(
  entries: Array<{ lid: string; title: string; body: string }>,
  assets: Array<{ key: string; mime: string; bytes: Uint8Array }> = [],
): ArchiveSource {
  const rows = entries.map((e, i) => ({
    ...e,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
  }));
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () =>
      rows.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    listBodies: async () => ({ rows: rows.map((e) => ({ lid: e.lid, body: e.body })), done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => assets.map((a) => ({ key: a.key, mime: a.mime, size: a.bytes.length, hash: null })),
    getAssetBlob: async (key) => {
      const a = assets.find((x) => x.key === key);
      return a ? new Blob([a.bytes as unknown as BlobPart]) : null;
    },
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

/** 閲覧側が張った popstate の受け手(test の間に積み上がって別の test を揺らさないよう、後で外す)。 */
const popHandlers: EventListener[] = [];
const realAdd = window.addEventListener.bind(window);
beforeEach(() => {
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: EventListener, o?: unknown) => {
    if (type === 'popstate') popHandlers.push(fn);
    realAdd(type, fn, o as AddEventListenerOptions);
  }) as typeof window.addEventListener);
});

afterEach(() => {
  for (const h of popHandlers.splice(0)) window.removeEventListener('popstate', h);
  vi.restoreAllMocks();
});

async function run(blob: Blob): Promise<void> {
  const html = await blob.text();
  const dataJson = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const viewer = /<script>\n([\s\S]*?)\n<\/script>$/.exec(html)![1]!;
  const markup = /<\/script>([\s\S]*?)<script>/.exec(html.slice(html.indexOf('</script>')))![1]!;
  document.body.innerHTML = markup;
  const data = document.createElement('script');
  data.id = 'pkc-data';
  data.type = 'application/json';
  data.textContent = dataJson;
  document.body.appendChild(data);
  new Function(viewer)();
  await new Promise((r) => setTimeout(r, 0));
}

const render = (t: string, o?: Parameters<typeof renderMarkdown>[1]): Promise<string> =>
  Promise.resolve(renderMarkdown(t, o));
const title = (): string => document.getElementById('pkc-title')!.textContent ?? '';
const pop = (state: unknown): void => {
  window.dispatchEvent(Object.assign(new Event('popstate'), { state }));
};

describe('依頼 77-4 C: 「戻る」「進む」でノートを行き来できる', () => {
  const threeNotes = (): ArchiveSource =>
    source([
      { lid: 'n1', title: '一つ目', body: '[二つ目へ](entry:n2)\n' },
      { lid: 'n2', title: '二つ目', body: '[三つ目の節へ](entry:n3#h/%E7%AF%80)\n' },
      { lid: 'n3', title: '三つ目', body: '## 節\n\n本文\n' },
    ]);

  it('🔴 リンクで移るたびに履歴が積まれ、最初の表示は積まない(replace)', async () => {
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    await run((await writePortableHtml(threeNotes(), NOW, render)).blob);
    expect(replace).toHaveBeenCalledWith({ pkcI: 0, pkcH: '' }, '');
    expect(push, '最初の表示で履歴を積んだ(戻るがファイルを開く前に出られなくなる)').not.toHaveBeenCalled();
    document.querySelector<HTMLAnchorElement>('#pkc-body a[data-pkc-entry-ref="entry:n2"]')!.click();
    expect(title()).toBe('二つ目');
    expect(push).toHaveBeenLastCalledWith({ pkcI: 1, pkcH: '' }, '');
    document.querySelector<HTMLAnchorElement>('#pkc-body a[data-pkc-entry-ref^="entry:n3"]')!.click();
    expect(title()).toBe('三つ目');
    expect(push).toHaveBeenLastCalledWith({ pkcI: 2, pkcH: '%E7%AF%80' }, '');
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('🔴 戻る(popstate)で前のノートが開き、履歴は増えない。進むも同じ', async () => {
    await run((await writePortableHtml(threeNotes(), NOW, render)).blob);
    document.querySelector<HTMLAnchorElement>('#pkc-body a[data-pkc-entry-ref="entry:n2"]')!.click();
    expect(title()).toBe('二つ目');
    const push = vi.spyOn(history, 'pushState');
    pop({ pkcI: 0, pkcH: '' });
    expect(title(), '戻っても前のノートが開かない').toBe('一つ目');
    expect(document.querySelector('#pkc-list [aria-current="true"]')?.textContent, '一覧の印が戻らない').toBe('一つ目');
    pop({ pkcI: 1, pkcH: '' });
    expect(title(), '進んでも開かない').toBe('二つ目');
    expect(push, '戻る・進むで履歴を積み直した(戻るが堂々巡りになる)').not.toHaveBeenCalled();
  });

  it('一覧のボタンで移っても履歴に積む。自分のものでない履歴(state なし・範囲外)は無視する', async () => {
    const push = vi.spyOn(history, 'pushState');
    await run((await writePortableHtml(threeNotes(), NOW, render)).blob);
    document.querySelectorAll<HTMLButtonElement>('#pkc-list button')[2]!.click();
    expect(title()).toBe('三つ目');
    expect(push).toHaveBeenLastCalledWith({ pkcI: 2, pkcH: '' }, '');
    pop(null);
    pop({ pkcI: 99, pkcH: '' });
    pop({ other: 1 });
    expect(title(), '知らない履歴で表示が変わった').toBe('三つ目');
  });

  it('履歴が使えない環境でも、ノートへは移れる(今までどおり)', async () => {
    vi.spyOn(history, 'pushState').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    await run((await writePortableHtml(threeNotes(), NOW, render)).blob);
    expect(() => document.querySelector<HTMLAnchorElement>('#pkc-body a[data-pkc-entry-ref="entry:n2"]')!.click()).not.toThrow();
    expect(title()).toBe('二つ目');
  });
});

describe('依頼 77-5 B: 画像を押すと、元の大きさで新しいタブに開く', () => {
  const png = { key: 'ast-p', mime: 'image/png', bytes: enc.encode('PNGBYTES') };

  it('🔴 本文の画像はリンクで包まれ、新しいタブ(noopener)で元の画像を開く', async () => {
    await run(
      (
        await writePortableHtml(
          source([{ lid: 'n1', title: '画像', body: '![図](asset:ast-p)\n' }], [png]),
          NOW,
          render,
        )
      ).blob,
    );
    const img = document.querySelector<HTMLImageElement>('#pkc-body img')!;
    expect(img.getAttribute('src'), '前提:画像が差し込まれていない').toMatch(/^blob:/);
    const a = img.closest('a')!;
    expect(a, '画像が押せる形になっていない').not.toBeNull();
    expect(a.getAttribute('href'), '同じ画像の URL を開く').toBe(img.getAttribute('src'));
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    expect(a.hasAttribute('data-pkc-img-open')).toBe(true);
    const css = Array.from(document.querySelectorAll('style'))
      .map((x) => x.textContent ?? '')
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css, '押せる画像の見た目の規則が無い').toMatch(/a\[data-pkc-img-open\]\{[^}]*cursor:zoom-in/);
  });

  it('すでにリンクの中にある画像は包み直さない(リンク先を奪わない)', async () => {
    await run(
      (
        await writePortableHtml(
          source([{ lid: 'n1', title: '画像', body: '[![図](asset:ast-p)](https://example.com/)\n' }], [png]),
          NOW,
          render,
        )
      ).blob,
    );
    const img = document.querySelector<HTMLImageElement>('#pkc-body img')!;
    expect(img.closest('a')?.getAttribute('href')).toBe('https://example.com/');
    expect(document.querySelectorAll('#pkc-body a[data-pkc-img-open]')).toHaveLength(0);
  });
});
