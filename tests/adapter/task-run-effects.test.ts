/**
 * 🔴 **リストを丸ごとそろえる書込が、履歴に積まれ、知らせを言うこと**(#1173)。
 *
 * ⚠ 守る主張は 3 つ:
 * 1. 🔴 `task-run` だけ `checkpoint: true` で書く(1 回で何件も動くので、版から戻せる)。
 *    ⚠ **1 件の印(`task`)は amend のまま** ── 履歴を印の数だけ伸ばさない(対照群)。
 * 2. 繰り返しの行を飛ばしたら、その数を**画面へ言う**(黙ると「全部そろった」と読める)。
 * 3. 元から全部そろっていれば**書かない**(更新日時だけ動かさない)が、**黙らない**
 *    (押したのに何も起きない、を作らない)。
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

interface Persist {
  readonly lid: string;
  readonly body: string;
  readonly opts: { checkpoint?: boolean; expectHash?: string } | undefined;
}

function boot(disk: Record<string, string>) {
  const persists: Persist[] = [];
  const store = {
    ...stubRevisionOps(),
    getBody: async (lid: string): Promise<string | null> => disk[lid] ?? null,
    getBodies: async (lids: string[]) => lids.map((lid) => ({ lid, body: disk[lid] ?? '' })),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    persistEntry: async (
      e: { lid: string; body: string },
      opts?: { checkpoint?: boolean; expectHash?: string },
    ) => {
      persists.push({ lid: e.lid, body: e.body, opts });
      disk[e.lid] = e.body;
      return stubStamps();
    },
  };
  const d = new Dispatcher();
  const notices: string[] = [];
  d.onState((s) => {
    if (s.notice !== null && notices[notices.length - 1] !== s.notice) notices.push(s.notice);
  });
  const dispose = connectStoreEffects(d, store as never);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  return { d, persists, notices, dispose };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

/** 押した時点の行の中身(`openLines`)は、その時の本文から組む(#1087)。 */
const run = (body: string, lines: number[], to: 'done' | 'open') =>
  ({
    type: 'SET_TASK_RUN' as const,
    lid: 'a',
    lines,
    openLines: lines.map((i) => body.split('\n')[i] ?? ''),
    to,
  });

const LIST = '- [ ] 歯ブラシ\n- [ ] 充電器\n- [ ] ゴミ出し @2026-09-07 毎週\n';

