/**
 * コマンドシェルの**命令表**(#274)── シェルと 2 ペインの命令行(#241)が読む、唯一の表。**pure module**。
 *
 * ## 🔑 新しい操作の種類を作らない
 *
 * ここにあるのは「既存の実体への**呼び名と引数の書き方**」である。移す・コピー・ゴミ箱・追記・タグ・書き出し・
 * 整理案(mkdir / rename)・SQL・操作の実行は、すべて adapter が既存の実体を呼ぶ(`shell-run.ts`)。
 * 命令表は `ShellPlan` を返すだけで、state も DOM も触らない。
 * 既存の操作(`KEY_COMMANDS`)は `do <名前>` で呼ぶ ── 命令表に写さない(一覧を 2 つにしない)。
 *
 * ## 🔴 危ない命令
 *
 * `dangerous: true`(いまは `rm` / `消す`)は `ShellPlan.confirm` を返し、adapter が既存の確認を通してから実行する。
 * ⚠ 試し実行(`-n`)では何も実行せず、実行したらどうなるかだけを出す。
 */
import { archetypeLabel } from '@features/flavor/archetype-label';
import { fold } from '@features/palette/palette-rows';
import { collectSubtreeLids, resolveCanonicalParents } from '@features/relation/tree';
import { planPreview, type PlanOp, type PlanTarget } from '@features/structure/structure-plan';
import { joinTokens, splitFlags, tokenize, type ShellToken } from './tokenize';
import { childrenOf, pathOf, resolveFolder, resolveNote, resolveNotes, splitParentTitle } from './resolve';
import type { ArgKind, ShellEffect, ShellEnv, ShellGroup, ShellPlan, ShellSurface, ShellTable } from './types';

interface Ctx {
  readonly env: ShellEnv;
  /** 旗を除いた引数。 */
  readonly args: readonly ShellToken[];
  readonly flags: ReadonlySet<string>;
  /** 命令の名前の後ろの生の文字列(SQL・操作の名前・追記する字に使う)。 */
  readonly rest: string;
}

export interface ShellCommand {
  /** 英字の名前(本来の綴り)。 */
  readonly name: string;
  /** 日本語などの別名。 */
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly summary: string;
  readonly group: ShellGroup;
  readonly surfaces: readonly ShellSurface[];
  /** 引数の種類(補完が見る)。位置ごと。最後の種類は残り全部に使う。 */
  readonly args: readonly ArgKind[];
  readonly dangerous?: true;
  readonly run: (ctx: Ctx) => ShellPlan;
}

const BOTH: readonly ShellSurface[] = ['shell', 'dual'];
const SHELL_ONLY: readonly ShellSurface[] = ['shell'];
const DUAL_ONLY: readonly ShellSurface[] = ['dual'];

const err = (error: string): ShellPlan => ({ lines: [], effects: [], error });
const say = (lines: readonly string[], effects: readonly ShellEffect[] = [], extra: Partial<ShellPlan> = {}): ShellPlan => ({
  lines,
  effects,
  ...extra,
});

const nameOf = (env: ShellEnv, lid: string): string => `「${env.metas.get(lid)?.title ?? lid}」`;
const whereText = (env: ShellEnv, scope: string | null): string => (scope === null ? 'ルート' : nameOf(env, scope));
const listText = (env: ShellEnv, lids: readonly string[]): string =>
  lids.length <= 3 ? lids.map((l) => nameOf(env, l)).join('、') : `${nameOf(env, lids[0]!)} ほか ${String(lids.length - 1)} 件`;
/** 本文に書く字の `\n` を改行にする(1 行で複数行を書くため)。 */
const unescapeBody = (s: string): string => s.replace(/\\n/gu, '\n');

const TABLE_CAP = 200;

/** 指した物と、フォルダの中身を含めた件数(重複は 1 つ)。 */
function subtreeCount(env: ShellEnv, lids: readonly string[]): number {
  const all = new Set<string>();
  for (const l of lids) for (const x of collectSubtreeLids(l, env.metas, env.relations)) all.add(x);
  return all.size;
}

