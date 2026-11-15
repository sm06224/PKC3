/** @vitest-environment happy-dom */
/** #1163 依頼 223: 書き出した HTML の表も、見出しを押して並べ替えられる(読む面と同じ規則)。 */
import { describe, expect, it } from 'vitest';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { MINUS_LIKE, PLAIN_DECIMAL, parseComparable } from '../../src/features/markdown/table-sort-key';

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


const TABLE = '| 品 | 金額 |\n|---|---|\n| あ | 9 |\n| い | 100 |\n| う | ¥25 |\n';
const col = (i: number): string[] =>
  Array.from(document.querySelectorAll('#pkc-body tbody tr')).map((tr) => tr.children[i]?.textContent ?? '');

describe('書き出した HTML の表の並べ替え(依頼 223)', () => {
  it('🔴 見出しを押すと 昇順 → 降順 → 元の順(数は数として並ぶ)', async () => {
    await open((await writePortableHtml(source([{ lid: 'n1', title: '表', body: TABLE }]), NOW, (t) => Promise.resolve(renderMarkdown(t)))).blob);
    const th = Array.from(document.querySelectorAll<HTMLElement>('#pkc-body thead th'));
    expect(th, '前提: 見出しが無い').toHaveLength(2);
    expect(col(1)).toEqual(['9', '100', '¥25']);
    th[1]!.click();
    expect(col(1), '数として並んでいない(9 が 100 より後ろ)').toEqual(['9', '¥25', '100']);
    expect(th[1]!.getAttribute('aria-sort')).toBe('ascending');
    th[1]!.click();
    expect(col(1)).toEqual(['100', '¥25', '9']);
    th[1]!.click();
    expect(col(1), '元の順に戻らない').toEqual(['9', '100', '¥25']);
  });

  it('🔴 数として読む規則は読む面と同じ 1 本(閲覧側は table-sort-key の正規表現をそのまま埋める)', async () => {
    const html = await (await writePortableHtml(source([{ lid: 'n1', title: '表', body: TABLE }]), NOW, (t) => Promise.resolve(renderMarkdown(t)))).blob.text();
    expect(html, '読む面の規則と違う字を埋めている').toContain(`new RegExp(${JSON.stringify(PLAIN_DECIMAL.source)})`);
    expect(html).toContain(`new RegExp(${JSON.stringify(MINUS_LIKE.source)},'g')`);
    // 対照: 読む面で数にならない字(部品番号)は、閲覧側でも字として並ぶ
    expect(parseComparable('12E5').isNum).toBe(false);
  });

  it('⚠ 全体の印刷(#pkc-all)の表には並べ替えを付けない(紙に印が出ない)', async () => {
    await open((await writePortableHtml(source([{ lid: 'n1', title: '表', body: TABLE }, { lid: 'n2', title: '二', body: TABLE }]), NOW, (t) => Promise.resolve(renderMarkdown(t)))).blob);
    document.getElementById('pkc-printall')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const allTh = document.querySelectorAll('#pkc-all thead th');
    expect(allTh.length, '前提: 全体の印刷に表が出ていない').toBeGreaterThan(0);
    expect(document.querySelectorAll('#pkc-all th[data-pkc-sort-direction]'), '全体の印刷に並べ替えが付いた').toHaveLength(0);
    expect(document.querySelectorAll('#pkc-body th[data-pkc-sort-direction]').length, '対照: 本文には付く').toBeGreaterThan(0);
  });
});
