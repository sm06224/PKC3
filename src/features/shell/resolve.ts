/**
 * シェルの語(ノート・フォルダの指し方)を ID に解く。**pure module**。
 *
 * ## 🔑 指し方(ノート)
 *
 * | 書き方 | 意味 |
 * |---|---|
 * | `#3` / `3` | 直前の一覧の 3 番(「探す → 番号で次のコマンド」。パイプを持たない代わり) |
 * | `#2-4` | 直前の一覧の 2〜4 番 |
 * | `.` | いまの対象(シェル = 選んでいるノート / 2 ペイン = 印を付けた行、無ければカーソルの行) |
 * | `*` | いまの場所の中の全部 |
 * | ID そのもの | そのノート |
 * | 題名 | 同じ題名(全角半角・大小・ひらがなカタカナを区別しない)→ 部分一致の順 |
 *
 * ⚠ 題名が複数に当たったときは**黙って 1 つを選ばない**。いまの場所の中に 1 件だけならそれ、
 *   それ以外は候補を並べて断る(違うノートを消す・移す事故を作らない)。
 *
 * ## 🔑 指し方(フォルダ)
 *
 * `/`(ルート)`..`(1 つ上)`.`(ここ)`反対`(2 ペインの反対側)`資料/議事録`(道。`/` で始まればルートから)、
 * それ以外はノートと同じ(フォルダだけを相手にする)。
 */
import { fold } from '@features/palette/palette-rows';
import { getRootEntries, getStructuralChildren, resolveCanonicalParents } from '@features/relation/tree';
import type { EntryMeta } from '@core/model/entry-meta';
import type { ShellEnv } from './types';

export type Resolved<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * 🔴 **引用符で囲んだ語は「題名そのもの」**(`"3"` `"-n"` `"."` `"*"` は、番号・旗・指し方ではなく題名として探す)。
 * 呼び側(コマンド表)が囲んだ語の頭に付ける目印。⚠ ここで外すので、画面の字には出ない。
 */
export const LITERAL = '\u0001';

/**
 * 🔴 **解く側が特別扱いする語は、ここ 1 か所**(補完が題名を欄へ入れるとき囲むかどうかも、これを引く ── 解く側と入れる側を非対称にしない)。
 *
 * - 番号 `3` / `#3`、範囲 `2-4` / `#2-4`(直前の一覧の指し方)
 * - 予約語: ノートの `.`(選んでいるノート)`*`(場所の全部)/ フォルダの `/` `root` `ルート` `.` `..` `反対` `other`
 */
export const NUMBER_REF = /^#?(\d+)$/u;
export const RANGE_REF = /^#?(\d+)-(\d+)$/u;
export const RESERVED_WORDS: readonly string[] = ['.', '..', '*', '/', 'root', 'ルート', '反対', 'other'];

/** この字を囲まずに欄へ入れると、題名ではなく指し方・予約語として読まれるか。 */
export function readsAsReference(s: string): boolean {
  const t = s.trim();
  return NUMBER_REF.test(t) || RANGE_REF.test(t) || RESERVED_WORDS.includes(t);
}

/**
 * 題名を欄へ入れる形。空白・引用符のほか、**解く側(`resolve.ts`)が特別扱いする語**も囲む:
 * 番号・範囲・予約語(`readsAsReference` ── 解く側と同じ判定を引く)、`-` で始まる(旗)、`!` `#` で始まる(履歴・番号)、`/` を含む(フォルダの道)。
 */
export const quoteIfNeeded = (s: string): string =>
  /[\s"'「」“”]/u.test(s) || s === '' || /^[-!#]|\//u.test(s) || readsAsReference(s)
    ? `"${s.replace(/(["\\])/gu, '\\$1')}"`
    : s;

const ok = <T>(value: T): Resolved<T> => ({ ok: true, value });
const fail = <T>(error: string): Resolved<T> => ({ ok: false, error });

/** 場所の中身(ルート = `null`)。 */
export function childrenOf(env: ShellEnv, scope: string | null): EntryMeta[] {
  return scope === null ? getRootEntries(env.metas, env.relations) : getStructuralChildren(scope, env.metas, env.relations);
}

/** 場所の道(`資料 / 議事録`)。ルートは `/`。 */
export function pathOf(env: Pick<ShellEnv, 'metas' | 'relations'>, lid: string | null): string {
  if (lid === null) return '/';
  const parents = resolveCanonicalParents(env.metas, env.relations);
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = lid;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const m = env.metas.get(cur);
    if (m === undefined) break;
    names.unshift(m.title);
    cur = parents.get(cur);
  }
  return `/${names.join('/')}`;
}

