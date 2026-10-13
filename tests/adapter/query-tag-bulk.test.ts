/** @vitest-environment happy-dom */
/**
 * 🔴 **集計(タグ)の組から、そのタグを全ノートで付け替える / 外す**(依頼 65-1)。
 *
 * 守るもの:①タグで束ねた組にだけ押し口が出る(未設定の組・他の項目には出ない)
 * ②確認の字に**影響するノートの件数**が出る ③「やめる」では何も撃たない
 * ④付け替えは「外す → 付ける」の順に `BULK_TAG`(既存の書く口)を撃つ ⑤編集中は断る
 * ⑥上限で切れた組は断る ⑦新しい名前が 1 つでないとき・同じ名前のときは撃たない
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initialState, type AppState, type Dispatchable } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { QueryRenderer } from '../../src/adapter/ui/render/query';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

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
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function make(over: Partial<AppState> = {}) {
  const state: AppState = {
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([['a', meta('a', 0)], ['b', meta('b', 1)], ['c', meta('c', 2)]]),
    queryKey: 'tags',
    queryKeys: { keys: [{ key: 'tags', count: 3 }, { key: 'author', count: 1 }], omittedKeys: 0, scanned: 3 },
    queryGroups: {
      groups: [
        { value: '請求', total: 2, lids: ['a', 'b'] },
        { value: '', total: 1, lids: ['c'] },
      ],
      omittedGroups: 0,
      scanned: 3,
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
  bindActions(root, d, { settle: () => Promise.resolve() });
  new QueryRenderer(region).render(d.getState());
  const btn = (action: string, tag = '請求') =>
    root.querySelector<HTMLElement>(`[data-pkc-action="${action}"][data-pkc-tag="${tag}"]`);
  return { root, d, sent, btn };
}

const dialogBody = (): string =>
  document.querySelector('[data-pkc-field="dialog-body"]')?.textContent ?? '';
const dialogOk = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!;
const dialogCancel = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!;
const bulks = (sent: Dispatchable[]) =>
  sent.filter((a): a is Extract<Dispatchable, { type: 'BULK_TAG' }> => a.type === 'BULK_TAG');

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('押し口が出る場所 (依頼 65-1)', () => {
  it('🔴 タグの組には 2 つ出る / 「(タグなし)」の組には出ない', () => {
    const s = make();
    expect(s.btn('query-tag-rename')?.textContent).toBe('名前を変える');
    expect(s.btn('query-tag-remove')?.textContent).toBe('全部外す');
    expect(
      s.root.querySelectorAll('[data-pkc-action^="query-tag-"]'),
      '未設定の組にまで押し口が出ている',
    ).toHaveLength(2);
  });

  it('対照群: タグ以外の項目で束ねた組には出ない', () => {
    const s = make({
      queryKey: 'author',
      queryGroups: { groups: [{ value: '佐藤', total: 1, lids: ['a'] }], omittedGroups: 0, scanned: 3 },
    });
    expect(s.root.querySelectorAll('[data-pkc-group="佐藤"]')).toHaveLength(1);
    expect(s.root.querySelector('[data-pkc-action^="query-tag-"]')).toBeNull();
  });
});

describe('全部外す', () => {
  it('🔴 確認の字に件数が出て、受けたら組の全ノートへ remove を 1 回撃つ', async () => {
    const s = make();
    s.btn('query-tag-remove')!.click();
    await tick();
    expect(dialogBody()).toBe('タグ「請求」を 2 件のノートから全部外します');
    expect(bulks(s.sent), '確認の前に撃っている').toHaveLength(0);
    dialogOk().click();
    await tick();
    expect(bulks(s.sent)).toEqual([
      { type: 'BULK_TAG', lids: ['a', 'b'], tags: ['請求'], mode: 'remove' },
    ]);
    // 書込が着いたら集計を数え直す
    expect(s.sent.some((a) => a.type === 'REFRESH_QUERY'), '数え直していない').toBe(true);
  });

  it('🔴 「やめる」では何も撃たない', async () => {
    const s = make();
    s.btn('query-tag-remove')!.click();
    await tick();
    dialogCancel().click();
    await tick();
    expect(bulks(s.sent)).toHaveLength(0);
  });

  it('🔴 編集中は断る(確認も出さない)', async () => {
    const s = make({ phase: 'editing' });
    s.btn('query-tag-remove')!.click();
    await tick();
    expect(document.querySelector('[data-pkc-field="dialog-body"]')).toBeNull();
    expect(s.d.getState().error ?? '').toContain('編集を保存するか');
    expect(bulks(s.sent)).toHaveLength(0);
  });

  it('🔴 上限で切れた組は断る(一部だけ外して「全部」と読ませない)', async () => {
    const s = make({
      queryGroups: {
        groups: [{ value: '請求', total: 600, lids: ['a', 'b'] }],
        omittedGroups: 0,
        scanned: 600,
      },
    });
    s.btn('query-tag-remove')!.click();
    await tick();
    expect(s.d.getState().error ?? '').toContain('600 件');
    expect(document.querySelector('[data-pkc-field="dialog-body"]')).toBeNull();
    expect(bulks(s.sent)).toHaveLength(0);
  });
});

describe('名前を変える', () => {
  const type = async (value: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>('[data-pkc-field="prompt-input"]')!;
    input.value = value;
    dialogOk().click();
    await tick();
  };

  it('🔴 新しい名前を聞き、確認に件数と両方の名前を出し、「外す → 付ける」の順に撃つ', async () => {
    const s = make();
    s.btn('query-tag-rename')!.click();
    await tick();
    expect(
      document.querySelector('[data-pkc-field="prompt-input"]'),
      'アプリ自身の入力窓が出ていない',
    ).not.toBeNull();
    await type('請求書');
    expect(dialogBody()).toBe('タグ「請求」を 2 件のノートで「請求書」に変えます');
    expect(bulks(s.sent)).toHaveLength(0);
    dialogOk().click();
    await tick();
    expect(
      bulks(s.sent).map((b) => [b.mode, b.tags, b.lids]),
      '順番が「外す → 付ける」ではない(付けてから外すと、上限のノートでタグが消える)',
    ).toEqual([
      ['remove', ['請求'], ['a', 'b']],
      ['add', ['請求書'], ['a', 'b']],
    ]);
  });

  it('同じ名前・名前が 2 つ以上・やめる、では撃たない', async () => {
    const same = make();
    same.btn('query-tag-rename')!.click();
    await tick();
    await type('請求');
    expect(bulks(same.sent)).toHaveLength(0);
    expect(document.querySelector('[data-pkc-field="dialog-body"]')?.textContent ?? '').not.toContain('変えます');

    document.body.innerHTML = '';
    resetAppDialogForTest();
    const two = make();
    two.btn('query-tag-rename')!.click();
    await tick();
    await type('請求書, 経理');
    expect(two.d.getState().error ?? '').toContain('1 つだけ');
    expect(bulks(two.sent)).toHaveLength(0);

    document.body.innerHTML = '';
    resetAppDialogForTest();
    const cancel = make();
    cancel.btn('query-tag-rename')!.click();
    await tick();
    dialogCancel().click();
    await tick();
    expect(bulks(cancel.sent)).toHaveLength(0);
  });
});
