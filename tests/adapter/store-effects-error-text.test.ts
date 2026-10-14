/** @vitest-environment happy-dom */
/**
 * 🔴 保存・削除が失敗したとき、画面に出る字に「Error: …」「QuotaExceededError: …」の英語の前置きが
 * 付かない(#1087)。本文の保存が「空きが足りない」で落ちたときは、空きを作った後の一手
 * (本文の上の「ノートを保存し直す」)まで言う。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { StorePort } from '../../src/adapter/state/store-effects';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { bodySaveErrorText, errorText } from '../../src/features/error-text';
import { WRITE_QUOTA_REFUSAL } from '../../src/features/storage/write-quota';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
}

function store(over: Partial<StorePort>): StorePort {
  return {
    ...stubRevisionOps(),
    async getBody() {
      return '# A';
    },
    async deleteEntry() {},
    async setEntryParent() {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    async persistEntry() {
      return stubStamps();
    },
    ...over,
  } as StorePort;
}

async function commitWith(over: Partial<StorePort>): Promise<Dispatcher> {
  const d = new Dispatcher();
  connectStoreEffects(d, store(over));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  await until(() => d.getState().openBody !== null);
  d.dispatch({ type: 'START_EDIT' });
  d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A2' });
  d.dispatch({ type: 'COMMIT_EDIT' });
  await until(() => d.getState().phase === 'error');
  return d;
}

describe('本文の保存が失敗したときの字', () => {
  it('🔴 空きが足りないとき: 英語の前置きが無く、空きを作った後の「ノートを保存し直す」まで言う', async () => {
    const d = await commitWith({
      async persistEntry() {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    });
    const e = d.getState().error ?? '';
    expect(e).toContain('空き容量が足りません');
    expect(e).toContain('使われていない添付を消す');
    expect(e, '空きを作った後の一手').toContain('「ノートを保存し直す」を押してください');
    expect(e, '括弧の外に英語の前置きが出た').not.toMatch(/^(エラー: )?(Quota|Error)/);
  });

  it('対照群: 空き以外の失敗には「保存し直す」の案内を足さず、Error: の前置きも付けない', async () => {
    const d = await commitWith({
      async persistEntry() {
        throw new Error('disk exploded');
      },
    });
    const e = d.getState().error ?? '';
    expect(e).toContain('disk exploded');
    expect(e).not.toContain('Error: ');
    expect(e).not.toContain('ノートを保存し直す');
  });
});

describe('bodySaveErrorText / errorText', () => {
  it('errorText 本体には「保存し直す」を足さない(添付・書き出しなどボタンの無い場面にも出る)', () => {
    const q = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    expect(errorText(q)).not.toContain('ノートを保存し直す');
    expect(bodySaveErrorText(q)).toContain('ノートを保存し直す');
  });
});

describe('bodySaveErrorText: worker の空き容量の断り(#1087 S1)', () => {
  it('🔴 WRITE_QUOTA_REFUSAL は自分で「ノートを保存し直す」まで言うので、同じ一手を重ねて足さない', () => {
    const t = bodySaveErrorText(new Error(WRITE_QUOTA_REFUSAL));
    expect(t, '断りの本文が消えた').toContain('保存できる空き容量が足りません');
    expect(t.split('ノートを保存し直す').length - 1, '同じ一手が 2 回出ている / 1 回も出ていない').toBe(1);
    expect(t).not.toContain('。その後、本文の上の');
    // 対照群: 関係ない失敗には足さない
    expect(bodySaveErrorText(new Error('disk exploded'))).not.toContain('その後、本文の上の');
  });
});

describe('削除の失敗', () => {
  it('Error: の前置きが付かない', async () => {
    const d = new Dispatcher();
    connectStoreEffects(
      d,
      store({
        async deleteEntry() {
          throw new Error('消せなかった理由');
        },
      }),
    );
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'a' });
    await until(() => d.getState().error !== null);
    const e = d.getState().error ?? '';
    expect(e).toContain('消せなかった理由');
    expect(e).not.toContain('Error: ');
  });
});
