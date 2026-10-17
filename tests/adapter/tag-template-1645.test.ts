/** @vitest-environment happy-dom */
/**
 * 🔴 #1645 の残り 2 点(Gemini 裁定 = #1163 の依頼 39-1=A / 39-4=A「推薦どおり」)。
 *
 * ① 設定に「色を付けたタグ」の一覧(色の見本・名前・「色を外す」)── 外すと色の一覧から消える
 * ④ 左上の作成の ▼ に「テンプレートから作る…」── 選ぶと、中身の入った新しいノートが編集の状態で開く
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyTagColors, currentTagColors } from '../../src/adapter/ui/render/tag-color';
import { createTagColorListSection } from '../../src/adapter/ui/render/settings/tag-color-list';
import { snippetItemOf } from '../../src/features/snippet/snippet-table';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { openDialog } from './dialog-helper';

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
    ...over,
  };
}

afterEach(() => {
  resetAppDialogForTest();
  document.body.textContent = '';
});

describe('① 設定の「色を付けたタグ」の一覧', () => {
  beforeEach(() => applyTagColors(document, []));

  function mount() {
    const region = document.createElement('div');
    document.body.append(region);
    const sec = createTagColorListSection(region);
    const nodes = sec.build();
    region.append(...(Array.isArray(nodes) ? nodes : [nodes]));
    return { region, sec };
  }
  const rows = (r: HTMLElement) =>
    [...r.querySelectorAll<HTMLElement>('[data-pkc-field="tag-color-list-row"]')];

  it('色を付けたタグが、見本・名前・「色を外す」つきで並ぶ。色が無ければその旨', () => {
    const { region, sec } = mount();
    sec.sync({} as never);
    expect(region.textContent).toContain('色を付けたタグはありません');
    applyTagColors(document, [
      { tag: '買い物', color: '#ff8800' },
      { tag: '急ぎ', color: '#00aa44' },
    ]);
    const rs = rows(region);
    expect(
      rs.map((x) => x.querySelector('[data-pkc-field="tag-color-list-name"]')?.textContent),
    ).toEqual(['買い物', '急ぎ']);
    expect(
      rs[0]!.querySelector<HTMLElement>('[data-pkc-field="tag-color-list-swatch"]')!.style.background,
    ).toMatch(/#ff8800|rgb\(255, 136, 0\)/);
    const btn = rs[1]!.querySelector<HTMLButtonElement>('[data-pkc-action="tag-color-clear"]')!;
    expect(btn.textContent).toBe('色を外す');
    expect(btn.getAttribute('data-pkc-tag')).toBe('急ぎ');
    expect(region.textContent).not.toContain('色を付けたタグはありません');
  });

  it('🔑 「色を外す」を押すと、色の一覧から消えて、一覧も組み直される', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const { region } = mount();
    root.append(region); // 押しの受け手は root の中の物だけ拾う
    const d = new Dispatcher();
    // 色を外す口(`setTagColor`)は main.ts が持つ ── ここでは同じ形で色の一覧へ反映する
    bindActions(root, d, {
      setTagColor: (tag: string, color: string | null) => {
        applyTagColors(
          document,
          currentTagColors().filter((e) => e.tag !== tag || color !== null),
        );
      },
    });
    applyTagColors(document, [
      { tag: '買い物', color: '#ff8800' },
      { tag: '急ぎ', color: '#00aa44' },
    ]);
    region
      .querySelector<HTMLElement>('[data-pkc-tag="買い物"][data-pkc-action="tag-color-clear"]')!
      .click();
    expect(currentTagColors().map((e) => e.tag)).toEqual(['急ぎ']);
    expect(rows(region)).toHaveLength(1);
  });
});

describe('④ テンプレートから作る', () => {
  function setup() {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    const sent: Dispatchable[] = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: Dispatchable) => {
      sent.push(a);
      return raw(a);
    }) as typeof d.dispatch;
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    const item = snippetItemOf('tpl1', '議事録の型', '## 議事録 ${date}\n- ');
    expect(item).not.toBeNull();
    d.dispatch({ type: 'SET_SNIPPET_SCAN', scan: { items: [item!], total: 1, truncated: false } });
    sent.length = 0;
    const press = () =>
      root
        .querySelector<HTMLElement>(
          '[data-pkc-region="create-menu"] [data-pkc-action="create-from-template"]',
        )!
        .click();
    return { root, d, sent, press };
  }

  it('▼ の中に「テンプレートから作る…」が在る', () => {
    const { root } = setup();
    const b = root.querySelector(
      '[data-pkc-region="create-menu"] [data-pkc-action="create-from-template"]',
    );
    expect(b?.textContent).toContain('テンプレートから作る…');
  });

  it('🔴 押すと一覧が出て、選ぶと中身の入ったノートが編集の状態で開く', async () => {
    const { d, sent, press } = setup();
    press();
    await tick();
    const row = openDialog()?.querySelector<HTMLButtonElement>(
      '[data-pkc-field="pick-template-note"]',
    );
    expect(row?.textContent).toBe('議事録の型');
    expect(sent.some((a) => a.type === 'CREATE_ENTRY'), '選ぶ前に作っている').toBe(false);
    row!.click();
    await tick();
    const created = sent.find((a) => a.type === 'CREATE_ENTRY') as
      | { body?: string; archetype: string }
      | undefined;
    expect(created, '作っていない').toBeDefined();
    expect(created!.archetype).toBe('text');
    expect(created!.body).toContain('## 議事録 ');
    expect(created!.body, '変数が埋まっていない').not.toContain('${date}');
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().openBody?.body).toBe(created!.body);
  });

  it('自分のテンプレートが無いときは、作り方を書いた 1 行を出す(黙らない)', async () => {
    const { d, sent, press } = setup();
    d.dispatch({ type: 'SET_SNIPPET_SCAN', scan: { items: [], total: 0, truncated: false } });
    sent.length = 0;
    press();
    await tick();
    expect(openDialog()).toBeNull();
    const n = sent.find((a) => a.type === 'OP_NOTICE') as { message: string } | undefined;
    expect(n?.message).toContain('まだ自分のテンプレートがありません');
    expect(sent.some((a) => a.type === 'CREATE_ENTRY')).toBe(false);
  });
});
