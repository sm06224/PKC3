/** @vitest-environment happy-dom */
/**
 * DuckDB wasm 一式の**取得**(#682 段③a)。
 *
 * 守りたい主張:
 *  ① 目録(`pack.json`)を検めるのは `readDuckDbPack`(pure)── ここで書き直さない
 *     (`fetchDuckDbPackManifest` の断り文が、pure 層の `why` とそのまま一致する)
 *  ② 2 file は**1 つずつ**(同時に 2 本飛ばさない)
 *  ③ 🔴 **取った実体の大きさが目録と食い違ったら断る**(出力を見る検査)
 *  ④ 404 を沈黙で通さない(目録・実体どちらも)
 *  ⑤ 進捗を必ず流す
 *  🔴 ⑥ **取得元が同じ場所(origin)でなければ断る** ── pure 層の `duckDbAssetUrl` は
 *     **ただの文字列の連結**なので、門はこの層にしか無い(2026-09-15 に読み直して判明)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DuckDbPackAcquireError,
  resolveDuckDbBase,
  fetchDuckDbPackFiles,
  fetchDuckDbPackFromBase,
  fetchDuckDbPackManifest,
} from '../../src/adapter/platform/duckdb/duckdb-pack-acquire';
import {
  DUCKDB_PACK_FILES,
  DUCKDB_REQUIRED_FILES,
  DUCKDB_WASM,
  DUCKDB_WORKER,
  duckDbExtensionPath,
  readDuckDbPack,
  type DuckDbPack,
} from '../../src/features/query/duckdb-pack';

/** 実測の byte 数(2026-09-15 = 器 / 2026-09-16 = 拡張)。floor を満たす。 */
const REAL: Readonly<Record<string, number>> = {
  [DUCKDB_WASM]: 35_913_747,
  [DUCKDB_WORKER]: 773_223,
  [duckDbExtensionPath('json')]: 821_413,
  [duckDbExtensionPath('parquet')]: 3_218_307,
  [duckDbExtensionPath('sqlite_scanner')]: 1_641_696,
};

/** ⚠ 一式は `DUCKDB_PACK_FILES` から組む(手で並べると足した日に古くなる)。 */
const manifestText = (over: Partial<{ version: string; files: unknown }> = {}): string =>
  JSON.stringify({
    version: '1.33.1-dev57.0',
    files: DUCKDB_REQUIRED_FILES.map((path) => ({ path, bytes: REAL[path] ?? 0 })),
    ...over,
  });

function mockFetch(handler: (url: string) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL) => handler(String(input))));
}

describe('fetchDuckDbPackManifest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('🟢 揃った目録は読める(同一オリジンの base/pack.json を見る)', async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return new Response(manifestText(), { status: 200 });
    });
    const pack = await fetchDuckDbPackManifest('duckdb/');
    expect(pack.version).toBe('1.33.1-dev57.0');
    /**
     * 🔴 **絶対の字で飛ぶ**(2026-09-15 に変わった)── 門(`resolveDuckDbBase`)が
     *   `document.baseURI` と突き合わせて解決するので、相対のままでは飛ばない。
     * 🔑 **この形が門を通った証拠**である ── 相対のままなら、門を素通りしている。
     */
    expect(seen).toEqual([new URL('duckdb/pack.json', document.baseURI).href]);
  });

  it('🔴 検めるのは pure 層 ── 断り文が readDuckDbPack の `why` とそのまま一致する', async () => {
    // ⚠ 判定を 2 つ目に書いていたら、ここで文言がずれる(CLAUDE.md §7)
    const broken = manifestText({ version: '' });
    mockFetch(() => new Response(broken, { status: 200 }));
    const expected = readDuckDbPack(broken);
    expect(expected.ok).toBe(false);
    await expect(fetchDuckDbPackManifest('duckdb/')).rejects.toThrow(
      !expected.ok ? expected.why : 'unreachable',
    );
  });

  it('🔴 404 を沈黙で通さない ── HTTP status を言う', async () => {
    mockFetch(() => new Response('not found', { status: 404 }));
    await expect(fetchDuckDbPackManifest('duckdb/')).rejects.toThrow(/HTTP 404/);
  });

  it('🔴 通信そのものが失敗したら「届きません」と言う', async () => {
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    await expect(fetchDuckDbPackManifest('duckdb/')).rejects.toThrow(/届きません/);
  });

  it('🔴 JSON として読めない応答を「目録だった」と扱わない(404 の HTML 対策)', async () => {
    mockFetch(() => new Response('<!doctype html>', { status: 200 }));
    await expect(fetchDuckDbPackManifest('duckdb/')).rejects.toThrow(DuckDbPackAcquireError);
  });
});