const label = (env: ShellEnv, lid: string): string => `「${env.metas.get(lid)?.title ?? lid}」`;

function ambiguous(env: ShellEnv, ref: string, lids: readonly string[]): string {
  const shown = lids.slice(0, 5).map((l) => label(env, l)).join('、');
  const more = lids.length > 5 ? ` ほか ${String(lids.length - 5)} 件` : '';
  return `「${ref}」に当てはまるノートが ${String(lids.length)} 件あります(${shown}${more})。番号(#1)か ID で指してください`;
}

/** 1 つのノート(`filter` で相手を絞る)。 */
export function resolveNote(
  ref: string,
  env: ShellEnv,
  filter: (m: EntryMeta) => boolean = () => true,
  /**
   * 🔴 **危ないコマンド(消す)では「いまの場所に 1 件だけならそれ」を使わない**。
   * ⚠ 使うと、別のフォルダにも同じ題名があるのに、黙って目の前の 1 件を消す。曖昧なら候補を出して止める。
   */
  strict = false,
): Resolved<string> {
  const literal = ref.startsWith(LITERAL);
  const text = (literal ? ref.slice(LITERAL.length) : ref).trim();
  if (text === '') return fail('ノートの指定が空です');
  const num = literal ? null : NUMBER_REF.exec(text);
  if (num !== null && (text.startsWith('#') || env.last.length > 0)) {
    const n = Number(num[1]);
    const lid = env.last[n - 1];
    if (lid !== undefined && n >= 1) {
      const m = env.metas.get(lid);
      if (m === undefined) return fail(`${text} 番のノートはもうありません(一覧を出し直してください)`);
      return filter(m) ? ok(lid) : fail(`${text} 番は ${label(env, lid)} ですが、ここでは指せない種類です`);
    }
    if (text.startsWith('#')) {
      return fail(
        env.last.length === 0
          ? `${text} 番がありません。先に ls か find で一覧を出してください`
          : `${text} 番がありません(直前の一覧は ${String(env.last.length)} 件です)`,
      );
    }
  }
  const byId = env.metas.get(text);
  if (byId !== undefined) return filter(byId) ? ok(byId.lid) : fail(`${label(env, byId.lid)} はここでは指せない種類です`);
  if (text === '.' && !literal) {
    const only = env.marked.filter((l) => env.metas.has(l));
    if (only.length === 1) return ok(only[0]!);
    return fail(only.length === 0 ? '対象のノートがありません(先に選んでください)' : '対象が複数あります。1 件に絞ってください');
  }
  const q = fold(text);
  const pool = [...env.metas.values()].filter(filter);
  const exact = pool.filter((m) => fold(m.title) === q);
  const hits = exact.length > 0 ? exact : pool.filter((m) => fold(m.title).includes(q));
  if (hits.length === 0) return fail(`「${text}」というノートはありません`);
  if (hits.length === 1) return ok(hits[0]!.lid);
  if (!strict) {
    const here = hits.filter((m) => childrenOf(env, env.cwd).some((c) => c.lid === m.lid));
    if (here.length === 1) return ok(here[0]!.lid);
  }
  return fail(ambiguous(env, text, hits.map((m) => m.lid)));
}

/** 複数の語を、ノートの ID の並びに解く(`.` `*` `#2-4` を展開する)。重複は 1 つにする。 */
export function resolveNotes(refs: readonly string[], env: ShellEnv, strict = false): Resolved<string[]> {
  const out: string[] = [];
  const push = (lid: string): void => {
    if (!out.includes(lid)) out.push(lid);
  };
  for (const ref of refs) {
    if (ref.startsWith(LITERAL)) {
      const one = resolveNote(ref, env, () => true, strict);
      if (!one.ok) return one;
      push(one.value);
      continue;
    }
    if (ref === '.') {
      const live = env.marked.filter((l) => env.metas.has(l));
      if (live.length === 0) return fail('対象のノートがありません(先に選んでください)');
      live.forEach(push);
      continue;
    }
    if (ref === '*') {
      const kids = childrenOf(env, env.cwd);
      if (kids.length === 0) return fail('いまの場所にはノートがありません');
      kids.forEach((m) => push(m.lid));
      continue;
    }
    const range = RANGE_REF.exec(ref);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to < from || to > env.last.length) {
        return fail(`${ref} は直前の一覧の範囲にありません(直前の一覧は ${String(env.last.length)} 件です)`);
      }
      for (let n = from; n <= to; n += 1) push(env.last[n - 1]!);
      continue;
    }
    const one = resolveNote(ref, env, () => true, strict);
    if (!one.ok) return one;
    push(one.value);
  }
  return ok(out);
}

