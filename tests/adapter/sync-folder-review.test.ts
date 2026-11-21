/** @vitest-environment node */
/**
 * 🔴 **フォルダ同期(#2000 段 3)のレビュー指摘の直し**を、実物の worker 2 台とメモリのフォルダで通す。
 *
 * 1. 添付の実体の門(hash なし = 大きさ / hash あり = 大きさ + hash)と、足りない添付の引き直し(取り込み時に弾いた物も引き直す・開き直しても続く)
 * 2. 色ラベル・ピン留め: 相手でゴミ箱へ移した(こちらは編集して残した)ノートの印を外さない / 付けられなかった印を「合意した」と残さない
 * 3. 定期の同期が「取り込みを取り消す」を奪わない / 同じ失敗のファイルを繰り返さない・黙って動く
 * 4. フォルダを選び直したとき・別のタブとの排他・自分のファイルの見分け・添付 1 件だけ置けない
 * 5. 差分ファイルの組み立ては storage worker で行う
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SyncFolder, type SyncFolderDeps } from '../../src/adapter/ui/actions/sync-folder';
import { assetMismatch, exportSyncDiff } from '../../src/adapter/ui/actions/sync-diff';
import { MemorySyncFolderStore } from '../../src/adapter/platform/sync-folder-store';
import { SYNC_FOLDER_ASSETS_DIR, SYNC_FOLDER_DIR, folderFileNameOf } from '../../src/features/sync/sync-folder';
import { MemDir, type MemClock } from '../helpers/mem-dir';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const devices: SyncDevice[] = [];
async function dev(name: string): Promise<SyncDevice> {
  const d = await spawnDevice(name);
  devices.push(d);
  await d.setEnabled(true);
  return d;
}
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

const clock: MemClock = { t: 1_700_000_000_000 };
const tick = (ms = 10_000): void => void (clock.t += ms);

interface Side {
  d: SyncDevice;
  f: SyncFolder;
  store: MemorySyncFolderStore;
  say: string[];
  fail: string[];
}
function side(d: SyncDevice, root: MemDir, over: Partial<SyncFolderDeps> = {}, store = new MemorySyncFolderStore()): Side {
  const s: Side = { d, f: null as unknown as SyncFolder, store, say: [], fail: [] };
  s.f = new SyncFolder({
    picker: async () => root,
    store,
    cid: d.cid,
    enabled: () => d.enabled,
    syncDeps: async () => d.deps(),
    ready: () => true,
    lock: null,
    say: (t) => void s.say.push(t),
    fail: (t) => void s.fail.push(t),
    onChange: () => undefined,
    nowMs: () => clock.t,
    ...over,
  });
  return s;
}
async function cycle(s: Side, manual = true): Promise<void> {
  tick();
  await s.f.syncNow(manual);
}
async function pick(s: Side): Promise<void> {
  tick();
  await s.f.pick();
}
async function pair(over: Partial<SyncFolderDeps> = {}): Promise<{ a: Side; b: Side; root: MemDir }> {
  const root = new MemDir('クラウド', clock);
  const a = side(await dev('A'), root);
  const b = side(await dev('B'), root, over);
  return { a, b, root };
}
const labels = async (d: SyncDevice): Promise<Record<string, number>> => Object.fromEntries((await d.request({ op: 'listNoteLabels', cid: d.cid })).map((l) => [l.lid, l.color]));
const pins = (d: SyncDevice): Promise<string[]> => d.request({ op: 'listNotePins', cid: d.cid });
const snap = (d: SyncDevice) => d.request({ op: 'syncSnapshot', cid: d.cid });
const syncDir = async (root: MemDir): Promise<MemDir> => (await root.getDirectoryHandle(SYNC_FOLDER_DIR)) as MemDir;
const assetsDir = async (root: MemDir): Promise<MemDir> => (await (await syncDir(root)).getDirectoryHandle(SYNC_FOLDER_ASSETS_DIR)) as MemDir;
const bytes = (n: number, v = 7): Blob => new Blob([new Uint8Array(n).fill(v)], { type: 'application/octet-stream' });

describe('添付の実体の門(assetMismatch)', () => {
  it('hash なし(64MB 超)は大きさが目録と同じ物だけ通す / hash ありは大きさと hash の両方', async () => {
    expect(await assetMismatch(bytes(6), { size: 6, hash: null })).toBeNull();
    expect(await assetMismatch(bytes(3), { size: 6, hash: null })).toContain('大きさ');
    expect(await assetMismatch(bytes(0), { size: 0, hash: null })).toBeNull();
    const h = 'a'.repeat(64);
    expect(await assetMismatch(bytes(3), { size: 6, hash: h })).toContain('大きさ');
    expect(await assetMismatch(bytes(6), { size: 6, hash: h })).toContain('hash');
    expect(await assetMismatch(bytes(6), { size: 0, hash: h })).toContain('hash'); // 大きさ不明(0)は大きさを見ない
  });
});

describe('フォルダ同期: 足りない添付の引き直し', () => {
  async function setup(): Promise<{ a: Side; b: Side; root: MemDir }> {
    const p = await pair();
    p.a.d.blobs.set('ast-big', bytes(6));
    await p.a.d.request({ op: 'putAssetMeta', cid: p.a.d.cid, meta: { key: 'ast-big', mime: 'application/octet-stream', size: 6, hash: null } });
    await p.a.d.put('n1', '大きい添付', '![x](asset:ast-big)');
    await pick(p.a);
    return p;
  }
  it('hash なしの添付が途中までしか届いていなければ置かず、揃ったら次の回で置く', async () => {
    const { b, root } = await setup();
    const assets = await assetsDir(root);
    const full = assets.files.get('ast-big')!.blob;
    assets.put('ast-big', full.slice(0, 3), clock.t - 60_000); // 途中までのアップロード
    await pick(b);
    expect(b.d.blobs.has('ast-big')).toBe(false);
    expect(b.d.reports.join('\n')).toContain('取り込まなかった添付');
    await cycle(b, false);
    expect(b.d.blobs.has('ast-big')).toBe(false); // 途中のままなら何度回しても置かない
    assets.put('ast-big', full, clock.t - 30_000);
    await cycle(b, false);
    expect(b.d.blobs.get('ast-big')?.size).toBe(6); // 引き直した
  });
  it('hash の合わない添付(取り込み時に弾いた物)も、正しい実体が来たら引き直す', async () => {
    const { a, b, root } = await pair();
    a.d.blobs.set('ast-h', bytes(4, 1));
    const good = bytes(4, 1);
    const hash = await (await import('../../src/adapter/platform/storage/asset-key')).sha256Hex(good);
    await a.d.request({ op: 'putAssetMeta', cid: a.d.cid, meta: { key: 'ast-h', mime: 'image/png', size: 4, hash } });
    await a.d.put('n1', '絵', '![x](asset:ast-h)');
    await pick(a);
    const assets = await assetsDir(root);
    assets.put('ast-h', bytes(4, 9), clock.t - 60_000); // 同じ大きさで中身が違う
    await pick(b);
    expect(b.d.blobs.has('ast-h')).toBe(false);
    assets.put('ast-h', good, clock.t - 30_000);
    await cycle(b, false);
    expect(b.d.blobs.has('ast-h')).toBe(true);
  });
  it('開き直し(新しい SyncFolder)でも、足りない添付の引き直しを続ける', async () => {
    const { b, root } = await setup();
    const assets = await assetsDir(root);
    const full = assets.files.get('ast-big')!.blob;
    assets.put('ast-big', full.slice(0, 2), clock.t - 60_000);
    await pick(b);
    expect((await b.store.get(b.d.cid))?.missing?.map((m) => m.key)).toEqual(['ast-big']);
    assets.put('ast-big', full, clock.t - 30_000);
    const again = side(b.d, root, {}, b.store);
    tick();
    await again.f.init();
    expect(b.d.blobs.get('ast-big')?.size).toBe(6);
    expect((await b.store.get(b.d.cid))?.missing ?? []).toEqual([]);
  });
});

describe('フォルダ同期: 色ラベル・ピン留めの取りこぼし', () => {
  it('相手でゴミ箱へ移した(こちらで編集して残した)ノートの色ラベル・ピン留めを、黙って外さない', async () => {
    const { a, b } = await pair();
    await a.d.put('n1', '共有', '初稿');
    await a.d.request({ op: 'putNoteLabel', cid: a.d.cid, lid: 'n1', color: 2 });
    await a.d.request({ op: 'putNotePin', cid: a.d.cid, lid: 'n1', on: true });
    await pick(a);
    await pick(b);
    await cycle(a);
    await cycle(b);
    expect(await labels(b.d)).toEqual({ n1: 2 });
    await a.d.del('n1');
    await b.d.put('n1', '共有', 'B で編集');
    await cycle(a);
    await cycle(b); // こちらで編集したので残す(相手の削除では消さない)
    expect((await b.d.request({ op: 'listEntryMetas', cid: b.d.cid })).map((m) => m.lid)).toEqual(['n1']);
    expect(await labels(b.d)).toEqual({ n1: 2 });
    expect(await pins(b.d)).toEqual(['n1']);
    for (let i = 0; i < 2; i++) {
      await cycle(a);
      await cycle(b);
    }
    expect(await labels(b.d)).toEqual({ n1: 2 });
  });

  it('ピン留めの上限で付けられなかった印は「合意した」と記録せず、空きができて次に取り込むとき付く', async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 100; i++) {
      await b.d.put(`p${i}`, `留める${i}`, `本文${i}`);
      await b.d.request({ op: 'putNotePin', cid: b.d.cid, lid: `p${i}`, on: true });
    }
    await a.d.put('nx', 'A のノート', '初稿');
    await a.d.request({ op: 'putNotePin', cid: a.d.cid, lid: 'nx', on: true });
    await pick(a);
    await pick(b);
    expect(await pins(b.d)).not.toContain('nx'); // 上限で付かない
    const idA = (await snap(a.d)).device!;
    expect(Object.keys((await snap(b.d)).bases[idA]!.baseline)).not.toContain('pin:nx'); // 合意として残していない
    await b.d.request({ op: 'putNotePin', cid: b.d.cid, lid: 'p0', on: false });
    await a.d.put('nx', 'A のノート', '二版'); // 新しい連番のファイルが来る
    await cycle(a);
    await cycle(b);
    expect(await pins(b.d)).toContain('nx');
  });
});

describe('フォルダ同期: 定期の同期が取り消しを奪わない・黙って動く', () => {
  it('「取り込みを取り消す」が残っているあいだ・定期の回は、取り込んでも取り消しを上書きしない(押した回は、何も残っていなければ登録する)', async () => {
    let pending = true;
    const { a, b } = await pair({ undoPending: () => pending });
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    await pick(b); // 押した回だが取り消しが残っている
    expect(b.d.undo).toBeNull();
    expect(b.d.reports.join('\n')).not.toContain('取り消せるのは');
    pending = false;
    await a.d.put('n2', '二つ目', '本文');
    await cycle(a);
    await cycle(b, false); // 定期の回
    expect(b.d.undo).toBeNull();
    await a.d.put('n3', '三つ目', '本文');
    await cycle(a);
    await cycle(b, true); // 押した回・取り消しなし → 登録
    expect(b.d.undo).not.toBeNull();
  });

  it('定期の回は、ステータスバー(notify)・注意の面(report)を使わず、メッセージへだけ出す', async () => {
    const notes: string[] = [];
    const root = new MemDir('クラウド2', clock);
    const a2 = side(await dev('A2'), root);
    const b2 = side(await dev('B2'), root, { syncDeps: async () => ({ ...b2.d.deps(), notify: (m) => void notes.push(m) }) });
    await a2.d.put('n1', '一つ目', '本文');
    await pick(a2);
    await pick(b2); // 初回(押した回)
    notes.length = 0;
    const reports = b2.d.reports.length;
    await a2.d.put('n1', '一つ目', '本文 2');
    await cycle(a2);
    await cycle(b2, false);
    expect(await b2.d.request({ op: 'getBodies', cid: b2.d.cid, lids: ['n1'] })).toEqual([{ lid: 'n1', body: '本文 2' }]);
    expect(notes).toEqual([]);
    expect(b2.d.reports.length).toBe(reports);
    expect(b2.say.join('\n')).toContain('他の端末から取り込み');
    await a2.d.put('n1', '一つ目', '本文 3');
    await cycle(a2);
    await cycle(b2, true);
    expect(notes.length + b2.d.reports.length).toBeGreaterThan(reports); // 押した回は従来どおり
  });

  it('取り込みに失敗したファイルは、変わるまで定期の回で繰り返さず、知らせも 1 度だけ(押した回はもう一度試す)', async () => {
    let applies = 0;
    let failApply = false;
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A'), root);
    const b = side(await dev('B'), root, {
      syncDeps: async () => ({
        ...b.d.deps(),
        request: ((req: { op: string }) => {
          if (req.op === 'syncApply') {
            applies++;
            if (failApply) return Promise.reject(new Error('書き込めません'));
          }
          return b.d.request(req as never);
        }) as never,
      }),
    });
    failApply = false;
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    await pick(b); // 初回の対応づけ(押した回)
    expect(applies).toBe(1);
    failApply = true;
    await a.d.put('n1', '一つ目', '本文 2');
    await cycle(a);
    await cycle(b, false); // 定期の回で失敗
    expect(applies).toBe(2);
    expect(b.d.failures).toEqual([]); // 注意の面(reportProblem)ではなくメッセージへ
    expect(b.fail.filter((t) => t.includes('取り込めませんでした')).length).toBe(1);
    await cycle(b, false);
    await cycle(b, false);
    expect(applies).toBe(2); // 飛ばした
    expect(b.fail.filter((t) => t.includes('取り込めませんでした')).length).toBe(1);
    failApply = false;
    await cycle(b, true); // 押した回は試す
    expect(applies).toBe(3);
    expect(await b.d.request({ op: 'getBodies', cid: b.d.cid, lids: ['n1'] })).toEqual([{ lid: 'n1', body: '本文 2' }]);
  });

  it('壊れて読めないファイルは、定期の回では読み直さず、更新されたら読む(押した回は試す)', async () => {
    const { b, root } = await pair();
    await pick(b);
    const dir = await syncDir(root);
    const bad = '0123456789abcdef.pkc3-diff.zip';
    dir.put(bad, new Blob(['zip ではない'.repeat(10)]), clock.t - 60_000);
    let slices = 0;
    const orig = dir.getFileHandle.bind(dir);
    dir.getFileHandle = (async (n: string, o?: { create?: boolean }) => {
      const h = await orig(n, o);
      if (n !== bad) return h;
      return {
        ...h,
        getFile: async () => {
          const f = await h.getFile();
          for (const m of ['slice', 'stream', 'arrayBuffer', 'text'] as const) {
            const orig2 = (f[m] as (...a: unknown[]) => unknown).bind(f);
            (f as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
              slices++;
              return orig2(...args);
            };
          }
          return f;
        },
      };
    }) as typeof dir.getFileHandle;
    await cycle(b, false);
    const first = slices;
    expect(first).toBeGreaterThan(0);
    await cycle(b, false);
    await cycle(b, false);
    expect(slices).toBe(first); // 読み直していない
    await cycle(b, true);
    expect(slices).toBeGreaterThan(first); // 押した回は試す
  });
});

describe('フォルダ同期: 選び直し・排他・自分のファイル・添付 1 件', () => {
  it('同期の最中にフォルダが選び直されたら、古い回が終わったあとに新しいフォルダを同期し、タイマーも残る', async () => {
    const root1 = new MemDir('一つ目', clock);
    const root2 = new MemDir('二つ目', clock);
    const roots = [root1, root2];
    let n = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => void (release = r));
    const timers: Array<{ ms: number; cleared: boolean }> = [];
    const a = await dev('A');
    await a.put('n1', '一つ目', '本文');
    let first = true;
    const s = side(a, root1, {
      picker: async () => roots[n++] as MemDir,
      syncDeps: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return a.deps();
      },
      setTimer: (_fn, ms) => {
        const h = { ms, cleared: false };
        timers.push(h);
        return h;
      },
      clearTimer: (h) => void ((h as { cleared: boolean }).cleared = true),
    });
    tick();
    const p1 = s.f.pick(); // 一つ目の同期が止まっている
    await new Promise((r) => setTimeout(r, 20));
    tick();
    const p2 = s.f.pick(); // 選び直し
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([p1, p2]);
    expect(s.f.view().folderName).toBe('二つ目');
    expect(s.f.view().phase).toBe('idle');
    expect([...(await syncDir(root2)).files.keys()].length).toBe(1); // 新しいフォルダへ書いた
    expect(timers.filter((t) => !t.cleared).length).toBeGreaterThan(0); // タイマーが残っている
  });

  it('別のタブ・ウィンドウとの排他: 同じ名前の鍵を持つあいだ、もう一方の同期は動かない(同時に 2 本走らない)', async () => {
    const root = new MemDir('クラウド', clock);
    const a = await dev('A');
    await a.put('n1', '一つ目', '本文');
    const held = new Set<string>();
    const keys: string[] = [];
    const lock = async (key: string, fn: () => Promise<void>): Promise<boolean> => {
      keys.push(key);
      if (held.has(key)) return false;
      held.add(key);
      try {
        await fn();
      } finally {
        held.delete(key);
      }
      return true;
    };
    let inside = 0;
    let maxInside = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => void (release = r));
    const mk = (): Side =>
      side(a, root, {
        lock,
        syncDeps: async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await gate;
          inside--;
          return a.deps();
        },
      });
    const s1 = mk();
    const s2 = mk();
    tick();
    const r1 = s1.f.pick(); // 鍵を持って止まっている
    await new Promise((r) => setTimeout(r, 30));
    const r2 = s2.f.pick(); // 同じ鍵 → 動かない
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all([r1, r2]);
    expect(maxInside).toBe(1);
    expect(keys.every((k) => k === `pkc3-sync-folder:${a.cid}`)).toBe(true);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(s2.say.join('\n')).toContain('別のタブ');
  });

  it('手動の書き出しを何度繰り返しても(記録の保持数を超えても)、フォルダの自分のファイルを「重複」と疑わない', async () => {
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A'), root);
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    for (let i = 0; i < 10; i++) await exportSyncDiff(a.d.deps(), { all: true });
    const confirms = a.d.confirms.length;
    await cycle(a, true);
    expect(a.d.confirms.length).toBe(confirms); // 作り直しの確認を出さない
    expect(a.f.view().pendingPeers).toEqual([]);
    expect(a.fail).toEqual([]);
    const idA = (await snap(a.d)).device!;
    expect((await syncDir(root)).files.has(folderFileNameOf(idA))).toBe(true);
  });

  it('添付 1 件だけ置けなくても(名前を受け付けない等)同期は止まらず、その添付を飛ばして 1 度だけ知らせる', async () => {
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A'), root);
    const assets = (await (await root.getDirectoryHandle(SYNC_FOLDER_DIR, { create: true }) as MemDir).getDirectoryHandle(SYNC_FOLDER_ASSETS_DIR, { create: true })) as MemDir;
    const orig = assets.getFileHandle.bind(assets);
    assets.getFileHandle = (async (n: string, o?: { create?: boolean }) => {
      if (n === 'ast-bad') throw new TypeError('invalid name');
      return orig(n, o);
    }) as typeof assets.getFileHandle;
    for (const k of ['ast-bad', 'ast-ok']) {
      a.d.blobs.set(k, bytes(3));
      await a.d.request({ op: 'putAssetMeta', cid: a.d.cid, meta: { key: k, mime: 'application/octet-stream', size: 3, hash: null } });
    }
    await a.d.put('n1', '二つの添付', '![a](asset:ast-bad) ![b](asset:ast-ok)');
    await pick(a);
    expect(a.fail.filter((t) => t.includes('ast-bad')).length).toBe(1);
    expect(a.fail.join('\n')).not.toContain('止まりました');
    expect([...assets.files.keys()]).toEqual(['ast-ok']);
    await a.d.put('n1', '二つの添付', '![a](asset:ast-bad) ![b](asset:ast-ok) 追記');
    await cycle(a);
    await cycle(a);
    expect(a.fail.filter((t) => t.includes('ast-bad')).length).toBe(1);
  });

  it('フォルダ同期の差分ファイルは storage worker で組み立てる(主スレッドで本文を取り出さない・連番は worker が進める)', async () => {
    const root = new MemDir('クラウド', clock);
    const ops: string[] = [];
    const d = await dev('A');
    const a = side(d, root, { syncDeps: async () => ({ ...d.deps(), request: ((req: { op: string }) => (ops.push(req.op), d.request(req as never))) as never }) });
    await d.put('n1', '一つ目', '本文');
    await pick(a);
    expect(ops).toContain('syncBuildDiff');
    expect(ops).not.toContain('getBodies');
    expect(ops).not.toContain('syncCommitExport');
    const idA = (await snap(d)).device!;
    expect((await syncDir(root)).files.get(folderFileNameOf(idA))!.blob.size).toBeGreaterThan(0);
  });
});
