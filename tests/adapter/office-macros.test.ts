/**
 * 🔴 **user が書いたマクロを、ウィンドウを閉じても残す**(#431 ②)。
 *
 * LO の「My Macros」は `/instdir/user/basic/**`(MEMFS)に在り、閉じると消える ──
 * 窓(`host.html`)が IndexedDB へ退避し、次の起動で **`callMain` より前**に書き戻す。
 *
 * ⚠ `public/office/office-macros.js` は **bundle されない素の JS** である
 * (`host.html` が `<script src>` で読む)。`readFileSync` + `new Function` で読み込んで
 * 当てる(`office-restart-watch.test.ts` と同じ作法)── これをやらないと、
 * 走査も上限も書き戻しも**どの test からも実行されない**。
 *
 * 🔴 守る主張:
 * 1. 3 file(入れ子のディレクトリ込み)を退避 → **空の FS** に書き戻すと 3 file が
 *    同じ bytes で揃う(親ディレクトリも作られる)
 * 2. 前回と同じ中身なら**書かない**(`same`)── 中身を読まずに決める
 * 3. 合計 8MB を超えたら**退避しない**(`too-big`)── そのとき中身を読まない
 * 4. 全部消えたら記録を消す(`empty`)
 * 5. 書き戻しは `/instdir/user/basic` の**外へは書かない**
 * 6. 綴り(IDB の key)が本体(`office-pack-store.ts`)と同じ
 * 7. `host.html` の配線(読む → 起動前に書き戻す → 30 秒 / pagehide で退避 →
 *    初期化で捨てる)── 原文 pin(弱いと自覚して使う)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OFFICE_MACROS_KEY } from '../../src/adapter/platform/office/office-pack-store';

interface Entry {
  path: string;
  size: number;
  mtime: number;
}
interface Saved {
  path: string;
  bytes: Uint8Array;
}
type Plan =
  | { kind: 'same'; signature: string }
  | { kind: 'empty'; signature: string }
  | { kind: 'too-big'; signature: string; bytes: number }
  | { kind: 'save'; signature: string; bytes: number; files: Saved[] };
interface Api {
  DIR: string;
  KEY: string;
  MAX_BYTES: number;
  scan(FS: FakeFs, dir: string): Entry[];
  signature(entries: Entry[]): string;
  totalBytes(entries: Entry[]): number;
  read(FS: FakeFs, entries: Entry[]): Saved[];
  plan(FS: FakeFs, dir: string, last: string | null, max: number): Plan;
  restore(FS: FakeFs, dir: string, files: unknown): number;
}

function load(): Api {
  const src = readFileSync('public/office/office-macros.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeMacros as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}

const api = load();

/**
 * emscripten MEMFS の**意味論を真似た**最小の FS(CLAUDE.md §3「stub は本物の意味論を
 * 真似る」)── `readdir` は `.` / `..` を含む / 親が無い `writeFile` は ENOENT /
 * `stat` は `mode` を持ち `isDir(mode)` で見分ける / `mtime` は Date。
 */
class FakeFs {
  readonly dirs = new Set<string>(['/']);
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  reads = 0;
  private clock = 1000;

