/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import {
  FolderSync,
  SYNC_UNSUPPORTED_NOTE,
  type FolderSyncDeps,
  type SyncDirLike,
  type SyncFileHandleLike,
} from '../../src/adapter/platform/folder-sync';
import {
  SYNC_CONFLICT_DIR,
  SYNC_MANIFEST_NAME,
  readManifest,
} from '../../src/features/folder-sync/folder-sync';
import { SYNC_OTHER_TAB_NOTE, SYNC_SAVE_EVERY, windowSyncLock, type SyncLock } from '../../src/adapter/platform/folder-sync';

/**
 * 🔴 PC のフォルダとの同期(#1455 の後半)── 本物の判断(`planSync`)+ 本物のハッシュ(`crypto.subtle`)+
 * 記憶上のフォルダ。ノート側は小さな「保存領域」を差し込み、`replaceBody` が世代を進める(本物の保存の効果の写し)。
 */
class FakeDir implements SyncDirLike {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  readonly dirs = new Map<string, FakeDir>();
  clock = 1000;
  /** 書き込みを失敗させる名前。 */
  failWrite = new Set<string>();
  writes: string[] = [];
  permission = 'granted';
  constructor(readonly name = 'sync') {}
  async *values() {
    for (const n of this.files.keys()) yield { kind: 'file', name: n };
    for (const n of this.dirs.keys()) yield { kind: 'directory', name: n };
  }
  async getFileHandle(name: string, o?: { create?: boolean }): Promise<SyncFileHandleLike> {
    if (!this.files.has(name)) {
      if (o?.create !== true) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
      this.files.set(name, { bytes: new Uint8Array(), mtime: this.clock++ });
    }
    const files = this.files;
    const bump = (): number => this.clock++;
    const writes = this.writes;
    const failWrite = this.failWrite;
    return {
      kind: 'file',
      name,
      async getFile() {
        const f = files.get(name)!;
        return new File([f.bytes.slice().buffer as ArrayBuffer], name, { lastModified: f.mtime });
      },
      async createWritable() {
        let acc = new Uint8Array();
        return {
          async write(d: Blob | string) {
            if (failWrite.has(name)) throw new Error('disk full');
            const b = typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(await d.arrayBuffer());
            const n = new Uint8Array(acc.length + b.length);
            n.set(acc);
            n.set(b, acc.length);
            acc = n;
          },
          async close() {
            files.set(name, { bytes: acc, mtime: bump() });
            writes.push(name);
          },
        };
      },
    };
  }
  async getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<SyncDirLike> {
    let d = this.dirs.get(name);
    if (!d) {
      if (o?.create !== true) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
      d = new FakeDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  removeFail = new Set<string>();
  async removeEntry(name: string) {
    if (this.removeFail.has(name)) throw new Error('locked');
    this.files.delete(name);
  }
  async queryPermission() {
    return this.permission;
  }
  put(name: string, text: string | Uint8Array) {
    this.files.set(name, { bytes: typeof text === 'string' ? new TextEncoder().encode(text) : text, mtime: this.clock++ });
  }
  text(name: string): string | null {
    const f = this.files.get(name);
    return f === undefined ? null : new TextDecoder().decode(f.bytes);
  }
}

interface Note {
  lid: string;
  title: string;
  archetype: string;
  body: string;
  rev: number;
}

interface Hooks {
  settle?: () => Promise<void> | void;
  readBody?: (lid: string) => Promise<void> | void;
  /** n 回目(1 始まり)の adopt を失敗させる。 */
  adoptFail?: (call: number) => boolean;
  lock?: SyncLock | null;
}

function setup(initial: Note[], opts: { cid?: string; picker?: boolean; confirm?: boolean; hooks?: Hooks } = {}) {
  const hooks = opts.hooks ?? {};
  let adoptCalls = 0;
  const dir = new FakeDir();
  const notes = new Map(initial.map((n) => [n.lid, { ...n }]));
  const busy = new Set<string>();
  const said: string[] = [];
  const failed: string[] = [];
  const replaced: string[] = [];
  const confirms: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  let nextLid = 100;
  let ready = true;
  const stamp = (n: Note) => ({
    updatedAt: `2026-10-0${1 + (n.rev % 9)} 00:00:00`,
    chars: n.body.length,
  });
  const deps: FolderSyncDeps = {
    picker: opts.picker === false ? null : async () => dir,
    cid: () => opts.cid ?? 'c1',
    notes: () => [...notes.values()].map((n) => ({ lid: n.lid, title: n.title, archetype: n.archetype, ...stamp(n) })),
    isBusy: (lid) => busy.has(lid),
    ready: () => ready,
    settle: async () => {
      await hooks.settle?.();
    },
    lock: hooks.lock ?? null,
    readBody: async (lid) => {
      await hooks.readBody?.(lid);
      return notes.get(lid)?.body ?? null;
    },
    replaceBody: (lid, body) => {
      replaced.push(lid);
      const n = notes.get(lid)!;
      n.body = body;
      n.rev += 1;
    },
    adopt: async (files) => {
      adoptCalls += 1;
      if (hooks.adoptFail?.(adoptCalls) === true) throw new Error('adopt failed');
      const lids: string[] = [];
      for (const f of files) {
        const lid = `L${nextLid++}`;
        notes.set(lid, { lid, title: f.name.replace(/\.md$/, ''), archetype: 'text', body: await f.text(), rev: 0 });
        lids.push(lid);
      }
      return lids;
    },
    askAdopt: async (m) => {
      confirms.push(m);
      return opts.confirm ?? true;
    },
    say: (t) => said.push(t),
    fail: (t) => failed.push(t),
    onChange: () => {},
    now: () => new Date(2026, 9, 29, 13, 5, 9),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {
      cleared += 1;
    },
  };
  const sync = new FolderSync(deps);
  return {
    dir, notes, busy, said, failed, replaced, confirms, timers, sync,
    cleared: () => cleared,
    setReady: (v: boolean) => (ready = v),
    edit: (lid: string, body: string) => {
      const n = notes.get(lid)!;
      n.body = body;
      n.rev += 1;
    },
  };
}
const note = (lid: string, title: string, body: string, archetype = 'text'): Note => ({ lid, title, archetype, body, rev: 0 });

describe('接続と最初の同期', () => {
  it('🔴 選ぶとすぐ同期: ノートが <題名>.md で書かれ、記録が残る。フォルダ・添付は書かない', async () => {
    const t = setup([note('a', 'メモ', '# メモ\n\n本文'), note('b', '日記', 'きょう'), note('f', 'フォルダ', '', 'folder'), note('x', '添付', '', 'attachment')]);
    await t.sync.pick();
    expect(t.dir.text('メモ.md')).toBe('# メモ\n\n本文');
    expect(t.dir.text('日記.md')).toBe('きょう');
    expect([...t.dir.files.keys()].sort()).toEqual([SYNC_MANIFEST_NAME, 'メモ.md', '日記.md'].sort());
    const m = JSON.parse(t.dir.text(SYNC_MANIFEST_NAME)!);
    expect(Object.keys(m.entries).sort()).toEqual(['a', 'b']);
    expect(m.cid).toBe('c1');
    expect(t.sync.view().phase).toBe('idle');
    expect(t.sync.view().folderName).toBe('sync');
    expect(t.sync.view().lastAt).toBe('13:05');
    expect(t.said.join('')).toContain('2 件をフォルダへ書きました');
    expect(t.timers.at(-1)!.ms).toBe(5 * 60_000);
  });

  it('🔴 2 回目: 何も変わっていなければ 1 ファイルも書かない(空振りの対照: 変えれば書く)', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.dir.writes.length = 0;
    await t.sync.syncNow(true);
    expect(t.dir.writes.filter((w) => w !== SYNC_MANIFEST_NAME)).toEqual([]);
    expect(t.sync.view().lastText).toBe('変更はありませんでした');
    // 対照: ノートを変えると書く
    t.edit('a', '本文 2');
    await t.sync.syncNow(true);
    expect(t.dir.text('メモ.md')).toBe('本文 2');
  });

  it('🔴 選べないブラウザ: 理由を言って断る(押せる口を作らない)', async () => {
    const t = setup([], { picker: false });
    expect(t.sync.view().phase).toBe('unsupported');
    expect(t.sync.view().message).toBe(SYNC_UNSUPPORTED_NOTE);
    await t.sync.pick();
    expect(t.dir.files.size).toBe(0);
  });

  it('🔴 最初の接続でフォルダに .md が在れば、取り込むか聞く。断れば取り込まず、書き換えず、次の回で聞き直さない', async () => {
    const t = setup([note('a', 'メモ', '本文')], { confirm: false });
    t.dir.put('既存.md', '外のファイル');
    await t.sync.pick();
    expect(t.confirms.length).toBe(1);
    expect(t.confirms[0]).toContain('1 件');
    expect(t.notes.size).toBe(1);
    expect(t.dir.text('既存.md')).toBe('外のファイル');
    await t.sync.syncNow(true);
    expect(t.confirms.length).toBe(1);
    expect(t.notes.size).toBe(1);
  });

  it('🔴 取り込むと答えれば、新しいノートになり、記録に入る(次の回で二重に取り込まない)', async () => {
    const t = setup([], { confirm: true });
    t.dir.put('既存.md', '# 外\n\n本文');
    await t.sync.pick();
    expect([...t.notes.values()].map((n) => n.body)).toEqual(['# 外\n\n本文']);
    expect(t.said.join('')).toContain('1 件の新しいファイルをノートにしました');
    await t.sync.syncNow(true);
    expect(t.notes.size).toBe(1);
    // 取り込んだノートを改題しても、名前は勝手に変えない(未確認の題名)── 外で書き換えたら取り込まれる側
    expect(t.dir.text('既存.md')).toBe('# 外\n\n本文');
  });
});

describe('変更の行き来(世代とハッシュ)', () => {
  it('🔴 フォルダ側だけ変えると、ノートの本文が置き換わる。次の回でファイルを書き戻さない', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.dir.put('メモ.md', '外で直した');
    await t.sync.syncNow(true);
    expect(t.replaced).toEqual(['a']);
    expect(t.notes.get('a')!.body).toBe('外で直した');
    t.dir.writes.length = 0;
    await t.sync.syncNow(true);
    // 世代が進んだぶんの記録更新だけ ── ファイルは書かない
    expect(t.dir.writes.filter((w) => w !== SYNC_MANIFEST_NAME)).toEqual([]);
    expect(t.dir.text('メモ.md')).toBe('外で直した');
    await t.sync.syncNow(true);
    expect(t.replaced).toEqual(['a']);
  });

  it('🔴 両方が変わった: PKC3 の版を書き、フォルダ側の版は _conflicts/ に残る', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.dir.put('メモ.md', '外の版');
    t.edit('a', 'PKC3 の版');
    await t.sync.syncNow(true);
    expect(t.dir.text('メモ.md')).toBe('PKC3 の版');
    expect(t.replaced).toEqual([]);
    const sub = t.dir.dirs.get(SYNC_CONFLICT_DIR)!;
    expect(sub, '退避先が無い').toBeDefined();
    const [saved] = [...sub.files.keys()];
    expect(saved).toMatch(/^メモ-\d{8}-\d{6}\.md$/);
    expect(sub.text(saved!)).toBe('外の版');
    expect(t.said.join('')).toContain(SYNC_CONFLICT_DIR);
  });