function tableOf(env: ShellEnv, metas: readonly { lid: string }[], extra?: (lid: string) => string): { table: ShellTable; numbered: string[] } {
  const shown = metas.slice(0, TABLE_CAP);
  const columns = ['#', '種類', '題名', extra === undefined ? '更新' : '場所'];
  const rows = shown.map((m, i) => {
    const meta = env.metas.get(m.lid)!;
    return [
      String(i + 1),
      archetypeLabel(meta.archetype),
      meta.archetype === 'folder' ? `${meta.title}/` : meta.title,
      extra === undefined ? (meta.updatedAt ?? '').slice(0, 10) : extra(meta.lid),
    ];
  });
  return {
    table: { columns, rows, lids: shown.map((m) => m.lid) },
    numbered: shown.map((m) => m.lid),
  };
}

/** `mv` / `cp` の引数を「元」と「先」に割る。 */
function sourcesAndDest(ctx: Ctx, example: string): { lids: string[]; to: string | null } | ShellPlan {
  const { env, args } = ctx;
  const texts = args.map((a) => a.text);
  let srcRefs: string[];
  let destRef: string | null;
  if (texts.length === 0) {
    if (env.other === undefined) return err(`行き先を書いてください(例: ${example})`);
    srcRefs = ['.'];
    destRef = null;
  } else if (texts.length === 1) {
    srcRefs = ['.'];
    destRef = texts[0]!;
  } else {
    srcRefs = texts.slice(0, -1);
    destRef = texts[texts.length - 1]!;
  }
  const srcs = resolveNotes(srcRefs, env);
  if (!srcs.ok) return err(srcs.error);
  let to: string | null;
  if (destRef === null) {
    to = env.other ?? null;
  } else {
    const dest = resolveFolder(destRef, env);
    if (!dest.ok) return err(dest.error);
    to = dest.value;
  }
  if (to !== null && env.metas.get(to)?.archetype !== 'folder') {
    return err(`${nameOf(env, to)} はフォルダではないので、入れられません`);
  }
  return { lids: srcs.value, to };
}

const isPlan = (v: { lids: string[]; to: string | null } | ShellPlan): v is ShellPlan => 'effects' in v;

const toTarget = (parent: string | null): PlanTarget => (parent === null ? { at: 'root' } : { at: 'lid', lid: parent });

function previewLines(ops: readonly PlanOp[], env: ShellEnv): string[] {
  return planPreview(ops, env.metas).map((l) => l.text);
}

const FORMATS: ReadonlyMap<string, 'md' | 'pdf'> = new Map([
  ['md', 'md'],
  ['markdown', 'md'],
  ['pdf', 'pdf'],
]);

const TAG_VERBS: ReadonlyMap<string, 'add' | 'remove'> = new Map([
  ['add', 'add'],
  ['付ける', 'add'],
  ['+', 'add'],
  ['remove', 'remove'],
  ['rm', 'remove'],
  ['外す', 'remove'],
  ['-', 'remove'],
]);

