/**
 * 🔴 **書庫の中を見て、選んだ物だけ取り出す**(#818)── 純粋な層。
 *
 * > user の言葉 2026-09-09:「**アーカイブ形式ファイルを右クリックでファイル
 * > エクスプローラ開始して、階層の異なる複数のファイルを指定して展開できるように
 * > したい / 最低限 zip 対応したい**」
 *
 * ## 🔑 解凍は既に在る。ここが作るのは「見せ方」と「選び方」だけ
 *
 * `features/import/zip-reader.ts` が中央ディレクトリの走査(`readZipDirectory`)と
 * 1 件の取り出し(`readZipEntry`)を持っている。⚠ ただし呼んでいるのは**取り込みの
 * 経路だけ**で、user が自分の zip を覗く口は 1 つも無かった。
 *
 * ## ⚠ 階層は「作る」もの ── zip は持っているとは限らない
 *
 * 中央ディレクトリに**フォルダの行が無い** zip は普通に在る(作った道具による)。
 * だから**file の path から親を起こす** ── 起こさないと、
 * `写真/2026/海.jpg` が**根に 1 件**として並び、user の言う「階層」が消える。
 */
import type { ZipEntry } from '../import/zip-reader';

/** 一覧に出す 1 行。 */
export interface ArchiveRow {
  /** 書庫の中での場所(`写真/2026/海.jpg`)。⚠ **名指しの鍵**でもある。 */
  readonly path: string;
  /** その階層での名前(`海.jpg`)。 */
  readonly name: string;
  /** 根からの深さ(0 始まり)。字下げに使う。 */
  readonly depth: number;
  readonly isDirectory: boolean;
  /** 中身の大きさ(フォルダは 0)。 */
  readonly size: number;
}

/** `写真/2026/海.jpg` → `写真/2026`(根なら空)。 */
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** 末尾の名前(`海.jpg`)。 */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * 一覧の行を組む(**深さ優先・名前順**、フォルダが先)。
 *
 * ⚠ **フォルダを起こす** ── zip がフォルダの行を持っていなくても、
 *   file の path から親を全部作る(上の docstring)。
 * ⚠ **空の名前は捨てる**(`//` を含む壊れた path)── 押せない行を並べない。
 */
export function archiveRows(entries: readonly ZipEntry[]): ArchiveRow[] {
  const files = new Map<string, ZipEntry>();
  const dirs = new Set<string>();
  for (const e of entries) {
    const path = e.name.replace(/\/+$/, '');
    if (path === '' || path.split('/').some((s) => s === '')) continue;
    if (e.isDirectory) dirs.add(path);
    else files.set(path, e);
    for (let p = parentOf(path); p !== ''; p = parentOf(p)) dirs.add(p);
  }
  // ⚠ フォルダと同じ名前の file が在ったら、**フォルダを優先**(下に物が在るので)
  for (const d of dirs) files.delete(d);

  const childrenOf = (parent: string): ArchiveRow[] => {
    const rows: ArchiveRow[] = [];
    for (const d of dirs) {
      if (parentOf(d) === parent) {
        rows.push({
          path: d,
          name: baseName(d),
          depth: d.split('/').length - 1,
          isDirectory: true,
          size: 0,
        });
      }
    }
    for (const [path, e] of files) {
      if (parentOf(path) === parent) {
        rows.push({
          path,
          name: baseName(path),
          depth: path.split('/').length - 1,
          isDirectory: false,
          size: e.uncompressedSize,
        });
      }
    }
    // フォルダが先、その中は名前順
    rows.sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name, 'ja')
        : a.isDirectory
          ? -1
          : 1,
    );
    return rows;
  };

  const out: ArchiveRow[] = [];
  const walk = (parent: string): void => {
    for (const row of childrenOf(parent)) {
      out.push(row);
      if (row.isDirectory) walk(row.path);
    }
  };
  walk('');
  return out;
}

/** 印を付ける / 外す(`path` で名指す)。 */
export function toggleArchiveMark(marks: readonly string[], path: string): string[] {
  return marks.includes(path) ? marks.filter((m) => m !== path) : [...marks, path];
}

/**
 * 🔴 **印から、実際に取り出す file を起こす**。
 *
 * ⚠ **フォルダの印は、その下の file 全部**である(user の言葉「階層の異なる
 *   複数のファイルを指定して」)── 起こさないと、フォルダを選んでも何も出ない。
 * ⚠ **重複は 1 件にする**(フォルダとその中の file を両方選んだとき)。
 * 🔑 並びは**書庫の並び**(`entries` の順)── 印の順にしない。
 *   取り出しは「選んだ物を全部」であって、順番に意味は無い。
 */
export function markedFiles(
  entries: readonly ZipEntry[],
  marks: readonly string[],
): ZipEntry[] {
  const marked = new Set(marks);
  const under = (path: string): boolean => {
    for (const m of marked) {
      if (m === path) return true;
      if (path.startsWith(`${m}/`)) return true;
    }
    return false;
  };
  return entries.filter((e) => !e.isDirectory && under(e.name.replace(/\/+$/, '')));
}

/**
 * 🔴 **取り出した物の名前**(#818 の裁定 ②)。
 *
 * **普段は末尾の名前だけ**(`海.jpg`)。⚠ **同じ名前がぶつかったときだけ**
 * 場所を混ぜた名前にする(`写真-2026-海.jpg`)── 普段から長くすると、
 * 1 枚だけ取り出した user にも読みにくい名前が付く。
 *
 * ⚠ 名前に `/` を残さない(添付の名前は 1 段である)。
 * 🔑 返りは**入力と同じ並び・同じ件数** ── 呼び側が添字で対応づけられる。
 */
export function extractNames(paths: readonly string[]): string[] {
  const clean = paths.map((p) => p.replace(/\/+$/, ''));
  const count = new Map<string, number>();
  for (const p of clean) {
    const b = baseName(p);
    count.set(b, (count.get(b) ?? 0) + 1);
  }
  return clean.map((p) => {
    const b = baseName(p);
    return (count.get(b) ?? 0) > 1 ? p.split('/').join('-') : b;
  });
}
