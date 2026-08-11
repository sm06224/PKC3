/** @vitest-environment happy-dom */
/**
 * O6-a: Office 一式の**設置・削除**(#88)。
 *
 * 守りたい主張:
 *  ① 🔴 **投げない** ── 失敗はそのまま画面に出せる文で返る(握り忘れで固まらない)
 *  ② 🔴 **二重起動しない** ── 93MB を 2 本走らせると quota も帯域も倍食う
 *  ③ 🔴 **失敗しても門は開く**(`finally`)── 落ちたまま立つと以後全部断られる
 *  ④ 🔴 **消えたことを確かめてから「削除しました」と言う**
 *  ⑤ 取得元の目録に従う(PKC3 側にフォント名を書き写さない)
 *  ⑥ 進捗を必ず流す ── 93MB の間、無反応にしない
 */
import { describe, expect, it, vi } from 'vitest';
import { OfficePackInstaller } from '../../src/adapter/platform/office/office-pack-install';
import {
  OfficePackError,
  parsePackManifest,
  type OfficePackMeta,
  type PackManifest,
} from '../../src/adapter/platform/office/office-pack';

const META: OfficePackMeta = {
  version: 'lo-wasm-dev',
  installedAt: 1,
  source: 'url',
  totalBytes: 80 * 1024 * 1024,
  files: [],
};

const MANIFEST: PackManifest = {
  version: 'lo-wasm-dev',
  files: ['soffice.js'],
  fonts: ['fonts/BIZUDGothic-Regular.ttf'],
  totalBytes: 1,
};

function make(over: {
  install?: (files: ReadonlyMap<string, Blob>, opts: { version: string; source: 'url' | 'file' }) => Promise<OfficePackMeta>;
  remove?: () => Promise<void>;
  readMeta?: () => Promise<OfficePackMeta | null>;
  fetchManifest?: (base: string) => Promise<PackManifest>;
  fetchFiles?: (base: string, fonts: readonly string[]) => Promise<Map<string, Blob>>;
  readZip?: (zip: Blob) => Promise<Map<string, Blob>>;
} = {}) {
  const progress: string[] = [];
  let stored: OfficePackMeta | null = null;
  const installer = new OfficePackInstaller({
    store: {
      install: over.install ?? (async (_f: unknown, o: { version: string; source: 'url' | 'file' }) => {
        stored = { ...META, version: o.version, source: o.source };
        return stored;
      }),
      remove: over.remove ?? (async () => { stored = null; }),
      readMeta: over.readMeta ?? (async () => stored),
    } as never,
    fetchManifest: (over.fetchManifest ?? (async () => MANIFEST)) as never,
    fetchFiles: (over.fetchFiles
      ?? (async () => new Map([['soffice.js', new Blob(['x'])]]))) as never,
    readZip: (over.readZip
      ?? (async () => new Map([['soffice.js', new Blob(['x'])]]))) as never,
    onProgress: (t) => progress.push(t),
  });
  return { installer, progress, setStored: (m: OfficePackMeta | null) => { stored = m; } };
}