describe('リストをそろえる書込(#1173)', () => {
  it('🔴 `task-run` は履歴に積む(checkpoint: true)── 対照群の `task` は積まない', async () => {
    const disk = { a: LIST };
    const b = boot(disk);
    dispose = b.dispose;
    // ── 対照群 ── 1 件の印は amend(`checkpoint` を渡さない)
    b.d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 0, openLine: '- [ ] 歯ブラシ' });
    await tick();
    expect(b.persists).toHaveLength(1);
    expect(b.persists[0]!.opts?.checkpoint, '1 件の印まで履歴に積んでいる').toBeUndefined();
    // ── 本体 ──
    b.d.dispatch(run(LIST, [0, 1, 2], 'done'));
    await tick();
    expect(b.persists).toHaveLength(2);
    expect(b.persists[1]!.opts?.checkpoint, 'リストをそろえる回が履歴に積まれていない').toBe(true);
    // ⚠ 門(expectHash)も一緒に渡っている ── 積むために門を外していない
    expect(b.persists[1]!.opts?.expectHash).toEqual(expect.any(String));
    // 書かれた本文: 規則の行は触らず、残りが完了
    expect(b.persists[1]!.body).toBe('- [x] 歯ブラシ\n- [x] 充電器\n- [ ] ゴミ出し @2026-09-07 毎週\n');
  });

  it('🔴 繰り返しの行を飛ばしたら、その数を画面へ言う', async () => {
    const b = boot({ a: LIST });
    dispose = b.dispose;
    b.d.dispatch(run(LIST, [0, 1, 2], 'done'));
    await tick();
    expect(b.notices).toEqual(['2 件を完了にしました / 1 件は繰り返しなので触りませんでした']);
  });

  it('⚠ 飛ばした行が無ければ、知らせは出さない(画面の印が答えである)', async () => {
    const b = boot({ a: '- [ ] あ\n- [ ] い\n' });
    dispose = b.dispose;
    b.d.dispatch(run('- [ ] あ\n- [ ] い\n', [0, 1], 'done'));
    await tick();
    expect(b.persists).toHaveLength(1);
    expect(b.notices).toEqual([]);
  });

  it('🔴 元から全部そろっていれば書かないが、黙らない', async () => {
    const b = boot({ a: '- [x] あ\n- [x] い\n' });
    dispose = b.dispose;
    b.d.dispatch(run('- [x] あ\n- [x] い\n', [0, 1], 'done'));
    await tick();
    expect(b.persists, '同じ本文を書き直している').toHaveLength(0);
    expect(b.notices).toEqual(['すべて完了になっています']);
  });

  it('🔴 繰り返しの行しか無いリストでも、飛ばした数は言う(書かない回でも)', async () => {
    const b = boot({ a: '- [ ] ゴミ出し @2026-09-07 毎週\n' });
    dispose = b.dispose;
    b.d.dispatch(run('- [ ] ゴミ出し @2026-09-07 毎週\n', [0], 'done'));
    await tick();
    expect(b.persists).toHaveLength(0);
    expect(b.notices).toEqual(['1 件は繰り返しなので触りませんでした']);
  });

  it('画面の行番号が古くて 1 行も項目でなければ、断りが出る(別の行を書かない)', async () => {
    const b = boot({ a: '普通の行\n' });
    dispose = b.dispose;
    let error: string | null = null;
    b.d.onState((s) => {
      error = s.error;
    });
    b.d.dispatch(run('普通の行\n', [0], 'done'));
    await tick();
    expect(b.persists).toHaveLength(0);
    expect(error).toContain('本文が変わっている');
  });
});

describe('表の行・列を消す書込も履歴に積む(#1087 の見直し 2026-10-13)', () => {
  const TABLE = '```csv\na,b\nc,d\n```\n';

  it('🔴 消す回は checkpoint: true ── 対照群の足す回は積まない', async () => {
    const b = boot({ a: TABLE });
    dispose = b.dispose;
    // ── 対照群 ── 足す回は amend
    b.d.dispatch({ type: 'SET_CSV_SHAPE', lid: 'a', line: 1, col: 0, what: 'row', mode: 'add' });
    await tick();
    expect(b.persists, '前提:足す回が書かれていない').toHaveLength(1);
    expect(b.persists[0]!.opts?.checkpoint, '足す回まで履歴に積んでいる').toBeUndefined();
    // ── 本体 ──
    b.d.dispatch({ type: 'SET_CSV_SHAPE', lid: 'a', line: 1, col: 1, what: 'col', mode: 'remove' });
    await tick();
    expect(b.persists, '前提:消す回が書かれていない').toHaveLength(2);
    expect(b.persists[1]!.opts?.checkpoint, '消す回が履歴に積まれていない').toBe(true);
    expect(b.persists[1]!.opts?.expectHash).toEqual(expect.any(String));
  });

  it('🔴 最後の 1 行を消そうとしたら、その理由を言う(「本文が変わっている」と取り違えない)', async () => {
    const b = boot({ a: '```csv\na,b\n```\n' });
    dispose = b.dispose;
    b.d.dispatch({ type: 'SET_CSV_SHAPE', lid: 'a', line: 1, col: 0, what: 'row', mode: 'remove' });
    await tick();
    expect(b.persists, '断ったのに書いた').toHaveLength(0);
    expect(b.d.getState().error).toBe('最後の 1 行は消せません');
  });
});
