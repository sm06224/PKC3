/** @vitest-environment happy-dom */
/**
 * 🔴 **PC タブ: サブフォルダへ入る・パンくずで戻る(#215)/ Office のファイルを選んで開く(#432)**。
 *
 * ⚠ fake は本物の意味論を真似る: サブフォルダは一覧の行であり `values()` を持つ handle そのもの、
 *   `getDirectoryHandle` は無ければ `NotFoundError` を投げる、`getFile` は数える(一覧では 0 回, #1271)。
 */
import { describe, expect, it } from 'vitest';
import {
  LocalFolder,
  windowFilePicker,
  type DirectoryHandleLike,
  type FolderEntryHandle,
  type LocalFileItem,
} from '@adapter/platform/local-folder';

interface FakeFile extends FolderEntryHandle {
  gets: number;
}

function fileHandle(name: string): FakeFile {
  const h: FakeFile = {
    kind: 'file',
    name,
    gets: 0,
    getFile: async () => {
      h.gets += 1;
      return new File(['x'], name, { lastModified: 1 });
    },
    isSameEntry: async (o) => o === h,
  };
  return h;
}

type Dir = DirectoryHandleLike & FolderEntryHandle;

function dirOf(
  name: string,
  entries: FolderEntryHandle[],
  children: Record<string, DirectoryHandleLike> = {},
  perm: { state: string } = { state: 'granted' },
): Dir {
  return {
    kind: 'directory',
    name,
    values: async function* () {
      for (const e of entries) yield e;
    },
    queryPermission: async () => perm.state,
    getDirectoryHandle: async (n: string) => {
      const c = children[n];
      if (c === undefined) throw new DOMException('not found', 'NotFoundError');
      return c;
    },
  };
}

function tree() {
  const deepFile = fileHandle('底.md');
  const deep = dirOf('奥', [deepFile]);
  const midFile = fileHandle('中.md');
  const mid = dirOf('下', [deep, midFile], { 奥: deep });
  const rootFile = fileHandle('根.md');
  const root = dirOf('資料', [mid, rootFile], { 下: mid });
  return { root, mid, deep, deepFile, midFile, rootFile };
}

interface Place {
  root: string;
  path: readonly string[];
}
function memory() {
  let v: Place | null = null;
  return { get: () => v, set: (p: Place) => void (v = p) };
}

function make(root: DirectoryHandleLike, place?: ReturnType<typeof memory>) {
  const opened: LocalFileItem[] = [];
  const folder = new LocalFolder({
    picker: async () => root,
    open: async (i) => void opened.push(i),
    fail: () => {},
    onChange: () => {},
    ...(place === undefined ? {} : { place }),
  });
  return { folder, opened };
}

const names = (f: LocalFolder): string[] => f.view().rows.map((r) => r.name);

