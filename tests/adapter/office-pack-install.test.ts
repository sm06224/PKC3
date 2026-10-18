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
import { OFFICE_PACK_APPROX } from '../../src/features/office/office-pack-size';
import { describe, expect, it, vi } from 'vitest';
import {
  OfficePackInstaller,
  PACK_CANCELLED_MESSAGE,
} from '../../src/adapter/platform/office/office-pack-install';
import { PackAbortedError } from '../../src/adapter/platform/office/office-pack-acquire';
import {
  OfficePackError,
  parsePackManifest,
  type OfficePackMeta,
  type PackBuild,
  type PackManifest,
} from '../../src/adapter/platform/office/office-pack';

const META: OfficePackMeta = {
  version: 'lo-wasm-dev',
  build: null,
  installedAt: 1,
  source: 'url',
  totalBytes: 80 * 1024 * 1024,
  files: [],
};

const MANIFEST: PackManifest = {
  version: 'lo-wasm-dev',
  build: null,
  files: ['soffice.js'],
  fonts: ['fonts/BIZUDGothic-Regular.ttf'],
  totalBytes: 1,
};

function make(over: {
  install?: (
    files: ReadonlyMap<string, Blob>,
    opts: { version: string; source: 'url' | 'file'; build?: PackBuild | null },
  ) => Promise<OfficePackMeta>;
  remove?: () => Promise<void>;
  readMeta?: () => Promise<OfficePackMeta | null>;
  fetchManifest?: (base: string) => Promise<PackManifest>;
  fetchFiles?: (base: string, fonts: readonly string[]) => Promise<Map<string, Blob>>;
  readZip?: (zip: Blob) => Promise<Map<string, Blob>>;
  readZipInfo?: (zip: Blob) => Promise<{ version: string | null; build: PackBuild | null } | null>;
  persist?: () => Promise<boolean>;
} = {}) {
  const progress: string[] = [];
  /** ⚠ **順番まで見る** ── 永続化は「書く前」でないと、書いた分が対象にならない。 */
  const order: string[] = [];
  let stored: OfficePackMeta | null = null;
  const installer = new OfficePackInstaller({
    persist: async () => {
      order.push('persist');
      return (await over.persist?.()) ?? true;
    },
    store: {
      install: over.install ?? (async (
        _f: unknown,
        o: { version: string; source: 'url' | 'file'; build?: PackBuild | null },
      ) => {
        order.push('install');
        // ⚠ **本物と同じ意味論**(#155)── 受け取った素性をそのまま保存する。
        //    stub が捨てると、配線が切れていても test が緑のままになる
        stored = { ...META, version: o.version, source: o.source, build: o.build ?? null };
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
    readZipInfo: (over.readZipInfo ?? (async () => null)) as never,
    onProgress: (t) => progress.push(t),
  });
  return { installer, progress, order, setStored: (m: OfficePackMeta | null) => { stored = m; } };
}

/**
 * 🔴 **目録の `build` を落とさない**(#155)。⚠ 版の文字列は使い回されることがあり、
 * それだけでは**新旧を見分けられない**(`lo-wasm-dev` の頃に実際に起きた)。
 */
describe('ビルドの素性(#155)', () => {
  it('🔴 取得 → 保存まで素性が届く(配線が切れていないこと)', async () => {
    /**
     * ⚠ 目録を読めるだけでは足りない ── **保存された meta に載っている**ことまで
     * 見る。1 稿目は変異試験で「取得時に渡さない」「保存時に捨てる」の 2 つが
     * 生き延びた(どちらも**画面には出ないのに誰も気づかない**形)。
     */
    const build: PackBuild = {
      loSha: 'fb02e9d1fc6277a4',
      builtAt: '2026-08-15T18:39:00Z',
      runId: '31890208793',
      qtRef: '6.9',
      emsdk: '4.0.10',
      pkc3Commit: '1c1866b',
    };
    const { installer } = make({
      fetchManifest: async () => ({ ...MANIFEST, build }),
    });
    const r = await installer.installFromUrl();
    expect(r.ok, '設置に失敗した').toBe(true);
    expect(r.ok && r.meta?.build, '取得した素性が保存まで届いていない').toEqual(build);
  });

  it('目録に素性が無ければ null のまま保存される', async () => {
    const { installer } = make({ fetchManifest: async () => ({ ...MANIFEST, build: null }) });
    const r = await installer.installFromUrl();
    expect(r.ok && r.meta?.build).toBeNull();
  });

  it('目録の build を読む(snake_case → camelCase)', () => {
    const m = parsePackManifest({
      version: 'v1',
      files: ['soffice.js'],
      fonts: ['fonts/a.ttf'],
      build: {
        lo_sha: 'abc123',
        built_at: '2026-08-15T00:00:00Z',
        run_id: '42',
        qt_ref: '6.9',
        emsdk: '4.0.10',
        pkc3_commit: 'deadbeef',
      },
    });
    expect(m.build).toEqual({
      loSha: 'abc123',
      builtAt: '2026-08-15T00:00:00Z',
      runId: '42',
      qtRef: '6.9',
      emsdk: '4.0.10',
      pkc3Commit: 'deadbeef',
    });
  });

  it('🔴 build が無い / 壊れている目録でも一式は受ける(素性だけ null)', () => {
    /**
     * ⚠ 素性が読めないだけで一式を撥ねる理由は無い ── 撥ねると、古い配布元から
     * **入れられなくなる**(後方互換の破壊)。
     */
    const base = { version: 'v1', files: ['soffice.js'], fonts: ['fonts/a.ttf'] };
    expect(parsePackManifest(base).build).toBeNull();
    expect(parsePackManifest({ ...base, build: 'こわれ' }).build).toBeNull();
    expect(parsePackManifest({ ...base, build: { lo_sha: 123 } }).build).toBeNull();
  });
});

describe('OfficePackInstaller', () => {
  it('配布元から入れると、版と出所が記録される', async () => {
    const { installer } = make();
    const r = await installer.installFromUrl();
    expect(r.ok).toBe(true);
    expect(r.ok && r.meta?.version).toBe('lo-wasm-dev');
    expect(r.ok && r.meta?.source).toBe('url');
    expect(r.ok && r.message).toContain('取り込みました');
  });

  /**
   * 🔴 実測(2026-08-12): `{"usageMB":196,"quotaMB":10436,"persisted":false}` ──
   * 一式 196MB が **evictable** のまま置かれていた。容量逼迫時に Chrome が
   * 丸ごと捨てるので、user からは「昨日まで動いてたのに今日は動かない」に見える。
   */
  it('🔴 書く前に保存の永続化を頼む(順番が逆だと書いた分が対象にならない)', async () => {
    const { installer, order } = make();
    const r = await installer.installFromUrl();
    expect(order, '永続化を頼む前に書いている').toEqual(['persist', 'install']);
    // 許可されたときは、余計なことを言わない
    expect(r.ok && r.message).not.toContain('自動で消されることがあります');
  });

  it('🔴 永続化を断られたら、そのことを言う(黙って消えうる状態にしない)', async () => {
    const { installer } = make({ persist: async () => false });
    const r = await installer.installFromUrl();
    expect(r.ok, '断られただけで設置ごと失敗にしない').toBe(true);
    expect(r.ok && r.message).toContain('自動で消されることがあります');
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

  it('🔴 O7: zip に pack.json が在れば、版はその version(file 名ではない)。素性も残る', async () => {
    const build: PackBuild = {
      loSha: 'a', builtAt: 'b', runId: 'c', qtRef: 'd', emsdk: 'e', pkc3Commit: 'f',
    };
    const { installer } = make({ readZipInfo: async () => ({ version: 'lo-wasm-dev', build }) });
    const r = await installer.installFromZip(new Blob(['zip']), 'lo-wasm-qt6.zip');
    expect(r.ok && r.meta?.version, '配布元の版と食い違う file 名を版にしている').toBe('lo-wasm-dev');
    expect(r.ok && r.meta?.build).toEqual(build);
  });

  it('O7: pack.json の読み取りが落ちても取り込みは続け、file 名へ倒す', async () => {
    const { installer } = make({ readZipInfo: async () => { throw new Error('broken'); } });
    const r = await installer.installFromZip(new Blob(['zip']), 'x.zip');
    expect(r.ok && r.meta?.version).toBe('x.zip');
  });

  it('🔴 投げない ── 失敗はそのまま出せる文で返る', async () => {
    const { installer } = make({
      fetchManifest: async () => { throw new OfficePackError('取得元に一式がありません'); },
    });
    const r = await installer.installFromUrl();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message, 'こちらが書いた文が先頭に残る').toMatch(/^取得元に一式がありません/);
    expect(!r.ok && r.message, '出口(ファイルから取り込む)を案内していない').toContain(
      '配布元に届かないときは「ファイルから取り込む」で一式の zip を選んでください。',
    );
  });

  it('🔴 配布元への通信が素の英語で落ちても、日本語の 1 文と出口になる。入手先の URL は書かない', async () => {
    const { installer } = make({
      fetchManifest: async () => { throw new TypeError('Failed to fetch'); },
    });
    const r = await installer.installFromUrl();
    const msg = !r.ok ? r.message : '';
    expect(r.ok).toBe(false);
    expect(msg, '英語の原文がそのまま出ている').not.toContain('Failed to fetch');
    expect(msg).toMatch(/^配布元から取り込めませんでした。/);
    expect(msg).toContain('「ファイルから取り込む」');
    expect(msg, 'URL を書いている').not.toMatch(/https?:|\/office-pack/);
  });

  it('手元の zip からの失敗には、配布元の案内を付けない(対照群)', async () => {
    const { installer } = make({
      readZip: async () => { throw new OfficePackError('この zip に Office 一式が見つかりません。'); },
    });
    const r = await installer.installFromZip(new Blob(['x']), 'a.zip');
    expect(!r.ok && r.message).toBe('この zip に Office 一式が見つかりません。');
  });

  it('🔴 容量不足は「次に何をすべきか」が分かる文にする', async () => {
    const { installer } = make({
      install: async () => { throw new Error('QuotaExceededError: quota'); },
    });
    const r = await installer.installFromUrl();
    expect(!r.ok && r.message).toContain('空き容量');
    expect(!r.ok && r.message, '必要な量を言う').toContain(OFFICE_PACK_APPROX);
  });

  it('🔴 二重起動しない(93MB を 2 本走らせない)', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { installer } = make({ fetchManifest: async () => { await gate; return MANIFEST; } });
    const first = installer.installFromUrl();
    expect(installer.isRunning()).toBe(true);
    const second = await installer.installFromUrl();
    expect(second.ok).toBe(false);
    expect(!second.ok && second.message).toContain('すでに取り込み中');
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
      /□ ばかりになって読めない/,
    );
  });

  it('版が無ければ unknown(嘘の版を作らない)', () => {
    const m = parsePackManifest({ files: ['soffice.js'], fonts: ['fonts/a.ttf'] });
    expect(m.version).toBe('unknown');
    expect(m.totalBytes).toBe(0);
  });
});

/**
 * 🔴 **取り込みをやめる**(台帳 #1852 束 T1、依頼 156 ②)。取得の間は通信を止め、端末には何も書かない。
 * 書き込みに入った後は止められない(理由を言う ── 押して無反応にしない)。
 */
describe('取り込みをやめる(依頼 156 ②)', () => {
  /** 取得が user の合図で止まるまで待つ fetchFiles(本物の取得と同じく signal を見る)。 */
  const waitsForAbort = (): ((base: string, fonts: readonly string[], p?: unknown, s?: number, signal?: AbortSignal) => Promise<never>) =>
    (_b, _f, _p, _s, signal) =>
      new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new PackAbortedError()), { once: true });
      });

  it('🔴 取得中にやめると「やめました」を返し、端末には何も書かず、門は開く', async () => {
    const installs: unknown[] = [];
    const { installer } = make({
      fetchFiles: waitsForAbort() as never,
      install: async (...a) => {
        installs.push(a);
        return META;
      },
    });
    const running = installer.installFromUrl();
    await Promise.resolve();
    await Promise.resolve();
    expect(installer.isRunning()).toBe(true);
    expect(installer.cancel(), 'やめられなかった').toBe(true);
    const r = await running;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.cancelled, 'やめたのが「失敗」と区別できない').toBe(true);
    expect(r.message).toBe(PACK_CANCELLED_MESSAGE);
    expect(r.message, '失敗の案内(ファイルから取り込む…)を足している').not.toContain('ファイルから取り込む');
    expect(installs, 'やめたのに端末へ書いた').toEqual([]);
    expect(installer.isRunning(), 'やめた後も「取り込み中」のまま').toBe(false);
    // 門が開いている ── すぐ入れ直せる
    const again = make();
    expect((await again.installer.installFromUrl()).ok).toBe(true);
  });

  it('🔴 取得が終わる直前にやめた回も、端末には書かない', async () => {
    const installs: unknown[] = [];
    let release!: () => void;
    const { installer } = make({
      fetchFiles: (() =>
        new Promise((resolve) => {
          release = () => resolve(new Map([['soffice.js', new Blob(['x'])]]));
        })) as never,
      install: async (...a) => {
        installs.push(a);
        return META;
      },
    });
    const running = installer.installFromUrl();
    await Promise.resolve();
    await Promise.resolve();
    installer.cancel();
    release();
    const r = await running;
    expect(!r.ok && r.cancelled).toBe(true);
    expect(installs, '合図の後に書いた').toEqual([]);
  });

  it('🔴 端末へ書き始めた後は、やめられない(false)── 書き込みは止めず、最後まで入る', async () => {
    let letGo!: () => void;
    const { installer } = make({
      install: () =>
        new Promise((resolve) => {
          letGo = () => resolve(META);
        }),
    });
    const running = installer.installFromUrl();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(installer.isRunning()).toBe(true);
    expect(installer.cancel(), '書き込み中なのに止められると言った').toBe(false);
    letGo();
    const r = await running;
    expect(r.ok, '書き込みは止めずに完了する').toBe(true);
  });

  it('対照群: 走っていないときのやめるは何も起こさない(false)', () => {
    const { installer } = make();
    expect(installer.cancel()).toBe(false);
  });

  it('対照群: やめていなければ、今までどおり入る', async () => {
    const { installer } = make();
    const r = await installer.installFromUrl();
    expect(r.ok).toBe(true);
  });
});