  it('🔴 退避に失敗したら、フォルダ側の版を上書きしない', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.dir.put('メモ.md', '外の版');
    t.edit('a', 'PKC3 の版');
    const sub = (await t.dir.getDirectoryHandle(SYNC_CONFLICT_DIR, { create: true })) as FakeDir;
    sub.failWrite = new Set(['メモ.md']);
    // 退避先の名前は日時入りなので全部失敗させる
    sub.getFileHandle = async () => {
      throw Object.assign(new Error('read-only'), { name: 'InvalidStateError' });
    };
    await t.sync.syncNow(true);
    expect(t.dir.text('メモ.md')).toBe('外の版');
    expect(t.failed.join('')).toContain('処理できませんでした');
  });

  it('🔴 改題すると新しい名前で書き、前のファイルは外れる', async () => {
    const t = setup([note('a', '旧', '本文')]);
    await t.sync.pick();
    t.notes.get('a')!.title = '新';
    t.edit('a', '本文 2');
    await t.sync.syncNow(true);
    expect(t.dir.text('新.md')).toBe('本文 2');
    expect(t.dir.text('旧.md')).toBeNull();
  });

  it('🔴 ノートが消えても、ファイルは消さない。同じ内容は取り込み直さない。外で書き換えたら新しいノートになる', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.notes.delete('a');
    await t.sync.syncNow(true);
    expect(t.dir.text('メモ.md')).toBe('本文');
    await t.sync.syncNow(true);
    expect(t.notes.size).toBe(0);
    t.dir.put('メモ.md', '外で書いた');
    await t.sync.syncNow(true);
    expect([...t.notes.values()].map((n) => n.body)).toEqual(['外で書いた']);
  });

  it('🔴 編集中のノートは触らない(書かず・取り込まず)。終われば次の回で同期する', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.busy.add('a');
    t.dir.put('メモ.md', '外の版');
    await t.sync.syncNow(true);
    expect(t.replaced).toEqual([]);
    expect(t.notes.get('a')!.body).toBe('本文');
    expect(t.said.join('')).toContain('編集中');
    t.busy.clear();
    await t.sync.syncNow(true);
    expect(t.replaced).toEqual(['a']);
  });

  it('🔴 UTF-8 として読めないファイルは、ノートに取り込まない(文字化けで壊さない)', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.dir.put('メモ.md', new Uint8Array([0x82, 0xa0, 0x82, 0xa2])); // Shift_JIS の「あい」
    await t.sync.syncNow(true);
    expect(t.replaced).toEqual([]);
    expect(t.notes.get('a')!.body).toBe('本文');
    expect(t.failed.join('')).toContain('UTF-8');
    // 同じ知らせを毎回出さない
    const n = t.failed.length;
    await t.sync.syncNow(true);
    expect(t.failed.length).toBe(n);
  });

  it('🔴 取り込みの直前にノートが変わっていたら、置き換えない(世代の確かめ直し)', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.dir.put('メモ.md', '外の版');
    // 読んでいる間にノートが保存された、を再現する(replaceBody の直前の世代確認で拾う)
    const orig = t.dir.getFileHandle.bind(t.dir);
    t.dir.getFileHandle = async (name: string, o?: { create?: boolean }) => {
      const h = await orig(name, o);
      if (name === 'メモ.md' && o === undefined) t.edit('a', 'その間に保存された');
      return h;
    };
    await t.sync.syncNow(true);
    expect(t.replaced, '世代が変わったのに置き換えた').toEqual([]);
  });
});

