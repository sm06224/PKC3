/** @vitest-environment happy-dom */
/**
 * O1: Office wasm 一式の**取り込み**(#88)。
 *
 * 守りたい主張:
 *  ① zip から**要るものだけ**を採る(probe の png や qtlogo.svg を拾わない)
 *  ② 生の `soffice.wasm` は **gz にしてから**保管の形へ揃える
 *  ③ 揃っていない zip は**その場で**落とす
 *  ④ **別 origin を取得元に指定できない**(ACAO の無い相手で必ず失敗する導線を作らない)
 *  ⑤ 404 を**沈黙で通さない**
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficePackInstaller } from '../../src/adapter/platform/office/office-pack-install';
import {
  PackAbortedError,
  fetchPackFromBase,
  fetchPackManifest,
  packUrlFailureMessage,
  readPackFromZip,
  readPackInfoFromZip,
} from '../../src/adapter/platform/office/office-pack-acquire';
import { REQUIRED_PACK_FILES } from '../../src/adapter/platform/office/office-pack';
import * as zipReader from '../../src/features/import/zip-reader';

vi.mock('../../src/features/import/zip-reader', () => ({
  readZipDirectory: vi.fn(async () => (globalThis as { __zipNames?: string[] }).__zipNames!.map(
    (name) => ({ name }),
  )),
  readZipEntry: vi.fn(async (_zip: Blob, e: { name: string }) => new Blob([`${e.name}-bytes`])),
}));

const setZip = (names: string[]): void => {
  (globalThis as { __zipNames?: string[] }).__zipNames = names;
};

/** CI の release zip に実在する、要らない file も混ぜた一覧。 */
const REALISTIC_ZIP = [
  'soffice.js',
  'qtloader.js',
  'soffice.data.js.metadata',
  'soffice.wasm.gz',
  'soffice.data.gz',
  'inject/BIZUDGothic-Regular.ttf',
  'inject/BIZUDMincho-Regular.ttf',
  // ⚠ 以下は**拾ってはいけない**もの(実際に zip に入っている)
  'qt_soffice.html',
  'qtlogo.svg',
  'favicon.ico',
  'boot.png',
  'boot-probe.json',
  'lo-wasm-qt6/',
];

describe('readPackFromZip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('要るものだけを採り、要らないものは 1 つも拾わない', async () => {
    setZip(REALISTIC_ZIP);
    const files = await readPackFromZip(new Blob(['zip']));
    expect([...files.keys()].sort()).toEqual([
      'fonts/BIZUDGothic-Regular.ttf',
      'fonts/BIZUDMincho-Regular.ttf',
      'qtloader.js',
      'soffice.data.gz',
      'soffice.data.js.metadata',
      'soffice.js',
      'soffice.wasm.gz',
    ]);
    // ⚠ 「拾わない」を数だけで見ない ── 名指しで不在を確かめる
    for (const junk of ['qt_soffice.html', 'qtlogo.svg', 'boot.png', 'favicon.ico']) {
      expect([...files.keys()].some((k) => k.includes(junk)), `${junk} を拾っていない`).toBe(false);
    }
  });

  it('1 段深い zip(lo-wasm-qt6/… )でも採れる', async () => {
    setZip(REQUIRED_PACK_FILES.map((f) => `lo-wasm-qt6/${f}`)
      .concat(['lo-wasm-qt6/inject/BIZUDGothic-Regular.ttf']));
    const files = await readPackFromZip(new Blob(['zip']));
    expect([...files.keys()]).toContain('soffice.js');
    expect([...files.keys()]).toContain('fonts/BIZUDGothic-Regular.ttf');
  });

  it('🔴 生の soffice.wasm しか無い zip は gz にしてから採る', async () => {
    setZip(['soffice.js', 'qtloader.js', 'soffice.data.js.metadata',
      'soffice.wasm', 'soffice.data', 'inject/BIZUDGothic-Regular.ttf']);
    const files = await readPackFromZip(new Blob(['zip']));
    expect([...files.keys()], '保管の形は gz に揃う').toContain('soffice.wasm.gz');
    expect([...files.keys()]).toContain('soffice.data.gz');
    expect([...files.keys()], '生のままでは入れない').not.toContain('soffice.wasm');
    // gzip されている = 先頭 2 バイトが 1f 8b
    const head = new Uint8Array(await files.get('soffice.wasm.gz')!.slice(0, 2).arrayBuffer());
    expect([head[0], head[1]], 'gzip の magic').toEqual([0x1f, 0x8b]);
  });

  it('🔴 揃っていない zip はその場で落とす(欠けた名前を言う)', async () => {
    setZip(['soffice.js', 'qtloader.js', 'soffice.wasm.gz', 'soffice.data.gz',
      'inject/BIZUDGothic-Regular.ttf']);
    await expect(readPackFromZip(new Blob(['zip']))).rejects.toThrow(/soffice\.data\.js\.metadata/);
  });

  it('🔴 フォントが 1 つも無い zip は落とす(日本語は絶対)', async () => {
    setZip([...REQUIRED_PACK_FILES]);
    await expect(readPackFromZip(new Blob(['zip']))).rejects.toThrow(/フォント/);
  });

  it('Office 一式でない zip は「見つかりません」で落とす', async () => {
    setZip(['readme.txt', 'photo.jpg']);
    await expect(readPackFromZip(new Blob(['zip']))).rejects.toThrow(/見つかりません/);
  });
});

