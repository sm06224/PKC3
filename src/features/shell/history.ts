/**
 * コマンドシェルの履歴(#274)。**pure module**。置き場(端末の localStorage)は
 * `adapter/ui/render/shell-history-store.ts`。
 *
 * ## 🔑 履歴の形
 *
 * - **新しいものが先頭**。同じ行を打ち直したら古いほうを消して先頭へ(2 行に並べない)。
 * - 空の行・`history` / `clear` のような**見るだけ・消すだけの行**は積まない(↑ で空振りを踏ませない)。
 * - `↑`(古いほうへ)`↓`(新しいほうへ)。🔑 **`↓` で打ちかけの字へ戻れる**(`at = -1` が打ちかけ)── 戻れないと
 *   ↑ を押した人が、打ちかけを黙って失う。
 * - `!!`(直前の行)`!3`(`history` の一覧の 3 番)で呼び戻す。⚠ 実行する前に展開した行を**結果の上に見せる**(呼び側)。
 */

export const SHELL_HISTORY_MAX = 200;

/** 履歴に積まない行(見るだけ・消すだけ)の先頭の語。 */
const NOT_KEPT: ReadonlySet<string> = new Set(['history', '履歴', 'clear', '消去', 'help', 'ヘルプ', '?']);

export function pushShellHistory(list: readonly string[], line: string, max = SHELL_HISTORY_MAX): string[] {
  const text = line.trim();
  if (text === '') return [...list];
  const head = text.split(/\s+/u)[0] ?? '';
  if (NOT_KEPT.has(head)) return [...list];
  return [text, ...list.filter((x) => x !== text)].slice(0, max);
}

export interface HistoryStep {
  /** 新しい位置(`-1` = 打ちかけ)。 */
  readonly at: number;
  /** 欄に入れる字。`null` = 打ちかけへ戻す(呼び側が控えを入れる)。 */
  readonly text: string | null;
}

/**
 * `↑`(`older`)`↓`(`newer`)。端では動かない。
 * @returns 動けなかったとき `null`
 */
export function stepShellHistory(list: readonly string[], at: number, dir: 'older' | 'newer'): HistoryStep | null {
  if (dir === 'older') {
    if (at + 1 >= list.length) return null;
    return { at: at + 1, text: list[at + 1]! };
  }
  if (at < 0) return null;
  if (at === 0) return { at: -1, text: null };
  return { at: at - 1, text: list[at - 1]! };
}

/**
 * `!!` と `!n` を展開する。`history` の一覧は**古いほうが 1 番**。
 * @returns 展開した行。`!` で始まらなければそのまま(`expanded: false`)。呼び出せないときは `error`。
 */
export function expandBang(
  line: string,
  list: readonly string[],
): { readonly line: string; readonly error: string | null; readonly expanded: boolean } {
  const t = line.trim();
  if (!t.startsWith('!')) return { line, error: null, expanded: false };
  if (t === '!!') {
    const prev = list[0];
    if (prev === undefined) return { line, error: '直前の行がありません', expanded: false };
    return { line: prev, error: null, expanded: true };
  }
  const m = /^!(\d+)$/u.exec(t);
  if (m !== null) {
    const n = Number(m[1]);
    const item = n >= 1 ? list[list.length - n] : undefined;
    if (item === undefined) return { line, error: `履歴に ${String(n)} 番はありません`, expanded: false };
    return { line: item, error: null, expanded: true };
  }
  return { line, error: '! の後ろは !! か番号(!3)で書いてください', expanded: false };
}
