/** @vitest-environment happy-dom */
/**
 * 🔴 **同期の保管先の口(RemoteBox)── フォルダの実装**(#2000 段 4a-1。挙動は段 3 のまま)。
 *
 * 守る主張:
 * 1. 一覧は同期のファイルだけ(`accept` が真の名前・ファイルだけ。フォルダや他のファイルには触らない)── 大きさ・更新日時つき
 * 2. 書いた後の控えは、書いた後のファイルから取り直した大きさ・更新日時(次の回で「自分が書いた物か」を見分ける)
 * 3. 書きかけで失敗したら `abort` して投げ直す(書きかけを残さない・黙って成功にしない)
 * 4. 読む / 消すは、その名前のファイルだけ
 */
import { describe, expect, it } from 'vitest';
import { folderBox } from '../../src/adapter/platform/sync-box';
import type { SyncDirLike } from '../../src/adapter/platform/folder-sync';

function fakeDir(opts: { failWrite?: boolean } = {}) {
  const files = new Map<string, { blob: Blob; mtime: number }>();
  // ⚠ 名前は同期のファイルの形(accept が通す)── フォルダであることだけで弾かれることを見る
  const dirs = ['pkc3-dir.pkc3-diff.zip'];
  let clock = 100;
  const aborted: string[] = [];
  const removed: string[] = [];
  const dir: SyncDirLike = {
    name: '同期フォルダ',
    async *values() {
      for (const d of dirs) yield { kind: 'directory', name: d };
      for (const name of files.keys()) yield { kind: 'file', name };
    },
    async getFileHandle(name, o) {
      if (!files.has(name) && o?.create !== true) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
      return {
        kind: 'file' as const,
        name,
        async getFile() {
          const f = files.get(name);
          return new File([f?.blob ?? new Blob([])], name, { lastModified: f?.mtime ?? 0 });
        },
        async createWritable() {
          const parts: Blob[] = [];
          return {
            write: async (d: Blob | string) => {
              if (opts.failWrite === true) throw new Error('書けない');
              parts.push(typeof d === 'string' ? new Blob([d]) : d);
            },
            // ⚠ 書いた後のファイルは、書いた blob より 1 バイト長い(保管先が付け足す想定)── 控えが「書いた後を取り直した値」か
            //   「書いた blob の大きさ」かを見分ける
            close: async () => void files.set(name, { blob: new Blob([...parts, '!']), mtime: ++clock }),
            abort: async () => void aborted.push(name),
          };
        },
      };
    },
    async getDirectoryHandle(): Promise<never> {
      throw new Error('使わない');
    },
    async removeEntry(name) {
      removed.push(name);
      files.delete(name);
    },
  };
  return { dir, files, aborted, removed };
}

describe('folderBox', () => {
  it('🔴 一覧は accept が真のファイルだけ(フォルダ・他のファイルは見ない)。大きさ・更新日時つき', async () => {
    const f = fakeDir();
    f.files.set('pkc3-a.pkc3-diff.zip', { blob: new Blob(['abc']), mtime: 7 });
    f.files.set('メモ.txt', { blob: new Blob(['x']), mtime: 8 });
    const box = folderBox(f.dir);
    expect(box.label).toBe('同期フォルダ');
    const list = await box.list((n) => n.endsWith('.pkc3-diff.zip'));
    expect(list).toEqual([{ name: 'pkc3-a.pkc3-diff.zip', size: 3, mtime: 7 }]);
  });

  it('🔴 書いた後の控えは、書いた後のファイルの大きさ・更新日時 / 読むとその中身', async () => {
    const f = fakeDir();
    const box = folderBox(f.dir);
    const after = await box.write('pkc3-me.pkc3-diff.zip', new Blob(['hello']));
    expect(after, '控えが書いた後のファイルから取り直されていない').toEqual({ name: 'pkc3-me.pkc3-diff.zip', size: 6, mtime: 101 });
    await box.write('pkc3-other.pkc3-diff.zip', new Blob(['other']));
    // 2 つ在るときも、名前で選んだ方を読む
    expect(await (await box.read('pkc3-me.pkc3-diff.zip')).text()).toBe('hello!');
    expect(await (await box.read('pkc3-other.pkc3-diff.zip')).text()).toBe('other!');
  });

  it('🔴 書きかけで失敗したら abort して投げ直す(黙って成功にしない)', async () => {
    const f = fakeDir({ failWrite: true });
    const box = folderBox(f.dir);
    await expect(box.write('pkc3-me.pkc3-diff.zip', new Blob(['x']))).rejects.toThrow('書けない');
    expect(f.aborted).toEqual(['pkc3-me.pkc3-diff.zip']);
    expect(f.files.has('pkc3-me.pkc3-diff.zip'), '書きかけが残った').toBe(false);
  });

  it('消すのはその名前だけ', async () => {
    const f = fakeDir();
    f.files.set('a', { blob: new Blob(['1']), mtime: 1 });
    f.files.set('b', { blob: new Blob(['2']), mtime: 2 });
    await folderBox(f.dir).remove('a');
    expect([...f.files.keys()]).toEqual(['b']);
    expect(f.removed).toEqual(['a']);
  });
});
