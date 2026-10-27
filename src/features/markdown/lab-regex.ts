/**
 * 🔴 **テキスト整形の正規表現の置換**(純粋な本体)。#1233 のレビュー ⚠1。
 *
 * ⚠ **この file だけを置換ワーカーが読む**(`platform/text/lab-worker.ts`)── 整えの他の段(表の変換など)を
 *   ワーカーの束に連れて行かない。画面側の整え(`text-lab.ts`)はここを import して再公開する。
 */

export interface LabRegex {
  readonly pattern: string;
  readonly replacement: string;
  /** g i m s の組み合わせ(オプション)。それ以外の字は黙って捨てず、理由を言う。 */
  readonly flags: string;
}

/** 置換を掛ける入力の上限(文字数)。 */
export const LAB_REGEX_MAX_CHARS = 1_000_000;

/** 使えるオプション。 */
export const LAB_REGEX_FLAGS = ['g', 'i', 'm', 's'] as const;

/** オプションの文字列を確かめて、使えない字を返す(使える字だけなら `null`)。重複は使えない字として数える。 */
export function badRegexFlags(flags: string): string | null {
  const seen = new Set<string>();
  for (const f of flags) {
    if (!(LAB_REGEX_FLAGS as readonly string[]).includes(f) || seen.has(f)) return f;
    seen.add(f);
  }
  return null;
}

/** 置換の結果。 */
export interface LabRegexResult {
  readonly text: string;
  readonly note: string | null;
  readonly hits: number;
}

/**
 * 置換文の展開(`$&` `$1` `$<名前>` `$$` `` $` `` `$'`)。⚠ `String.prototype.replace` の文字列置換と同じ規則を
 * 自前で持つのは、**関数で置換して当たった数をその場で数える**ためである(`matchAll` を別に回すと、
 * 重い正規表現は 2 倍の時間がかかる)。同じ結果になることは `tests/features/text-lab.test.ts` が本物の `replace` と突き合わせる。
 */
export function expandLabReplacement(
  template: string,
  match: string,
  captures: readonly (string | undefined)[],
  offset: number,
  input: string,
  groups: Record<string, string | undefined> | undefined,
): string {
  if (!template.includes('$')) return template;
  const m = captures.length;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c !== '$' || i === template.length - 1) {
      out += c;
      continue;
    }
    const n = template[i + 1]!;
    if (n === '$') {
      out += '$';
      i += 1;
    } else if (n === '&') {
      out += match;
      i += 1;
    } else if (n === '`') {
      out += input.slice(0, offset);
      i += 1;
    } else if (n === "'") {
      out += input.slice(offset + match.length);
      i += 1;
    } else if (n >= '0' && n <= '9') {
      const two = template[i + 2];
      const d2 = two !== undefined && two >= '0' && two <= '9' ? Number(n + two) : 0;
      if (d2 >= 1 && d2 <= m) {
        out += captures[d2 - 1] ?? '';
        i += 2;
      } else if (Number(n) >= 1 && Number(n) <= m) {
        out += captures[Number(n) - 1] ?? '';
        i += 1;
      } else {
        out += '$';
      }
    } else if (n === '<' && groups !== undefined) {
      const close = template.indexOf('>', i + 2);
      if (close === -1) {
        out += '$';
      } else {
        out += groups[template.slice(i + 2, close)] ?? '';
        i = close;
      }
    } else {
      out += '$';
    }
  }
  return out;
}

/**
 * 正規表現の置換(整えの最後の段)。⚠ **重い式は固まる**(`(a+)+$` のような入れ子の繰り返し)。
 * 画面からはワーカーで走らせ、時間切れで止める(`platform/text/lab-client.ts`)。ここは純粋な本体で、
 * ワーカーの中でも、ワーカーの無い環境でも同じ関数を回す。
 * 🔑 当たった数は置換の関数の中で数える(1 回で済ませる)。
 */
export function applyLabRegex(text: string, r: LabRegex): LabRegexResult {
  if (r.pattern === '') return { text, note: null, hits: 0 };
  const bad = badRegexFlags(r.flags);
  if (bad !== null) {
    return { text, note: `オプション「${bad}」は使えません(使えるのは g i m s です)`, hits: 0 };
  }
  if (text.length > LAB_REGEX_MAX_CHARS) {
    return { text, note: '文章が長すぎるため(100 万字まで)、置換は掛けていません', hits: 0 };
  }
  let re: RegExp;
  try {
    re = new RegExp(r.pattern, r.flags);
  } catch (e) {
    const why = e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e);
    return { text, note: `検索パターンが正規表現として読めません(${why})`, hits: 0 };
  }
  let hits = 0;
  const replaced = text.replace(re, (...args: unknown[]): string => {
    hits += 1;
    // 引数の並び: 一致, 捕獲 1..n, 位置, 全文, (名前つき捕獲があれば最後に groups)
    const last = args[args.length - 1];
    const hasGroups = typeof last === 'object' && last !== null;
    const groups = hasGroups ? (last as Record<string, string | undefined>) : undefined;
    const tail = hasGroups ? 3 : 2;
    const captures = args.slice(1, args.length - tail) as (string | undefined)[];
    const offset = args[args.length - tail] as number;
    return expandLabReplacement(r.replacement, args[0] as string, captures, offset, text, groups);
  });
  return { text: replaced, note: null, hits };
}