/** フォルダ 1 つ。`null` = ルート。 */
export function resolveFolder(ref: string, env: ShellEnv): Resolved<string | null> {
  const literal = ref.startsWith(LITERAL);
  const text = (literal ? ref.slice(LITERAL.length) : ref).trim();
  if (!literal && (text === '' || text === '/' || text === 'root' || text === 'ルート')) return ok(null); // RESERVED_WORDS
  if (text === '') return fail('フォルダの指定が空です');
  if (!literal && text === '.') return ok(env.cwd);
  if (!literal && text === '..') {
    if (env.cwd === null) return ok(null);
    return ok(resolveCanonicalParents(env.metas, env.relations).get(env.cwd) ?? null);
  }
  if (!literal && (text === '反対' || text === 'other')) { // RESERVED_WORDS
    if (env.other === undefined) return fail('反対側は 2 ペインのコマンドラインでだけ使えます');
    return ok(env.other);
  }
  const isFolder = (m: EntryMeta): boolean => m.archetype === 'folder';
  if (!literal && text.includes('/')) {
    const absolute = text.startsWith('/');
    const segs = text.split('/').filter((s) => s !== '');
    let cur: string | null = absolute ? null : env.cwd;
    for (const seg of segs) {
      if (seg === '..') {
        cur = cur === null ? null : (resolveCanonicalParents(env.metas, env.relations).get(cur) ?? null);
        continue;
      }
      if (seg === '.') continue;
      const q = fold(seg);
      const kids = childrenOf(env, cur).filter(isFolder);
      const hit = kids.filter((m) => fold(m.title) === q);
      const found = hit.length > 0 ? hit : kids.filter((m) => fold(m.title).includes(q));
      if (found.length === 0) return fail(`「${seg}」というフォルダが ${pathOf(env, cur)} の中にありません`);
      if (found.length > 1) return fail(ambiguous(env, seg, found.map((m) => m.lid)));
      cur = found[0]!.lid;
    }
    return ok(cur);
  }
  // 現在地の直下を先に見る(同じ名前のフォルダが他にあっても、目の前のものを指す)
  const q = fold(text);
  const near = childrenOf(env, env.cwd).filter((m) => isFolder(m) && fold(m.title) === q);
  if (near.length === 1) return ok(near[0]!.lid);
  const found = resolveNote(literal ? ref : text, env, isFolder);
  if (!found.ok) return found.error.includes('というノート') ? fail(`「${text}」というフォルダはありません`) : found;
  return ok(found.value);
}

/**
 * `資料/議事録` のように、題名の前にフォルダの道が付いているとき、(親, 題名) に割る。付いていなければ現在地。
 *
 * 🔴 **道が解けなければ断る**(黙って現在地に作らない ── 「資料/メモ」と打ったのに、現在地に「資料/メモ」という題名のノートができる)。
 * ⚠ `/` を題名の一部にしたいときは引用符で囲む(`literal`)。
 */
export function splitParentTitle(
  raw: string,
  env: ShellEnv,
  literal = false,
): { readonly parent: string | null; readonly title: string } | { readonly error: string } {
  const at = raw.lastIndexOf('/');
  if (literal || at < 0) return { parent: env.cwd, title: raw };
  const head = raw.slice(0, at);
  const title = raw.slice(at + 1);
  if (title === '') return { error: `「${raw}」は題名が空です(末尾の / の後ろに題名を書いてください。/ を題名に含めたいときは "…" で囲んでください)` };
  const folder = resolveFolder(head === '' ? '/' : head, env);
  if (!folder.ok) return { error: `${folder.error}(/ を題名に含めたいときは "…" で囲んでください)` };
  return { parent: folder.value, title };
}
