/** @vitest-environment node */
/**
 * 🔴 **話者を直す**(#952 B6)── 押してから本文に入るまで(reducer → 効果層 → 書込 → 知らせ)。
 *
 * 守りたい主張:
 *  ① 「## 話者」の名前を付け替え、「## 話者つき文字起こし」を作り直して書く(節の外は 1 文字も変わらない)
 *  ② 書いたあとに、何件直したかを言い、「元に戻す」(直す前の版)を出す。版は積む(checkpoint)
 *  ③ 何も変わらない回も言う(黙らない)/ 話者の節が無い・別の窓が先に書いた回は書かず理由を出す
 *  ④ 編集中のノートには書かない(新しい断り文を作らず、他の書換と同じ門)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'attachment',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function boot(disk: Record<string, string>, mode: 'ok' | 'conflict' = 'ok') {
  const persists: Array<{ body: string; checkpoint: boolean }> = [];
  const store = {
    ...stubRevisionOps(),
    getBody: async (lid: string): Promise<string | null> => disk[lid] ?? null,
    getBodies: async (lids: string[]) => lids.map((lid) => ({ lid, body: disk[lid] ?? '' })),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; body: string }, opts?: { checkpoint?: boolean }) => {
      persists.push({ body: e.body, checkpoint: opts?.checkpoint === true });
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

const AT = new Date(2026, 9, 25, 10, 30).getTime();
const BODY = ['説明', '', '## 文字起こし', '0:00 はじめに', '0:15 こんにちは', '', '## 話者 2026-10-25 10:00', '0:00 話者A', '0:12 話者B', ''].join('\n');
const fix = (d: Dispatcher, renames: Array<[string, string]>): void => d.dispatch({ type: 'FIX_SPEAKERS', lid: 'a', renames, at: AT });

describe('話者を直す(効果層まで)', () => {
  it('🔴 名前を替えて、話者つき文字起こしを作り直して書き、版を積み、件数を言う', async () => {
    const b = boot({ a: BODY });
    dispose = b.dispose;
    fix(b.d, [['話者A', '田中']]);
    await tick();
    expect(b.persists).toHaveLength(1);
    const p = b.persists[0]!;
    expect(p.checkpoint, '直す前の版を積んでいない').toBe(true);
    expect(p.body).toContain('## 話者 2026-10-25 10:00\n0:00 田中\n0:12 話者B');
    expect(p.body).toContain('## 話者つき文字起こし 2026-10-25 10:30\n0:00 田中: はじめに\n0:15 話者B: こんにちは');
    expect(p.body.startsWith('説明\n\n## 文字起こし\n0:00 はじめに\n0:15 こんにちは\n')).toBe(true);
    expect(b.notices).toEqual(['話者の名前を 1 件直しました(話者つき文字起こしを 2 行で作り直しました)']);
    expect(b.errors).toEqual([]);
  });

  it('🔴 付け替えが無い回は、本文を書き直さず、「変わりませんでした」と言う(黙らない)', async () => {
    const b = boot({ a: '## 話者\n0:00 話者A\n0:12 話者B\n' });
    dispose = b.dispose;
    fix(b.d, []);
    await tick();
    expect(b.persists).toHaveLength(0);
    expect(b.notices).toEqual(['話者の一覧は変わりませんでした']);
  });

  it('🔴 話者の節が無い本文は書かず、理由を言う', async () => {
    const b = boot({ a: '説明だけ\n' });
    dispose = b.dispose;
    fix(b.d, [['話者A', '田中']]);
    await tick();
    expect(b.persists).toHaveLength(0);
    expect(b.errors).toEqual(['本文に「## 話者」の一覧が見つからないため、話者を直せませんでした(開き直してください)']);
    expect(b.notices).toEqual([]);
  });

  it('🔴 別の窓が先に書いていて断られた回は、「直しました」と言わない', async () => {
    const b = boot({ a: BODY }, 'conflict');
    dispose = b.dispose;
    fix(b.d, [['話者A', '田中']]);
    await tick();
    expect(b.notices).toEqual([]);
    expect(b.errors).toHaveLength(1);
  });
});
