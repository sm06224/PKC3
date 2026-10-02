/** @vitest-environment happy-dom */
/**
 * 🔴 **パソコンのフォルダを繋ぐ**(#215 段①②。🟣 Gemini 裁定 2026-10-01)。
 *
 * ⚠ 見るのは **user が何を見て、押すと何が起きるか** ──
 *   ①選ぶと直下が名前順に並び、200 件で切れる ②「切る」は列挙の途中でも効き、handle を手放す
 *   ③許可が `granted` 以外なら「切れた」と読む ④**消す・改名・移動の口は 1 つも無い**。
 *
 * ⚠ **fake は本物の意味論を真似る**: `values()` は非同期の列挙、`queryPermission` は
 *   `'granted' | 'prompt' | 'denied'`、`isSameEntry` は同じ file かどうか、`getFile` は読めなければ投げる。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LocalFolder,
  windowDirectoryPicker,
  type DirectoryHandleLike,
  type FolderEntryHandle,
} from '@adapter/platform/local-folder';
import { FOLDER_PAGE } from '@features/local-folder/folder-entries';
import { codeOnly } from '../helpers/code-only';

interface FakeFile extends FolderEntryHandle {
  gets: number;
}

function fileHandle(name: string, opts: { size?: number; fail?: boolean } = {}): FakeFile {
  const h: FakeFile = {
    kind: 'file',
    name,
    gets: 0,
    getFile: async () => {
      h.gets += 1;
      if (opts.fail) throw new DOMException('A requested file or directory could not be found', 'NotFoundError');
      return new File(['x'.repeat(opts.size ?? 3)], name, { lastModified: Date.UTC(2026, 8, 30, 12, 0) });
    },
    isSameEntry: async (other) => other === h,
  };
  return h;
}

const dirEntry = (name: string): FolderEntryHandle => ({ kind: 'directory', name });

function dirHandle(
  entries: FolderEntryHandle[],
  perm: { state: string } = { state: 'granted' },
  gate?: { wait: Promise<void>; after: number },
): DirectoryHandleLike & { asked: { mode: string }[] } {
  const asked: { mode: string }[] = [];
  return {
    name: '資料',
    asked,
    values: async function* () {
      let n = 0;
      for (const e of entries) {
        if (gate && n === gate.after) await gate.wait;
        yield e;
        n += 1;
      }
    },
    queryPermission: async (d) => {
      asked.push(d);
      return perm.state;
    },
  };
}

function make(dir: DirectoryHandleLike | (() => Promise<DirectoryHandleLike>)): {
  folder: LocalFolder;
  changes: () => number;
  picks: { mode: string }[];
} {
  const picks: { mode: string }[] = [];
  let changes = 0;
  const folder = new LocalFolder({
    picker: async (o) => {
      picks.push(o);
      return typeof dir === 'function' ? dir() : dir;
    },
    onChange: () => void (changes += 1),
  });
  return { folder, changes: () => changes, picks };
}

/** 非同期の連なり(列挙・大きさの読み込み)が落ち着くまで待つ。⚠ 数えた回数ではなく時間で待つ。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('繋いで一覧する(段①)', () => {
  it('🔴 選ぶと直下が並ぶ ── フォルダが先、あとは名前順(数は数として)', async () => {
    const dir = dirHandle([
      fileHandle('b.md'),
      fileHandle('10.md'),
      dirEntry('資料'),
      fileHandle('2.md'),
      fileHandle('A.md'),
    ]);
    const { folder, picks } = make(dir);
    await folder.pick();
    const v = folder.view();
    expect(v.phase).toBe('listed');
    expect(v.folderName).toBe('資料');
    expect(v.rows.map((r) => r.name)).toEqual(['資料', '2.md', '10.md', 'A.md', 'b.md']);
    expect(v.rows[0]!.kind, 'フォルダの行').toBe('directory');
    // ⚠ 読むだけの許可で選ばせる(書く許可は、書き戻すときに聞く)
    expect(picks).toEqual([{ mode: 'read' }]);
  });

  it('🔴 見える行の大きさと更新日を読む ── 読めない行は null(0 と読ませない)', async () => {
    const ok = fileHandle('a.md', { size: 7 });
    const bad = fileHandle('b.md', { fail: true });
    const { folder } = make(dirHandle([ok, bad]));
    await folder.pick();
    await flush();
    const rows = folder.view().rows;
    expect(rows[0]!.size).toBe(7);
    expect(rows[0]!.modified).toBe(Date.UTC(2026, 8, 30, 12, 0));
    expect(rows[1]!.size, '読めなかった行が 0 になっている').toBeNull();
  });

  it('🔴 200 件で切れて「さらに表示」── 大きさを読むのも見える分だけ', async () => {
    const files = Array.from({ length: 450 }, (_, i) => fileHandle(`f${String(i).padStart(3, '0')}.md`));
    const { folder } = make(dirHandle(files));
    await folder.pick();
    await flush();
    let v = folder.view();
    expect(v.total).toBe(450);
    expect(v.rows).toHaveLength(FOLDER_PAGE);
    expect(v.more).toBe(true);
    // ⚠ 1 万件のフォルダで 1 万回 getFile を撃たない ── 見える 200 件だけ
    expect(files.filter((f) => f.gets > 0)).toHaveLength(FOLDER_PAGE);
    await folder.more();
    await flush();
    v = folder.view();
    expect(v.rows).toHaveLength(400);
    expect(v.more).toBe(true);
    await folder.more();
    v = folder.view();
    expect(v.rows).toHaveLength(450);
    expect(v.more, '全部出したのに「さらに表示」が残っている').toBe(false);
    // 対照群 ── 200 件ちょうどなら切れない
    const exact = make(dirHandle(Array.from({ length: 200 }, (_, i) => fileHandle(`g${i}.md`))));
    await exact.folder.pick();
    expect(exact.folder.view().more, '200 件ちょうどで「さらに表示」が出ている').toBe(false);
  });

  it('🔴 「切る」で消える ── handle を手放す', async () => {
    const dir = dirHandle([fileHandle('a.md')]);
    const { folder } = make(dir);
    await folder.pick();
    expect(folder.heldHandle()).toBe(dir);
    folder.cut();
    const v = folder.view();
    expect(v.phase).toBe('none');
    expect(v.rows).toEqual([]);
    expect(v.folderName).toBeNull();
    expect(folder.heldHandle(), '「切る」で handle を握ったまま').toBeNull();
  });

  it('🔴 列挙の途中でも「切る」が効く ── 続きが戻ってきても蘇らない', async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const entries = Array.from({ length: 5 }, (_, i) => fileHandle(`f${i}.md`));
    const inner = dirHandle(entries, { state: 'granted' }, { wait, after: 2 });
    let pulled = 0;
    const counting: DirectoryHandleLike = {
      ...inner,
      values: async function* () {
        for await (const e of inner.values()) {
          pulled += 1;
          yield e;
        }
      },
    };
    const { folder } = make(counting);
    const picking = folder.pick();
    await flush();
    expect(folder.view().phase, '列挙の途中のはず').toBe('listing');
    expect(folder.view().counted).toBe(2);
    folder.cut();
    release();
    await picking;
    await flush();
    expect(folder.view().phase, '切ったのに一覧が出てきた').toBe('none');
    expect(folder.view().rows).toEqual([]);
    expect(folder.heldHandle()).toBeNull();
    // ⚠ 切った後は**列挙を続けない**(1 万件のフォルダを切っても、残りを最後まで読み続けない)
    expect(pulled, '切ったのに列挙を最後まで読んでいる').toBeLessThan(entries.length);
  });

  it('🔴 選ぶ画面を閉じた(AbortError)なら、繋いでいたフォルダはそのまま', async () => {
    let n = 0;
    const first = dirHandle([fileHandle('a.md')]);
    const { folder } = make(async () => {
      n += 1;
      if (n === 2) throw new DOMException('The user aborted a request.', 'AbortError');
      return first;
    });
    await folder.pick();
    await folder.pick();
    expect(folder.view().phase).toBe('listed');
    expect(folder.heldHandle()).toBe(first);
  });

  it('🔴 選べなかった(他の理由)なら、理由を持って failed になる', async () => {
    const { folder } = make(async () => {
      throw new Error('system files');
    });
    await folder.pick();
    const v = folder.view();
    expect(v.phase).toBe('failed');
    expect(v.message).toContain('system files');
  });

  it('🔴 API の無いブラウザ ── タブは出たまま、押しても何も起きない', async () => {
    const folder = new LocalFolder({
      picker: null,
      onChange: () => {},
    });
    expect(folder.view().phase).toBe('unsupported');
    await folder.pick();
    expect(folder.view().phase).toBe('unsupported');
    folder.cut();
    expect(folder.view().phase, '「切る」で unsupported が none に化けた').toBe('unsupported');
  });

  it('🔴 窓から showDirectoryPicker を引く ── 無ければ null、在れば窓として呼ぶ', async () => {
    expect(windowDirectoryPicker({})).toBeNull();
    const seen: unknown[] = [];
    const win = {
      showDirectoryPicker(this: unknown, o: unknown) {
        seen.push(this, o);
        return Promise.resolve(dirHandle([]));
      },
    };
    await windowDirectoryPicker(win)!({ mode: 'read' });
    expect(seen[0], '窓を this にして呼んでいない(本物は Illegal invocation になる)').toBe(win);
    expect(seen[1]).toEqual({ mode: 'read' });
  });
});

describe('許可が切れたとき(読む側)', () => {
  it('🔴 granted 以外は「切れた」── prompt も denied も', async () => {
    for (const state of ['prompt', 'denied']) {
      const perm = { state: 'granted' };
      const { folder } = make(dirHandle([fileHandle('a.md')], perm));
      await folder.pick();
      await flush();
      expect(folder.view().phase).toBe('listed');
      perm.state = state;
      await folder.more();
      expect(folder.view().phase, `${state} を granted と読んでいる`).toBe('lost');
      expect(folder.view().rows, '切れたのに行が残っている').toEqual([]);
      expect(folder.heldHandle(), '切れた handle を握ったまま').toBeNull();
    }
  });

  it('🔴 列挙の途中で投げられ、許可も無ければ「切れた」(読めなかったではない)', async () => {
    const perm = { state: 'granted' };
    const dir: DirectoryHandleLike = {
      name: '資料',
      values: async function* () {
        yield fileHandle('a.md');
        perm.state = 'prompt';
        throw new DOMException('denied', 'NotAllowedError');
      },
      queryPermission: async () => perm.state,
    };
    const { folder } = make(dir);
    await folder.pick();
    expect(folder.view().phase).toBe('lost');
  });
});

describe('🔴 消す口・改名・移動を作らない(裁定)', () => {
  it('公開面は 選ぶ / 切る / さらに / 見る だけ', () => {
    const names = Object.getOwnPropertyNames(LocalFolder.prototype)
      .filter((n) => n !== 'constructor')
      .sort();
    // ⚠ private の補助(readable / lose / changed / fillStats)は TS の private で、実行時には見える
    expect(names).toEqual(['changed', 'cut', 'fillStats', 'heldHandle', 'lose', 'more', 'pick', 'readable', 'view'].sort());
    expect(names.filter((n) => /remove|delete|rename|move|unlink|write|trash/i.test(n))).toEqual([]);
  });

  it('🔴 実行する行に、書く・消す API が 1 つも無い', () => {
    const code = codeOnly(readFileSync('src/adapter/platform/local-folder.ts', 'utf-8'));
    expect(code.length, '読めていない').toBeGreaterThan(1000);
    for (const banned of ['removeEntry', 'createWritable', 'getFileHandle', 'getDirectoryHandle', 'requestPermission', '.move(']) {
      expect(code.includes(banned), `${banned} を使っている`).toBe(false);
    }
  });

  it('🔴 handle は state にも IndexedDB にも入れない', () => {
    const code = codeOnly(readFileSync('src/adapter/platform/local-folder.ts', 'utf-8'));
    for (const banned of ['indexedDB', 'localStorage', 'sessionStorage', 'dispatch(', 'postMessage']) {
      expect(code.includes(banned), `${banned} に触れている`).toBe(false);
    }
    const state = codeOnly(readFileSync('src/adapter/state/app-state.ts', 'utf-8'));
    expect(state.includes('DirectoryHandle'), 'state が handle を持っている').toBe(false);
    expect(state.includes('local-folder'), 'state が local-folder を知っている').toBe(false);
  });
});

describe('onChange', () => {
  it('🔴 選ぶ・切るで描き直しが呼ばれる(呼ばないと画面が古いまま)', async () => {
    const { folder, changes } = make(dirHandle([fileHandle('a.md')]));
    const before = changes();
    await folder.pick();
    await flush();
    const afterPick = changes();
    expect(afterPick).toBeGreaterThan(before);
    folder.cut();
    expect(changes()).toBeGreaterThan(afterPick);
  });
});