describe('止めるべきとき', () => {
  it('🔴 記録が壊れていたら何も書かずに止める', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    t.dir.put(SYNC_MANIFEST_NAME, '{壊れた');
    await t.sync.pick();
    expect(t.sync.view().phase).toBe('stopped');
    expect(t.dir.text('メモ.md')).toBeNull();
    expect(t.dir.text(SYNC_MANIFEST_NAME)).toBe('{壊れた');
    expect(t.failed.join('')).toContain('何も書かずに止めました');
    expect(t.timers.length, '止めたのにタイマーを張った').toBe(0);
  });

  it('🔴 別の保存領域の記録を持つフォルダへは書かない', async () => {
    const other = setup([note('a', 'メモ', '本文')], { cid: 'other' });
    await other.sync.pick();
    const t = setup([note('z', '別', '別の本文')], { cid: 'c1' });
    for (const [k, v] of other.dir.files) t.dir.files.set(k, v);
    await t.sync.pick();
    expect(t.sync.view().phase).toBe('stopped');
    expect(t.dir.text('別.md')).toBeNull();
  });

  it('🔴 許可が切れたら止めて、選び直しを言う。やめると handle を捨てる', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.dir.permission = 'prompt';
    await t.sync.syncNow(true);
    expect(t.sync.view().phase).toBe('lost');
    expect(t.sync.view().message).toContain('もう一度フォルダを選んで');
    t.sync.stop();
    expect(t.sync.heldHandle()).toBeNull();
    expect(t.sync.view().phase).toBe('none');
  });

  it('🔴 同期できる状態でないとき(編集中など)は書かず、次の回へ回す', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.setReady(false);
    t.edit('a', '本文 2');
    const before = t.timers.length;
    await t.sync.syncNow(false);
    expect(t.dir.text('メモ.md')).toBe('本文');
    expect(t.timers.length).toBe(before + 1);
  });

  it('1 件の書き込みが失敗しても、ほかの件は進む。失敗は数えて言う', async () => {
    const t = setup([note('a', 'あ', '1'), note('b', 'い', '2')]);
    t.dir.failWrite.add('あ.md');
    await t.sync.pick();
    expect(t.dir.text('い.md')).toBe('2');
    expect(t.failed.join('')).toContain('あ.md');
    expect(t.sync.view().lastText).toContain('1 件は失敗しました');
    // 失敗した分は次の回で書ける
    t.dir.failWrite.clear();
    await t.sync.syncNow(true);
    expect(t.dir.text('あ.md')).toBe('1');
  });
});