describe('fetchDuckDbPackFiles', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * ⚠ 目録は**要る物ぜんぶ**を並べる ── 2 つだけ並べると、拡張の取得が
   *   落ちても「大きさが目録と違う」の門が鳴らない(目録に無いものは検めない)。
   * 🔑 `wasm` / `worker` 以外は**器と同じ大きさ**にしておく(fake の応答が
   *   `wasm` かどうかだけで分岐するため)。
   */
  const pack = (bytes: { wasm: number; worker: number }): DuckDbPack => ({
    version: 'v1',
    files: DUCKDB_PACK_FILES.map((path) => ({
      path,
      bytes: path === DUCKDB_WASM ? bytes.wasm : bytes.worker,
    })),
  });

  it('🔴 1 つずつ取る(同時に 2 本飛んでいない)', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const order: string[] = [];
    mockFetch(async (url) => {
      order.push(url);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // ⚠ 次の呼び出しが来る前にわざと間を空ける ── 同時に飛んでいたら
      //   2 本目の fetch がこの `await` の最中に呼ばれ、inflight が 2 になる
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      const body = url.includes(DUCKDB_WASM) ? 'w'.repeat(5) : 'k'.repeat(3);
      return new Response(body);
    });
    const out = await fetchDuckDbPackFiles('duckdb/', pack({ wasm: 5, worker: 3 }));
    expect(maxInflight, '2 本同時に飛んでいた').toBe(1);
    // ⚠ 上と同じ ── 門を通ると絶対の字になる(相対のままなら素通りしている)
    expect(order).toEqual(
      DUCKDB_PACK_FILES.map((n) => new URL(`duckdb/${n}`, document.baseURI).href),
    );
    /**
     * 🔴 **拡張は取りに行かない**(#682 段④b。実測 2026-09-16)── engine は拡張を
     *   **HTTP GET** で取りに来るので、`blob:` で貸す端末の一式には置けない。
     * ⚠ 取ると IDB を食うだけで 1 度も使われない ── だから 2 件のままが正しい。
     */
    expect(order, '取る物の数が変わった').toHaveLength(2);
    expect(out.get(DUCKDB_WASM)?.size).toBe(5);
    expect(out.get(DUCKDB_WORKER)?.size).toBe(3);
  });

  it('🔴 取った実体の大きさが目録と食い違ったら断る(出力を見る検査)', async () => {
    mockFetch((url) => new Response(url.includes(DUCKDB_WASM) ? 'x'.repeat(3) : 'y'.repeat(3)));
    // 目録は wasm が 999 byte だと言っているが、実際に返るのは 3 byte
    await expect(fetchDuckDbPackFiles('duckdb/', pack({ wasm: 999, worker: 3 }))).rejects.toThrow(
      /999 byte.*3 byte/,
    );
  });

  it('🔴 404 を沈黙で通さない(file 名を言う)', async () => {
    mockFetch((url) => new Response('nope', { status: url.includes(DUCKDB_WASM) ? 404 : 200 }));
    await expect(fetchDuckDbPackFiles('duckdb/', pack({ wasm: 5, worker: 5 }))).rejects.toThrow(
      new RegExp(`${DUCKDB_WASM}.*HTTP 404`),
    );
  });

  it('進捗は file ごとに刻まれ、最後に「検査中」が来る', async () => {
    mockFetch((url) => new Response(url.includes(DUCKDB_WASM) ? 'w'.repeat(5) : 'k'.repeat(3)));
    const seen: string[] = [];
    await fetchDuckDbPackFiles('duckdb/', pack({ wasm: 5, worker: 3 }), (phase) => seen.push(phase));
    expect(seen[0]).toContain(DUCKDB_WASM);
    expect(seen[1]).toContain(DUCKDB_WORKER);
    expect(seen.at(-1)).toBe('検査中');
  });
});

