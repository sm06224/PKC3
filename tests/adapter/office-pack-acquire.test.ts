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
import {
  fetchPackFromBase,
  readPackFromZip,
} from '../../src/adapter/platform/office/office-pack-acquire';
import { REQUIRED_PACK_FILES } from '../../src/adapter/platform/office/office-pack';

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
