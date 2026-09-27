/** @vitest-environment happy-dom */
/**
 * 🔴 **コード枠の保存が、別の窓の書込を消さない**(#1044 段3。
 *   `tests/adapter/section-save-effect.test.ts` と同じ 3 つの主張をコード枠で当て直す)。
 *
 * ① 🔴 **保存は disk から読み直す** ── 別経路が足した行(枠の外)は保存後も残る
 * ② 🔴 **その枠自身が別の場所で書き換えられていたら断る** ── disk は 1 バイトも
 *    変わらず、箱(書きかけ)も残る
 * ③ 🔴 **枠は身元で探し直す** ── 枠より上に行が増えても正しい枠が差し替わる
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';
import type { CodeDraft } from '../../src/adapter/state/app-state';
import { isCodeDraft } from '../../src/adapter/state/app-state';

const tick = (ms = 30): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function draftOf(d: Dispatcher): CodeDraft | null {
  const s = d.getState().sectionDraft;
  return s !== null && isCodeDraft(s) ? s : null;
}

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

const DOC = ['# note', '', '前置き。', '', '```js', 'const a = 1;', '```', '', '続き。', ''].join(
  '\n',
);

function bench(initial: Record<string, string>) {
  const disk: Record<string, string> = { ...initial };
  const reads: string[] = [];
  const persisted: EntryUpsert[] = [];
  const port = {
    ...stubRevisionOps(),
    getBody: async (lid: string) => {
      reads.push(lid);
      return disk[lid] ?? null;
    },
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e: EntryUpsert): Promise<EntryStamps> => {
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  } as unknown as StorePort;

  const d = new Dispatcher();
  const errors: string[] = [];
  d.onState((s) => {
    if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
  });
  connectStoreEffects(d, port);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  return { d, disk, reads, persisted, errors };
}

/** SELECT_ENTRY → BODY_LOADED → OPEN_CODE_DRAFT(line 4 = 開きの行)まで進める。 */
async function openDraft(d: Dispatcher, body: string, line = 4): Promise<void> {
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  d.dispatch({ type: 'OPEN_CODE_DRAFT', lid: 'n1', line });
  // ⚠ 先に積まれた REQUEST_BODY を空にする(section-save-effect.test.ts の
  //   openDraft と同じ理由 ── 各 it の外部書込より前に openBody を確定させる)。
  await tick(20);
}

describe('コード枠の保存が別の窓の書込を消さない(#1044 段3)', () => {
  it('🔴 ① 別経路が本文の末尾(枠の外)に足した行は、保存した後も残る(disk から読み直す)', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    expect(draftOf(b.d)?.original, '前提が崩れている(開けていない)').toBe('const a = 1;');
    // 別経路(別タブ等)が本文の末尾に 1 行足した(disk に直接。openBody は動かさない)
    b.disk['n1'] = DOC + '別経路が足した行\n';
    b.d.dispatch({ type: 'SAVE_CODE_DRAFT', text: 'const a = 2;' });
    await tick(30);
    expect(b.errors, '保存できたのに理由が出た').toEqual([]);
    expect(b.d.getState().sectionDraft, '保存後も箱が残っている').toBeNull();
    expect(b.disk['n1'], '自分の変更が入っていない').toContain('const a = 2;');
    expect(b.disk['n1'], '別経路が足した行を消した').toContain('別経路が足した行');
    expect(b.disk['n1']).toContain('前置き。');
    expect(b.disk['n1']).toContain('続き。');
  });

  it('🔴 ② その枠自身が別の場所で書き換えられていたら断る(disk は 1 バイトも変わらない・箱は残る)', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    const rewritten = DOC.replace('const a = 1;', 'const a = 999;');
    b.disk['n1'] = rewritten;
    b.d.dispatch({ type: 'SAVE_CODE_DRAFT', text: '打ちかけ' });
    await tick(30);
    expect(b.disk['n1'], '断ったのに disk が書き換わった').toBe(rewritten);
    expect(b.persisted, '断ったのに persistEntry が呼ばれた').toEqual([]);
    expect(b.d.getState().sectionDraft, '断ったのに箱が消えた').not.toBeNull();
    expect(draftOf(b.d)?.saving, '保存中の印が解けていない').toBe(false);
    expect(b.errors.at(-1) ?? '').toContain('別の場所で書き換えられました');
  });

  it('🔴 ③ 枠より上に行が増えていても、身元で追えて正しい枠が差し替わる', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    // 別経路が枠より上に段落を 1 つ足した(枠の位置がずれる)
    const withNewParagraph = DOC.replace('前置き。', '前置き。\n\n増えた段落。');
    b.disk['n1'] = withNewParagraph;
    b.d.dispatch({ type: 'SAVE_CODE_DRAFT', text: 'const a = 2;' });
    await tick(30);
    expect(b.errors, '身元で追えず断られた').toEqual([]);
    expect(b.d.getState().sectionDraft).toBeNull();
    expect(b.disk['n1']).toContain('増えた段落。');
    expect(b.disk['n1']).toContain('const a = 2;');
    expect(b.disk['n1']).toContain('続き。');
  });

  it('⚠ 対照群:別経路の書込が無ければ、いつもどおり保存できる', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    b.d.dispatch({ type: 'SAVE_CODE_DRAFT', text: 'const a = 2;' });
    await tick(30);
    expect(b.errors).toEqual([]);
    expect(b.d.getState().sectionDraft).toBeNull();
    expect(b.disk['n1']).toContain('const a = 2;');
    expect(b.persisted[0]?.body).toBe(b.disk['n1']);
  });
});