describe('間隔とタイマー', () => {
  it('🔴 間隔の選択肢だけ受ける。変えるとタイマーを張り直す(古いタイマーは外す)', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    const c = t.cleared();
    t.sync.setMinutes(15);
    expect(t.sync.view().minutes).toBe(15);
    expect(t.cleared()).toBeGreaterThan(c);
    expect(t.timers.at(-1)!.ms).toBe(15 * 60_000);
    t.sync.setMinutes(7); // 選択肢に無い
    expect(t.sync.view().minutes).toBe(15);
  });

  it('🔴 タイマーが鳴ると同期する。やめた後に鳴っても何もしない', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    t.edit('a', '本文 2');
    const fire = t.timers.at(-1)!.fn;
    fire();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.dir.text('メモ.md')).toBe('本文 2');
    const late = t.timers.at(-1)!.fn;
    t.sync.stop();
    t.edit('a', '本文 3');
    late();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.dir.text('メモ.md')).toBe('本文 2');
  });
});

const manifestOf = (dir: FakeDir) => {
  const r = readManifest(dir.text(SYNC_MANIFEST_NAME) ?? '');
  if (!r.ok) throw new Error('記録が読めない');
  return r.manifest;
};

describe('穴 A: 記録は、書けた分を必ず保存する(次の回に重複ノートを出さない)', () => {
  it('🔴 同期の途中で「やめる」(世代が変わる)── 書けた分の記録が残り、選び直しても書き直さない', async () => {
    let t!: ReturnType<typeof setup>;
    // eslint-disable-next-line prefer-const -- フックの中から参照する
    t = setup([note('a', 'あ', '1'), note('b', 'い', '2'), note('c', 'う', '3')], {
      hooks: {
        readBody: (lid) => {
          if (lid === 'b') t.sync.stop();
        },
      },
    });
    await t.sync.pick();
    // 1 件目は書けている ── 記録も残っている(最後にしか保存しない実装では 0 件)
    expect(t.dir.text('あ.md')).toBe('1');
    // 止めた時点で書き終えていた分(1 件目と、止めた瞬間に書いていた 2 件目)は記録にある。3 件目は書いていない
    expect(Object.keys(manifestOf(t.dir).entries)).toEqual(['a', 'b']);
    expect(t.dir.text('う.md')).toBeNull();
    t.dir.writes.length = 0;
    await t.sync.pick();
    expect(t.dir.text('う.md')).toBe('3');
    expect(t.dir.writes.filter((w) => w === 'あ.md' || w === 'い.md'), '書いた物を書き直した').toEqual([]);
    expect([...t.dir.files.keys()].filter((k) => k.endsWith('.md')).sort()).toEqual(['あ.md', 'い.md', 'う.md']);
  });

  it('🔴 許可が切れて途中で止まっても、書けた分の記録は残る', async () => {
    const t = setup([note('a', 'あ', '1'), note('b', 'い', '2')]);
    const orig = t.dir.getFileHandle.bind(t.dir);
    t.dir.getFileHandle = async (name: string, o?: { create?: boolean }) => {
      if (name === 'い.md') throw Object.assign(new Error('perm'), { name: 'NotAllowedError' });
      return orig(name, o);
    };
    await t.sync.pick();
    expect(t.sync.view().phase).toBe('lost');
    expect(Object.keys(manifestOf(t.dir).entries)).toEqual(['a']);
  });

  it('🔴 取り込みが途中で失敗しても、取り込めた分は記録に入る ── 次の回は残りだけを取り込む(重複なし)', async () => {
    const t = setup([], { confirm: true, hooks: { adoptFail: (n) => n === 2 } });
    for (let i = 0; i < 60; i += 1) t.dir.put(`f${String(i).padStart(2, '0')}.md`, `本文 ${i}`);
    await t.sync.pick();
    expect(t.notes.size).toBe(50);
    expect(Object.keys(manifestOf(t.dir).entries).length).toBe(50);
    expect(t.sync.view().lastText).toContain('失敗');
    await t.sync.syncNow(true);
    expect(t.notes.size, '取り込み済みのファイルをもう一度取り込んだ').toBe(60);
  });

  it('🔴 件数が多いときは途中でも保存する(SYNC_SAVE_EVERY ごと)', async () => {
    const n = SYNC_SAVE_EVERY + 20;
    const t = setup(Array.from({ length: n }, (_, i) => note(`n${i}`, `題${String(i).padStart(3, '0')}`, `本文${i}`)));
    await t.sync.pick();
    const saves = t.dir.writes.filter((w) => w === SYNC_MANIFEST_NAME).length;
    expect(saves, '途中で保存していない').toBeGreaterThanOrEqual(2);
    expect(Object.keys(manifestOf(t.dir).entries).length).toBe(n);
  });
});

