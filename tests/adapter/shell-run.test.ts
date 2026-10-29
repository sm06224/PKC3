/**
 * コマンドシェルの**実行の段取り**(#274 / #241)── 偽の `ShellOps` で全部の枝を見る。
 *
 * ①危ない命令は確認を通し、断られたら何も実行しない ②`-n` は何も実行しない ③履歴に積むのは読めた行だけ・`!!` `!3`
 * ④番号(`#1`)が次の命令に使える ⑤SQL・全文検索の結果が表になる ⑥断り・失敗は塊に「失敗」として残る
 * ⑦履歴は端末の保存に書かれ、読み戻せる(壊れた保存は空)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { runShellLine, type OpResult, type ShellOps } from '../../src/adapter/ui/actions/shell-run';
import { ShellSession, shellBlockText } from '../../src/adapter/ui/render/cmdshell';
import { ShellHistoryStore, SHELL_HISTORY_STORAGE_KEY } from '../../src/adapter/ui/render/shell-history-store';
import type { ShellEnv } from '../../src/features/shell/types';

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return { lid, title, archetype, createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: 0 };
}
const METAS = [meta('f1', '資料', 'folder'), meta('n1', '議事録'), meta('n2', '設計')];

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function fake(answer = true) {
  const calls: string[] = [];
  const ok = (text: string, lids?: string[]): OpResult => ({ text, failed: false, ...(lids === undefined ? {} : { lids }) });
  const ops: ShellOps = {
    env: (session): ShellEnv => ({
      surface: 'shell',
      metas: new Map(METAS.map((m) => [m.lid, m])),
      relations: [] as Relation[],
      cwd: session.cwd,
      other: undefined,
      marked: [],
      last: session.last,
      newLid: () => 'x',
    }),
    promptText: () => '/>',
    applyPlan: (p) => (calls.push(`plan:${String(p.length)}`), ok('適用')),
    create: (t) => (calls.push(`create:${t}`), ok('作った', ['nx'])),
    append: async (l, t) => (calls.push(`append:${l}:${t}`), ok('追記した')),
    move: (l, to) => (calls.push(`move:${l.join(',')}->${String(to)}`), ok('移した')),
    copy: async (l) => (calls.push(`copy:${l.join(',')}`), ok('コピーした')),
    trash: async (l) => (calls.push(`trash:${l.join(',')}`), ok('ゴミ箱へ')),
    tag: () => ok('タグ'),
    exportNote: () => ok('書き出し'),
    open: (l) => (calls.push(`open:${l}`), ok('開いた')),
    enter: () => ok('入った'),
    select: () => ok('選んだ'),
    runSql: async (sql) => (calls.push(`sql:${sql}`), { columns: ['a', 'b'], rows: [[1, null], [2, 'x']], truncated: false, ms: 3, error: '' }),
    search: async () => ({ rows: [{ lid: 'n1', title: '議事録', snippet: '…一致…' }], truncated: false, error: '' }),
    operation: async (q) => (calls.push(`op:${q}`), { kind: 'ran', text: '実行した' }),
    operations: () => ({ kind: 'many', text: '2 件', table: { columns: ['操作'], rows: [['a'], ['b']], lids: [null, null] } }),
    askConfirm: async (m) => (calls.push(`confirm:${m}`), answer),
    copyText: async (t) => (calls.push(`copyText:${t}`), true),
  };
  return { ops, calls };
}

const session = (store = new ShellHistoryStore(memoryStorage())) => new ShellSession('shell', store);

describe('runShellLine', () => {
  it('rm は確認を通してから実行する。やめたら何も実行しない', async () => {
    const yes = fake(true);
    const s = session();
    await runShellLine(yes.ops, s, 'rm 設計');
    expect(yes.calls[0]).toContain('confirm:');
    expect(yes.calls).toContain('trash:n2');

    const no = fake(false);
    const s2 = session();
    const b = await runShellLine(no.ops, s2, 'rm 設計');
    expect(no.calls.some((c) => c.startsWith('trash'))).toBe(false);
    expect(b!.lines.join('\n')).toContain('やめました');
    // やめても履歴には残る(打ち直せる)
    expect(s2.history).toEqual(['rm 設計']);
  });

  it('-n は確認も実行もしない', async () => {
    const f = fake();
    const b = await runShellLine(f.ops, session(), 'rm 設計 -n');
    expect(f.calls).toEqual([]);
    expect(b!.lines[0]).toContain('試し実行');
  });

  it('履歴に積むのは読めた行だけ。!! と !n は展開した行を実行して積む', async () => {
    const f = fake();
    const s = session();
    await runShellLine(f.ops, s, 'xyz');
    await runShellLine(f.ops, s, 'open 設計');
    expect(s.history).toEqual(['open 設計']);
    await runShellLine(f.ops, s, 'ls');
    const b = await runShellLine(f.ops, s, '!1');
    expect(b!.prompt).toContain('open 設計');
    expect(f.calls.filter((c) => c === 'open:n2')).toHaveLength(2);
    const bad = await runShellLine(f.ops, s, '!99');
    expect(bad!.failed).toBe(true);
    expect(await runShellLine(f.ops, s, '   ')).toBeNull();
  });

  it('一覧の番号が次の命令で使える(find → mv #1)。作ったノートは #1 で指せる', async () => {
    const f = fake();
    const s = session();
    await runShellLine(f.ops, s, 'find 設計');
    expect(s.last).toEqual(['n2']);
    await runShellLine(f.ops, s, 'mv #1 資料');
    expect(f.calls).toContain('move:n2->f1');
    await runShellLine(f.ops, s, 'new 新規');
    expect(s.last).toEqual(['nx']);
  });

  it('cd で現在地が変わり、プロンプトと次の命令に効く', async () => {
    const f = fake();
    const s = session();
    await runShellLine(f.ops, s, 'cd 資料');
    expect(s.cwd).toBe('f1');
    await runShellLine(f.ops, s, 'cd ..');
    expect(s.cwd).toBeNull();
  });

  it('SQL の結果は表になり、コピー用の字はタブ区切り', async () => {
    const f = fake();
    const s = session();
    const b = await runShellLine(f.ops, s, 'sql SELECT 1');
    expect(b!.table!.columns).toEqual(['a', 'b']);
    expect(b!.table!.rows).toEqual([['1', ''], ['2', 'x']]);
    expect(shellBlockText(b!)).toContain('a\tb\n1\t\n2\tx');
    expect(b!.lines.join('\n')).toContain('2 行');
    expect(b!.pending).toBe(false);
  });

  it('SQL が断られたら失敗として残る', async () => {
    const f = fake();
    f.ops.runSql = async () => ({ columns: [], rows: [], truncated: false, ms: 0, error: '読むだけです' });
    const b = await runShellLine(f.ops, session(), 'sql DELETE FROM entries');
    expect(b!.failed).toBe(true);
    expect(b!.lines).toContain('読むだけです');
  });

  it('全文検索の結果は表になり、行の ID が #n の元になる', async () => {
    const f = fake();
    const s = session();
    const b = await runShellLine(f.ops, s, 'find 一致 -b');
    expect(b!.table!.lids).toEqual(['n1']);
    expect(s.last).toEqual(['n1']);
  });

  it('history は古い順に番号を振った表を返し、行を押すと入力欄に戻せる(recall)', async () => {
    const f = fake();
    const s = session();
    await runShellLine(f.ops, s, 'ls');
    await runShellLine(f.ops, s, 'pwd');
    const b = await runShellLine(f.ops, s, 'history');
    expect(b!.table!.rows).toEqual([['1', 'ls'], ['2', 'pwd']]);
    expect(b!.table!.recall).toEqual(['ls', 'pwd']);
  });

  it('copy-result は直前の結果をコピーし、clear は出力だけを消す', async () => {
    const f = fake();
    const s = session();
    await runShellLine(f.ops, s, 'ls');
    await runShellLine(f.ops, s, 'copy-result');
    expect(f.calls.some((c) => c.startsWith('copyText:') && c.includes('資料'))).toBe(true);
    await runShellLine(f.ops, s, 'clear');
    expect(s.blocks).toHaveLength(0);
    expect(s.history.length).toBeGreaterThan(0);
  });

  it('操作の呼び出し・一覧', async () => {
    const f = fake();
    const s = session();
    const b = await runShellLine(f.ops, s, 'do 設定を開く');
    expect(f.calls).toContain('op:設定を開く');
    expect(b!.lines).toContain('実行した');
    const l = await runShellLine(f.ops, s, 'ops');
    expect(l!.table!.rows).toHaveLength(2);
  });

  it('塊は上限を超えたら古いほうから消える', async () => {
    const f = fake();
    const s = session();
    for (let i = 0; i < 70; i += 1) await runShellLine(f.ops, s, 'pwd');
    expect(s.blocks.length).toBeLessThanOrEqual(60);
  });
});

describe('履歴の保存', () => {
  it('🔴 シェルと 2 ペインの命令行は同じ履歴を使い、互いの行を潰さない(C)', async () => {
    const store = new ShellHistoryStore(memoryStorage());
    const shell = new ShellSession('shell', store);
    const dual = new ShellSession('dual', store);
    const f = fake();
    await runShellLine(f.ops, shell, 'pwd');
    await runShellLine(f.ops, dual, 'ls');
    await runShellLine(f.ops, shell, 'find 設計');
    // どの順に打っても、3 行とも残る(先に打った側の行を後から打った側が上書きしない)
    expect(shell.history).toEqual(['find 設計', 'ls', 'pwd']);
    expect(dual.history).toEqual(['find 設計', 'ls', 'pwd']);
  });

  it('端末の保存に書かれ、新しい session で読み戻せる', async () => {
    const st = memoryStorage();
    const f = fake();
    const a = new ShellSession('shell', new ShellHistoryStore(st));
    await runShellLine(f.ops, a, 'pwd');
    await runShellLine(f.ops, a, 'ls');
    expect(JSON.parse(st.data.get(SHELL_HISTORY_STORAGE_KEY)!)).toEqual(['ls', 'pwd']);
    const b = new ShellSession('shell', new ShellHistoryStore(st));
    expect(b.history).toEqual(['ls', 'pwd']);
  });
  it('壊れた保存・文字列でない要素は空 / 落とす。書けない環境でも控えで動く', () => {
    const st = memoryStorage();
    st.data.set(SHELL_HISTORY_STORAGE_KEY, '{oops');
    expect(new ShellHistoryStore(st).get()).toEqual([]);
    st.data.set(SHELL_HISTORY_STORAGE_KEY, JSON.stringify(['a', 3, '', 'b']));
    expect(new ShellHistoryStore(st).get()).toEqual(['a', 'b']);
    const broken = new ShellHistoryStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    });
    broken.set(['x']);
    expect(broken.get()).toEqual(['x']);
  });
});
