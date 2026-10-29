/**
 * コマンドシェル(#274 / #241)の 1 行を語に割る。**pure module**。
 *
 * ## 🔑 割り方の規則
 *
 * - 空白(全角の空白も)で語を割る。
 * - `"..."` `'...'` `「...」` `“...”` で囲むと、中の空白は語の一部になる(題名に空白が入るノートが普通にあるため)。
 *   ⚠ `"..."` の中だけ `\"` と `\\` を使える(それ以外の `\` はそのまま)。
 * - 囲んだ語は `quoted: true`。⚠ 囲んだ `-n` は旗ではなく題名である(旗の判定は `quoted === false` のときだけ)。
 * - 閉じていない囲みは**黙って補わず**エラーにする(題名の半端な切れ方で別のノートへ当てない)。
 *
 * ⚠ 解釈器は「名前と相手に割る」ことをしない(`command-query.ts` の注記)。ここで割るのは**シェルの 1 行**であり、
 *   操作の名前(空白を含むものがある)は `do` / `操作` の後ろの**生の残り**を使う(`rest`)。
 */

export interface ShellToken {
  readonly text: string;
  readonly quoted: boolean;
  /** 元の行での位置(補完が置き換える範囲に使う)。 */
  readonly start: number;
  readonly end: number;
}

export interface Tokenized {
  readonly tokens: readonly ShellToken[];
  /** 閉じていない囲みなど。`null` = 読めた。 */
  readonly error: string | null;
}

const CLOSERS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  '「': '」',
  '“': '”',
};

const isSpace = (ch: string): boolean => /\s/u.test(ch);

export function tokenize(line: string): Tokenized {
  const tokens: ShellToken[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    const closer = CLOSERS[ch];
    if (closer !== undefined) {
      const start = i;
      i += 1;
      let text = '';
      let closed = false;
      while (i < line.length) {
        const c = line[i]!;
        if (ch === '"' && c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
          text += line[i + 1]!;
          i += 2;
          continue;
        }
        if (c === closer) {
          closed = true;
          i += 1;
          break;
        }
        text += c;
        i += 1;
      }
      if (!closed) {
        return { tokens, error: `${ch} が閉じていません(${closer} で閉じてください)` };
      }
      tokens.push({ text, quoted: true, start, end: i });
      continue;
    }
    const start = i;
    while (i < line.length && !isSpace(line[i]!)) i += 1;
    tokens.push({ text: line.slice(start, i), quoted: false, start, end: i });
  }
  return { tokens, error: null };
}

/**
 * 語を旗と引数に分ける。`-n` `--dry-run` のように `-` で始まる**囲んでいない**語が旗。
 * `--` 以降は全部引数(`-` で始まる題名を渡すため)。数字で始まる語(`-3`)は旗ではない。
 */
export function splitFlags(tokens: readonly ShellToken[]): {
  readonly flags: ReadonlySet<string>;
  readonly args: readonly ShellToken[];
} {
  const flags = new Set<string>();
  const args: ShellToken[] = [];
  let literal = false;
  for (const t of tokens) {
    if (!literal && !t.quoted && t.text === '--') {
      literal = true;
      continue;
    }
    if (!literal && !t.quoted && /^-{1,2}[^-\s\d]/u.test(t.text)) {
      flags.add(t.text.replace(/^-+/u, ''));
      continue;
    }
    args.push(t);
  }
  return { flags, args };
}

/** 語を空白で繋ぎ直す(`new` の本文など、残りを 1 つの字にしたいとき)。 */
export const joinTokens = (tokens: readonly ShellToken[]): string => tokens.map((t) => t.text).join(' ');
