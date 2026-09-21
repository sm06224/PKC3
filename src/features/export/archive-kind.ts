/**
 * 🔴 **file の型は「含まれる型の積」**(#1017 段④b。設計 doc
 * `docs/development/ui-total-design-2026-09.md` §5)。
 *
 * ## 二重拡張子で分ける(user 裁定 2026-09-20)
 *
 * `.pkc3.zip` は 1 つの名前で「全部」「1 件だけ」「読めた分だけ」の 3 通りを
 * 覆っていた ── user 裁定「バックアップは、中身が何のバックアップか(添付が
 * 入っているか)が分かる形にせよ」を受け、**末尾で中身を言う**。
 *
 * | 末尾 | 含む型 | 誰の操作か |
 * |---|---|---|
 * | `.pkc3-full.zip` | ノート × 添付 × つながり × 履歴(全部) | コレクション「バックアップ」 |
 * | `.pkc3-notes.zip` | ノート × 添付(1 件 / フォルダの中) | ノート・フォルダ「バックアップ(このノート / このフォルダ)」 |
 * | `.pkc3-part.zip` | ノート × 添付(保存領域に問題があるとき、読めた分だけ) | コレクション「バックアップ」/「Markdown」が自動で切り替える |
 *
 * ⚠ **中身の形式(manifest / container.json の shape)は 3 つとも同一**である
 * (`pkc3-archive.ts` の `writeArchive` / `readArchive` を素通しする)。分けるのは
 * **名前だけ** ── 読む側は `peekZipFormat` が manifest.format を見るので、
 * この file 名は判定に使わない(名前は表示用の補助でしかない)。
 *
 * ## 旧形式(`.pkc3.zip`)は読み続ける
 *
 * 中身が同一なので、旧ビルドが作った `.pkc3.zip` は**そのまま** `readArchive` /
 * `restoreArchive` を通る(#1017 以前の全アーカイブが対象)。⚠ 逆(新ビルドの
 * `-full.zip` を旧ビルドが読めるか)も**中身が 1 バイトも変わっていない**ので
 * 成立する ── `tests/features/archive-kind.test.ts` が manifest の等値で pin する。
 *
 * ⚠ **pure module**。browser API を持たない。
 */

/** file の型。⚠ `'part'` は自動復旧経路の内部専用(§4.3 の自動フォールバック)。 */
export type ArchiveKind = 'full' | 'notes' | 'part';

interface ArchiveKindSpec {
  /** file 名の末尾(拡張子込み)。 */
  readonly suffix: string;
  /** 「3 か所で言う」の 1 つ目(ボタンの下の 1 行 / 取込前の表)に使う短い説明。 */
  readonly contains: string;
}

const SPEC: Readonly<Record<ArchiveKind, ArchiveKindSpec>> = {
  full: { suffix: '.pkc3-full.zip', contains: 'ノート・添付・つながり・履歴 を全部' },
  notes: { suffix: '.pkc3-notes.zip', contains: '本文と添付' },
  part: {
    suffix: '.pkc3-part.zip',
    contains: '読めた分のノートと添付(つながり・履歴は入りません)',
  },
};

/** file 名の末尾(拡張子込み)。 */
export function archiveSuffix(kind: ArchiveKind): string {
  return SPEC[kind].suffix;
}

/** `<base>` に末尾を付けた file 名。⚠ `base` は既に `safeName()` 済みの前提。 */
export function archiveFileName(base: string, kind: ArchiveKind): string {
  return `${base}${SPEC[kind].suffix}`;
}

/** 「何が入っているか」の短い説明(§5 の「3 か所で言う」の材料)。 */
export function archiveKindContains(kind: ArchiveKind): string {
  return SPEC[kind].contains;
}

/** 🔴 旧形式(#1017 より前)。⚠ 中身の形式は `full` と同一 ── 取込は両方受ける。 */
export const LEGACY_ARCHIVE_SUFFIX = '.pkc3.zip';

/**
 * file 名の末尾で分かる 3 種 + 旧形式。⚠ **これは表示・案内用の一覧であって、
 * 取込の判定には使わない**(判定は `peekZipFormat` が manifest.format を読む)。
 */
export const ARCHIVE_SUFFIXES: readonly string[] = [
  SPEC.full.suffix,
  SPEC.notes.suffix,
  SPEC.part.suffix,
  LEGACY_ARCHIVE_SUFFIX,
];
