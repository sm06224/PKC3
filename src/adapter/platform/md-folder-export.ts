/**
 * 🔴 **Markdown を PC のフォルダへ 1 度だけ書き出す**(#1455 (b)。🟣 Gemini 経由の裁定 2026-10-10)。
 *
 * ## 守ること(裁定どおり)
 *
 * - **押すたびにフォルダを選ぶ**。⚠ handle を憶えない(state にも IndexedDB にも置かない ──
 *   `local-folder.ts`(#215)と同じ作法)。自動で同期もしない。
 * - 🔴 **user の file を上書きしない**。選ばれたフォルダの**中に新しいサブフォルダ**
 *   (`<題名>-<日付>`。在れば `-2`, `-3`…)を作り、書くのはその中だけ。
 * - 中身(パス・バイト列)は `pkc3-markdown-zip.ts` の `writeMarkdownTo` 1 本 ──
 *   ここは**書き出し先の口**(`MarkdownSink`)を作るだけで、直列化の規則を持たない。
 * - 1 file ずつ await で書く(メインを塞がない / 添付の Blob を 1 件ずつ流して heap に溜めない)。
 */
import type { MarkdownSink } from '@features/export/pkc3-markdown-zip';

/** `FileSystemWritableFileStream`(必要な部分だけ)。 */
export interface WritableLike {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}

/** 書き込める `FileSystemDirectoryHandle`(必要な部分だけ)。 */
export interface WritableDirLike {
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WritableDirLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

export type FolderWritePicker = (options: { mode: 'readwrite' }) => Promise<WritableDirLike>;

/** 窓の `showDirectoryPicker` を引く(無ければ `null` ── Firefox / Safari)。 */
export function windowFolderWritePicker(win: object = window): FolderWritePicker | null {
  const fn = (win as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  if (typeof fn !== 'function') return null;
  return (options) => (fn as (o: { mode: string }) => Promise<WritableDirLike>).call(win, options);
}

/** どの file で止まったかを持つ失敗。⚠ 既に書いた分は消さない(残る)。 */
export class FolderWriteError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'FolderWriteError';
  }
}

const errName = (e: unknown): string =>
  typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '';

/** user が選択窓を閉じたとき(エラーではない)。 */
export function isPickerCancel(e: unknown): boolean {
  return errName(e) === 'AbortError';
}

/**
 * `root` の中に**まだ無い名前**のサブフォルダを作って返す(`base`、`base-2`、`base-3`…)。
 * 🔴 同名の **file** が在っても「在る」と読む(`TypeMismatchError`)── 上書きしない。
 */
/** `-N` を試す上限。⚠ 無いと、常に「在る」と答える相手で終わらない。 */
export const SUBFOLDER_TRY_MAX = 1000;

export async function createFreshSubfolder(
  root: WritableDirLike,
  base: string,
): Promise<{ dir: WritableDirLike; name: string }> {
  for (let n = 1; n <= SUBFOLDER_TRY_MAX; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      await root.getDirectoryHandle(name);
      continue; // 在る
    } catch (e) {
      const k = errName(e);
      if (k === 'TypeMismatchError') continue; // 同名の file が在る
      if (k !== 'NotFoundError') throw e;
    }
    return { dir: await root.getDirectoryHandle(name, { create: true }), name };
  }
  throw new Error(
    `同じ名前のフォルダが多すぎます(『${base}』から『${base}-${SUBFOLDER_TRY_MAX}』まで使われています)。別のフォルダを選んでください`,
  );
}

/** `dir` の下へ `a/b.ext` の形の path で 1 file ずつ書く口。 */
export function folderSink(dir: WritableDirLike): MarkdownSink {
  const dirs = new Map<string, WritableDirLike>();
  return {
    async add(path, parts) {
      try {
        const segs = path.split('/');
        const file = segs.pop()!;
        let cur = dir;
        let key = '';
        for (const seg of segs) {
          key += `${seg}/`;
          let next = dirs.get(key);
          if (!next) {
            next = await cur.getDirectoryHandle(seg, { create: true });
            dirs.set(key, next);
          }
          cur = next;
        }
        const w = await (await cur.getFileHandle(file, { create: true })).createWritable();
        try {
          for (const p of parts) await w.write(p);
          await w.close();
        } catch (e) {
          await w.abort?.().catch(() => {});
          throw e;
        }
      } catch (e) {
        throw new FolderWriteError(path, e);
      }
    },
  };
}
