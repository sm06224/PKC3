/** @vitest-environment happy-dom */
/**
 * 🔴 **別のタブ・窓が編集中のノートへは、タグの付け外しも撃たない**(#1087。追記と同じ門)/
 * **集計のタグの名前を変えたら、色も付いてくる**。
 *
 * 対象の口: 情報ペインの `add-tag` / `untag-entry`、フォルダの帯の `bulk-tag-add` / `bulk-tag-remove`、
 * 集計の `query-tag-rename` / `query-tag-remove`、スマートフォルダの「外す」(`smart-evict`)。
 * ⚠ 通すと、編集中のタブの保存で上書きされ、足した / 外したタグは履歴にだけ残る。
 * 観測点は「撃った `BULK_TAG` / `SMART_TAGS`」と「出た断りの字」。各口に、錠が取れたとき(対照群)は撃つことを置く。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, type AppState, type Dispatchable } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { QueryRenderer } from '../../src/adapter/ui/render/query';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { applyTagColors } from '../../src/adapter/ui/render/tag-color';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';

function meta(lid: string, i: number): EntryMeta {
  return {
    lid,
    title: `ノート${lid}`,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: i + 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const denied = () => ({ acquireEditLock: vi.fn(async () => 'denied' as const), releaseEditLock: vi.fn() });
const granted = () => ({ acquireEditLock: vi.fn(async () => 'granted' as const), releaseEditLock: vi.fn() });

function make(services: Partial<BinderServices>, over: Partial<AppState> = {}) {
  const state: AppState = {
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([['a', meta('a', 0)], ['b', meta('b', 1)]]),
    selectedLid: 'a',
    queryKey: 'tags',
    queryKeys: { keys: [{ key: 'tags', count: 2 }], omittedKeys: 0, scanned: 2 },
    queryGroups: {
      groups: [{ value: '請求', total: 2, lids: ['a', 'b'] }],
      omittedGroups: 0,
      scanned: 2,
    },
    ...over,
  };
  const root = document.createElement('div');
  document.body.append(root);
  const region = document.createElement('div');
  root.append(region);
  const d = new Dispatcher(state);
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d, { settle: () => Promise.resolve(), ...services });
  new QueryRenderer(region).render(d.getState());
  const press = (action: string, attrs: Record<string, string> = {}): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', action);
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    root.append(b);
    b.click();
  };
  const bulks = () => sent.filter((a) => a.type === 'BULK_TAG');
  return { root, d, sent, press, bulks };
}

const dialogOk = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!;

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  applyTagColors(document, []);
});

describe('情報ペインのタグ(add-tag / untag-entry)', () => {
  const withField = (t: ReturnType<typeof make>, value: string): HTMLInputElement => {
    const f = document.createElement('input');
    f.setAttribute('data-pkc-field', 'tag-add-input');
    f.value = value;
    t.root.append(f);
    return f;
  };

  it('🔴 add-tag: 別のタブが握っていたら何も撃たず、理由を出し、打った字は欄に残る', async () => {
    const lock = denied();
    const t = make(lock);
    const f = withField(t, '請求済');
    t.press('add-tag');
    await tick();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('a');
    expect(t.bulks(), '断られたのにタグを撃った').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
    expect(f.value, '断った回に打った字を捨てた').toBe('請求済');
  });

  it('対照群: add-tag は取れたら撃ち、欄を空にする(錠は返す)', async () => {
    const lock = granted();
    const t = make(lock);
    const f = withField(t, '請求済');
    t.press('add-tag');
    await tick();
    expect(t.bulks()).toEqual([{ type: 'BULK_TAG', lids: ['a'], tags: ['請求済'], mode: 'add' }]);
    expect(f.value).toBe('');
    expect(lock.releaseEditLock).toHaveBeenCalledWith('a');
  });

  it('🔴 untag-entry: 別のタブが握っていたら何も撃たず、理由を出す', async () => {
    const lock = denied();
    const t = make(lock);
    t.press('untag-entry', { 'data-pkc-tag': '請求' });
    await tick();
    expect(t.bulks(), '断られたのにタグを外した').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it('対照群: untag-entry は取れたら撃つ', async () => {
    const t = make(granted());
    t.press('untag-entry', { 'data-pkc-tag': '請求' });
    await tick();
    expect(t.bulks()).toEqual([{ type: 'BULK_TAG', lids: ['a'], tags: ['請求'], mode: 'remove' }]);
  });

  it('問い合わせが落ちたら、次にすることを言って撃たない(add-tag)', async () => {
    const t = make({
      acquireEditLock: async () => {
        throw new Error('x');
      },
      releaseEditLock: vi.fn(),
    });
    withField(t, '請求済');
    t.press('add-tag');
    await tick();
    expect(t.bulks()).toHaveLength(0);
    expect(t.d.getState().error ?? '').toContain('タグを足せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください');
  });
});

describe('集計(query-tag-rename / query-tag-remove)', () => {
  const type = async (value: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>('[data-pkc-field="prompt-input"]')!;
    input.value = value;
    dialogOk().click();
    await tick();
  };

  it('🔴 全部外す: 組のノートの 1 つでも別のタブが握っていたら、何も撃たない', async () => {
    const lock = denied();
    const t = make(lock);
    t.press('query-tag-remove', { 'data-pkc-tag': '請求' });
    await tick();
    dialogOk().click();
    await tick();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('a');
    expect(t.bulks(), '断られたのに外した').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it('対照群: 全部外す は取れたら撃つ', async () => {
    const t = make(granted());
    t.press('query-tag-remove', { 'data-pkc-tag': '請求' });
    await tick();
    dialogOk().click();
    await tick();
    expect(t.bulks()).toHaveLength(1);
  });

  it('🔴 名前を変える: 別のタブが握っていたら、外すも付けるも撃たず、色も動かさない', async () => {
    const setTagColor = vi.fn();
    applyTagColors(document, [{ tag: '請求', color: '#ff0000' }]);
    const t = make({ ...denied(), setTagColor });
    t.press('query-tag-rename', { 'data-pkc-tag': '請求' });
    await tick();
    await type('請求済');
    dialogOk().click();
    await tick();
    expect(t.bulks()).toHaveLength(0);
    expect(setTagColor, '断ったのに色を動かした').not.toHaveBeenCalled();
  });
});

describe('名前を変えたら色も付いてくる(#1087)', () => {
  const rename = async (t: ReturnType<typeof make>, to: string): Promise<void> => {
    t.press('query-tag-rename', { 'data-pkc-tag': '請求' });
    await tick();
    const input = document.querySelector<HTMLInputElement>('[data-pkc-field="prompt-input"]')!;
    input.value = to;
    dialogOk().click();
    await tick();
    dialogOk().click();
    await tick();
  };

  it('🔴 古い名前の色を外し、新しい名前へ付ける(古い色を孤児にしない)', async () => {
    applyTagColors(document, [{ tag: '請求', color: '#ff0000' }]);
    const setTagColor = vi.fn();
    const t = make({ setTagColor });
    await rename(t, '請求済');
    expect(t.bulks()).toHaveLength(2);
    expect(setTagColor.mock.calls).toEqual([
      ['請求', null],
      ['請求済', '#ff0000'],
    ]);
  });

  it('新しい名前に既に色があるなら、そちらを尊重して動かさない', async () => {
    applyTagColors(document, [
      { tag: '請求', color: '#ff0000' },
      { tag: '請求済', color: '#00ff00' },
    ]);
    const setTagColor = vi.fn();
    const t = make({ setTagColor });
    await rename(t, '請求済');
    expect(setTagColor).not.toHaveBeenCalled();
  });

  it('古い名前に色が無ければ何もしない', async () => {
    const setTagColor = vi.fn();
    const t = make({ setTagColor });
    await rename(t, '請求済');
    expect(t.bulks()).toHaveLength(2);
    expect(setTagColor).not.toHaveBeenCalled();
  });
});

describe('フォルダの帯(bulk-tag-add / bulk-tag-remove)', () => {
  const rig = (services: Partial<BinderServices>) => {
    const t = make(services, { selection: ['a', 'b'] });
    const f = document.createElement('input');
    f.setAttribute('data-pkc-field', 'bulk-tag');
    f.value = '請求済';
    t.root.append(f);
    return { t, f };
  };

  it.each(['bulk-tag-add', 'bulk-tag-remove'])('🔴 %s: 選んだ 1 つでも別のタブが握っていたら何も撃たず、欄も残る', async (action) => {
    const lock = denied();
    const { t, f } = rig(lock);
    t.press(action);
    await tick();
    expect(t.bulks(), '断られたのにタグを撃った').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
    expect(f.value, '断った回に打った字を捨てた').toBe('請求済');
  });

  it.each([
    ['bulk-tag-add', 'add'],
    ['bulk-tag-remove', 'remove'],
  ])('対照群: %s は取れたら 1 回で撃ち、欄を空にする', async (action, mode) => {
    const { t, f } = rig(granted());
    t.press(action);
    await tick();
    expect(t.bulks()).toEqual([
      { type: 'BULK_TAG', lids: ['a', 'b'], tags: ['請求済'], mode, field: 'bulk-tag' },
    ]);
    expect(f.value).toBe('');
  });
});
