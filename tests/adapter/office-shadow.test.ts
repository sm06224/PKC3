/**
 * 🔴 **Office の窓の「影」(編集中の文書の写し)を自前で書く**(#1228 段 1)。
 *
 * ⚠ `public/office/office-shadow.js` は **bundle されない素の JS**(`host.html` が `<script src>` で読む)。
 * `readFileSync` + `new Function` で**実 file を読んで**当てる(`office-unsaved.test.ts` と同じ形)。
 *
 * 🔴 守る主張:
 * 1. 差し替えの口 ── `begin()` 〜 `end()` の間**だけ** `fd_sync` が同期の 0 を返す。外では素の側
 *    (開いていない fd は EBADF = 元の `fd_sync` が返していた値)。重ねた `begin()` は断る
 * 2. 起動の import へ**包む**(`env` / `wasi_snapshot_preview1` の両方・当たらなければ空を返す)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

interface Gate {
  fdSync(fd: number): number;
  wrapImports(imports: unknown): string[];
  begin(): void;
  end(): void;
  isActive(): boolean;
  counts(): { gated: number; passed: number; ebadf: number; unsyncedMount: number };
}
interface Api {
  QUIET_MS: number;
  SHADOW_FILTERS: Record<string, string>;
  extOfName(name: string): string;
  filterFor(ext: string): string | null;
  createSyncGate(getFS: () => unknown): Gate;
}

function load(): Api {
  const src = readFileSync('public/office/office-shadow.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeShadow as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}
const api = load();

/** 開いている fd だけ stream を返す偽の FS。`syncfs` を持つ mount を差せる。 */
function fakeFS(open: readonly number[], syncfsMount = false) {
  return {
    getStream(fd: number) {
      if (!open.includes(fd)) return undefined;
      return { node: { mount: { type: syncfsMount ? { syncfs: () => undefined } : {} } } };
    },
  };
}

