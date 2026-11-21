/**
 * test 用: メモリの中のフォルダ(`SyncDirLike`)。フォルダ同期(段 3)を、2 台が同じフォルダを指す形で通すために使う。
 * - `createWritable` は閉じるまで元のファイルを残し、閉じたときに入れ替える(実ブラウザの swap file と同じ)。`abort` は捨てる。
 * - 更新日時は共有の時計(`clock.t`)から付く。許可の状態(`perm`)と求めた回数を持つ。
 */
import type { SyncDirLike, SyncFileHandleLike } from '../../src/adapter/platform/folder-sync';

export interface MemClock {
  t: number;
}

interface FileRec {
  blob: Blob;
  lastModified: number;
}

class NotFound extends Error {
  override name = 'NotFoundError';
}

export class MemDir implements SyncDirLike {
  readonly files = new Map<string, FileRec>();
  readonly dirs = new Map<string, MemDir>();
  perm = 'granted';
  /** `requestPermission` が返す値。 */
  grantResult = 'granted';
  requested = 0;
  /** 書き込みの回数(名前ごと。無駄な書き換えが無いかを見る)。 */
  readonly writes = new Map<string, number>();

  constructor(
    readonly name: string,
    private readonly clock: MemClock,
    private readonly root: MemDir | null = null,
  ) {}

  async *values(): AsyncIterable<{ kind: string; name: string }> {
    for (const n of this.files.keys()) yield { kind: 'file', name: n };
    for (const n of this.dirs.keys()) yield { kind: 'directory', name: n };
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<SyncFileHandleLike> {
    if (!this.files.has(name)) {
      if (options?.create !== true) throw new NotFound(name);
      this.files.set(name, { blob: new Blob([]), lastModified: this.clock.t });
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 返す handle の中から、この MemDir の表を引く
    const dir = this;
    return {
      kind: 'file',
      name,
      async getFile() {
        const rec = dir.files.get(name);
        if (rec === undefined) throw new NotFound(name);
        return new File([rec.blob], name, { lastModified: rec.lastModified });
      },
      async createWritable() {
        const parts: Blob[] = [];
        return {
          async write(data: Blob | string) {
            parts.push(typeof data === 'string' ? new Blob([data]) : data);
          },
          async close() {
            dir.files.set(name, { blob: new Blob(parts), lastModified: dir.clock.t });
            const rootDir = dir.root ?? dir;
            rootDir.writes.set(`${dir.name}/${name}`, (rootDir.writes.get(`${dir.name}/${name}`) ?? 0) + 1);
          },
          async abort() {
            parts.length = 0;
          },
        };
      },
    };
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<SyncDirLike> {
    let d = this.dirs.get(name);
    if (d === undefined) {
      if (options?.create !== true) throw new NotFound(name);
      d = new MemDir(name, this.clock, this.root ?? this);
      this.dirs.set(name, d);
    }
    return d;
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
    this.dirs.delete(name);
  }

  async queryPermission(): Promise<string> {
    return this.perm;
  }

  async requestPermission(): Promise<string> {
    this.requested++;
    this.perm = this.grantResult;
    return this.perm;
  }

  /** 直接ファイルを置く(壊れたファイル・途中のファイルを作る用)。 */
  put(name: string, blob: Blob, lastModified = this.clock.t): void {
    this.files.set(name, { blob, lastModified });
  }
}
