/** @vitest-environment happy-dom */
/**
 * 音声認識の部品の**設置・削除**(#772 段②)。
 *
 * 守りたい主張:
 *  ① 🔴 **2 回目からは取らない**(同じ版が入っていれば、目録のほかは 1 本も取りに行かない)
 *  ② 🔴 **実行の部品は 2 択に共通** ── 片方を入れた後でもう片方を入れるとき、取り直さない
 *  ③ 🔴 **失敗したら部分を捨てる** ── 取る途中で落ちたら、端末の保管には **1 バイトも書かない**
 *  ④ 🔴 **途中で止められる**(止めた後も保管は無傷 / 次の取り込みが「取り込み中」で断られない)
 *  ⑤ 🔴 **重みが書けなかったら、新しく入れた実行の部品も巻き戻す**
 *  ⑥ **進み具合を必ず流す**(0〜100 の字が増えていき、終わったら空へ戻る)
 *  ⑦ 投げない ── 必ず「そのまま出せる文」を返す
 */
import { describe, expect, it, vi } from 'vitest';
import { AsrPackInstaller, type AsrPackInstallDeps } from '../../src/adapter/platform/asr/asr-pack-install';
import type { AsrGroupMeta, AsrInstalled } from '../../src/adapter/platform/asr/asr-pack-store';
import type { FetchLike } from '../../src/adapter/platform/asr/asr-pack-acquire';
import {
  ASR_PARTS,
  ASR_RUNTIME_FILES,
  asrModelDir,
  asrModelFloorBytes,
  type AsrPackFile,
  type AsrPartId,
} from '../../src/features/asr/asr-parts';