  mkdirTree(p: string): void {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (const s of parts) {
      cur += '/' + s;
      this.dirs.add(cur);
    }
  }
  mkdir(p: string): void {
    const parent = p.slice(0, p.lastIndexOf('/')) || '/';
    if (!this.dirs.has(parent)) throw new Error('ENOENT: ' + parent);
    this.dirs.add(p);
  }
  writeFile(p: string, bytes: Uint8Array): void {
    const parent = p.slice(0, p.lastIndexOf('/')) || '/';
    if (!this.dirs.has(parent)) throw new Error('ENOENT: no such directory, ' + parent);
    this.clock += 1000;
    this.files.set(p, { bytes, mtime: this.clock });
  }
  readFile(p: string): Uint8Array {
    const f = this.files.get(p);
    if (!f) throw new Error('ENOENT: ' + p);
    this.reads += 1;
    return f.bytes;
  }
  readdir(p: string): string[] {
    if (!this.dirs.has(p)) throw new Error('ENOTDIR: ' + p);
    const names = new Set<string>(['.', '..']);
    const prefix = p === '/' ? '/' : p + '/';
    for (const k of [...this.dirs, ...this.files.keys()]) {
      if (k.startsWith(prefix) && k !== p) {
        const head = k.slice(prefix.length).split('/')[0];
        if (head) names.add(head);
      }
    }
    return [...names];
  }
  stat(p: string): { mode: number; size: number; mtime: Date } {
    const f = this.files.get(p);
    if (f) return { mode: 0o100644, size: f.bytes.length, mtime: new Date(f.mtime) };
    if (this.dirs.has(p)) return { mode: 0o40755, size: 4096, mtime: new Date(1) };
    throw new Error('ENOENT: ' + p);
  }
  isDir(mode: number): boolean {
    return (mode & 0o170000) === 0o40000;
  }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** LO が実際に置く形: 目録 2 つ + `Standard/` の本体。 */
function seedMacros(fs: FakeFs): void {
  fs.mkdirTree(api.DIR + '/Standard');
  fs.writeFile(api.DIR + '/script.xlc', enc('<library-container/>'));
  fs.writeFile(api.DIR + '/dialog.xlc', enc('<library-container/>'));
  fs.writeFile(api.DIR + '/Standard/Module1.xba', enc('Sub Main\nEnd Sub'));
}

describe('走査(scan)', () => {
  it('入れ子のディレクトリを再帰で集め、path 順に並ぶ(`.` / `..` に潜らない)', () => {
    const fs = new FakeFs();
    seedMacros(fs);
    const got = api.scan(fs, api.DIR).map((e) => e.path);
    expect(got).toEqual([
      api.DIR + '/Standard/Module1.xba',
      api.DIR + '/dialog.xlc',
      api.DIR + '/script.xlc',
    ]);
    // ⚠ 中身は読まない(30 秒ごとに全 file を読むのは無駄)
    expect(fs.reads, '走査が中身を読んでいる').toBe(0);
  });

  it('置き場がまだ無ければ空(LO が一度もマクロを書いていない起動で落ちない)', () => {
    expect(api.scan(new FakeFs(), api.DIR)).toEqual([]);
  });

  it('大きさと mtime を採る(印の材料)', () => {
    const fs = new FakeFs();
    seedMacros(fs);
    const e = api.scan(fs, api.DIR).find((x) => x.path.endsWith('Module1.xba'))!;
    expect(e.size).toBe(enc('Sub Main\nEnd Sub').length);
    expect(typeof e.mtime).toBe('number');
    expect(e.mtime).toBeGreaterThan(0);
  });
});

describe('退避と書き戻し(plan / restore)', () => {
  it('🔴 3 file を退避 → 空の FS に書き戻すと 3 file が同じ bytes で揃う', () => {
    const src = new FakeFs();
    seedMacros(src);
    const p = api.plan(src, api.DIR, null, api.MAX_BYTES);
    expect(p.kind).toBe('save');
    if (p.kind !== 'save') return;
    expect(p.files).toHaveLength(3);
    expect(p.bytes).toBe(api.totalBytes(api.scan(src, api.DIR)));
    // ⚠ bytes は FS が返したまま(base64 にしない ── ゼロコピーの向き)
    expect(p.files.every((f) => f.bytes instanceof Uint8Array)).toBe(true);

    // 🔴 **空の FS**(ディレクトリも無い)へ ── 親を作らなければ ENOENT で落ちる
    const dst = new FakeFs();
    expect(api.restore(dst, api.DIR, p.files)).toBe(3);
    for (const f of p.files) {
      expect(dst.readFile(f.path), f.path + ' が戻っていない').toEqual(src.readFile(f.path));
    }
    // 空振り防止 ── 入れ子の 1 本が実際に入っている
    expect([...dst.files.keys()]).toContain(api.DIR + '/Standard/Module1.xba');
  });

  it('🔴 前回と同じ中身なら書かない(same)── 中身を読まずに決める', () => {
    const fs = new FakeFs();
    seedMacros(fs);
    const first = api.plan(fs, api.DIR, null, api.MAX_BYTES);
    expect(first.kind).toBe('save');
    fs.reads = 0;
    const again = api.plan(fs, api.DIR, first.signature, api.MAX_BYTES);
    expect(again.kind).toBe('same');
    expect(again.signature).toBe(first.signature);
    expect(fs.reads, '同じ中身なのに読んでいる').toBe(0);
  });

  it('1 file 書き換えると印が変わり、また退避する', () => {
    const fs = new FakeFs();
    seedMacros(fs);
    const first = api.plan(fs, api.DIR, null, api.MAX_BYTES);
    fs.writeFile(api.DIR + '/Standard/Module1.xba', enc('Sub Main\nMsgBox 1\nEnd Sub'));
    const next = api.plan(fs, api.DIR, first.signature, api.MAX_BYTES);
    expect(next.kind).toBe('save');
    expect(next.signature).not.toBe(first.signature);
  });

  it('🔴 合計が上限を超えたら退避しない(too-big)── 中身を読まない', () => {
    const fs = new FakeFs();
    fs.mkdirTree(api.DIR);
    // ⚠ 上限「ちょうど」は通り、+1 で止まる(境界を両側から押さえる)
    fs.writeFile(api.DIR + '/big.xba', new Uint8Array(api.MAX_BYTES));
    expect(api.plan(fs, api.DIR, null, api.MAX_BYTES).kind).toBe('save');
    fs.writeFile(api.DIR + '/one.xba', new Uint8Array(1));
    fs.reads = 0;
    const p = api.plan(fs, api.DIR, null, api.MAX_BYTES);
    expect(p.kind).toBe('too-big');
    if (p.kind !== 'too-big') return;
    expect(p.bytes).toBe(api.MAX_BYTES + 1);
    expect(fs.reads, '上限超なのに中身を読んでいる').toBe(0);
    // ⚠ 印は返す ── 呼び側が憶えないと 30 秒ごとに同じ警告が出続ける
    expect(api.plan(fs, api.DIR, p.signature, api.MAX_BYTES).kind).toBe('same');
  });

  it('上限は 8MB', () => {
    expect(api.MAX_BYTES).toBe(8_000_000);
  });

  it('全部消えたら記録を消す(empty)── ただし「元から無い」を消しはしない', () => {
    const fs = new FakeFs();
    // 元から無い: 前回の印(空の走査)と同じなので same
    const none = api.plan(fs, api.DIR, api.signature([]), api.MAX_BYTES);
    expect(none.kind).toBe('same');
    seedMacros(fs);
    const saved = api.plan(fs, api.DIR, null, api.MAX_BYTES);
    for (const k of [...fs.files.keys()]) fs.files.delete(k);
    expect(api.plan(fs, api.DIR, saved.signature, api.MAX_BYTES).kind).toBe('empty');
  });

  it('🔴 書き戻しは置き場の外へ書かない(壊れた記録で起動ごと壊さない)', () => {
    const dst = new FakeFs();
    const n = api.restore(dst, api.DIR, [
      { path: '/instdir/program/soffice.cfg', bytes: enc('x') },
      { path: api.DIR + '/../../program/evil', bytes: enc('x') },
      { path: '/instdir/user/basic2/x.xba', bytes: enc('x') },
      { path: api.DIR + '/ok.xba', bytes: enc('ok') },
      { path: api.DIR + '/nobytes.xba' },
      null,
    ]);
    expect(n).toBe(1);
    expect([...dst.files.keys()]).toEqual([api.DIR + '/ok.xba']);
  });

  it('記録が壊れていても(配列でない)何も書かず 0 を返す', () => {
    const dst = new FakeFs();
    expect(api.restore(dst, api.DIR, { files: 'x' })).toBe(0);
    expect(api.restore(dst, api.DIR, undefined)).toBe(0);
    expect(dst.files.size).toBe(0);
  });
});

/**
 * 🔴 **綴りは 1 つ**(CLAUDE.md §7)。本体(設定の初期化)と窓(退避)が
 * 別の key を持つと、「初期化しました」と言いながらマクロだけ残る。
 */
describe('本体との突き合わせ', () => {
  it('🔴 IDB の key が office-pack-store.ts と同じ綴りである', () => {
    expect(api.KEY).toBe(OFFICE_MACROS_KEY);
  });
  it('置き場は LO の user プロファイルの basic/', () => {
    expect(api.DIR).toBe('/instdir/user/basic');
  });
});

/**
 * 🔴 `host.html` の配線。判断が正しくても、窓が呼んでいなければ user には何も届かない
 * ── そして `host.html` は bundle されないので unit は届かない。**原文で pin する**
 * (弱いと自覚して使う。実挙動は `office-host.smoke.spec.ts` が見る)。
 * ⚠ **実行行だけを見る** ── 解説コメントに満たされないよう、コメント行を落とす。
 */
describe('窓(host.html)の配線', () => {
  const host = readFileSync('public/office/host.html', 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*\*|<!--)/.test(l))
    .join('\n');
  expect(host.length, '抜き出せていない ── 検査が空振りしている').toBeGreaterThan(1000);

  const fnBlock = (name: string): string => {
    const at = host.indexOf(`function ${name}(`);
    expect(at, `${name} が無い`).toBeGreaterThan(-1);
    const next = host.indexOf('\n  function ', at + 1);
    return host.slice(at, next > -1 ? next : at + 2000);
  };

  it('判断を読み込み、直書きへ戻していない', () => {
    expect(host, 'script を読んでいない').toContain('src="office-macros.js"');
    expect(host).toContain('PKC3OfficeMacros');
    // 置き場の綴りは office-macros.js の 1 か所だけ
    expect(host, '置き場が host.html にも書かれている(2 か所)').not.toContain("'/instdir/user/basic'");
  });

  it('🔴 起動前に IDB を読み終え、FS が出来たら callMain より前に書き戻す', () => {
    const readAt = host.indexOf("idbGet(db, 'meta', window.PKC3OfficeMacros.KEY)");
    const bootAt = host.indexOf('await window.qtLoad(');
    const restoreAt = host.indexOf('restoreMacros(FS, savedMacros)');
    const seedAt = host.indexOf('seedWindowSize(FS);');
    const mainAt = host.indexOf('armSaveWatch(FS, docToken)');
    expect(readAt, 'IDB から読んでいない').toBeGreaterThan(-1);
    expect(bootAt).toBeGreaterThan(-1);
    expect(restoreAt, '書き戻していない').toBeGreaterThan(-1);
    expect(mainAt).toBeGreaterThan(-1);
    // ⚠ IDB は非同期 ── 起動(qtLoad)の後ろに置くと callMain に間に合わない
    expect(readAt, '読みが起動より後').toBeLessThan(bootAt);
    expect(restoreAt, '書き戻しが設定の仕込みより前(FS がまだ無い)').toBeGreaterThan(seedAt);
    expect(restoreAt, '書き戻しが起動の後').toBeLessThan(mainAt);
  });

  it('🔴 退避は設定と同じ 2 つの呼び時(30 秒ごと + pagehide)', () => {
    expect(host).toContain('setInterval(function () { saveProfile(FS); saveMacros(FS); }, 30000)');
    const at = host.indexOf('clearInterval(profTimer);');
    expect(at).toBeGreaterThan(-1);
    expect(host.slice(at, at + 300), 'pagehide で退避していない').toContain('saveMacros(FS);');
  });

  it('🔴 捨てると決めた後は退避しない(設定と同じ門 #634)', () => {
    const block = fnBlock('saveMacros');
    expect(block).toContain('if (profileReset) return;');
    // 上限超は console に理由を 1 行
    expect(block).toContain("p.kind === 'too-big'");
    expect(block).toContain('console.warn(');
  });

  it('🔴 「設定を初期化」でマクロも捨てる ── 窓が閉じても戻ってこない', () => {
    const drop = fnBlock('dropProfile');
    expect(drop, '設定だけ捨ててマクロを残している').toContain('dropMacros()');
    const macros = fnBlock('dropMacros');
    expect(macros).toContain("idbDel(db, 'meta', M.KEY)");
    // ⚠ 停止・不調の帯からは**消し終わってから**開き直す(先に reload すると届かない)
    const reload = fnBlock('resetProfileAndReload');
    expect(reload).toContain('settleWrite(dropProfile())');
    expect(reload).toContain('location.reload()');
  });

  it('捨てる前の字にマクロも消えると書いてある', () => {
    expect(host).toContain('書いたマクロを消して開き直します');
    expect(host).toContain('書いたマクロも消えます');
  });
});