describe('🔴 サブフォルダへ入る・パンくずで戻る(#215)', () => {
  it('入ると中の一覧に替わり、パンくずが増える。戻ると上の階層(根まで)。getFile は 0 回', async () => {
    const t = tree();
    const { folder } = make(t.root);
    await folder.pick();
    expect(folder.view().crumbs).toEqual([{ name: '資料', level: 0 }]);
    expect(names(folder)).toEqual(['下', '根.md']);
    await folder.enter(0);
    expect(names(folder)).toEqual(['奥', '中.md']);
    await folder.enter(0);
    expect(names(folder)).toEqual(['底.md']);
    expect(folder.view().crumbs.map((c) => c.name)).toEqual(['資料', '下', '奥']);
    expect(folder.view().folderName).toBe('奥');
    await folder.goTo(1);
    expect(names(folder)).toEqual(['奥', '中.md']);
    expect(folder.view().crumbs.map((c) => c.name)).toEqual(['資料', '下']);
    await folder.goTo(0);
    expect(names(folder)).toEqual(['下', '根.md']);
    expect(t.midFile.gets + t.deepFile.gets + t.rootFile.gets, '階層の移動で getFile を呼んだ(#1271)').toBe(0);
  });

  it('ファイルの行・範囲外・いまの階層への enter / goTo は何も変えない', async () => {
    const t = tree();
    const { folder } = make(t.root);
    await folder.pick();
    const v = folder.view().version;
    await folder.enter(1);
    await folder.enter(99);
    await folder.goTo(0);
    await folder.goTo(5);
    await folder.goTo(-1);
    expect(folder.view().version).toBe(v);
    expect(names(folder)).toEqual(['下', '根.md']);
  });

  it('入った先のファイルを押すと、取り込みの口へそのファイルの handle で渡る', async () => {
    const t = tree();
    const { folder, opened } = make(t.root);
    await folder.pick();
    await folder.enter(0);
    await folder.open(1);
    expect(opened.map((o) => o.file.name)).toEqual(['中.md']);
    expect(opened[0]!.handle).toBe(t.midFile);
  });

  it('権限が切れていたら入らずに「切れた」と言う', async () => {
    const perm = { state: 'granted' };
    const child = dirOf('下', []);
    const { folder } = make(dirOf('資料', [child], {}, perm));
    await folder.pick();
    perm.state = 'prompt';
    await folder.enter(0);
    expect(folder.view().phase).toBe('lost');
    expect(folder.view().crumbs).toEqual([]);
  });

  it('更新は今の階層を読み直す(根へ戻らない)/ 切ると階層も捨てる', async () => {
    const t = tree();
    const { folder } = make(t.root);
    await folder.pick();
    await folder.enter(0);
    await folder.refresh();
    expect(names(folder)).toEqual(['奥', '中.md']);
    expect(folder.view().crumbs).toHaveLength(2);
    folder.cut();
    expect(folder.view().crumbs).toEqual([]);
    expect(folder.heldHandle()).toBeNull();
  });

  describe('開いている階層の記憶', () => {
    it('入る・戻るたびに名前の並びを憶え、同じ名前のフォルダを選び直すと憶えた階層から始まる', async () => {
      const t = tree();
      const place = memory();
      const a = make(t.root, place).folder;
      await a.pick();
      expect(place.get()).toEqual({ root: '資料', path: [] });
      await a.enter(0);
      await a.enter(0);
      expect(place.get()).toEqual({ root: '資料', path: ['下', '奥'] });
      await a.goTo(1);
      expect(place.get()).toEqual({ root: '資料', path: ['下'] });
      // 読み込み直し相当 ── 新しい LocalFolder(handle は持ち越さない)で選び直す
      const b = make(t.root, place).folder;
      await b.pick();
      expect(b.view().crumbs.map((c) => c.name), '憶えた階層へ戻らない').toEqual(['資料', '下']);
      expect(names(b)).toEqual(['奥', '中.md']);
    });

    it('別の名前のフォルダを選んだら憶えは使わず根から始まる(対照群)', async () => {
      const t = tree();
      const place = memory();
      place.set({ root: '別', path: ['下'] });
      const f = make(t.root, place).folder;
      await f.pick();
      expect(f.view().crumbs).toHaveLength(1);
      expect(place.get()).toEqual({ root: '資料', path: [] });
    });

    it('辿れない名前(消えた)は、辿れた所までで止める。落ちない', async () => {
      const t = tree();
      const place = memory();
      place.set({ root: '資料', path: ['下', '消えた'] });
      const f = make(t.root, place).folder;
      await f.pick();
      expect(f.view().crumbs.map((c) => c.name)).toEqual(['資料', '下']);
      expect(f.view().phase).toBe('listed');
    });
  });
});

describe('🔴 Office のファイルを選んで開く(#432)', () => {
  const folderWith = (filePicker: Parameters<typeof mk>[0]) => mk(filePicker);
  function mk(filePicker: (() => Promise<{ file: File; handle: FolderEntryHandle } | null>) | null) {
    const opened: LocalFileItem[] = [];
    const failed: string[] = [];
    const folder = new LocalFolder({
      picker: null,
      filePicker,
      open: async (i) => void opened.push(i),
      fail: (m) => void failed.push(m),
      onChange: () => {},
    });
    return { folder, opened, failed };
  }

  it('選ぶと、行を押したときと同じ口(open)へ file と handle が渡る', async () => {
    const h = fileHandle('報告.docx');
    const { folder, opened } = folderWith(async () => ({ file: new File(['x'], '報告.docx'), handle: h }));
    expect(folder.view().canPickFile).toBe(true);
    await folder.pickFile();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.handle).toBe(h);
    expect(opened[0]!.file.name).toBe('報告.docx');
  });

  it('選ばずに閉じたら何も起きない / 口が無ければ canPickFile は偽', async () => {
    const a = folderWith(async () => null);
    await a.folder.pickFile();
    expect(a.opened).toEqual([]);
    const b = folderWith(null);
    expect(b.folder.view().canPickFile).toBe(false);
    await b.folder.pickFile();
    expect(b.opened).toEqual([]);
    expect(b.failed).toEqual([]);
  });

  it('選ぶ口が投げたら、黙らず理由を言う', async () => {
    const { folder, opened, failed } = folderWith(async () => {
      throw new Error('boom');
    });
    await folder.pickFile();
    expect(opened).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('boom');
  });

  describe('windowFilePicker', () => {
    it('showOpenFilePicker があれば handle つきで返す(Office の拡張子と readwrite を渡す)', async () => {
      const h = fileHandle('a.xlsx');
      let opts: { types: { accept: Record<string, string[]> }[]; mode: string; multiple: boolean } | null = null;
      const win = {
        showOpenFilePicker: async (o: NonNullable<typeof opts>) => {
          opts = o;
          return [h];
        },
      };
      const r = await windowFilePicker(win)!();
      expect(r!.handle).toBe(h);
      expect(opts!.mode).toBe('readwrite');
      expect(opts!.multiple).toBe(false);
      const exts = Object.values(opts!.types[0]!.accept).flat();
      for (const e of ['.docx', '.xlsx', '.pptx']) expect(exts).toContain(e);
    });

    it('閉じた(AbortError)なら null。ほかの失敗は投げる', async () => {
      const abort = {
        showOpenFilePicker: async () => {
          throw new DOMException('x', 'AbortError');
        },
      };
      expect(await windowFilePicker(abort)!()).toBeNull();
      const bad = {
        showOpenFilePicker: async () => {
          throw new Error('boom');
        },
      };
      await expect(windowFilePicker(bad)!()).rejects.toThrow('boom');
    });

    it('showOpenFilePicker が無いブラウザは input[type=file] で選ぶ(handle は書けない形)', async () => {
      const f = new File(['x'], 'b.docx');
      const picker = windowFilePicker({ document })!;
      const orig = document.createElement.bind(document);
      let made: HTMLInputElement | null = null;
      document.createElement = ((tag: string) => {
        const el = orig(tag);
        if (tag === 'input') {
          made = el as HTMLInputElement;
          el.click = () => {
            Object.defineProperty(el, 'files', { value: [f] });
            el.dispatchEvent(new Event('change'));
          };
        }
        return el;
      }) as typeof document.createElement;
      try {
        const r = await picker();
        expect(made!.type).toBe('file');
        expect(made!.accept).toContain('.docx');
        expect(r!.file).toBe(f);
        expect(r!.handle.createWritable, '書ける形になっている').toBeUndefined();
        expect(await r!.handle.getFile!()).toBe(f);
      } finally {
        document.createElement = orig;
      }
    });

    it('どちらも無ければ null', () => {
      expect(windowFilePicker({})).toBeNull();
    });
  });
});