const sha = async (b: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

interface World {
  readonly manifest: string;
  readonly bodies: Map<string, Uint8Array>;
  readonly fetched: string[];
  readonly fetchFn: FetchLike;
}

/** 本物の sha256 つきの小さな pack を組む。⚠ 重みの大きさは**目録の下限を満たす**ように作る。 */
async function world(version = 'v1', only: readonly AsrPartId[] = ['light']): Promise<World> {
  const bodies = new Map<string, Uint8Array>();
  const put = async (path: string, n: number, fill: number): Promise<AsrPackFile> => {
    const b = new Uint8Array(n).fill(fill);
    bodies.set(path, b);
    return { path, bytes: n, sha256: await sha(b) };
  };
  const runtime = [
    await put(ASR_RUNTIME_FILES[0]!, 150_000, 1),
    await put(ASR_RUNTIME_FILES[1]!, 6_000, 2),
    await put(ASR_RUNTIME_FILES[2]!, 5_100_000, 3),
  ];
  const models: Record<string, AsrPackFile[]> = {};
  for (const p of ASR_PARTS) {
    if (!only.includes(p.id)) continue;
    models[p.id] = [
      await put(`${asrModelDir(p)}config.json`, 700, 4),
      await put(`${asrModelDir(p)}onnx/m.onnx`, asrModelFloorBytes(p) + 10, 5),
    ];
  }
  const manifest = JSON.stringify({ version, runtime, models });
  const fetched: string[] = [];
  const fetchFn: FetchLike = (url) => {
    fetched.push(url);
    const path = new URL(url).pathname.replace(/^\/asr-pack\//, '');
    if (path === 'pack.json') return Promise.resolve(new Response(manifest));
    const b = bodies.get(decodeURIComponent(path));
    return Promise.resolve(b === undefined ? new Response('nf', { status: 404 }) : new Response(b as BodyInit));
  };
  return { manifest, bodies, fetched, fetchFn };
}

/** 記録つきの偽の保管。⚠ 書いた順番と回数が見える。 */
function fakeStore(opts: { failPart?: boolean } = {}) {
  let runtime: AsrGroupMeta | null = null;
  const parts: Partial<Record<AsrPartId, AsrGroupMeta>> = {};
  const calls: string[] = [];
  const meta = (version: string, files: ReadonlyMap<string, Blob>): AsrGroupMeta => ({
    version,
    installedAt: Date.now(),
    totalBytes: [...files.values()].reduce((s, b) => s + b.size, 0),
    files: [...files.keys()].map((path) => ({ path, bytes: 1, sha256: 'x' })),
  });
  const store: AsrPackInstallDeps['store'] = {
    readInstalled: () =>
      Promise.resolve({ runtime, parts: runtime === null ? {} : { ...parts } } as AsrInstalled),
    writeRuntime: (files, _e, version) => {
      calls.push('writeRuntime');
      runtime = meta(version, files);
      return Promise.resolve(runtime);
    },
    writePart: (id, files, _e, version) => {
      calls.push(`writePart:${id}`);
      if (opts.failPart) return Promise.reject(new Error('QuotaExceededError'));
      parts[id] = meta(version, files);
      return Promise.resolve(parts[id]!);
    },
    removePart: (id) => {
      calls.push(`removePart:${id}`);
      delete parts[id];
      const drop = Object.keys(parts).length === 0 && runtime !== null;
      if (drop) runtime = null;
      return Promise.resolve(drop);
    },
    removeRuntimeIfAlone: () => {
      calls.push('removeRuntimeIfAlone');
      if (Object.keys(parts).length === 0) runtime = null;
      return Promise.resolve();
    },
  };
  return { store, calls, state: () => ({ runtime, parts }) };
}

const installer = (w: World, fs: ReturnType<typeof fakeStore>, extra: Partial<AsrPackInstallDeps> = {}) =>
  new AsrPackInstaller({
    store: fs.store,
    base: '/asr-pack/',
    fetchFn: w.fetchFn,
    persist: () => Promise.resolve(true),
    ...extra,
  });

const fileFetches = (w: World): string[] => w.fetched.filter((u) => !u.endsWith('/pack.json'));

describe('AsrPackInstaller.install', () => {
  it('入れると、実行の部品 → 重みの順に書き、入っている物が返る', async () => {
    const w = await world();
    const fs = fakeStore();
    const r = await installer(w, fs).install('light');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fs.calls).toEqual(['writeRuntime', 'writePart:light']);
    expect(r.installed.parts.light).toBeDefined();
    expect(r.installed.runtime).not.toBeNull();
    expect(r.message).toContain('軽い');
    // 実行の部品 3 + 重み 2 だけを取った
    expect(fileFetches(w)).toHaveLength(5);
  });

  it('🔴 2 回目は取らない ── 同じ版が入っていれば、目録のほかは 1 本も取りに行かない', async () => {
    const w = await world();
    const fs = fakeStore();
    const inst = installer(w, fs);
    await inst.install('light');
    const before = fileFetches(w).length;
    expect(before).toBeGreaterThan(0);
    const again = await inst.install('light');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.message).toContain('取り込み済み');
    expect(fileFetches(w).length, '2 回目にも file を取りに行った').toBe(before);
    expect(fs.calls, '2 回目にも書いた').toEqual(['writeRuntime', 'writePart:light']);
  });

  it('🔴 もう一方を入れるとき、実行の部品は取り直さない(2 択に共通)', async () => {
    const w = await world('v1', ['light', 'accurate']);
    const fs = fakeStore();
    const inst = installer(w, fs);
    await inst.install('light');
    const first = fileFetches(w).length;
    await inst.install('accurate');
    const added = fileFetches(w).slice(first);
    expect(added.every((u) => u.includes('whisper-small')), '実行の部品を取り直した').toBe(true);
    expect(added).toHaveLength(2);
    expect(fs.calls).toEqual(['writeRuntime', 'writePart:light', 'writePart:accurate']);
  });

  it('実行の部品の版が変われば取り直す(重みはそのまま)', async () => {
    const w1 = await world('v1');
    const fs = fakeStore();
    await installer(w1, fs).install('light');
    const w2 = await world('v2', ['light', 'accurate']);
    const r = await installer(w2, fs).install('accurate');
    expect(r.ok).toBe(true);
    expect(fileFetches(w2).filter((u) => u.includes('/runtime/'))).toHaveLength(3);
  });

  it('🔴 取る途中で落ちたら、端末の保管には 1 バイトも書かない', async () => {
    const w = await world();
    const fs = fakeStore();
    // 重みの 2 file 目だけ 404 にする
    const bad: FetchLike = (url, init) =>
      url.includes('whisper-base/onnx') ? Promise.resolve(new Response('x', { status: 404 })) : w.fetchFn(url, init);
    const r = await installer(w, fs, { fetchFn: bad }).install('light');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/取得できません/);
    expect(fs.calls, '落ちたのに保管へ書いた').toEqual([]);
    expect(fs.state()).toEqual({ runtime: null, parts: {} });
  });

  it('🔴 目録の大きさと違う file を取ったら、書かずに断る', async () => {
    const w = await world();
    const fs = fakeStore();
    const short: FetchLike = (url, init) =>
      url.endsWith('config.json') && url.includes('whisper-base')
        ? Promise.resolve(new Response(new Uint8Array(3)))
        : w.fetchFn(url, init);
    const r = await installer(w, fs, { fetchFn: short }).install('light');
    expect(r.ok).toBe(false);
    expect(fs.calls).toEqual([]);
  });

  it('🔴 途中で止められる ── 止めた後も保管は無傷で、次の取り込みが断られない', async () => {
    const w = await world();
    const fs = fakeStore();
    const inst = installer(w, fs);
    const progress: string[] = [];
    const p = inst.install('light', (t) => {
      progress.push(t);
      // 取り込みが始まったら止める
      if (t.startsWith('取り込み中')) inst.cancel();
    });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/やめました/);
    expect(fs.calls, '止めたのに書いた').toEqual([]);
    expect(inst.isRunning()).toBe(false);
    // 対照群:止めた後で、もう一度入れられる
    const again = await inst.install('light');
    expect(again.ok).toBe(true);
  });

  it('止めようとして何も走っていなければ、何も起きない', () => {
    const inst = installer({ manifest: '', bodies: new Map(), fetched: [], fetchFn: vi.fn() as never }, fakeStore());
    expect(() => inst.cancel()).not.toThrow();
  });

  it('🔴 重みが書けなかったら、この回に入れた実行の部品も巻き戻す', async () => {
    const w = await world();
    const fs = fakeStore({ failPart: true });
    const r = await installer(w, fs).install('light');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/空き容量/);
    expect(fs.calls).toEqual(['writeRuntime', 'writePart:light', 'removeRuntimeIfAlone']);
    expect(fs.state().runtime, '重みの無い実行の部品が「入っている」まま残った').toBeNull();
  });

  it('🔴 配っていない 2 択は「まだ配っていません」と言う(取り直しでは直らない)', async () => {
    const w = await world('v1', ['light']);
    const fs = fakeStore();
    const r = await installer(w, fs).install('accurate');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/まだ配っていません/);
    expect(fileFetches(w)).toEqual([]);
    expect(fs.calls).toEqual([]);
  });

  it('目録そのものが無い(404)ときも、投げずに文を返す', async () => {
    const fs = fakeStore();
    const f: FetchLike = () => Promise.resolve(new Response('nf', { status: 404 }));
    const r = await new AsrPackInstaller({ store: fs.store, base: '/asr-pack/', fetchFn: f }).install('light');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/まだ配っていません/);
  });

  it('🔴 進み具合を必ず流す ── 増えていき、終わったら空へ戻る', async () => {
    const w = await world();
    const fs = fakeStore();
    const progress: string[] = [];
    await installer(w, fs).install('light', (t) => progress.push(t));
    expect(progress[0]).toBe('取り先を調べています');
    const pcts = progress.filter((t) => t.startsWith('取り込み中')).map((t) => Number(/(\d+)%/.exec(t)![1]));
    expect(pcts.length).toBeGreaterThan(3);
    expect(pcts.at(-1)).toBe(100);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
    expect(progress).toContain('端末へ書き込んでいます');
    expect(progress.at(-1), '終わっても進みが空に戻らない').toBe('');
  });

  it('失敗しても進みは空へ戻る(「取り込み中」の字が残らない)', async () => {
    const fs = fakeStore();
    const f: FetchLike = () => Promise.reject(new Error('net'));
    const progress: string[] = [];
    const inst = new AsrPackInstaller({ store: fs.store, base: '/asr-pack/', fetchFn: f });
    await inst.install('light', (t) => progress.push(t));
    expect(progress.at(-1)).toBe('');
    expect(inst.isRunning()).toBe(false);
  });

  it('🔴 2 本同時には走らせない', async () => {
    const w = await world();
    const fs = fakeStore();
    const inst = installer(w, fs);
    const first = inst.install('light');
    const second = await inst.install('accurate');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/取り込み中/);
    expect((await first).ok).toBe(true);
  });

  it('「消さずに残す」許可が拒否されたら、黙らずにそう言う(入れるのは続ける)', async () => {
    const w = await world();
    const fs = fakeStore();
    const r = await installer(w, fs, { persist: () => Promise.resolve(false) }).install('light');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toMatch(/自動で消されることがあります/);
    const ok = await installer(w, fakeStore()).install('light');
    if (ok.ok) expect(ok.message).not.toMatch(/自動で消されることがあります/);
  });

  it('知らない部品は断る', async () => {
    const w = await world();
    const r = await installer(w, fakeStore()).install('nope' as AsrPartId);
    expect(r.ok).toBe(false);
  });
});

