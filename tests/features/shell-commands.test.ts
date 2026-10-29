/**
 * コマンドシェル(#274)と 2 ペインの命令行(#241)の**命令表**(pure)。
 *
 * 見るのは user が打つ字と、返る計画:
 * ①語の割り方(引用符・全角の空白・閉じていない引用符は断る)②履歴(↑↓ で打ちかけに戻れる・`!!` `!3`)
 * ③ノートの指し方(番号・`.`・題名の一意性・曖昧は黙って選ばない)④命令ごとの計画(移す・コピー・ゴミ箱・タグ…)
 * ⑤危ない命令は確認つき・`-n` は何も実行しない ⑥シェルと 2 ペインが同じ表を読む ⑦補完
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { tokenize, splitFlags } from '../../src/features/shell/tokenize';
import { SHELL_HISTORY_MAX, expandBang, pushShellHistory, stepShellHistory } from '../../src/features/shell/history';
import { SHELL_COMMANDS, commandWords, findCommand, planLine } from '../../src/features/shell/commands';
import { resolveFolder, resolveNote, resolveNotes, splitParentTitle } from '../../src/features/shell/resolve';
import { commonPrefix, completeLine, quoteIfNeeded } from '../../src/features/shell/complete';
import type { ShellEnv } from '../../src/features/shell/types';

function meta(lid: string, title: string, archetype = 'text', order = 1): EntryMeta {
  return { lid, title, archetype, createdAt: null, updatedAt: '2026-10-01T00:00:00Z', entryOrder: order, status: null, date: null, archived: false, bodyChars: 0 };
}
const rel = (from: string, to: string): Relation => ({ id: `${from}-${to}`, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null });

const METAS = [
  meta('f1', '資料', 'folder', 1),
  meta('f2', 'アーカイブ', 'folder', 2),
  meta('n1', '議事録 2026', 'text', 3),
  meta('n2', '議事録 2025', 'text', 4),
  meta('n3', '買い物メモ', 'text', 5),
  meta('n4', '設計', 'text', 6),
];
const RELATIONS = [rel('f1', 'n1'), rel('f1', 'n2')];

function env(over: Partial<ShellEnv> = {}): ShellEnv {
  let n = 0;
  return {
    surface: 'shell',
    metas: new Map(METAS.map((m) => [m.lid, m])),
    relations: RELATIONS,
    cwd: null,
    other: undefined,
    marked: [],
    last: [],
    newLid: () => `new${String((n += 1))}`,
    ...over,
  };
}

describe('tokenize', () => {
  it('空白(全角も)で割り、引用符の中の空白は残す', () => {
    const r = tokenize('mv "議事録 2026"　資料');
    expect(r.error).toBeNull();
    expect(r.tokens.map((t) => t.text)).toEqual(['mv', '議事録 2026', '資料']);
    expect(r.tokens.map((t) => t.quoted)).toEqual([false, true, false]);
  });
  it('「」と \\" の逃がしを読む', () => {
    expect(tokenize('new 「a b」 "x\\"y"').tokens.map((t) => t.text)).toEqual(['new', 'a b', 'x"y']);
  });
  it('閉じていない引用符は黙って補わず断る', () => {
    expect(tokenize('new "abc').error).toContain('閉じていません');
  });
  it('旗は囲んでいない -x だけ。囲んだ -n は題名、-- 以降は全部引数', () => {
    const t = tokenize('rm -n "-n" -- -x').tokens;
    const { flags, args } = splitFlags(t.slice(1));
    expect([...flags]).toEqual(['n']);
    expect(args.map((a) => a.text)).toEqual(['-n', '-x']);
  });
});

describe('履歴', () => {
  it('新しい順・重複は先頭へ・見るだけの行は積まない・上限', () => {
    let h: string[] = [];
    h = pushShellHistory(h, 'ls');
    h = pushShellHistory(h, 'find a');
    h = pushShellHistory(h, 'ls');
    h = pushShellHistory(h, 'history');
    h = pushShellHistory(h, '   ');
    expect(h).toEqual(['ls', 'find a']);
    let big: string[] = [];
    for (let i = 0; i < SHELL_HISTORY_MAX + 5; i += 1) big = pushShellHistory(big, `cmd ${String(i)}`);
    expect(big).toHaveLength(SHELL_HISTORY_MAX);
    expect(big[0]).toBe(`cmd ${String(SHELL_HISTORY_MAX + 4)}`);
  });
  it('↑ で古いほうへ・↓ で打ちかけ(null)に戻る・端では動かない', () => {
    const h = ['c', 'b', 'a'];
    expect(stepShellHistory(h, -1, 'older')).toEqual({ at: 0, text: 'c' });
    expect(stepShellHistory(h, 2, 'older')).toBeNull();
    expect(stepShellHistory(h, 0, 'newer')).toEqual({ at: -1, text: null });
    expect(stepShellHistory(h, -1, 'newer')).toBeNull();
    expect(stepShellHistory([], -1, 'older')).toBeNull();
  });
  it('!! は直前、!n は history の番号(古いほうが 1)', () => {
    const h = ['c', 'b', 'a'];
    expect(expandBang('!!', h)).toMatchObject({ line: 'c', expanded: true });
    expect(expandBang('!1', h)).toMatchObject({ line: 'a', expanded: true });
    expect(expandBang('!3', h)).toMatchObject({ line: 'c' });
    expect(expandBang('!9', h).error).toContain('9 番');
    expect(expandBang('!!', []).error).not.toBeNull();
    expect(expandBang('ls', h)).toMatchObject({ line: 'ls', expanded: false, error: null });
  });
});

describe('ノート・フォルダの指し方', () => {
  it('番号・範囲・.・*・ID・題名', () => {
    const e = env({ last: ['n3', 'n4', 'n1'], marked: ['n4'] });
    expect(resolveNote('#2', e)).toEqual({ ok: true, value: 'n4' });
    expect(resolveNote('3', e)).toEqual({ ok: true, value: 'n1' });
    expect(resolveNote('.', e)).toEqual({ ok: true, value: 'n4' });
    expect(resolveNote('n3', e)).toEqual({ ok: true, value: 'n3' });
    expect(resolveNote('買い物', e)).toEqual({ ok: true, value: 'n3' });
    expect(resolveNotes(['#1-2'], e)).toEqual({ ok: true, value: ['n3', 'n4'] });
    expect(resolveNotes(['*'], e)).toMatchObject({ ok: true, value: ['f1', 'f2', 'n3', 'n4'] });
  });
  it('題名が複数に当たったら黙って選ばず、候補を並べて断る(いまの場所に 1 件ならそれ)', () => {
    const r = resolveNote('議事録', env());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('2 件');
    expect(resolveNote('議事録', env({ cwd: 'f1' })).ok).toBe(false);
    expect(resolveNote('2026', env({ cwd: 'f1' }))).toEqual({ ok: true, value: 'n1' });
    expect(resolveNote('存在しない', env()).ok).toBe(false);
  });
  it('範囲外の番号は断る(直前の一覧が空のときは一覧を出すよう言う)', () => {
    const none = resolveNote('#1', env());
    expect(!none.ok && none.error).toContain('ls');
    const e = env({ last: ['n1'] });
    expect(resolveNote('#5', e).ok).toBe(false);
    expect(resolveNotes(['#1-9'], e).ok).toBe(false);
  });
  it('フォルダ: / .. . 道 反対', () => {
    const e = env({ cwd: 'f1', other: 'f2' });
    expect(resolveFolder('/', e)).toEqual({ ok: true, value: null });
    expect(resolveFolder('..', e)).toEqual({ ok: true, value: null });
    expect(resolveFolder('.', e)).toEqual({ ok: true, value: 'f1' });
    expect(resolveFolder('反対', e)).toEqual({ ok: true, value: 'f2' });
    expect(resolveFolder('/資料', env())).toEqual({ ok: true, value: 'f1' });
    expect(resolveFolder('アーカ', env())).toEqual({ ok: true, value: 'f2' });
    expect(resolveFolder('買い物メモ', env()).ok).toBe(false); // フォルダではない
    expect(resolveFolder('反対', env()).ok).toBe(false); // シェルには反対側が無い
  });
  it('資料/議事録 は (親, 題名) に割る。解けない道は題名の一部', () => {
    expect(splitParentTitle('資料/メモ', env())).toEqual({ parent: 'f1', title: 'メモ' });
    expect(splitParentTitle('無い/メモ', env())).toMatchObject({ error: expect.stringContaining('というフォルダ') });
    expect(splitParentTitle('資料/', env())).toMatchObject({ error: expect.stringContaining('題名が空') });
    expect(splitParentTitle('無い/メモ', env(), true)).toEqual({ parent: null, title: '無い/メモ' });
    expect(splitParentTitle('メモ', env({ cwd: 'f2' }))).toEqual({ parent: 'f2', title: 'メモ' });
  });
});

describe('命令の計画', () => {
  it('ls は番号つきの表を返し、次の #n の元になる', () => {
    const p = planLine('ls 資料', env());
    expect(p.table?.rows.map((r) => r[2])).toEqual(['議事録 2026', '議事録 2025']);
    expect(p.numbered).toEqual(['n1', 'n2']);
    expect(p.error).toBeUndefined();
  });
  it('find は題名で探し(全語)、-b は本文検索の頼みを返す', () => {
    expect(planLine('find 議事録 2025', env()).table?.lids).toEqual(['n2']);
    expect(planLine('find 存在しない', env()).table).toBeUndefined();
    expect(planLine('find 議事録 -b', env()).effects).toEqual([{ type: 'search', query: '議事録' }]);
    expect(planLine('find', env()).error).toBeDefined();
  });
  it('全角・ひらがな・カタカナを区別せずに探す', () => {
    const e = env({ metas: new Map([...METAS, meta('n9', 'ノート Ａ')].map((m) => [m.lid, m])) });
    expect(planLine('find のーと ａ', e).table?.lids).toEqual(['n9']);
  });
  it('cd はシェルでは現在地を変え、2 ペインでは enter の頼みを返す', () => {
    expect(planLine('cd 資料', env()).cwd).toBe('f1');
    expect(planLine('cd', env({ cwd: 'f1' })).cwd).toBeNull();
    expect(planLine('cd 資料', env({ surface: 'dual', cwd: null, other: null })).effects).toEqual([{ type: 'enter', scope: 'f1' }]);
    expect(planLine('cd 買い物メモ', env()).error).toBeDefined();
  });
  it('new / mkdir は現在地(または 資料/ の道)に作る', () => {
    expect(planLine('new 資料/メモ 本文 \\n二行目', env()).effects).toEqual([
      { type: 'create', title: 'メモ', body: '本文 \n二行目', parent: 'f1' },
    ]);
    const m = planLine('mkdir 新規', env({ cwd: 'f2' }));
    expect(m.effects).toEqual([{ type: 'plan', ops: [{ kind: 'mkdir', title: '新規', parent: { at: 'lid', lid: 'f2' }, alias: null }] }]);
    expect(m.lines[0]).toContain('アーカイブ');
  });
  it('🔴 / の前のフォルダが解けなければ、黙って現在地に作らず断る。引用符で囲めば / も題名(⚠8)', () => {
    const bad = planLine('new 無い/メモ 本文', env());
    expect(bad.error).toContain('というフォルダ');
    expect(bad.effects).toEqual([]);
    expect(planLine('mkdir 無い/新規', env()).error).toBeDefined();
    expect(planLine('new "2026/10/29 メモ"', env()).effects).toEqual([{ type: 'create', title: '2026/10/29 メモ', body: '', parent: null }]);
  });
  it('append はフォルダを相手にできない', () => {
    expect(planLine('append 買い物 牛乳', env()).effects).toEqual([{ type: 'append', lid: 'n3', text: '牛乳' }]);
    expect(planLine('append 資料 x', env()).error).toBeDefined();
    expect(planLine('append 買い物', env()).error).toBeDefined();
  });
  it('mv: 元と先・番号・引数 1 つは「選んでいるノートを先へ」・2 ペインは先を省くと反対側', () => {
    expect(planLine('mv 買い物メモ 資料', env()).effects).toEqual([{ type: 'move', lids: ['n3'], to: 'f1' }]);
    expect(planLine('mv #1 #2 /', env({ last: ['n1', 'n2'] })).effects).toEqual([{ type: 'move', lids: ['n1', 'n2'], to: null }]);
    expect(planLine('mv アーカイブ', env({ marked: ['n3'] })).effects).toEqual([{ type: 'move', lids: ['n3'], to: 'f2' }]);
    expect(planLine('mv', env({ surface: 'dual', marked: ['n3', 'n4'], cwd: null, other: 'f2' })).effects).toEqual([
      { type: 'move', lids: ['n3', 'n4'], to: 'f2' },
    ]);
    expect(planLine('mv', env()).error).toBeDefined();
    expect(planLine('mv 買い物メモ 設計', env()).error).toContain('というフォルダはありません');
    expect(planLine('mv 買い物メモ 資料', env()).lines[0]).toContain('移します');
  });
  it('cp は同じ引数の読み方で copy の頼みを返す', () => {
    expect(planLine('cp 設計 アーカイブ', env()).effects).toEqual([{ type: 'copy', lids: ['n4'], to: 'f2' }]);
    expect(planLine('コピー 設計 アーカイブ', env()).effects).toHaveLength(1);
  });
  it('rename は対象を省くと選んでいるノート', () => {
    expect(planLine('rename 設計 設計メモ', env()).effects).toEqual([{ type: 'plan', ops: [{ kind: 'rename', lid: 'n4', title: '設計メモ' }] }]);
    expect(planLine('rename 新しい名前', env({ marked: ['n4'] })).effects).toEqual([
      { type: 'plan', ops: [{ kind: 'rename', lid: 'n4', title: '新しい名前' }] },
    ]);
    expect(planLine('rename', env()).error).toBeDefined();
  });
  it('rm は確認文を持つ。対象が無ければ断る', () => {
    const p = planLine('rm 買い物 設計', env());
    expect(p.effects).toEqual([{ type: 'trash', lids: ['n3', 'n4'] }]);
    expect(p.confirm).toContain('ゴミ箱へ入れます');
    expect(planLine('rm', env()).error).toBeDefined();
    expect(SHELL_COMMANDS.filter((c) => c.dangerous === true).map((c) => c.name)).toEqual(['rm']);
  });
  it('🔴 rm の確認文に件数が出る。フォルダがあれば中身を含めた件数も出る(B)', () => {
    expect(planLine('rm 買い物 設計', env()).confirm).toContain('(2 件。あとで戻せます)');
    const withFolder = planLine('rm 資料', env());
    // 資料(1)+ 中の 議事録 2026 / 2025(2)= 3 件
    expect(withFolder.confirm).toContain('(1 件。フォルダの中身を含めて 3 件。あとで戻せます)');
    expect(withFolder.confirmDanger).toBe(true);
  });
  it('🔴 cp を 2 件以上 / フォルダごとまとめて複製するときだけ、件数つきの確認が出る', () => {
    expect(planLine('cp 設計 アーカイブ', env()).confirm).toBeUndefined();
    const all = planLine('cp * アーカイブ', env());
    // * = ルート直下の 4 件(資料 / アーカイブ / 買い物メモ / 設計)。資料の中の 2 件を含めて 6 件
    expect(all.confirm).toContain('4 件。フォルダの中身を含めて 6 件');
    expect(all.confirmDanger).toBe(false);
    expect(planLine('cp 資料 アーカイブ', env()).confirm).toContain('1 件。フォルダの中身を含めて 3 件');
    expect(planLine('cp * アーカイブ -n', env()).confirm).toBeUndefined();
  });
  it('🔴 rm は「いまの場所に 1 件ならそれ」で曖昧さを救わない。mv は救う(G)', () => {
    const metas = new Map([...METAS, meta('n5', '設計', 'text', 7)].map((m) => [m.lid, m]));
    const e = env({ metas, relations: [...RELATIONS, rel('f2', 'n5')], cwd: 'f2' });
    // 同じ題名「設計」がルート(n4)とアーカイブの中(n5)にある。いまの場所はアーカイブ
    const rm = planLine('rm 設計', e);
    expect(rm.error).toContain('2 件');
    expect(rm.effects).toEqual([]);
    expect(planLine('mv 設計 資料', e).effects).toEqual([{ type: 'move', lids: ['n5'], to: 'f1' }]);
    // 番号か ID で指せば消せる
    expect(planLine('rm n5', e).effects).toEqual([{ type: 'trash', lids: ['n5'] }]);
  });
  it('tag は付ける / 外すを読む', () => {
    expect(planLine('tag add 重要 設計', env()).effects).toEqual([{ type: 'tag', lids: ['n4'], tags: ['重要'], mode: 'add' }]);
    expect(planLine('タグ 外す #重要 設計', env()).effects).toEqual([{ type: 'tag', lids: ['n4'], tags: ['重要'], mode: 'remove' }]);
    expect(planLine('tag foo 重要', env()).error).toBeDefined();
  });
  it('export は形式を末尾から読む(既定 md)', () => {
    expect(planLine('export 設計', env()).effects).toEqual([{ type: 'export', lid: 'n4', format: 'md' }]);
    expect(planLine('export 設計 pdf', env()).effects).toEqual([{ type: 'export', lid: 'n4', format: 'pdf' }]);
  });
  it('sql / do は生の残りを渡す(空白を含む操作の名前もそのまま)', () => {
    expect(planLine('sql SELECT  1 AS "a b"', env()).effects).toEqual([{ type: 'sql', sql: 'SELECT  1 AS "a b"' }]);
    expect(planLine('do 2 ペインへ移る', env()).effects).toEqual([{ type: 'operation', query: '2 ペインへ移る' }]);
    expect(planLine('sql', env()).error).toBeDefined();
    expect(planLine('do', env()).error).toBeDefined();
  });
  it('select は 2 ペインだけ', () => {
    expect(planLine('select 議事', env({ surface: 'dual', cwd: 'f1', other: null })).effects).toEqual([
      { type: 'select', lids: ['n1', 'n2'], mode: 'set' },
    ]);
    expect(planLine('select -c', env({ surface: 'dual', other: null })).effects).toEqual([{ type: 'select', lids: [], mode: 'clear' }]);
    expect(planLine('select 議事', env()).error).toContain('命令はありません');
  });
  it('-n は何も実行せず、何が起きるかだけを返す(SQL の字には影響しない)', () => {
    const p = planLine('mv 買い物メモ 資料 -n', env());
    expect(p.effects).toEqual([]);
    expect(p.lines[0]).toContain('試し実行');
    expect(p.lines.join('\n')).toContain('移します');
    expect(planLine('rm 設計 --dry-run', env())).toMatchObject({ effects: [] });
    expect(planLine('rm 設計 -n', env()).confirm).toBeUndefined();
  });
  it('知らない命令は近い候補を添えて断る。閉じていない引用符も断る', () => {
    const p = planLine('mkd 資料', env());
    expect(p.error).toContain('mkdir');
    expect(planLine('xyz', env()).error).toContain('help');
    expect(planLine('new "abc', env()).error).toContain('閉じていません');
    expect(planLine('   ', env())).toMatchObject({ lines: [], effects: [] });
  });
  it('help は命令の全部(2 ペインでは 2 ペイン向けだけ)を表にし、help <命令> は書き方を返す', () => {
    const shell = planLine('help', env()).table!;
    const dual = planLine('help', env({ surface: 'dual', other: null })).table!;
    expect(shell.rows.map((r) => r[1] ?? '').some((u) => u.startsWith('sql'))).toBe(true);
    expect(dual.rows.map((r) => r[1] ?? '').some((u) => u.startsWith('sql'))).toBe(false);
    expect(dual.rows.map((r) => r[1] ?? '').some((u) => u.startsWith('select'))).toBe(true);
    expect(planLine('help mv', env()).lines.join('\n')).toContain('mv <ノート…> <フォルダ>');
  });
});

describe('命令表(1 つの表を 2 つの口が読む)', () => {
  it('名前と別名が全部で一意(同じ語が 2 つの命令を指さない)', () => {
    const all = SHELL_COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(all).size).toBe(all.length);
    expect(SHELL_COMMANDS.length).toBeGreaterThanOrEqual(20);
  });
  it('全部の命令に書き方・説明・分類がある', () => {
    for (const c of SHELL_COMMANDS) {
      expect(c.usage.startsWith(c.name)).toBe(true);
      expect(c.summary.length).toBeGreaterThan(5);
    }
  });
  it('日本語の別名で同じ命令を引ける', () => {
    expect(findCommand('移す', 'shell')?.name).toBe('mv');
    expect(findCommand('ＬＳ', 'shell')?.name).toBe('ls');
    expect(findCommand('select', 'shell')).toBeNull();
    expect(commandWords('dual')).toContain('select');
  });
});

describe('補完', () => {
  it('1 語目は命令。空なら本来の名前だけ、打ち始めれば別名も', () => {
    const empty = completeLine('', env());
    expect(empty.items.map((i) => i.insert)).toContain('mv');
    expect(empty.items.map((i) => i.insert)).not.toContain('移す');
    expect(completeLine('移', env()).items.map((i) => i.insert)).toEqual(['移動', '移す']);
    expect(completeLine('m', env()).items.map((i) => i.insert).sort()).toEqual(['mkdir', 'mv']);
  });
  it('引数はノートの題名。空白を含む題名は引用符で囲んで入れる', () => {
    const c = completeLine('mv 議事', env());
    expect(c.items.map((i) => i.insert)).toEqual(['"議事録 2026"', '"議事録 2025"']);
    expect(c.from).toBe(3);
    expect(c.to).toBe(5);
    // 入れた字は tokenize で読み戻せる
    expect(tokenize(`mv ${c.items[0]!.insert}`).tokens[1]!.text).toBe('議事録 2026');
  });
  it('最後の引数はフォルダだけ・. .. も候補', () => {
    const c = completeLine('mv 設計 ', env());
    const ins = c.items.map((i) => i.insert);
    expect(ins).toContain('資料');
    expect(ins).not.toContain('設計');
    expect(ins).toContain('..');
  });
  it('do の後ろは操作の名前(生の残りで絞る)', () => {
    const c = completeLine('do 設定', env(), { operationLabels: ['設定を開く', 'フラグを開く', '設定ファイルを書き出す'] });
    expect(c.items.map((i) => i.insert)).toEqual(['設定を開く', '設定ファイルを書き出す']);
    expect(c.from).toBe(3);
  });
  it('閉じていない引用符の途中でも候補を出せる', () => {
    const c = completeLine('mv "議事', env());
    expect(c.items.length).toBe(2);
  });
  it('🔴 旗・番号・指し方に読み間違えられる題名は引用符で囲み、囲んだ語は題名として解く', () => {
    for (const t of ['-n', '3', '*', '.', '..', '!!', '#1', 'a/b']) expect(quoteIfNeeded(t), t).toBe(`"${t}"`);
    expect(quoteIfNeeded('議事録')).toBe('議事録');
    const metas = new Map([...METAS, meta('n7', '3', 'text', 8), meta('n8', '-n', 'text', 9)].map((m) => [m.lid, m]));
    const e = env({ metas, last: ['n1', 'n2', 'n3'] });
    // 囲まない 3 は直前の一覧の 3 番(n3)/ 囲めば題名「3」(n7)
    expect(resolveNote('3', e)).toEqual({ ok: true, value: 'n3' });
    expect(planLine('append "3" 追記', e).effects).toEqual([{ type: 'append', lid: 'n7', text: '追記' }]);
    expect(planLine('append 3 追記', e).effects).toEqual([{ type: 'append', lid: 'n3', text: '追記' }]);
    expect(planLine('append "-n" 追記', e).effects).toEqual([{ type: 'append', lid: 'n8', text: '追記' }]);
  });
  it('共通の頭を返す', () => {
    expect(commonPrefix([{ insert: 'abc', label: '', hint: '' }, { insert: 'abd', label: '', hint: '' }])).toBe('ab');
    expect(commonPrefix([])).toBe('');
  });
});
