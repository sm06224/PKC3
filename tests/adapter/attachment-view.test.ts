/** @vitest-environment happy-dom */
/**
 * attachment view(P4a)の表示と **lend/dispose 規律**(生成物のライフサイクル
 * 終端での即破棄 ── user 指示 2026-07-27)の pin。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(bodies: Record<string, string>, lender: AssetLender) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, lender);
  d.onState((s) => detail.render(s));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    persistEntry: async () => {},
    deleteEntry: async () => {},
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a1'), meta('a2', { archetype: 'text' })],
    relations: [],
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { d, q };
}

describe('attachment view (P4a)', () => {
  const imgBody = attachmentBody({
    name: 'p.png',
    mime: 'image/png',
    size: 3,
    assetKey: 'ast-1',
  });

  it('image preview: lend した URL が img に付き、選択遷移で必ず dispose される', async () => {
    let disposed = 0;
    const lender: AssetLender = {
      lend: async () => ({ url: 'blob:fake-1', dispose: () => disposed++ }),
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);

    const img = q<HTMLImageElement>('[data-pkc-field="attachment-media"]');
    expect(img?.getAttribute('src')).toBe('blob:fake-1');
    // メタ表示 + ダウンロード導線
    expect(q('[data-pkc-field="attachment-info"]')?.textContent).toContain('p.png');
    expect(
      q('[data-pkc-action="download-asset"]')?.getAttribute('data-pkc-asset-key'),
    ).toBe('ast-1');
    expect(disposed).toBe(0); // 表示中は生きている

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a2' });
    await tick(20);
    expect(disposed).toBe(1); // 表示の寿命の終わりで即 dispose
  });

  /**
   * P8 段⑰: 🔴 **同じノートを開いたままの再描画で借り直さない**(レビュー H-4)。
   *
   * 🔴 直す前の実測: 添付を選んだまま履歴の開閉を 3 往復すると
   * **lend 7 回 / dispose 0 回**、画面の `<img>` は 1 枚。骨組みを使い回す
   * ようになった段⑪ 以降、`fresh` でない再描画では `disposeLends()` が走らず、
   * `textContent=''` で `<img>` だけ消えて貸出が積み上がっていた。
   * ⚠ 既存 test は「**選択遷移で** dispose」しか見ておらず、同一 lid の
   * 再描画を 1 件も見ていなかった。
   */
  it('🔴 同じノートのまま何度描き直しても、生きている貸出は 1 本だけ', async () => {
    let lent = 0;
    let disposed = 0;
    const lender: AssetLender = {
      lend: async () => {
        lent += 1;
        return { url: `blob:n${lent}`, dispose: () => disposed++ };
      },
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);

    // 履歴の開閉 = 同じノートのまま再描画(骨組みは作り直されない)
    for (let i = 0; i < 3; i++) {
      d.dispatch({ type: 'SHOW_HISTORY' });
      await tick(20);
      d.dispatch({ type: 'HIDE_HISTORY' });
      await tick(20);
    }
    expect(q('[data-pkc-field="attachment-media"]'), '画像が消えた').not.toBeNull();
    // 🔴 生きている貸出は**常に 1 本**(= 借りた数 - 返した数)
    expect(lent - disposed, `貸出が積み上がっている(lend ${lent} / dispose ${disposed})`).toBe(1);

    // 選択を移したら最後の 1 本も返る
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a2' });
    await tick(20);
    expect(lent - disposed).toBe(0);
  });

  it('text preview は blob.text() を切り出して表示(URL を借りない)', async () => {
    const lender: AssetLender = {
      lend: async () => {
        throw new Error('text preview must not lend a URL');
      },
      getBlob: async () => new Blob(['こんにちは asset'], { type: 'text/plain' }),
    };
    const body = attachmentBody({
      name: 'a.txt',
      mime: 'text/plain',
      size: 10,
      assetKey: 'ast-t',
    });
    const { d, q } = setup({ a1: body }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-field="attachment-text"]')?.textContent).toContain(
      'こんにちは asset',
    );
  });

  it('asset 不在は missing 表示(黙って空にしない)', async () => {
    const lender: AssetLender = {
      lend: async () => null,
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-asset-missing]')).not.toBeNull();
  });

  it('stale hydrate: 解決前に選択が移ったら結果を捨てて即 dispose(URL leak 0)', async () => {
    let disposed = 0;
    let release: (v: { url: string; dispose: () => void } | null) => void = () => {};
    const lender: AssetLender = {
      lend: () =>
        new Promise((r) => {
          release = r;
        }),
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a2' }); // 解決前に離脱
    await tick();
    release({ url: 'blob:late', dispose: () => disposed++ }); // 遅延解決
    await tick();
    expect(disposed).toBe(1); // 借りた瞬間に返す
    expect(q('[data-pkc-field="attachment-media"]')).toBeNull(); // stale DOM 注入なし
  });
});

/**
 * P8 段⑬ review L-3: 🔴 **添付の説明にも図が書ける**。
 *
 * 本文(`renderView`)は `hydrateMermaid` を呼んでいたが、添付の説明だけ
 * 呼んでいなかった ── 同じ markdown なのに、置き場所で描けたり描けなかったりする。
 * 器(`data-pkc-mermaid-src`)は出るので**空の枠が残る**だけで、例外も出ない。
 *
 * ⚠ 観測点は「図が描けたか」ではなく「**面倒を見始めたか**」── 実際の焼き上げは
 * mermaid の読み込みが要る(`tests/adapter/mermaid-hydrate.test.ts` と同じ判断)。
 */
describe('添付の説明に書いた図(P8 段⑬)', () => {
  it('🔴 本文と同じように図の面倒を見る', async () => {
    const observed: Element[] = [];
    class FakeIO {
      constructor(_cb: unknown) {
        void _cb;
      }
      observe(el: Element): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    try {
      // 説明は frontmatter の**後ろ**に書く markdown(本文と同じ書き方)
      const body =
        attachmentBody({ name: 'p.png', mime: 'image/png', size: 3, assetKey: 'ast-1' }) +
        'この図の通り。\n\n```mermaid\ngraph TD\n  A-->B\n```\n';
      const lender: AssetLender = {
        lend: async () => ({ url: 'blob:fake-1', dispose: () => {} }),
        getBlob: async () => null,
      };
      const { d, q } = setup({ a1: body, a2: '# text' }, lender);
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
      await tick(20);

      const host = q('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
      expect(host, '添付の説明に図の器が出ていない').not.toBeNull();
      expect(observed, '器は出たのに、誰も焼きに来ない(空の枠が残る)').toContain(host);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
