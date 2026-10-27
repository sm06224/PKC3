/** @vitest-environment happy-dom */
/**
 * 🔴 **読む面だけが、本文の `[[題名]]` を押せる字にし、「ある / まだ無い」の印を当てる**(#1174 段②。穴 B / D)。
 *
 * 描画そのものは `tests/features/markdown-title-link.test.ts`、押した後は `tests/adapter/title-link-actions.test.ts`。
 * **ここが見るのは配線**:
 * - 読む面(`DetailRenderer`)の出力に `open-title-note` が出る(旗 `titleLinks` を渡している)
 * - 受け手の居ない面(章の別ウィンドウ = `readingRenderOptions`)は旗を持たず、生の括弧も出さない
 * - `applyTitleLinks` が描画後に配線され、ノートの一覧が変わると描き直さずに印だけが付き外れする
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, readingRenderOptions } from '../../src/adapter/ui/render/detail';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function meta(lid: string, title: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function stateWith(body: string, metas: EntryMeta[]): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  return s;
}

const BODY = '指す [[在る題名]] と [[まだ無い題名]] と [[在る題名|別の字]]\n';

describe('読む面の配線([[題名]])', () => {
  it('🔴 読む面の出力に、押せる [[題名]] が出る(旗が渡っている)', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(stateWith(BODY, [meta('a', 'リンク元'), meta('t', '在る題名')]));
    await settle();
    const links = root.querySelectorAll('[data-pkc-field="detail-body"] [data-pkc-action="open-title-note"]');
    expect(links.length, '読む面に押せる [[題名]] が出ていない').toBe(3);
    expect(links[0]!.getAttribute('data-pkc-title')).toBe('在る題名');
    expect(links[2]!.textContent, '|表示 の字が出ていない').toBe('別の字');
  });

  it('🔴 描画後に印が当たる(穴 D): 無い題名にだけ「まだ無い」/ ノートが増えると外れる', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    const s1 = stateWith(BODY, [meta('a', 'リンク元'), meta('t', '在る題名')]);
    detail.render(s1);
    await settle();
    const q = (title: string): HTMLElement =>
      root.querySelector<HTMLElement>(`.pkc-title-link[data-pkc-title="${title}"]`)!;
    expect(q('在る題名').hasAttribute('data-pkc-link-missing'), '在るのに印').toBe(false);
    expect(q('まだ無い題名').hasAttribute('data-pkc-link-missing'), '無いのに印が無い(applyTitleLinks が配線されていない)').toBe(true);
    // 作った(一覧が変わった)→ 印が外れる(本文の差し替えでも、一覧が変わっただけでも)
    const s2 = reduce(s1, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 'リンク元'), meta('t', '在る題名'), meta('n', 'まだ無い題名', { entryOrder: 2 })],
      relations: [],
    }).state;
    // SYS_BOOTED は選択を消すので、選び直して本文を戻す
    let s3 = reduce(s2, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s3 = reduce(s3, { type: 'BODY_LOADED', lid: 'a', body: BODY }).state;
    detail.render(s3);
    await settle();
    expect(q('まだ無い題名').hasAttribute('data-pkc-link-missing'), '作ったのに印が残る').toBe(false);
  });

  it('🔴 片付けたノートだけが同名なら「まだ無い」のまま(押したときに開くノートと同じ規則)', async () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(stateWith('[[片付け済み]]\n', [meta('a', 'リンク元'), meta('x', '片付け済み', { archived: true })]));
    await settle();
    expect(root.querySelector('.pkc-title-link')!.hasAttribute('data-pkc-link-missing')).toBe(true);
  });

  it('🔴 章の別ウィンドウが使う設定(readingRenderOptions)は旗を持たず、生の括弧も出さない', () => {
    const opts = readingRenderOptions(BODY, { allowExternalImages: false, currentContainerId: 'c1' });
    expect('titleLinks' in opts, '受け手の居ない面にも旗が渡る').toBe(false);
    const html = renderMarkdown(BODY, opts);
    expect(html).not.toContain('open-title-note');
    expect(html).not.toContain('[[');
    expect(html).toContain('data-pkc-title-ref="在る題名"');
  });
});