describe('穴 B: 読めない(大きすぎる)ファイル', () => {
  it('🔴 記録にある 8 MB 超のファイルは、ノートが変わっても上書きしない・取り込まない。新しい大きいファイルも取り込まない', async () => {
    const t = setup([note('a', 'あ', '1')]);
    await t.sync.pick();
    const big = new Uint8Array(8 * 1024 * 1024 + 1).fill(97);
    t.dir.put('あ.md', big);
    t.dir.put('huge.md', big);
    t.edit('a', '2');
    await t.sync.syncNow(true);
    expect(t.dir.files.get('あ.md')!.bytes.length, '大きいファイルを上書きした').toBe(big.length);
    expect(t.replaced).toEqual([]);
    expect(t.notes.size).toBe(1);
    expect(t.failed.join('')).toContain('大きすぎて同期できません');
    expect(t.dir.dirs.get(SYNC_CONFLICT_DIR)).toBeUndefined();
  });
});

describe('穴 C: `_` で始まる題名', () => {
  it('🔴 書いたファイルが次の回に「無い」と読まれない(名前は `_` で始まらない)', async () => {
    const t = setup([note('a', '_秘密', '本文')]);
    await t.sync.pick();
    expect(t.dir.text('秘密.md')).toBe('本文');
    t.dir.writes.length = 0;
    await t.sync.syncNow(true);
    expect(t.dir.writes.filter((w) => w !== SYNC_MANIFEST_NAME)).toEqual([]);
    expect(t.sync.view().gone).toEqual([]);
  });

  it('🔴 記録が `_x.md` を指している(旧い記録)ときも、在るファイルとして照合する', async () => {
    const t = setup([note('a', 'あ', '本文')]);
    await t.sync.pick();
    // 記録を `_x.md` に付け替え、ファイルも同名にする
    const m = manifestOf(t.dir);
    const rec = m.entries['a']!;
    m.entries['a'] = { ...rec, file: '_x.md' };
    t.dir.files.set('_x.md', t.dir.files.get('あ.md')!);
    t.dir.files.delete('あ.md');
    t.dir.put(SYNC_MANIFEST_NAME, JSON.stringify(m));
    t.dir.writes.length = 0;
    await t.sync.syncNow(true);
    expect(t.dir.writes.filter((w) => w !== SYNC_MANIFEST_NAME)).toEqual([]);
    expect(t.sync.view().gone).toEqual([]);
  });
});

