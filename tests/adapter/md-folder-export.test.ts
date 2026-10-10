/** @vitest-environment happy-dom */
/**
 * 🔴 **Markdown を PC のフォルダへ 1 度だけ書き出す**(#1455 (b))。
 *
 * 守るもの:
 * - 中身(パス・バイト列)が **zip の書き出しと同じ**(直列化の道が 1 本)
 * - 🔴 **選ばれたフォルダの中の新しいサブフォルダ**にだけ書く(もとの file を上書きしない / 同名は `-2`)
 * - 選択窓を閉じたら**何も言わない**
 * - 途中で失敗したら、**どの file か**と**既に書いた分が残る**ことを言う
 * - ブラウザに窓が無ければ**ボタンごと出さない**
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  exportMarkdownToFolder,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import {
  windowFolderWritePicker,
  SUBFOLDER_TRY_MAX,
  type FolderWritePicker,
  type WritableDirLike,
} from '../../src/adapter/platform/md-folder-export';
import { writeMarkdownZip } from '../../src/features/export/pkc3-markdown-zip';
import { readZipDirectory, readZipEntry } from '../../src/features/import/zip-reader';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { initialState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const named = (name: string, msg = name): Error => Object.assign(new Error(msg), { name });

/** 木で持つ偽のディレクトリ。本物と同じく、無ければ `NotFoundError`、種類違いは `TypeMismatchError`。 */
class FakeDir implements WritableDirLike {
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, Uint8Array>();
  constructor(
    readonly name: string,
    private readonly failFile: string | null = null,
  ) {}
  async getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDir> {
    if (this.files.has(name)) throw named('TypeMismatchError');
    const d = this.dirs.get(name);
    if (d) return d;
    if (!o.create) throw named('NotFoundError');
    const made = new FakeDir(name, this.failFile);
    this.dirs.set(name, made);
    return made;
  }
  async getFileHandle(name: string, o: { create?: boolean } = {}) {
    if (this.dirs.has(name)) throw named('TypeMismatchError');
    if (!this.files.has(name) && !o.create) throw named('NotFoundError');
    const files = this.files;
    const failFile = this.failFile;
    return {
      async createWritable() {
        if (failFile === name) throw named('QuotaExceededError', 'ディスクがいっぱいです');
        const chunks: Uint8Array[] = [];
        return {
          async write(data: Blob | string) {
            chunks.push(
              typeof data === 'string'
                ? new TextEncoder().encode(data)
                : new Uint8Array(await data.arrayBuffer()),
            );
          },
          async close() {
            const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const c of chunks) {
              all.set(c, at);
              at += c.length;
            }
            files.set(name, all);
          },
        };
      },
    };
  }
  /** 全 file を `a/b.md` の path で。 */
  flat(prefix = ''): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const [n, b] of this.files) out.set(prefix + n, b);
    for (const [n, d] of this.dirs) for (const [p, b] of d.flat(`${prefix}${n}/`)) out.set(p, b);
    return out;
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250, 251]);