describe('O7: readPackInfoFromZip', () => {
  it('🔴 zip の中の pack.json から版とビルドの素性を読む(1 段深くても)', async () => {
    setZip(['lo-wasm-qt6/pack.json', 'lo-wasm-qt6/soffice.js']);
    vi.mocked(zipReader.readZipEntry).mockImplementationOnce(async () => new Blob([JSON.stringify({
      version: 'lo-wasm-dev',
      build: { lo_sha: 'abc', built_at: '2026-10-01', run_id: '1', qt_ref: '6.9', emsdk: '4', pkc3_commit: 'z' },
    })]));
    const info = await readPackInfoFromZip(new Blob(['zip']));
    expect(info?.version).toBe('lo-wasm-dev');
    expect(info?.build?.loSha).toBe('abc');
  });

  it('pack.json が無い zip は null(呼び側が file 名へ倒す)', async () => {
    setZip(['soffice.js']);
    expect(await readPackInfoFromZip(new Blob(['zip']))).toBeNull();
  });
});

describe('fetchPackFromBase', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('🔴 別 origin は受け付けない(ACAO の無い相手で必ず失敗する導線を作らない)', async () => {
    await expect(fetchPackFromBase('https://github.example/office/', ['a.ttf']))
      .rejects.toThrow(/同一 origin/);
  });

  it('🔴 404 を沈黙で通さない', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (
      u.endsWith('qtloader.js')
        ? new Response('not found', { status: 404 })
        : new Response('x', { status: 200 })
    )));
    await expect(fetchPackFromBase('/office/', ['BIZUDGothic-Regular.ttf']))
      .rejects.toThrow(/qtloader\.js.*404/);
  });

  it('🔴 O6: 目録も一式の各 file も cache: no-cache で取る(既定の cache に古い版を握らせない)', async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      inits.push(init);
      return new Response('{}', { status: 200 });
    }));
    await fetchPackManifest('/office-pack/').catch(() => undefined);
    await fetchPackFromBase('/office/', ['a.ttf']).catch(() => undefined);
    expect(inits.length, '目録 1 + 一式 6').toBeGreaterThanOrEqual(7);
    for (const init of inits) expect(init?.cache).toBe('no-cache');
  });

  it('必須 5 つ + 指定フォントを、同一 origin のサブパスから取る', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      asked.push(new URL(u).pathname);
      return new Response('x', { status: 200 });
    }));
    const files = await fetchPackFromBase('/office/', ['BIZUDGothic-Regular.ttf']);
    expect(asked).toEqual([
      '/office/soffice.js',
      '/office/qtloader.js',
      '/office/soffice.data.js.metadata',
      '/office/soffice.wasm.gz',
      '/office/soffice.data.gz',
      '/office/fonts/BIZUDGothic-Regular.ttf',
    ]);
    expect(files.size).toBe(6);
  });

  it('フォントを 1 つも指定しない呼び出しは落とす', async () => {
    await expect(fetchPackFromBase('/office/', [])).rejects.toThrow(/フォント/);
  });
});

describe('取り込みをやめる(台帳 #1852 束 T1、依頼 156 ②)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 返事が来ない通信(signal で止まる)── 本物の fetch と同じく abort で reject する。 */
  const hangs = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          }),
      ),
    );
  };

  it('🔴 通信が止まっていても、やめる合図で打ち切る(60 秒待たない)', async () => {
    hangs();
    const ac = new AbortController();
    const p = fetchPackFromBase('/office/', ['a.ttf'], undefined, 60_000, ac.signal).catch((e: unknown) => e);
    await Promise.resolve();
    ac.abort();
    const e = await p;
    expect(e, '「応答が止まりました」(失敗)ではなく、やめた合図で終わる').toBeInstanceOf(PackAbortedError);
  });

  it('🔴 目録の取得もやめられる。「配布元に届きません」(失敗)と取り違えない', async () => {
    hangs();
    const ac = new AbortController();
    const p = fetchPackManifest('/office-pack/', 60_000, ac.signal).catch((e: unknown) => e);
    await Promise.resolve();
    ac.abort();
    expect(await p).toBeInstanceOf(PackAbortedError);
  });

  it('合図が最初から出ていれば、1 byte も取りに行かない', async () => {
    const f = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', f);
    const ac = new AbortController();
    ac.abort();
    await expect(fetchPackFromBase('/office/', ['a.ttf'], undefined, 60_000, ac.signal)).rejects.toBeInstanceOf(PackAbortedError);
    expect(f).not.toHaveBeenCalled();
  });

  it('対照群: 合図が無ければ今までどおり取れる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 200 })));
    const files = await fetchPackFromBase('/office/', ['a.ttf']);
    expect(files.size).toBe(6);
  });
});

