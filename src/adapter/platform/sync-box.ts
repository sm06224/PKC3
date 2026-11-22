/**
 * 🔴 **同期の保管先(RemoteBox)**(#2000 段 4a-1。user 裁定 2026-11-22)── 同期の回(`SyncFolder`)が保管先へ頼む操作を、
 * 保管先の種類に依らない 1 つの口にする。いまの実装はフォルダ(`folderBox`)だけ ── S3 互換(`S3Box`)は段 4a-3 で足す。
 *
 * ## 口(保管先がすること)
 * - `list` … 同期のファイルの一覧(名前・大きさ・版)
 * - `read` / `write` / `remove` … 1 ファイルを読む / 書く / 消す
 *
 * ## 版(`mtime` / `version`)
 * - 「前の回と同じファイルか」を見分ける印。フォルダは**大きさ + 更新日時**(段 3 のまま)、S3 は**ETag**(段 4a-3 で `version`)。
 * - ⚠ 大小は比べない(端末の時計に依らない)── 比べるのは「前の回と同じか」だけ(`planFolderRound`)。
 *
 * ## ⚠ この段では挙動を変えない
 * 段 3 の `SyncFolder.round` が `dir` を直に触っていた読み書きを、この口へ寄せただけである(同じ順・同じ呼び方)。
 * handle の保存・許可・読み込みの見張り(`SYNC_FOLDER_LOADING_MARK`)は `SyncFolder` に残す(保管先の種類で変わらない所は動かさない)。
 */
import type { SyncDirLike } from './folder-sync';

/** 保管先にある 1 ファイル。 */
export interface BoxEntry {
  readonly name: string;
  readonly size: number;
  /** 更新日時(ms)。フォルダの版。S3 は一覧の `LastModified`(比べるのは `version` が在ればそちら)。 */
  readonly mtime: number;
  /** 保管先が持つ版の印(S3 の ETag)。フォルダには無い(大きさ + 更新日時で見分ける)。 */
  readonly version?: string;
}

/** 同期の保管先。 */
export interface RemoteBox {
  /** 画面に出す名前(フォルダ名 / バケット名)。 */
  readonly label: string;
  /** 一覧。`accept` が真の名前だけ(同期のファイルだけを見る ── 他のファイルには触らない)。 */
  list(accept: (name: string) => boolean): Promise<BoxEntry[]>;
  read(name: string): Promise<Blob>;
  /**
   * 書く。書いた後の控えを返す。
   * @param expect 前の回に自分が書いた控え(条件付き書き込みに使う ── S3 は `If-Match`。フォルダは使わない)。
   *   相手が変えていたら(412)**上書きせずに throw** するのは段 4a-3 の `S3Box` の約束。
   */
  write(name: string, blob: Blob, expect?: BoxEntry | null): Promise<BoxEntry>;
  remove(name: string): Promise<void>;
}

/**
 * 🔴 **フォルダの保管先**(段 3 の読み書きそのまま)。
 * ⚠ 書くのは `createWritable` → `write` → `close`、失敗したら `abort`(書きかけを残さない)。書いた後は `getFile` で大きさ・更新日時を
 *   取り直す(次の回で「自分が書いた物か」を見分ける控え ── 段 3 の `own`)。
 */
export function folderBox(dir: SyncDirLike): RemoteBox {
  return {
    label: dir.name,
    async list(accept) {
      const out: BoxEntry[] = [];
      for await (const e of dir.values()) {
        if (e.kind !== 'file' || !accept(e.name)) continue;
        const f = await (await dir.getFileHandle(e.name)).getFile();
        out.push({ name: e.name, size: f.size, mtime: f.lastModified });
      }
      return out;
    },
    async read(name) {
      return (await dir.getFileHandle(name)).getFile();
    },
    async write(name, blob) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(blob);
        await w.close();
      } catch (e) {
        await w.abort?.().catch(() => undefined);
        throw e;
      }
      const after = await fh.getFile();
      return { name, size: after.size, mtime: after.lastModified };
    },
    async remove(name) {
      await dir.removeEntry(name);
    },
  };
}