describe('fetchDuckDbPackFromBase', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * ⚠ 目録の下限(`readDuckDbPack` の `FLOOR`)を満たしつつ、実体は**その 1 byte 上**に
   * 留める ── これより小さくすると目録の段で断られ、大きくすると(実測 wasm 35MB)
   * このオーケストレーション test のためだけに毎回 35MB を確保することになる。
   */
  const FLOOR_PLUS_ONE: Readonly<Record<string, number>> = {
    [DUCKDB_WASM]: 16_000_001,
    [DUCKDB_WORKER]: 300_001,
    [duckDbExtensionPath('json')]: 400_001,
    [duckDbExtensionPath('parquet')]: 1_500_001,
    [duckDbExtensionPath('sqlite_scanner')]: 800_001,
  };
  /** 🔑 目録が言う大きさを、そのまま fake の応答にも使う(食い違い検査に触れない)。 */
  const sizeOf = (url: string): number => {
    const hit = DUCKDB_REQUIRED_FILES.find((n) => url.includes(n));
    return FLOOR_PLUS_ONE[hit ?? DUCKDB_WASM] ?? 1;
  };
  const floorManifest = (): string =>
    JSON.stringify({
      version: '1.33.1-dev57.0',
      files: DUCKDB_REQUIRED_FILES.map((path) => ({ path, bytes: FLOOR_PLUS_ONE[path] ?? 0 })),
    });

  it('目録を読んでから実体を取り、版を返す', async () => {
    mockFetch((url) => {
      if (url.endsWith('pack.json')) return new Response(floorManifest(), { status: 200 });
      // ⚠ 実サイズを目録と揃える(食い違い検査に触れないため)
      return new Response(new Uint8Array(sizeOf(url)));
    });
    const { files, version } = await fetchDuckDbPackFromBase('duckdb/');
    expect(version).toBe('1.33.1-dev57.0');
    expect(files.size, '取る物の数が変わった').toBe(DUCKDB_PACK_FILES.length);
  });

  it('🔴 目録の取得そのものは刻まない ── 進捗は file の取得から始まる', async () => {
    // ⚠ 「取り掛かった」ことを伝える 1 行は呼び側(duckdb-pack-install.ts)の役目。
    //   ここが目録の分まで刻むと、install 側と 2 か所で同じ narrative を持つことになる。
    mockFetch((url) => {
      if (url.endsWith('pack.json')) return new Response(floorManifest(), { status: 200 });
      return new Response(new Uint8Array(sizeOf(url)));
    });
    const seen: string[] = [];
    await fetchDuckDbPackFromBase('duckdb/', (phase) => seen.push(phase));
    expect(seen[0]).toContain(DUCKDB_WASM);
    expect(seen.at(-1)).toBe('検査中');
  });
});


describe('🔴 取得元は同じ場所でなければならない(#682 段③a)', () => {
  /**
   * ⚠ **ここが唯一の門である。** `duckDbAssetUrl`(pure)は文字列を繋ぐだけなので、
   *   `base` に外の宛先を渡せば**そのまま組めてしまう** ── 直す前はその事実に反して
   *   「外の宛先を組める形にしない」と docstring に書いてあった。
   * 🔑 だから**この層で断る**ことを、外と内の両側で pin する。
   */
  it('別の場所(origin)を渡したら断る ── 理由も言う', () => {
    const here = 'https://example.test/app/';
    for (const away of ['https://evil.test/duckdb/', 'http://example.test/app/', 'https://cdn.jsdelivr.net/npm/']) {
      let why = '';
      try {
        resolveDuckDbBase(away, here);
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      expect(why, `${away} が通ってしまった`).toContain('同じ場所');
      // ⚠ 「駄目です」で終わらせない ── なぜ道が無いのかを言う
      expect(why).toContain('CORS');
    }
  });

  it('⚠ 空振りしていない ── 同じ場所なら通り、末尾の / も揃う(対照群)', () => {
    const here = 'https://example.test/app/index.html';
    expect(resolveDuckDbBase('duckdb/', here)).toBe('https://example.test/app/duckdb/');
    // ⚠ `/` を書き忘れても足す(呼び側の書き方で門の通り方が変わらない)
    expect(resolveDuckDbBase('duckdb', here)).toBe('https://example.test/app/duckdb/');
    // 🔑 絶対 path も、同じ場所なら通る
    expect(resolveDuckDbBase('/duckdb/', here)).toBe('https://example.test/duckdb/');
  });

  it('🔴 取りに行く 2 か所(目録と実体)が、どちらも門を通っている', async () => {
    const here = 'https://example.test/app/';
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string) => {
        seen.push(u);
        return Promise.reject(new Error('この test では届かせない'));
      }),
    );
    // ⚠ 片方だけ門を通していれば、もう片方は外の宛先で飛ぶ ── だから両方を見る
    await expect(fetchDuckDbPackManifest('https://evil.test/x/')).rejects.toThrow('同じ場所');
    await expect(
      fetchDuckDbPackFiles('https://evil.test/x/', { version: '1', files: [] }),
    ).rejects.toThrow('同じ場所');
    expect(seen, '断ったのに取りに行っている').toEqual([]);
    void here;
  });
});