describe('OfficePackInstaller', () => {
  it('配布元から入れると、版と出所が記録される', async () => {
    const { installer } = make();
    const r = await installer.installFromUrl();
    expect(r.ok).toBe(true);
    expect(r.ok && r.meta?.version).toBe('lo-wasm-dev');
    expect(r.ok && r.meta?.source).toBe('url');
    expect(r.ok && r.message).toContain('配備しました');
  });

  it('🔴 目録に従ってフォントを取る(PKC3 側に名前を書き写さない)', async () => {
    const seen: string[][] = [];
    const { installer } = make({
      fetchManifest: async () => ({ ...MANIFEST, fonts: ['fonts/A.ttf', 'fonts/B.ttf'] }),
      fetchFiles: async (_b, fonts) => {
        seen.push([...fonts]);
        return new Map([['soffice.js', new Blob(['x'])]]);
      },
    });
    await installer.installFromUrl();
    expect(seen, '目録のフォントがそのまま渡る').toEqual([['fonts/A.ttf', 'fonts/B.ttf']]);
  });

  it('手元の zip から入れると、出所は file になる', async () => {
    const { installer } = make();
    const r = await installer.installFromZip(new Blob(['zip']), 'lo-wasm-qt6.zip');
    expect(r.ok && r.meta?.source).toBe('file');
    expect(r.ok && r.meta?.version, '選んだ file 名を残す').toBe('lo-wasm-qt6.zip');
  });

  it('🔴 投げない ── 失敗はそのまま出せる文で返る', async () => {
    const { installer } = make({
      fetchManifest: async () => { throw new OfficePackError('取得元に一式がありません'); },
    });
    const r = await installer.installFromUrl();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message, 'こちらが書いた文はそのまま出す').toBe('取得元に一式がありません');
  });

  it('🔴 容量不足は「次に何をすべきか」が分かる文にする', async () => {
    const { installer } = make({
      install: async () => { throw new Error('QuotaExceededError: quota'); },
    });
    const r = await installer.installFromUrl();
    expect(!r.ok && r.message).toContain('保存容量');
    expect(!r.ok && r.message, '必要な量を言う').toContain('77MB');
  });

  it('🔴 二重起動しない(93MB を 2 本走らせない)', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { installer } = make({ fetchManifest: async () => { await gate; return MANIFEST; } });
    const first = installer.installFromUrl();
    expect(installer.isRunning()).toBe(true);
    const second = await installer.installFromUrl();
    expect(second.ok).toBe(false);
    expect(!second.ok && second.message).toContain('すでに設置中');
    release();
    expect((await first).ok).toBe(true);
  });

  it('🔴 失敗しても門は開く(落ちたまま立つと以後全部断られる)', async () => {
    let fail = true;
    const { installer } = make({
      fetchManifest: async () => {
        if (fail) throw new OfficePackError('だめ');
        return MANIFEST;
      },
    });
    expect((await installer.installFromUrl()).ok).toBe(false);
    expect(installer.isRunning(), '走っていない状態に戻る').toBe(false);
    fail = false;
    expect((await installer.installFromUrl()).ok, '次の試行が通る').toBe(true);
  });

  it('🔴 設置中は削除を断る(消しながら書かない)', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const removed = vi.fn(async () => {});
    const { installer } = make({
      fetchManifest: async () => { await gate; return MANIFEST; },
      remove: removed,
    });
    const running = installer.installFromUrl();
    const r = await installer.remove();
    expect(r.ok).toBe(false);
    expect(removed, '実体に触れていない').not.toHaveBeenCalled();
    release();
    await running;
  });

  it('🔴 消えたことを確かめてから「削除しました」と言う', async () => {
    // ⚠ **消えていないのに成功と言わない** ── user は消えたと思って容量を当てにする
    const { installer } = make({ remove: async () => {}, readMeta: async () => META });
    const r = await installer.remove();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('まだ残っています');
  });

  it('削除できたら控えは空になる', async () => {
    const { installer, setStored } = make();
    setStored(META);
    const r = await installer.remove();
    expect(r).toEqual({ ok: true, meta: null, message: 'Office 一式を削除しました' });
  });

  it('🔴 進捗を流す(93MB の間、無反応にしない)', async () => {
    const { installer, progress } = make();
    await installer.installFromUrl();
    expect(progress.length, '1 行も出していない').toBeGreaterThan(2);
    expect(progress.some((p) => p.includes('配備'))).toBe(true);
    expect(progress.at(-1), '終わったら進捗を消す').toBe('');
  });

  it('🔴 失敗しても進捗は消える(字が出たまま固まらない)', async () => {
    const { installer, progress } = make({
      fetchManifest: async () => { throw new OfficePackError('だめ'); },
    });
    await installer.installFromUrl();
    expect(progress.at(-1)).toBe('');
  });

  it('読めない状態は「入っていない」側へ倒す', async () => {
    const { installer } = make({ readMeta: async () => { throw new Error('idb 死亡'); } });
    expect(await installer.readMeta()).toBeNull();
  });
});

describe('parsePackManifest', () => {
  it('揃っていれば読める', () => {
    expect(parsePackManifest(MANIFEST)).toEqual(MANIFEST);
  });

  it('🔴 file が 1 つも無い目録は受け付けない(404 の HTML を読めたことにしない)', () => {
    expect(() => parsePackManifest({ fonts: ['fonts/a.ttf'] })).toThrow(OfficePackError);
    expect(() => parsePackManifest(null)).toThrow(OfficePackError);
    expect(() => parsePackManifest('<!doctype html>')).toThrow(OfficePackError);
  });

  it('🔴 フォントが 1 本も無い目録は受け付けない(日本語が豆腐になる)', () => {
    expect(() => parsePackManifest({ files: ['soffice.js'], fonts: [] })).toThrow(
      /豆腐/,
    );
  });

  it('版が無ければ unknown(嘘の版を作らない)', () => {
    const m = parsePackManifest({ files: ['soffice.js'], fonts: ['fonts/a.ttf'] });
    expect(m.version).toBe('unknown');
    expect(m.totalBytes).toBe(0);
  });
});