describe('⚠4 上書き・削除の直前にハッシュを取り直す', () => {
  it('🔴 計画の後・書く前にフォルダ側が直された: 上書きせず、競合として退避してから書く', async () => {
    let t!: ReturnType<typeof setup>;
    let armed = false;
    // eslint-disable-next-line prefer-const -- フックの中から参照する
    t = setup([note('a', 'メモ', '本文')], {
      hooks: {
        settle: () => {
          if (armed) t.dir.put('メモ.md', '計画の後に外で直した');
        },
      },
    });
    await t.sync.pick();
    armed = true;
    t.edit('a', 'PKC3 で直した');
    await t.sync.syncNow(true);
    expect(t.dir.text('メモ.md')).toBe('PKC3 で直した');
    const sub = t.dir.dirs.get(SYNC_CONFLICT_DIR)!;
    expect(sub, '退避していない').toBeDefined();
    expect([...sub.files.keys()].map((k) => sub.text(k))).toEqual(['計画の後に外で直した']);
  });

  it('🔴 新しい名前のつもりが、計画の後に同じ名前のファイルが作られていた: 上書きせず退避する', async () => {
    let t!: ReturnType<typeof setup>;
    // eslint-disable-next-line prefer-const -- フックの中から参照する
    t = setup([note('a', 'メモ', '本文')], {
      hooks: {
        settle: () => {
          t.dir.put('メモ.md', '先に作られた');
        },
      },
    });
    await t.sync.pick();
    const sub = t.dir.dirs.get(SYNC_CONFLICT_DIR)!;
    expect([...sub.files.keys()].map((k) => sub.text(k))).toEqual(['先に作られた']);
    expect(t.dir.text('メモ.md')).toBe('本文');
  });

  it('🔴 改題で前のファイルを消す直前に外で直されていたら、コピーを残してから消す', async () => {
    let t!: ReturnType<typeof setup>;
    let armed = false;
    // eslint-disable-next-line prefer-const -- フックの中から参照する
    t = setup([note('a', '旧', '本文')], {
      hooks: {
        readBody: () => {
          if (armed) t.dir.put('旧.md', '外で直した前のファイル');
        },
      },
    });
    await t.sync.pick();
    armed = true;
    t.notes.get('a')!.title = '新';
    t.edit('a', '本文 2');
    await t.sync.syncNow(true);
    const sub = t.dir.dirs.get(SYNC_CONFLICT_DIR)!;
    expect([...sub.files.keys()].map((k) => sub.text(k))).toEqual(['外で直した前のファイル']);
    expect(t.dir.text('旧.md')).toBeNull();
    expect(t.dir.text('新.md')).toBe('本文 2');
  });
});