describe('AsrPackInstaller.remove', () => {
  it('消えたことを確かめてから成功と言う', async () => {
    const w = await world();
    const fs = fakeStore();
    const inst = installer(w, fs);
    await inst.install('light');
    const r = await inst.remove('light');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.installed.parts.light).toBeUndefined();
    expect(fs.calls.at(-1)).toBe('removePart:light');
  });

  it('🔴 消したつもりでまだ残っているなら、成功と言わない', async () => {
    const fs = fakeStore();
    // 消す口が何もしない保管
    const stuck: AsrPackInstallDeps['store'] = {
      ...fs.store,
      readInstalled: () =>
        Promise.resolve({
          runtime: { version: 'v1', installedAt: 0, totalBytes: 1, files: [] },
          parts: { light: { version: 'v1', installedAt: 0, totalBytes: 1, files: [] } },
        }),
      removePart: () => Promise.resolve(false),
    };
    const r = await new AsrPackInstaller({ store: stuck, base: '/asr-pack/' }).remove('light');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/まだ残っています/);
  });

  it('取り込み中は消さない', async () => {
    const w = await world();
    const fs = fakeStore();
    const inst = installer(w, fs);
    const running = inst.install('light');
    const r = await inst.remove('light');
    expect(r.ok).toBe(false);
    await running;
  });

  it('保管が投げても、投げ返さず文を返す', async () => {
    const fs = fakeStore();
    const boom: AsrPackInstallDeps['store'] = {
      ...fs.store,
      removePart: () => Promise.reject(new Error('QuotaExceededError')),
    };
    const r = await new AsrPackInstaller({ store: boom, base: '/asr-pack/' }).remove('light');
    expect(r.ok).toBe(false);
  });
});
