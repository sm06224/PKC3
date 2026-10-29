/**
 * コマンドシェルの補完(#274)。**pure module**。
 *
 * - 1 語目 = 命令の名前と別名。
 * - 2 語目以降 = 命令の `args`(位置ごとの種類)で決める: ノート(題名)・フォルダ・操作の名前・タグ・書式。
 * - 題名に空白や引用符が入るときは、挿入する字を `"…"` で囲む(`tokenize` で読み戻せる形)。
 * - 候補は**押せる形で並べるだけ**で、勝手に確定しない(Tab は共通の頭までを入れ、1 件なら確定する)。
 */
import { fold } from '@features/palette/palette-rows';
import { SHELL_COMMANDS, commandWords, findCommand } from './commands';
import { childrenOf } from './resolve';
import { tokenize, type ShellToken } from './tokenize';
import type { ArgKind, ShellEnv } from './types';

export interface Completion {
  /** 置き換える範囲(元の行の添字)。 */
  readonly from: number;
  readonly to: number;
  readonly items: readonly CompletionItem[];
}

export interface CompletionItem {
  /** 範囲へ入れる字(必要なら引用符つき)。 */
  readonly insert: string;
  /** 候補の表示。 */
  readonly label: string;
  /** 補足(種類・道)。 */
  readonly hint: string;
}

export const COMPLETION_MAX = 12;

/**
 * 題名を欄へ入れる形。空白・引用符のほか、**語として読み間違えられる題名**も囲む:
 * `-n`(旗)・数字(`3` は直前の一覧の番号)・`*` `.` `..`(指し方)・`/` を含む(フォルダの道)・`!` `#` で始まる(履歴・番号)。
 */
export const quoteIfNeeded = (s: string): string =>
  /[\s"'「」“”]/u.test(s) || s === '' || /^(-|!|#|\*$|\.{1,2}$|\d+$)|\//u.test(s) ? `"${s.replace(/(["\\])/gu, '\\$1')}"` : s;

function matches(candidate: string, q: string): number | null {
  const c = fold(candidate);
  if (q === '') return 2;
  if (c.startsWith(q)) return 0;
  if (c.includes(q)) return 1;
  return null;
}

export interface CompleteOptions {
  /** 「操作を探す」の操作の名前(`do` の補完)。 */
  readonly operationLabels?: readonly string[];
}

export function completeLine(line: string, env: ShellEnv, opts: CompleteOptions = {}): Completion {
  // 閉じていない引用符は、そこから行末までを「いま打っている語」として読む
  let tokens: readonly ShellToken[];
  const t = tokenize(line);
  if (t.error === null) tokens = t.tokens;
  else {
    const open = line.search(/["'「“][^"'「」“”]*$/u);
    tokens = [...tokenize(line.slice(0, Math.max(0, open))).tokens, { text: line.slice(open + 1), quoted: true, start: open, end: line.length }];
  }
  const endsWithSpace = /\s$/u.test(line) && t.error === null;
  const current = endsWithSpace || tokens.length === 0 ? null : tokens[tokens.length - 1]!;
  const pos = current === null ? tokens.length : tokens.length - 1;
  const from = current === null ? line.length : current.start;
  const to = line.length;
  const prefix = fold(current?.text ?? '');
  const items: CompletionItem[] = [];

  if (pos === 0) {
    const canonical = new Set(SHELL_COMMANDS.map((c) => c.name));
    for (const w of commandWords(env.surface)) {
      if (prefix === '' ? canonical.has(w) : matches(w, prefix) === 0) {
        const c = findCommand(w, env.surface)!;
        items.push({ insert: w, label: w, hint: c.summary });
      }
    }
    return { from, to, items: items.slice(0, COMPLETION_MAX * 3) };
  }

  const cmd = findCommand(tokens[0]!.text, env.surface);
  if (cmd === null) return { from, to, items: [] };
  if (current !== null && !current.quoted && current.text.startsWith('-')) {
    for (const f of ['-n']) if (f.startsWith(current.text)) items.push({ insert: f, label: f, hint: '試し実行(実行せずに何が起きるかだけ出す)' });
    return { from, to, items };
  }
  const kind: ArgKind | undefined = cmd.args[Math.min(pos - 1, cmd.args.length - 1)];
  if (kind === undefined) return { from, to, items: [] };
  const raw = current?.text ?? '';
  const q = fold(raw);

  const noteLike = (folderOnly: boolean): void => {
    const specials: [string, string][] = folderOnly
      ? [['..', '1 つ上'], ['/', 'ルート'], ...(env.other === undefined ? [] : [['反対', '反対側の場所'] as [string, string]])]
      : [['.', '選んでいるノート'], ['*', 'いまの場所の全部']];
    for (const [w, hint] of specials) if (matches(w, q) !== null) items.push({ insert: w, label: w, hint });
    const here = new Set(childrenOf(env, env.cwd).map((m) => m.lid));
    const scored: { lid: string; rank: number; near: number; order: number }[] = [];
    let order = 0;
    for (const m of env.metas.values()) {
      order += 1;
      if (folderOnly && m.archetype !== 'folder') continue;
      const rank = matches(m.title, q);
      if (rank === null) continue;
      scored.push({ lid: m.lid, rank, near: here.has(m.lid) ? 0 : 1, order });
    }
    scored.sort((a, b) => a.rank - b.rank || a.near - b.near || a.order - b.order);
    for (const s of scored.slice(0, COMPLETION_MAX)) {
      const title = env.metas.get(s.lid)!.title;
      items.push({ insert: quoteIfNeeded(title), label: title, hint: s.near === 0 ? 'ここ' : '' });
    }
  };

  if (kind === 'note' || kind === 'notes') noteLike(false);
  else if (kind === 'folder') noteLike(true);
  else if (kind === 'command') {
    for (const c of SHELL_COMMANDS) {
      if (c.surfaces.includes(env.surface) && matches(c.name, q) !== null) items.push({ insert: c.name, label: c.name, hint: c.summary });
    }
  } else if (kind === 'operation') {
    // 操作の名前は空白を含む。`do` の後ろは生の残りなので、引用符で囲まずそのまま入れる
    const rest = line.slice(tokens[0]!.end).trimStart();
    const startAt = line.length - rest.length;
    const rq = fold(rest);
    const found = (opts.operationLabels ?? []).filter((l) => matches(l, rq) !== null).slice(0, COMPLETION_MAX);
    return { from: startAt, to, items: found.map((l) => ({ insert: l, label: l, hint: '' })) };
  } else if (kind === 'tag') {
    for (const tg of env.tags ?? []) if (matches(tg, q) !== null) items.push({ insert: quoteIfNeeded(tg), label: tg, hint: 'タグ' });
  } else if (kind === 'verb') {
    for (const v of ['add', 'remove', '付ける', '外す']) if (matches(v, q) !== null) items.push({ insert: v, label: v, hint: '' });
  } else if (kind === 'format') {
    for (const f of ['md', 'pdf']) if (matches(f, q) !== null) items.push({ insert: f, label: f, hint: '書き出しの形式' });
  }
  return { from, to, items: items.slice(0, COMPLETION_MAX * 2) };
}

/** 候補の挿入文字の共通の頭(Tab で入れる分)。 */
export function commonPrefix(items: readonly CompletionItem[]): string {
  if (items.length === 0) return '';
  let p = items[0]!.insert;
  for (const it of items) {
    while (!it.insert.startsWith(p)) p = p.slice(0, -1);
    if (p === '') break;
  }
  return p;
}