describe('⚠5 やめる → すぐ選び直す', () => {
  it('🔴 古い同期が走っている間にやめて選び直しても、新しい同期は始まり、終わると次も走れる', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const t = setup([note('a', 'あ', '1')], {
      hooks: {
        readBody: async () => {
          if (first) {
            first = false;
            await gate;
          }
        },
      },
    });
    const p1 = t.sync.pick();
    await new Promise((r) => setTimeout(r, 10));
    t.sync.stop();
    const p2 = t.sync.pick();
    release();
    await Promise.all([p1, p2]);
    expect(t.sync.view().phase).toBe('idle');
    expect(t.dir.text('あ.md')).toBe('1');
    // 古い同期の終わりが、新しい世代の「動いている」印を倒していない ── 続けて押せて、重ならずに走る
    t.edit('a', '2');
    await t.sync.syncNow(true);
    expect(t.dir.text('あ.md')).toBe('2');
  });
});

describe('⚠6 別のタブ・ウィンドウとの排他', () => {
  it('🔴 ほかが同期している(ロックが取れない)ときは何も書かず、言って、次の回へ回す', async () => {
    const t = setup([note('a', 'あ', '1')], { hooks: { lock: async () => false } });
    await t.sync.pick();
    expect(t.dir.text('あ.md')).toBeNull();
    expect(t.said.join('')).toContain(SYNC_OTHER_TAB_NOTE);
    expect(t.timers.length).toBeGreaterThan(0);
    expect(t.sync.view().phase).toBe('idle');
  });

  it('🔴 ロックが取れれば動く。鍵はフォルダごと', async () => {
    const keys: string[] = [];
    const t = setup([note('a', 'あ', '1')], {
      hooks: {
        lock: async (k, fn) => {
          keys.push(k);
          await fn();
          return true;
        },
      },
    });
    await t.sync.pick();
    expect(t.dir.text('あ.md')).toBe('1');
    expect(keys).toEqual(['pkc3-folder-sync:c1:sync']);
  });

  it('windowSyncLock: navigator.locks が無ければ null / ifAvailable で取れなければ false', async () => {
    expect(windowSyncLock({})).toBeNull();
    let held = false;
    const nav = {
      locks: {
        request: async (_n: string, o: { ifAvailable?: boolean }, cb: (l: unknown) => Promise<void>) => {
          if (held && o.ifAvailable === true) return cb(null);
          held = true;
          try {
            await cb({});
          } finally {
            held = false;
          }
        },
      },
    };
    const lock = windowSyncLock(nav)!;
    let ran = 0;
    const inner: boolean[] = [];
    await lock('k', async () => {
      ran += 1;
      inner.push(await lock('k', async () => void (ran += 10)));
    });
    expect(ran).toBe(1);
    expect(inner).toEqual([false]);
  });
});