export const SHELL_COMMANDS: readonly ShellCommand[] = [
  {
    name: 'ls',
    aliases: ['一覧'],
    usage: 'ls [フォルダ]',
    summary: 'フォルダの中身を一覧にします(番号は次の命令で #1 のように使えます)',
    group: '探す・開く',
    surfaces: BOTH,
    args: ['folder'],
    run: ({ env, args }) => {
      const where = args.length === 0 ? { ok: true as const, value: env.cwd } : resolveFolder(args[0]!.text, env);
      if (!where.ok) return err(where.error);
      const kids = childrenOf(env, where.value);
      const { table, numbered } = tableOf(env, kids);
      const head = `${pathOf(env, where.value)}(${String(kids.length)} 件${kids.length > TABLE_CAP ? `。先頭の ${String(TABLE_CAP)} 件を表示` : ''})`;
      return say([head], [], { table, numbered });
    },
  },
  {
    name: 'pwd',
    aliases: ['現在地'],
    usage: 'pwd',
    summary: 'いまの場所を出します',
    group: '探す・開く',
    surfaces: BOTH,
    args: [],
    run: ({ env }) => say([pathOf(env, env.cwd)]),
  },
  {
    name: 'cd',
    aliases: ['移動'],
    usage: 'cd [フォルダ]',
    summary: '場所を変えます(省略するとルート。.. で 1 つ上)',
    group: '探す・開く',
    surfaces: BOTH,
    args: ['folder'],
    run: ({ env, args }) => {
      const to = args.length === 0 ? { ok: true as const, value: null } : resolveFolder(args[0]!.text, env);
      if (!to.ok) return err(to.error);
      if (to.value !== null && env.metas.get(to.value)?.archetype !== 'folder') {
        return err(`${nameOf(env, to.value)} はフォルダではないので、入れません`);
      }
      return env.surface === 'dual'
        ? say([pathOf(env, to.value)], [{ type: 'enter', scope: to.value }])
        : say([pathOf(env, to.value)], [], { cwd: to.value });
    },
  },
  {
    name: 'find',
    aliases: ['探す', '検索'],
    usage: 'find <語…> [-b]',
    summary: '題名から探します。-b を付けると本文も探します(全文検索)',
    group: '探す・開く',
    surfaces: BOTH,
    args: ['text'],
    run: ({ env, args, flags }) => {
      const words = args.map((a) => fold(a.text)).filter((w) => w !== '');
      if (words.length === 0) return err('探す語を書いてください(例: find 議事録)');
      if (flags.has('b') || flags.has('body')) {
        return say([`本文も含めて「${joinTokens(args)}」を探します`], [{ type: 'search', query: joinTokens(args) }]);
      }
      const hits = [...env.metas.values()].filter((m) => {
        const t = fold(m.title);
        return words.every((w) => t.includes(w));
      });
      if (hits.length === 0) return say([`「${joinTokens(args)}」に当てはまるノートはありません(本文も探すには -b)`], [], { numbered: [] });
      const parents = resolveCanonicalParents(env.metas, env.relations);
      const { table, numbered } = tableOf(env, hits, (lid) => pathOf(env, parents.get(lid) ?? null));
      return say([`${String(hits.length)} 件${hits.length > TABLE_CAP ? `(先頭の ${String(TABLE_CAP)} 件を表示)` : ''}`], [], { table, numbered });
    },
  },
  {
    name: 'open',
    aliases: ['開く'],
    usage: 'open <ノート>',
    summary: 'ノートを開きます(2 ペインではフォルダの中へ入ります)',
    group: '探す・開く',
    surfaces: BOTH,
    args: ['note'],
    run: ({ env, args }) => {
      const ref = args[0]?.text ?? '.';
      const one = resolveNote(ref, env);
      if (!one.ok) return err(one.error);
      if (env.surface === 'dual' && env.metas.get(one.value)?.archetype === 'folder') {
        return say([`${nameOf(env, one.value)} の中へ入ります`], [{ type: 'enter', scope: one.value }]);
      }
      return say([`${nameOf(env, one.value)} を開きます`], [{ type: 'open', lid: one.value }]);
    },
  },
  {
    name: 'new',
    aliases: ['作る'],
    usage: 'new <題名> [本文…]',
    summary: 'いまの場所にノートを作ります(題名の前に 資料/ のようにフォルダを付けられます。本文の改行は \\n)',
    group: '作る・書く',
    surfaces: BOTH,
    args: ['text'],
    run: ({ env, args }) => {
      if (args.length === 0) return err('題名を書いてください(例: new 議事録 今日の議題)');
      const split = splitParentTitle(args[0]!.text, env, args[0]!.quoted);
      if ('error' in split) return err(split.error);
      const { parent, title } = split;
      const body = unescapeBody(joinTokens(args.slice(1)));
      return say(
        [`${whereText(env, parent)}に、ノート「${title}」を作ります`],
        [{ type: 'create', title, body, parent }],
      );
    },
  },
  {
    name: 'mkdir',
    aliases: ['フォルダ'],
    usage: 'mkdir <題名>',
    summary: 'いまの場所にフォルダを作ります(題名の前に 資料/ のように親を付けられます)',
    group: '作る・書く',
    surfaces: BOTH,
    args: ['text'],
    run: ({ env, args }) => {
      if (args.length === 0) return err('フォルダの題名を書いてください(例: mkdir 資料)');
      const split = splitParentTitle(args[0]!.text, env, args[0]!.quoted);
      if ('error' in split) return err(split.error);
      const { parent, title } = split;
      const ops: PlanOp[] = [{ kind: 'mkdir', title, parent: toTarget(parent), alias: null }];
      return say(previewLines(ops, env), [{ type: 'plan', ops }]);
    },
  },
  {
    name: 'append',
    aliases: ['追記'],
    usage: 'append <ノート> <字…>',
    summary: 'ノートの末尾に字を足します(「元に戻す」で戻せます。\\n は改行)',
    group: '作る・書く',
    surfaces: BOTH,
    args: ['note', 'text'],
    run: ({ env, args }) => {
      if (args.length < 2) return err('足す先と字を書いてください(例: append 議事録 決定事項を足す)');
      const one = resolveNote(args[0]!.text, env, (m) => m.archetype !== 'folder');
      if (!one.ok) return err(one.error);
      const text = unescapeBody(joinTokens(args.slice(1)));
      return say([`${nameOf(env, one.value)} の末尾に ${String(text.length)} 字を足します`], [{ type: 'append', lid: one.value, text }]);
    },
  },
  {
    name: 'mv',
    aliases: ['移す'],
    usage: 'mv <ノート…> <フォルダ>',
    summary: 'ノートをフォルダへ移します(中のノートも付いていきます。2 ペインでは行き先を省くと反対側)',
    group: '整理する',
    surfaces: BOTH,
    args: ['notes', 'folder'],
    run: (ctx) => {
      const r = sourcesAndDest(ctx, 'mv 議事録 資料');
      if (isPlan(r)) return r;
      const ops: PlanOp[] = r.lids.map((lid) => ({ kind: 'mv', lid, parent: toTarget(r.to) }));
      return say(previewLines(ops, ctx.env), [{ type: 'move', lids: r.lids, to: r.to }]);
    },
  },
  {
    name: 'cp',
    aliases: ['コピー', '複製'],
    usage: 'cp <ノート…> <フォルダ>',
    summary: 'ノートをフォルダへコピーします(フォルダは中身ごと。2 ペインでは行き先を省くと反対側)',
    group: '整理する',
    surfaces: BOTH,
    args: ['notes', 'folder'],
    run: (ctx) => {
      const r = sourcesAndDest(ctx, 'cp 議事録 資料');
      if (isPlan(r)) return r;
      const total = subtreeCount(ctx.env, r.lids);
      const line = `${listText(ctx.env, r.lids)} を ${whereText(ctx.env, r.to)} へコピーします`;
      // 🔴 まとめて複製する(2 件以上 / フォルダは中身ごと)ときは、件数つきで確認する(コピーはゴミ箱に戻せない大量の増殖になりうる)
      const many = total > 1;
      const count = total > r.lids.length ? `${String(r.lids.length)} 件。フォルダの中身を含めて ${String(total)} 件` : `${String(r.lids.length)} 件`;
      return say([line], [{ type: 'copy', lids: r.lids, to: r.to }], many ? { confirm: `${line}(${count})。よろしいですか?`, confirmDanger: false } : {});
    },
  },
  {
    name: 'rename',
    aliases: ['改名'],
    usage: 'rename <ノート> <新しい題名>',
    summary: 'ノートの題名を変えます(対象を省くと、選んでいるノート)',
    group: '整理する',
    surfaces: BOTH,
    args: ['note', 'text'],
    run: ({ env, args }) => {
      if (args.length === 0) return err('新しい題名を書いてください(例: rename 議事録 議事録 2026)');
      const [refTok, ...titleToks] = args;
      let ref = refTok!.text;
      let title = joinTokens(titleToks);
      if (titleToks.length === 0) {
        ref = '.';
        title = refTok!.text;
      }
      const one = resolveNote(ref, env);
      if (!one.ok) return err(one.error);
      if (title.trim() === '') return err('新しい題名が空です');
      const ops: PlanOp[] = [{ kind: 'rename', lid: one.value, title }];
      return say(previewLines(ops, env), [{ type: 'plan', ops }]);
    },
  },
  {
    name: 'rm',
    aliases: ['消す', '削除', 'ゴミ箱'],
    usage: 'rm <ノート…>',
    summary: 'ノートをゴミ箱へ入れます(確認が出ます。あとで戻せます)',
    group: '整理する',
    surfaces: BOTH,
    args: ['notes'],
    dangerous: true,
    run: ({ env, args }) => {
      const refs = args.length === 0 ? ['.'] : args.map((a) => a.text);
      // 🔴 題名の曖昧さは「いまの場所に 1 件ならそれ」で救わない(strict)── 別のフォルダの同じ題名を黙って消さない
      const r = resolveNotes(refs, env, true);
      if (!r.ok) return err(r.error);
      const total = subtreeCount(env, r.value);
      const count = total > r.value.length ? `${String(r.value.length)} 件。フォルダの中身を含めて ${String(total)} 件` : `${String(r.value.length)} 件`;
      const line = `${listText(env, r.value)} をゴミ箱へ入れます(${count}。あとで戻せます)`;
      return say([line], [{ type: 'trash', lids: r.value }], { confirm: `${line}。よろしいですか?`, confirmDanger: true });
    },
  },
  {
    name: 'tag',
    aliases: ['タグ'],
    usage: 'tag <add|remove> <タグ> [ノート…]',
    summary: 'ノートにタグを付ける / 外します(add / 付ける、remove / 外す。対象を省くと選んでいるノート)',
    group: '整理する',
    surfaces: BOTH,
    args: ['verb', 'tag', 'notes'],
    run: ({ env, args }) => {
      if (args.length < 2) return err('書き方: tag add 重要 議事録(外すときは remove / 外す)');
      const mode = TAG_VERBS.get(args[0]!.text.toLowerCase());
      if (mode === undefined) return err(`「${args[0]!.text}」は付ける(add)か外す(remove)で書いてください`);
      const tag = args[1]!.text.replace(/^#/u, '');
      if (tag === '') return err('タグの名前が空です');
      const refs = args.length > 2 ? args.slice(2).map((a) => a.text) : ['.'];
      const r = resolveNotes(refs, env);
      if (!r.ok) return err(r.error);
      return say(
        [`${listText(env, r.value)} に、タグ「${tag}」を${mode === 'add' ? '付けます' : '外します'}`],
        [{ type: 'tag', lids: r.value, tags: [tag], mode }],
      );
    },
  },
  {
    name: 'export',
    aliases: ['書き出し'],
    usage: 'export [ノート] [md|pdf]',
    summary: 'ノート 1 件を Markdown か PDF で書き出します(既定は md)',
    group: '整理する',
    surfaces: BOTH,
    args: ['note', 'format'],
    run: ({ env, args }) => {
      let format: 'md' | 'pdf' = 'md';
      const refs = [...args];
      const last = refs[refs.length - 1];
      const f = last === undefined ? undefined : FORMATS.get(last.text.toLowerCase());
      if (f !== undefined && !last!.quoted) {
        format = f;
        refs.pop();
      }
      const one = resolveNote(refs[0]?.text ?? '.', env);
      if (!one.ok) return err(one.error);
      return say(
        [`${nameOf(env, one.value)} を ${format === 'md' ? 'Markdown' : 'PDF'} で書き出します`],
        [{ type: 'export', lid: one.value, format }],
      );
    },
  },
  {
    name: 'select',
    aliases: ['選ぶ'],
    usage: 'select <語…> | select * | select -c',
    summary: '2 ペイン: いまの場所で、題名に語を含む行を選択します(* で全部、-c で選択を外す)',
    group: '整理する',
    surfaces: DUAL_ONLY,
    args: ['text'],
    run: ({ env, args, flags }) => {
      if (flags.has('c') || flags.has('clear')) return say(['選択を外します'], [{ type: 'select', lids: [], mode: 'clear' }]);
      const kids = childrenOf(env, env.cwd);
      if (args.length === 0) return say([`選択している行: ${String(env.marked.length)} 件`]);
      const words = args.map((a) => fold(a.text));
      const hits = words.length === 1 && words[0] === '*' ? kids : kids.filter((m) => words.every((w) => fold(m.title).includes(w)));
      if (hits.length === 0) return err(`「${joinTokens(args)}」に当てはまる行がいまの場所にありません`);
      return say([`${String(hits.length)} 件を選択します`], [{ type: 'select', lids: hits.map((m) => m.lid), mode: 'set' }]);
    },
  },
  {
    name: 'sql',
    aliases: ['SQL'],
    usage: 'sql <SELECT 文>',
    summary: '保存領域を SQL で調べます(読むだけ。結果は表で出て、コピーできます)',
    group: '調べる・呼ぶ',
    surfaces: SHELL_ONLY,
    args: ['sql'],
    run: ({ rest }) => {
      if (rest.trim() === '') return err('SQL を書いてください(例: sql SELECT title FROM entries LIMIT 10)');
      return say(['SQL を実行します'], [{ type: 'sql', sql: rest.trim() }]);
    },
  },
  {
    name: 'do',
    aliases: ['操作', '実行'],
    usage: 'do <操作の名前>',
    summary: '「操作を探す」にある操作を名前で呼びます(一致が 1 つならその場で実行。複数なら候補を出します)',
    group: '調べる・呼ぶ',
    surfaces: BOTH,
    args: ['operation'],
    run: ({ rest }) => {
      if (rest.trim() === '') return err('操作の名前を書いてください(例: do 設定を開く)。一覧は ops');
      return say([`操作「${rest.trim()}」を呼びます`], [{ type: 'operation', query: rest.trim() }]);
    },
  },
  {
    name: 'ops',
    aliases: ['操作一覧'],
    usage: 'ops [語]',
    summary: '呼べる操作を一覧にします(語で絞れます)',
    group: '調べる・呼ぶ',
    surfaces: BOTH,
    args: ['operation'],
    run: ({ rest }) => say([], [{ type: 'operations', query: rest.trim() }]),
  },
  {
    name: 'history',
    aliases: ['履歴'],
    usage: 'history [-c]',
    summary: '打った命令の履歴を出します(!3 でその番号を、!! で直前をもう一度。-c で履歴を消します)',
    group: 'シェル',
    surfaces: BOTH,
    args: [],
    run: ({ flags }) =>
      flags.has('c') || flags.has('clear') ? say(['履歴を消します'], [{ type: 'history-clear' }]) : say([], [{ type: 'history' }]),
  },
  {
    name: 'copy-result',
    aliases: ['結果コピー'],
    usage: 'copy-result',
    summary: '直前の結果の表をタブ区切りでクリップボードへコピーします',
    group: 'シェル',
    surfaces: BOTH,
    args: [],
    run: () => say([], [{ type: 'copy-result' }]),
  },
  {
    name: 'clear',
    aliases: ['消去'],
    usage: 'clear',
    summary: '画面の出力を消します(履歴は残ります)',
    group: 'シェル',
    surfaces: BOTH,
    args: [],
    run: () => say([], [{ type: 'clear' }]),
  },
  {
    name: 'help',
    aliases: ['ヘルプ', '?'],
    usage: 'help [命令]',
    summary: '命令の一覧と書き方を出します',
    group: 'シェル',
    surfaces: BOTH,
    args: ['command'],
    run: ({ env, args }) => {
      const here = SHELL_COMMANDS.filter((c) => c.surfaces.includes(env.surface));
      if (args.length > 0) {
        const c = findCommand(args[0]!.text, env.surface);
        if (c === null) return err(`「${args[0]!.text}」という命令はありません。help で一覧を出せます`);
        const names = [c.name, ...c.aliases].join(' / ');
        return say([`${c.usage}`, `${c.summary}`, `別名: ${names}${c.dangerous === true ? '(確認が出ます)' : ''}`, '-n を付けると、実行せずに何が起きるかだけを出します']);
      }
      const rows = here.map((c) => [c.group, c.usage, c.summary]);
      return say(
        [
          '命令は英語でも日本語でも打てます(例: mv と 移す)。Tab で補完、↑ ↓ で履歴、-n で試し実行。',
          '一覧の番号は次の命令で使えます(例: find 議事録 → mv #1 資料)。.  は選んでいるノート、* は場所の中の全部です。',
        ],
        [],
        { table: { columns: ['分類', '書き方', '内容'], rows, lids: rows.map(() => null) } },
      );
    },
  },
];

/** 名前か別名で命令を引く(大小・全角半角を区別しない)。2 ペインに無い命令は `null`。 */
export function findCommand(word: string, surface: ShellSurface): ShellCommand | null {
  const w = fold(word);
  for (const c of SHELL_COMMANDS) {
    if (!c.surfaces.includes(surface)) continue;
    if (fold(c.name) === w || c.aliases.some((a) => fold(a) === w)) return c;
  }
  return null;
}

/** 命令の名前と別名の全部(補完の元)。 */
export function commandWords(surface: ShellSurface): string[] {
  return SHELL_COMMANDS.filter((c) => c.surfaces.includes(surface)).flatMap((c) => [c.name, ...c.aliases]);
}

/**
 * 1 行を読んで、命令表から `ShellPlan` を作る。**これが命令表の唯一の入口**。
 * ⚠ `-n` / `--dry-run` のときは `effects` を空にして、何が起きるかの文だけを返す。
 */
export function planLine(line: string, env: ShellEnv): ShellPlan {
  const text = line.trim();
  if (text === '') return say([]);
  const { tokens, error } = tokenize(text);
  if (error !== null) return err(error);
  const [head, ...restTokens] = tokens;
  if (head === undefined) return say([]);
  const cmd = findCommand(head.text, env.surface);
  if (cmd === null) {
    const w = fold(head.text);
    const near = commandWords(env.surface).filter((n) => fold(n).startsWith(w)).slice(0, 4);
    return err(
      `「${head.text}」という命令はありません${near.length > 0 ? `(もしかして: ${near.join('、')})` : ''}。help で一覧を出せます`,
    );
  }
  const { flags, args } = splitFlags(restTokens);
  // 試し実行の旗は命令の引数ではない(SQL / 操作の名前など生の残りからも除く)
  const dry = flags.has('n') || flags.has('dry-run');
  const rest = dry ? stripDryFlag(text.slice(head.end).trim()) : text.slice(head.end).trim();
  const plan = cmd.run({ env, args, flags, rest });
  if (plan.error !== undefined) return plan;
  if (dry) {
    const lines = plan.effects.length === 0 ? plan.lines : [...plan.lines];
    return {
      lines: [plan.effects.length === 0 ? '(試し実行)' : '(試し実行: 実行はしません)', ...lines],
      ...(plan.table === undefined ? {} : { table: plan.table }),
      effects: [],
      ...(plan.numbered === undefined ? {} : { numbered: plan.numbered }),
    };
  }
  return plan;
}

function stripDryFlag(rest: string): string {
  return rest.replace(/(^|\s)--?(?:n|dry-run)(?=\s|$)/gu, ' ').trim();
}

/** SQL を履歴に残す長さ(先頭だけ)。 */
export const SHELL_HISTORY_SQL_CHARS = 24;

/**
 * 🔴 **履歴に残す形**(機密を残さない)。
 *
 * ⚠ `new` / `append` の**本文**と、`sql` の**後ろ**には、金額・個人名・SQL の条件など端末の外へ出したくない字が入りうる。
 *   残すのはコマンドと対象(題名)まで ── `new` は題名、`append` は追記先、`sql` は先頭 {@link SHELL_HISTORY_SQL_CHARS} 字だけ。
 *   (`!3` で呼び戻すと本文の無い `new` になる。履歴は「打ち直す手がかり」であって、本文の控えではない)
 */
export function historyLineOf(line: string, surface: ShellSurface): string {
  const text = line.trim();
  const { tokens, error } = tokenize(text);
  const head = tokens[0];
  if (error !== null || head === undefined) return text;
  const cmd = findCommand(head.text, surface);
  if (cmd === null) return text;
  const q = (t: ShellToken): string => (/[\s"'「」“”]/u.test(t.text) ? `"${t.text.replace(/(["\\])/gu, '\\$1')}"` : t.text);
  if (cmd.name === 'new' || cmd.name === 'append') {
    const first = tokens[1];
    return first === undefined ? head.text : `${head.text} ${q(first)}`;
  }
  if (cmd.name === 'sql') {
    const rest = text.slice(head.end).trim();
    return rest.length <= SHELL_HISTORY_SQL_CHARS ? text : `${head.text} ${rest.slice(0, SHELL_HISTORY_SQL_CHARS)}…`;
  }
  return text;
}