describe('配布元に届かないときの字(user に見える)', () => {
  it('🔴 案内の「ファイルから取り込む」は、設定の画面に実在するボタン名', async () => {
    const { readFileSync } = await import('node:fs');
    const panel = readFileSync('src/adapter/ui/render/office-pack-panel.ts', 'utf8');
    const label = /button\('choose-office-pack', '([^']+)'/.exec(panel)?.[1];
    expect(label, 'ボタンの字を採れていない').toBeDefined();
    expect(packUrlFailureMessage(new Error('x'))).toContain(`「${label}」`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('🔴 目録に届かない / 無いときの字は日本語で、入手先の URL を書かない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const e1 = await fetchPackManifest('/office-pack/').catch((e: Error) => e.message);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nf', { status: 404 })));
    const e2 = await fetchPackManifest('/office-pack/').catch((e: Error) => e.message);
    expect(e1).toBe('配布元に届きません。');
    expect(e2).toBe('配布元に一式が見つかりません(HTTP 404)。');
    for (const m of [e1, e2]) expect(m, 'URL を書いている').not.toMatch(/https?:|pack\.json|\/office-pack/);
  });

  it('出口の案内は、画面のボタン名と同じ字で、素の英語の例外にも付く', () => {
    expect(packUrlFailureMessage(new TypeError('Failed to fetch'))).toBe(
      '配布元から取り込めませんでした。配布元に届かないときは「ファイルから取り込む」で一式の zip を選んでください。',
    );
  });
});

describe('🔴 応答が止まったまま終わらない(#1087)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 開始したきり応答が来ない fetch。⚠ signal を無視する実装でも先へ進めることを見るため、abort には反応しない */
  const stalledFetch = (): ReturnType<typeof vi.fn> => vi.fn(() => new Promise<Response>(() => undefined));

  it('1 file の応答が 60 秒止まれば、その file 名を指して落ちる(abort も送る)', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }));
    const p = fetchPackFromBase('/office/', ['BIZUDGothic-Regular.ttf']).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(signal?.aborted, '60 秒前に切っている').toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const e = await p;
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/soffice\.js.*60 秒/);
    expect(signal?.aborted, 'fetch を止めていない').toBe(true);
  });

  it('進みがある間は切らない(1 file が 60 秒を超えても、塊が来るたびに時計が戻る)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 40_000));
          n += 1;
          if (n > 3) c.close(); else c.enqueue(new Uint8Array([n]));
        },
      });
      return new Response(body, { status: 200 });
    }));
    const p = fetchPackFromBase('/office/', ['a.ttf']);
    const settled = p.then(() => 'ok', (e: Error) => e.message);
    // 1 file あたり 160 秒(> 60 秒)かかるが 40 秒ごとに進んでいる。6 file 分を流す
    await vi.advanceTimersByTimeAsync(170_000 * 7);
    expect(await settled).toBe('ok');
  });

  it('目録の応答が止まっても終わる', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stalledFetch());
    const p = fetchPackManifest('/office-pack/').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await p).toMatch(/60 秒止まりました/);
  });

  it('設置は止まった取得で「失敗」を返し、出口の案内が付き、二重起動の錠も戻る', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).endsWith('pack.json')) {
        return new Response(JSON.stringify({ version: 'v', files: ['soffice.js'], fonts: ['fonts/A.ttf'] }), { status: 200 });
      }
      return new Promise<Response>(() => undefined);
    }));
    const installer = new OfficePackInstaller({
      store: { install: vi.fn(), remove: vi.fn(), readMeta: vi.fn(async () => null) } as never,
      persist: async () => true,
    });
    const p = installer.installFromUrl();
    await vi.advanceTimersByTimeAsync(61_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('配布元に届かないときは「ファイルから取り込む」');
    expect(!r.ok && r.message).toMatch(/60 秒/);
    expect(installer.isRunning(), 'ボタンが戻らない').toBe(false);
  });
});