function source(): ArchiveSource {
  const entries = [
    {
      lid: 'a',
      title: '会議メモ',
      body: '---\ntags: [仕事]\n---\n# 見出し\n![図](asset:ast-1)\n',
    },
    { lid: 'b', title: '買い物/リスト', body: '牛乳\n' },
  ].map((e, i) => ({
    ...e,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
  }));
  return {
    cid: 'c1',
    title: '私の PKC',
    listEntryMetas: async () => entries.map(({ body, ...m }) => (void body, m)),
    listBodies: async () => ({
      rows: entries.map((e) => ({ lid: e.lid, body: e.body })),
      done: true,
      next: { entryOrder: 2, lid: 'b' },
    }),
    listRelations: async () => [],
    listAssetMetas: async () => [{ key: 'ast-1', mime: 'image/png', size: PNG.length, hash: null }],
    getAssetBlob: async (key) => (key === 'ast-1' ? new Blob([PNG as unknown as BlobPart]) : null),
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

function setup(over: Partial<ExportDeps> = {}) {
  const notices: string[] = [];
  const reported: string[][] = [];
  const dispatcher = new Dispatcher();
  dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const failed: string[] = [];
  const orig = dispatcher.dispatch.bind(dispatcher);
  vi.spyOn(dispatcher, 'dispatch').mockImplementation((a) => {
    if (a.type === 'OP_FAILED') failed.push(a.error);
    return orig(a);
  });
  const deps: ExportDeps = {
    source: source(),
    download: () => {
      throw new Error('フォルダへ書く道でダウンロードは呼ばない');
    },
    report: (n) => reported.push([...n]),
    settle: async () => {},
    renderFigure: async () => null,
    renderFigureVector: async () => null,
    askSql: async () => {
      throw new Error('引かない');
    },
    notify: (m) => notices.push(m),
    now: () => new Date('2026-10-10T03:00:00.000Z'),
    ...over,
  };
  return { dispatcher, deps, notices, reported, failed };
}

const pickerOf = (root: FakeDir): FolderWritePicker => async () => root;

describe('Markdown を PC のフォルダへ(#1455 (b))', () => {
  it('🔴 パスもバイト列も zip の書き出しと同じ(題名は日本語・frontmatter・添付つき)', async () => {
    const { dispatcher, deps } = setup();
    const root = new FakeDir('選んだ場所');
    await exportMarkdownToFolder(dispatcher, deps, pickerOf(root));

    const zip = await writeMarkdownZip(source(), '2026-10-10T03:00:00.000Z');
    const dir = await readZipDirectory(zip.blob);
    const expected = new Map<string, Uint8Array>();
    for (const e of dir) {
      if (e.name.endsWith('/')) continue;
      expected.set(e.name, new Uint8Array(await (await readZipEntry(zip.blob, e)).arrayBuffer()));
    }
    // 前提: 比べる物が空でない(日本語名の .md・assets・manifest が在る)
    expect([...expected.keys()].sort()).toEqual(
      ['assets/ast-1.png', 'manifest.json', '会議メモ.md', '買い物-リスト.md'].sort(),
    );

    const sub = [...root.dirs.values()];
    expect(sub).toHaveLength(1);
    const got = sub[0]!.flat();
    expect([...got.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [p, bytes] of expected) {
      expect(Array.from(got.get(p)!), p).toEqual(Array.from(bytes));
    }
    // 添付の中身が実バイトで届いている(落ちていない)
    expect(Array.from(got.get('assets/ast-1.png')!)).toEqual(Array.from(PNG));
  });

  it('🔴 選んだフォルダの中に新しいサブフォルダを作り、もとの file は触らない / 同名は -2, -3', async () => {
    const { dispatcher, deps, notices } = setup();
    const root = new FakeDir('選んだ場所');
    const mine = new TextEncoder().encode('大事な file');
    root.files.set('メモ.md', mine);
    // 既に同名のサブフォルダ(中に user の file)と、同名の「file」
    const base = '私の-PKC-20261010';
    const old = await root.getDirectoryHandle(base, { create: true });
    old.files.set('user.md', mine);
    root.files.set(`${base}-2`, mine);

    await exportMarkdownToFolder(dispatcher, deps, pickerOf(root));

    expect([...root.dirs.keys()].sort()).toEqual([base, `${base}-3`].sort());
    expect([...old.files.keys()], '既存のサブフォルダに書いていない').toEqual(['user.md']);
    expect(root.files.get('メモ.md')).toBe(mine);
    expect(root.files.get(`${base}-2`)).toBe(mine);
    expect(root.dirs.get(`${base}-3`)!.flat().size).toBe(4);
    expect(notices.at(-1)).toBe(`2 件のノートを『${base}-3』に書き出しました(添付 1)`);
  });

  it('🔴 窓を閉じたら何も言わない(進行中の字も出さない / 失敗にもしない)', async () => {
    const { dispatcher, deps, notices, failed } = setup();
    const n = await exportMarkdownToFolder(dispatcher, deps, async () => {
      throw named('AbortError');
    });
    expect(n).toBeNull();
    expect(notices).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('🔴 どの名前も「在る」と答える相手でも、終わって理由を言う(無限に回らない)', async () => {
    const { dispatcher, deps, failed, notices } = setup();
    const root = new FakeDir('選んだ場所');
    let tries = 0;
    root.getDirectoryHandle = async () => {
      tries++;
      return new FakeDir('x');
    };
    const n = await exportMarkdownToFolder(dispatcher, deps, pickerOf(root));
    expect(n).toBeNull();
    expect(tries).toBe(SUBFOLDER_TRY_MAX);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('同じ名前のフォルダが多すぎます');
    expect(notices.at(-1)).toBe('');
  });

  it('窓が開けなかった(取り消し以外)は失敗として言う', async () => {
    const { dispatcher, deps, failed } = setup();
    await exportMarkdownToFolder(dispatcher, deps, async () => {
      throw named('SecurityError', 'blocked');
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('blocked');
  });

  it('🔴 途中で失敗したら、どの file か・書いた分が残ることを言う', async () => {
    const { dispatcher, deps, notices, failed } = setup();
    const root = new FakeDir('選んだ場所', '買い物-リスト.md');
    const n = await exportMarkdownToFolder(dispatcher, deps, pickerOf(root));
    expect(n).toBeNull();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('買い物-リスト.md');
    expect(failed[0]).toContain('ディスクがいっぱいです');
    expect(failed[0]).toContain('私の-PKC-20261010');
    expect(failed[0]).toContain('残っています');
    // 先に書いた分は消していない
    expect([...root.dirs.get('私の-PKC-20261010')!.flat().keys()]).toContain('会議メモ.md');
    // 「書き出しています…」が残らない
    expect(notices.at(-1)).toBe('');
  });

  it('編集中などで ready でないときは窓を開かず断る', async () => {
    const { deps, failed } = setup();
    const d = new Dispatcher(); // まだ起動していない
    const picker = vi.fn(pickerOf(new FakeDir('x')));
    await exportMarkdownToFolder(d, deps, picker);
    expect(picker).not.toHaveBeenCalled();
    void failed;
  });
});

describe('ブラウザに窓が無いとき(Firefox / Safari)', () => {
  it('windowFolderWritePicker は無ければ null、在れば readwrite で呼ぶ', async () => {
    expect(windowFolderWritePicker({})).toBeNull();
    const fn = vi.fn(async () => new FakeDir('x'));
    const p = windowFolderWritePicker({ showDirectoryPicker: fn });
    await p!({ mode: 'readwrite' });
    expect(fn).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  function paneActions(): string[] {
    const root = document.createElement('div');
    document.body.append(root);
    new InspectorRenderer(buildShell(root).inspector).render(initialState);
    const out = [...root.querySelectorAll('[data-pkc-field="collection-pane"] button[data-pkc-action]')]
      .map((b) => b.getAttribute('data-pkc-action')!);
    root.remove();
    return out;
  }

  it('🔴 無いときはボタンごと出さない / 在るときは出る', () => {
    const w = window as unknown as { showDirectoryPicker?: unknown };
    expect(paneActions()).not.toContain('export-markdown-folder');
    w.showDirectoryPicker = () => {};
    try {
      const actions = paneActions();
      expect(actions).toContain('export-markdown-folder');
      // zip の Markdown の隣
      expect(actions.indexOf('export-markdown-folder')).toBe(actions.indexOf('export-markdown') + 1);
    } finally {
      delete w.showDirectoryPicker;
    }
  });
});
