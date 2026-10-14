/**
 * 🔴 **書換に「押した時点の行の中身」(`openLine`)を、いまの本文から自動で添える**(#1087)。
 *
 * ⚠ これは**行ずれの検査ではない** ── `task` / `line-date` / `repeat-*` / `csv-cell` / `task-run` の
 *   書換は、行番号に加えて**押した時点の行の中身**を持ち、disk 側の同じ行と byte 一致しなければ断る。
 *   「いまの本文の、その行」を添えれば**必ず一致する**ので、ここを通せば従来の主張(印の 1 文字だけ・
 *   日付の範囲だけ・当たらなければ `null` …)をそのまま検査できる。
 * ⚠ 行ずれの検査(1 行ずれていれば `null`)は、**ここを通さず**実物の `applyBodyRewrite` に
 *   `openLine` を自分で渡して書く(`body-rewrite.test.ts` の「押した時点の行の中身」)。
 * ⚠ `openLine` / `openLines` を**自分で渡した場合は上書きしない**(わざと違う字を渡す検査のため)。
 */
import {
  applyBodyRewrite as applyStrict,
  bodyLineAt,
  type BodyRewrite,
} from '../../src/features/markdown/body-rewrite';

type Loose<T> = T extends { openLine: string }
  ? Omit<T, 'openLine'> & { openLine?: string }
  : T extends { openLines: readonly string[] }
    ? Omit<T, 'openLines'> & { openLines?: readonly string[] }
    : T;

/** `openLine` / `openLines` を省いてよい書換(省いたらいまの本文から埋める)。 */
export type LooseRewrite = BodyRewrite extends infer U ? (U extends unknown ? Loose<U> : never) : never;

const NEEDS_OPEN_LINE = new Set(['task', 'line-date', 'repeat-done', 'repeat-move', 'csv-cell']);

/** いまの本文のその行で `openLine` / `openLines` を埋める(渡してあれば触らない)。 */
export function opened(body: string, rw: LooseRewrite): BodyRewrite {
  if (NEEDS_OPEN_LINE.has(rw.kind) && (rw as { openLine?: string }).openLine === undefined) {
    const line = (rw as { line: number }).line;
    return { ...rw, openLine: bodyLineAt(body, line) ?? '' } as BodyRewrite;
  }
  if (rw.kind === 'task-run' && rw.openLines === undefined) {
    return { ...rw, openLines: rw.lines.map((n) => bodyLineAt(body, n) ?? '') };
  }
  return rw as BodyRewrite;
}

/** `applyBodyRewrite` の、`openLine` を自動で添える版。 */
export function applyOpened(body: string, rw: LooseRewrite): string | null {
  return applyStrict(body, opened(body, rw));
}