const idx = (f: LocalFolder, name: string): number => f.view().rows.find((r) => r.name === name)!.index;

describe('🔴 Office の行を押した瞬間に窓を確保する(#432。user gesture を切らない)', () => {
  /** 許可の確認・getFile・取り込みを、reserve と同じ 1 本の列に積む。 */
  function setup(opts: { reserve?: boolean } = {}) {
    const log: string[] = [];
    const items: LocalFileItem[] = [];
    const doc = fileHandle('報告.docx');
    const md = fileHandle('メモ.md');
    const origGet = doc.getFile!;
    doc.getFile = async () => {
      log.push('getFile');
      return origGet();
    };
    const root = dirOf('資料', [doc, md]);
    const origQuery = root.queryPermission!;
    root.queryPermission = async (d) => {
      log.push('queryPermission');
      return origQuery(d);
    };
    const folder = new LocalFolder({
      picker: async () => root,
      open: async (i) => {
        log.push('open');
        items.push(i);
      },
      fail: () => {},
      onChange: () => {},
      ...(opts.reserve === undefined
        ? {}
        : {
            reserve: (name: string) => {
              log.push(`reserve:${name}`);
              return opts.reserve!;
            },
          }),
    });
    return { folder, log, items };
  }

  it('reserve は open() を呼んだ同じ同期区間で、最初の await(許可確認・getFile)より前に呼ばれる', async () => {
    const { folder, log, items } = setup({ reserve: true });
    await folder.pick();
    log.length = 0;
    const p = folder.open(idx(folder, '報告.docx')); // ⚠ await しない ── 同期区間で何が起きたかを見る
    // ⚠ 許可の確認(queryPermission)の呼び出し自体も同期区間で始まる ── 窓の確保は**それより前**でなければならない
    expect(log[0], '呼び出しの同期区間の先頭で窓を確保していない').toBe('reserve:報告.docx');
    expect(log, 'getFile / 取り込みが同期区間で走った').not.toContain('getFile');
    await p;
    expect(log).toEqual(['reserve:報告.docx', 'queryPermission', 'getFile', 'open']);
    expect(items[0]!.reserved, '確保したことが受け手に伝わっていない').toBe(true);
  });

  it('確保できなかった(reserve が false)/ reserve が無い / Office でない行 では reserved を付けず、確保も呼ばない(対照群)', async () => {
    const a = setup({ reserve: false });
    await a.folder.pick();
    await a.folder.open(idx(a.folder, '報告.docx'));
    expect(a.items[0]!.reserved).toBeUndefined();
    const b = setup();
    await b.folder.pick();
    await b.folder.open(idx(b.folder, '報告.docx'));
    expect(b.items[0]!.reserved).toBeUndefined();
    const c = setup({ reserve: true });
    await c.folder.pick();
    c.log.length = 0;
    await c.folder.open(idx(c.folder, 'メモ.md'));
    expect(c.log.some((l) => l.startsWith('reserve')), 'Markdown の行で窓を確保した').toBe(false);
  });
});