describe('⚠10 改題で前のファイルを消せなかったとき', () => {
  it('🔴 失敗に数え、次の回に新しいノートとして取り込まない', async () => {
    const t = setup([note('a', '旧', '本文')]);
    await t.sync.pick();
    t.dir.removeFail.add('旧.md');
    t.notes.get('a')!.title = '新';
    t.edit('a', '本文 2');
    await t.sync.syncNow(true);
    expect(t.sync.view().lastText).toContain('失敗');
    expect(t.failed.join('')).toContain('旧.md');
    await t.sync.syncNow(true);
    await t.sync.syncNow(true);
    expect(t.notes.size, '残った前のファイルを取り込んだ').toBe(1);
  });
});

describe('ゴミ箱から戻したノート', () => {
  it('🔴 同じファイル名を使い続ける(2 つのファイルにならない)', async () => {
    const t = setup([note('a', 'メモ', '本文')]);
    await t.sync.pick();
    const saved = t.notes.get('a')!;
    t.notes.delete('a');
    await t.sync.syncNow(true);
    expect(t.dir.text('メモ.md')).toBe('本文');
    t.notes.set('a', saved);
    await t.sync.syncNow(true);
    await t.sync.syncNow(true);
    expect([...t.dir.files.keys()].filter((k) => k.endsWith('.md'))).toEqual(['メモ.md']);
    expect(t.notes.size).toBe(1);
  });
});

describe('フォルダで消えたノート', () => {
  it('🔴 黙って書き戻さず、画面に出す。「書き戻す」で書き、「同期から外す」で外し、「同期に戻す」で戻る', async () => {
    const t = setup([note('a', 'あ', '1'), note('b', 'い', '2')]);
    await t.sync.pick();
    t.dir.files.delete('あ.md');
    t.dir.files.delete('い.md');
    await t.sync.syncNow(true);
    expect(t.dir.text('あ.md'), '黙って書き戻した').toBeNull();
    expect(t.sync.view().gone.map((g) => g.title)).toEqual(['あ', 'い']);
    expect(t.sync.view().lastText).toContain('2 件はフォルダでファイルが消えています');
    // タイマーの回でも同じ(選ぶまで何もしない)
    await t.sync.syncNow(false);
    expect(t.dir.text('あ.md')).toBeNull();

    await t.sync.resolveGone('a', 'restore');
    expect(t.dir.text('あ.md')).toBe('1');
    expect(t.sync.view().gone.map((g) => g.lid)).toEqual(['b']);

    await t.sync.resolveGone('b', 'detach');
    expect(t.sync.view().gone).toEqual([]);
    expect(t.sync.view().detached.map((d) => d.lid)).toEqual(['b']);
    expect(t.dir.text('い.md')).toBeNull();
    await t.sync.syncNow(true);
    expect(t.dir.text('い.md'), '外したノートを書いた').toBeNull();
    expect(manifestOf(t.dir).detached).toEqual({ b: true });

    // 片道にしない: 同期に戻すと、新しいファイルとして書く
    await t.sync.attach('b');
    expect(t.dir.text('い.md')).toBe('2');
    expect(t.sync.view().detached).toEqual([]);
  });
});

describe('記録の版', () => {
  it('🔴 別の版の記録は「壊れている」ではなく「別の版」と言って止める(何も書かない)', async () => {
    const t = setup([note('a', 'あ', '1')]);
    t.dir.put(SYNC_MANIFEST_NAME, JSON.stringify({ format: 'pkc3-folder-sync', version: 2, cid: 'c1', entries: {}, removed: {} }));
    await t.sync.pick();
    expect(t.sync.view().phase).toBe('stopped');
    expect(t.sync.view().message).toContain('別のバージョン');
    expect(t.sync.view().message).not.toContain('読めない');
    expect(t.dir.text('あ.md')).toBeNull();
  });
});
