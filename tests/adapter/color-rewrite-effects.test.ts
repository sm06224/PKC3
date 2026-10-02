/**
 * 🔴 **色を選び直したら、元と新しい綴りを知らせる**(#1254 §2 欠陥 5。Gemini 裁定 = A)。
 *
 * > user の物語:見本を押して違う色を選んだ。本文の字が上書きされ、**履歴にも知らせにも残らない**
 * >   ので、元の色を覚えていなければ戻せなかった。
 *
 * ⚠ 守る主張は 3 つ:
 * 1. 書換が**本文へ入った後**に、元と新しい綴りを**そのまま**言う。
 * 2. **同じ色**を選んだ回(本文が 1 byte も変わらない)は言わない(書かないので言う物が無い)。
 * 3. **書けなかった回**(別の窓が先に書いた / 行がずれた / 書込が落ちた)は「書き換えました」と言わない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';

function meta(lid: string): EntryMeta {
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
    bodyChars: null,
  };
}

type PersistMode = 'ok' | 'conflict' | 'throw';

function boot(disk: Record<string, string>, mode: PersistMode = 'ok') {
  const persists: string[] = [];
  const store = {
    ...stubRevisionOps(),
    getBody: async (lid: string): Promise<string | null> => disk[lid] ?? null,
    getBodies: async (lids: string[]) => lids.map((lid) => ({ lid, body: disk[lid] ?? '' })),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; body: string }) => {
      persists.push(e.body);
      if (mode === 'throw') throw new Error('disk full');
      if (mode === 'conflict') return { ...stubStamps(), conflict: true };
      disk[e.lid] = e.body;
      return stubStamps();
    },
  };
  const d = new Dispatcher();
  const notices: string[] = [];
  const errors: string[] = [];
  d.onState((s) => {
    if (s.notice !== null && notices[notices.length - 1] !== s.notice) notices.push(s.notice);
    if (s.error !== null && errors[errors.length - 1] !== s.error) errors.push(s.error);
  });
  const dispose = connectStoreEffects(d, store as never);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  return { d, persists, notices, errors, dispose };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

const BODY = '色 `#3b82f6` と `#10b981`\n';
const pick = (d: Dispatcher, from: string, to: string, nth = 0): void =>
  d.dispatch({ type: 'SET_COLOR_CODE', lid: 'a', line: 0, nth, from, to });

describe('色を選び直した知らせ(#1254 §2 欠陥 5)', () => {
  it('🔴 書き換えたら、元と新しい綴りをそのまま言う(本文は選んだ 1 つだけ変わる)', async () => {
    const b = boot({ a: BODY });
    dispose = b.dispose;
    pick(b.d, '#3b82f6', '#ef4444');
    await tick();
    expect(b.persists).toEqual(['色 `#ef4444` と `#10b981`\n']);
    expect(b.notices).toEqual(['#3b82f6 → #ef4444 に書き換えました']);
  });

  it('🔑 2 つ目の見本でも、押した見本の元の綴りを言う(最初の色の字を言わない)', async () => {
    const b = boot({ a: BODY });
    dispose = b.dispose;
    pick(b.d, '#10b981', '#000000', 1);
    await tick();
    expect(b.notices).toEqual(['#10b981 → #000000 に書き換えました']);
  });

  it('🔴 同じ色を選んだ回は、書かず・言わない(対照群)', async () => {
    const b = boot({ a: BODY });
    dispose = b.dispose;
    pick(b.d, '#3b82f6', '#3b82f6');
    await tick();
    expect(b.persists, '同じ本文を書き直している').toHaveLength(0);
    expect(b.notices).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it('🔴 行がずれていて当たらなかった回は、「書き換えました」と言わない', async () => {
    const b = boot({ a: BODY });
    dispose = b.dispose;
    pick(b.d, '#aaaaaa', '#ef4444'); // 押した時点の字が disk に無い
    await tick();
    expect(b.persists).toHaveLength(0);
    expect(b.notices).toEqual([]);
    expect(b.errors).toHaveLength(1);
  });

  it('🔴 別の窓が先に書いていて断られた回は、言わない', async () => {
    const b = boot({ a: BODY }, 'conflict');
    dispose = b.dispose;
    pick(b.d, '#3b82f6', '#ef4444');
    await tick();
    expect(b.persists).toHaveLength(1);
    expect(b.notices).toEqual([]);
    expect(b.errors).toHaveLength(1);
  });

  it('🔴 書込が落ちた回は、言わない', async () => {
    const b = boot({ a: BODY }, 'throw');
    dispose = b.dispose;
    pick(b.d, '#3b82f6', '#ef4444');
    await tick();
    expect(b.notices).toEqual([]);
    expect(b.errors).toHaveLength(1);
  });

  it('⚠ 色以外の書換(チェックの印)は、この知らせを出さない', async () => {
    const b = boot({ a: '- [ ] あ `#3b82f6`\n' });
    dispose = b.dispose;
    b.d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 0 });
    await tick();
    expect(b.persists).toHaveLength(1);
    expect(b.notices).toEqual([]);
  });
});
