/** @vitest-environment happy-dom */
/**
 * 🔴 **書き出した HTML にも紙面が届く**(2026-08-08。紙面フォーマット段 1)。
 *
 * 配る HTML は**別の面**である ── アプリで直しても、ここへ配らなければ
 * 「画面と紙・配った物で幅が違う」が起きる(2026-08-08 の裁定で 1 本化したばかりの
 * ところなので、同じ非対称を作り直さない)。
 *
 * 届く道は 3 つあり、**どれが欠けても静かに壊れる**:
 * ① 器(`<body>`)に印が焼かれている ② その印に当たる規則が `<style>` に在る
 * ③ 本文の器 2 つ(`#body` と「全体を印刷」の箱)が**散文の印**を持っている
 */
import { describe, expect, it } from 'vitest';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { pageFormatSpec } from '../../src/features/page-format';

function source(): ArchiveSource {
  const rows = [{ lid: 'e1', body: '書き出す段落。\n' }];
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () => [
      {
        lid: 'e1',
        title: '題',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ],
    listBodies: async () => ({ rows, done: true, next: { entryOrder: 1, lid: 'e1' } }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

const NOW = '2026-08-08T00:00:00.000Z';

async function html(fmt?: Parameters<typeof writePortableHtml>[4]): Promise<string> {
  const out = await writePortableHtml(source(), NOW, undefined, false, fmt);
  return out.blob.text();
}

describe('書き出す HTML の紙面', () => {
  it('🔴 器(body)に紙面が焼かれ、本文の器がその配下に在る', async () => {
    const doc = new DOMParser().parseFromString(await html('a3-landscape'), 'text/html');
    expect(
      doc.body.getAttribute('data-pkc-page-format'),
      '器に紙面が焼かれていない(配った HTML だけ既定の幅に戻る)',
    ).toBe('a3-landscape');
    const body = doc.querySelector('#body');
    expect(body, '本文の器が無い(この検査は空振り)').not.toBeNull();
    // ⚠ **継承で届く**のが仕組みなので、器が body の配下に在ることまで見る
    expect(doc.body.contains(body!), '本文の器が紙面の印の外に出ている').toBe(true);
  });

  it('🔴 散文の印は **2 か所とも**(#body と「全体を印刷」の箱)', async () => {
    const out = await html('a4-portrait');
    const doc = new DOMParser().parseFromString(out, 'text/html');
    expect(
      doc.querySelector('#body')!.hasAttribute('data-pkc-prose'),
      '読む器に散文の印が無い(本文が全幅に伸びる)',
    ).toBe(true);
    // ⚠ 「全体を印刷」の箱は閲覧側の script が作る ── 字面で pin する
    //    (片方だけ付けるのが、この file が 2 度踏んだ罠である)
    expect(
      out,
      '全体印刷の箱に散文の印が無い(誰も見ていない経路で全幅に伸びる)',
    ).toContain("box.setAttribute('data-pkc-prose','')");
  });

  it('🔴 選んだ紙面の**値そのもの**が焼かれる(読み幅 + 紙)', async () => {
    const out = await html('a3-landscape');
    expect(out, '読み幅の差し替えが焼かれていない').toContain(
      "[data-pkc-page-format='a3-landscape']{--read-w:91rem}",
    );
    expect(out, '紙の指定が焼かれていない').toContain('@page{size:A3 landscape}');
    expect(pageFormatSpec('a3-landscape').readWidth, '表と食い違っている').toBe('91rem');
  });

  it('画面用の紙面では @page を焼かない(受け手の既定紙に任せる)', async () => {
    const out = await html('fullhd');
    expect(out).toContain("[data-pkc-page-format='fullhd']{--read-w:none}");
    expect(out, '画面用なのに紙が指定されている').not.toContain('@page{');
  });

  it('⚠ 渡し忘れたら既定(A4 縦)── 全幅ではなく、いままでと同じ幅に倒れる', async () => {
    const out = await html();
    expect(out).toContain('data-pkc-page-format="a4-portrait"');
    expect(out).toContain("[data-pkc-page-format='a4-portrait']{--read-w:42rem}");
  });

  it('🔴 焼いた規則が**読み幅の規則より効く位置**に在る(--read-w が差し替わる)', async () => {
    // 焼いた本文の規則は `max-width:var(--read-w)` を使う ── 値の差し替えが
    // 同じ style に在って初めて意味を持つ(片方だけでは何も変わらない)
    const out = await html('a4-landscape');
    expect(out, '読み幅の規則が焼かれていない').toContain('max-width:var(--read-w)');
    const styleEnd = out.indexOf('</style>');
    const at = out.indexOf("[data-pkc-page-format='a4-landscape']");
    expect(at, '紙面の規則が <style> の外に出ている').toBeGreaterThan(0);
    expect(at, '紙面の規則が <style> の外に出ている').toBeLessThan(styleEnd);
  });
});