describe('🔴 fd_sync の差し替えの口(#1228 段 1)', () => {
  it('begin 〜 end の間だけ 0 を返す。外では素の側(開いていない fd は EBADF = 8)', () => {
    const g = api.createSyncGate(() => fakeFS([3]));
    // 外(既定): 素の側 ── 開いていない fd(99)は元の fd_sync と同じく 8 を返す
    expect(g.fdSync(99), '既定が素でない(開いていない fd が 0 になっている)').toBe(8);
    expect(g.fdSync(3)).toBe(0);
    g.begin();
    expect(g.isActive()).toBe(true);
    // 中: 同期の 0 ── **開いていない fd でも** 0(差し替えが効いている証拠。素の側なら 8)
    expect(g.fdSync(99), '影を書く間なのに素の側のまま').toBe(0);
    g.end();
    expect(g.isActive()).toBe(false);
    // 戻した後: 素へ戻る(戻し忘れの検出 ── ここで 0 のままなら差し替えが残っている)
    expect(g.fdSync(99), 'end の後も差し替えが残っている').toBe(8);
  });

  it('呼ぶ回数を数える(中 / 外 / EBADF)── どちらの側を通ったかが後から見える', () => {
    const g = api.createSyncGate(() => fakeFS([3]));
    g.fdSync(3); g.fdSync(99);
    g.begin(); g.fdSync(3); g.fdSync(4); g.fdSync(5); g.end();
    expect(g.counts()).toEqual({ gated: 3, passed: 2, ebadf: 1, unsyncedMount: 0 });
  });

  it('🔴 begin を重ねて呼ぶと断る(先の end で後の書き出しが SuspendError になるため)', () => {
    const g = api.createSyncGate(() => fakeFS([]));
    g.begin();
    expect(() => g.begin()).toThrow(/重なった/);
    // 断った後も、元の begin は有効なまま ── end で戻る
    expect(g.isActive()).toBe(true);
    g.end();
    expect(g.isActive()).toBe(false);
    // end は何度呼んでも安全(finally で必ず呼べる)
    expect(() => { g.end(); g.end(); }).not.toThrow();
    // 戻れば、もう一度 begin できる
    expect(() => { g.begin(); g.end(); }).not.toThrow();
  });

  it('FS がまだ無い(起動前)/ 例外を投げる FS でも、素の側は 0 を返し落ちない', () => {
    expect(api.createSyncGate(() => null).fdSync(3)).toBe(0);
    const g = api.createSyncGate(() => ({ getStream() { throw new Error('boom'); } }));
    expect(g.fdSync(3), 'getStream が例外のとき EBADF にしていない').toBe(8);
  });

  it('🔴 syncfs を持つ mount は、黙って 0 を返さず数える(この窓の MEMFS には無いので 0 件のはず)', () => {
    const g = api.createSyncGate(() => fakeFS([3], true));
    expect(g.fdSync(3)).toBe(0);
    expect(g.counts().unsyncedMount).toBe(1);
    const g2 = api.createSyncGate(() => fakeFS([3], false));
    g2.fdSync(3);
    expect(g2.counts().unsyncedMount, '対照群(syncfs 無し)で数えている').toBe(0);
  });

  it('起動の import へ包む: env / wasi_snapshot_preview1 のどちらにあっても、他の import は触らない', () => {
    const g = api.createSyncGate(() => null);
    const other = () => 1;
    const both = { env: { fd_sync: {}, fd_write: other }, wasi_snapshot_preview1: { fd_sync: {}, fd_read: other } };
    expect(g.wrapImports(both)).toEqual(['env', 'wasi_snapshot_preview1']);
    expect(both.env.fd_sync).toBe(g.fdSync);
    expect(both.wasi_snapshot_preview1.fd_sync).toBe(g.fdSync);
    expect(both.env.fd_write, '他の import を巻き込んだ').toBe(other);
    expect(both.wasi_snapshot_preview1.fd_read).toBe(other);
    // 片方だけ
    const one = { wasi_snapshot_preview1: { fd_sync: {} } };
    expect(g.wrapImports(one)).toEqual(['wasi_snapshot_preview1']);
    // 🔴 当たらないときは**空**を返す(呼び側が「影は書けない」と知る)── 空振りを true にしない
    expect(g.wrapImports({ env: { fd_write: other } })).toEqual([]);
    expect(g.wrapImports({})).toEqual([]);
    expect(g.wrapImports(null)).toEqual([]);
  });

  it('影を書ける形式は .odt / .docx だけ。.docx は FilterName を明示する(渡さないと ODF で書かれる)', () => {
    expect(api.filterFor('docx')).toBe('MS Word 2007 XML');
    expect(api.filterFor('DOCX')).toBe('MS Word 2007 XML');
    expect(api.filterFor('odt')).toBe('writer8');
    // 測っていない形式は書かない(null)
    for (const e of ['xlsx', 'pptx', 'ods', 'odp', 'rtf', 'doc', '', 'constructor', '__proto__']) {
      expect(api.filterFor(e), `${e} を書こうとしている`).toBeNull();
    }
    expect(api.extOfName('報告 書.DOCX')).toBe('docx');
    expect(api.extOfName('noext')).toBe('');
  });
});

/** `host.html` の**実行する行だけ**(解説コメントに満たされない。CLAUDE.md §1 の 5 度目)。 */
function hostCode(): string {
  return readFileSync('public/office/host.html', 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|<!--)/.test(l))
    .join('\n');
}

describe('🔴 host.html の配線(原文の pin ── host.html は bundle されず unit が届かない)', () => {
  const host = hostCode();
  it('script を読み、起動の import へ包む(instantiateStreaming より前・instantiateWasm の中)', () => {
    expect(host.length, '抜き出せていない ── 検査が空振りしている').toBeGreaterThan(1000);
    expect(host).toContain('<script src="office-shadow.js"></script>');
    const i = host.indexOf('instantiateWasm: function (imports, ok)');
    const j = host.indexOf('WebAssembly.instantiateStreaming(', i);
    const k = host.indexOf('shadowGate.wrapImports(imports)', i);
    expect(i, 'instantiateWasm を抜き出せていない').toBeGreaterThan(0);
    expect(k, '起動の import を包んでいない').toBeGreaterThan(i);
    expect(k, '包むのが instantiateStreaming より後(import は instantiate の時に決まる)').toBeLessThan(j);
  });
});

