/**
 * 🔴 **ノートの色ラベル**(#1982 段 4)。user が 1 冊ずつ、8 色(`--note-1`〜`--note-8`)のどれかを付けられる。
 *
 * - 置き場所 = コレクション(器)の `settings` 表(ピン留め `note-pins.ts` と同じ。本文・更新日時・履歴に触れない。
 *   frontmatter に書かない ── 書くと履歴が 1 件増える)。バックアップ(`container.json` の `noteLabels`)に入る。
 * - 色の値は `tokens.css` の `--note-N`(配色ごとに地に対して 3:1 以上)。ここは**番号と名前**だけを持つ。
 * - 🔴 **付けられるなら外せる**: `setLabel(…, null)` で外す(行の右クリック・「その他」の両方に同じ 2 方向を置く)。
 * - 一覧の絞り込みは `filterByLabel` の 1 か所(画面側に判定を持たない)。
 *
 * 🔑 **pure module**。browser API も dispatch も触らない。
 */

export const NOTE_LABEL_COUNT = 8;

/** 持てる行の総数の上限(手違い・壊れた取り込みの検出)。 */
export const MAX_NOTE_LABELS = 20000;

/** 色の名前(画面の字)。順は `--note-1`〜`--note-8`。 */
export const NOTE_LABEL_NAMES: readonly string[] = ['オレンジ', '黄', '緑', '青緑', '青', '紫', 'ピンク', 'グレー'];

export function isNoteLabelColor(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= NOTE_LABEL_COUNT;
}

export function noteLabelName(color: number): string {
  return NOTE_LABEL_NAMES[color - 1] ?? '';
}

/** 色を表す CSS(`var(--note-N)`)。⚠ 値は tokens.css が正本。 */
export function noteLabelVar(color: number): string {
  return `var(--note-${color})`;
}

export interface NoteLabelEntry {
  readonly lid: string;
  readonly color: number;
}

/** 保存の形を読む。⚠ どんな壊れ方でも空へ落ち、読めない行・重複 lid は捨てる。 */
export function normalizeNoteLabels(v: unknown): NoteLabelEntry[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: NoteLabelEntry[] = [];
  for (const x of v) {
    if (typeof x !== 'object' || x === null) continue;
    const { lid, color } = x as { lid?: unknown; color?: unknown };
    if (typeof lid !== 'string' || lid === '' || !isNoteLabelColor(color) || seen.has(lid)) continue;
    seen.add(lid);
    out.push({ lid, color });
    if (out.length >= MAX_NOTE_LABELS) break;
  }
  return out;
}

/** 付ける / 外す(`color === null`)。同じ色をもう一度選んでも外れない(外すは別の操作)。 */
export function setLabel(map: ReadonlyMap<string, number>, lid: string, color: number | null): Map<string, number> {
  const next = new Map(map);
  if (color === null) next.delete(lid);
  else if (isNoteLabelColor(color)) next.set(lid, color);
  return next;
}

/**
 * 色で絞る(一覧の絞り込みの 1 か所)。`color === null` = 絞らない(全部)。
 * @returns 残す lid の並び(元の順を保つ)
 */
export function filterByLabel<T extends { readonly lid: string }>(
  items: readonly T[],
  labels: ReadonlyMap<string, number>,
  color: number | null,
): T[] {
  if (color === null) return [...items];
  return items.filter((i) => labels.get(i.lid) === color);
}

/** 書き出すノートに在る分だけ(lid の集合で絞る)。 */
export function labelsFor(entries: readonly NoteLabelEntry[], lids: ReadonlySet<string>): NoteLabelEntry[] {
  return entries.filter((e) => lids.has(e.lid));
}
