/** @vitest-environment node */
/**
 * 🔴 **OSS 表記を焼く plugin(#948)**。
 *
 * ⚠ plugin の hook は Vite を起こさないと走らない(`body-css-plugin.test.ts` と
 * 同じ戒め)。ここは**配線**(resolveId / load / watch)と、**焼く中身の門**
 * (`collectOssNotices` ── 0 件 / 解決できない依存 / license が無い依存を
 * 全部止めるか)を、**合成した root**(fs を mock せず、実際にディレクトリを作る)で見る。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOssNotices, OSS_NOTICES_ID, ossNoticesPlugin } from '../../build/oss-notices-plugin';

interface FixtureDep {
  readonly license?: string | { type: string };
  /** `LICENSE` 系 file を置くか(置くならその中身)。 */
  readonly licenseText?: string;
  /** ⚠ **`exports` map で `./package.json` を塞ぐ**(実物の duckdb-wasm / chart.js と同じ形)。 */
  readonly blockPackageJsonExport?: boolean;
  /** ⚠ `node_modules` に実体を置かない(解決できない依存を作るため)。 */
  readonly missing?: boolean;
  /** `package.json` に `license` field を書かない(門を試すため)。 */
  readonly omitLicense?: boolean;
}

/** 合成 root を作る。⚠ **fs を mock せず、実際に置く** ── 実物の解決経路を通す。 */
function makeRoot(deps: Record<string, FixtureDep>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-oss-notices-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-root', dependencies: Object.fromEntries(
      Object.keys(deps).map((n) => [n, '1.0.0']),
    ) }),
  );
  for (const [name, opt] of Object.entries(deps)) {
    if (opt.missing) continue;
    const pkgDir = join(dir, 'node_modules', name);
    mkdirSync(pkgDir, { recursive: true });
    const pkgJson: Record<string, unknown> = { name, main: 'index.js' };
    if (!opt.omitLicense) pkgJson['license'] = opt.license ?? 'MIT';
    if (opt.blockPackageJsonExport) pkgJson['exports'] = { '.': './index.js' };
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n');
    if (opt.licenseText !== undefined) {
      writeFileSync(join(pkgDir, 'LICENSE'), opt.licenseText);
    }
  }
  return dir;
}

describe('collectOssNotices(root)', () => {
  it('全文が在る依存と無い依存を、両方とも事実のまま返す(⚠ わざと逆順で書く ── 並びが名前順であることも見る)', () => {
    const root = makeRoot({
      'no-license-file': { license: 'Apache-2.0' },
      'has-license': { license: 'MIT', licenseText: 'MIT full text here\n' },
    });
    try {
      const got = collectOssNotices(root);
      // ⚠ 並びは名前順で固定(package.json の書かれた順ではない ── 上で逆に書いてある)
      expect(got.map((n) => n.name)).toEqual(['has-license', 'no-license-file']);
      expect(got[0]).toEqual({ name: 'has-license', license: 'MIT', text: 'MIT full text here\n' });
      // 🔴 **捏造しない** ── 全文が無ければ `null`(ひな型を当てはめない)
      expect(got[1]).toEqual({ name: 'no-license-file', license: 'Apache-2.0', text: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 大文字小文字・拡張子違いのライセンス file も拾う(`LICENSE.md` / `LICENCE`)', () => {
    const root = makeRoot({
      'md-ext': { license: 'MIT', licenseText: 'md license\n' },
    });
    // ⚠ file 名を上書き(makeRoot は `LICENSE` 固定) ── 実物の chart.js は `LICENSE.md`
    rmSync(join(root, 'node_modules/md-ext/LICENSE'));
    writeFileSync(join(root, 'node_modules/md-ext/LICENSE.md'), 'md license\n');
    try {
      const got = collectOssNotices(root);
      expect(got[0]!.text, 'LICENSE.md を拾えていない').toBe('md license\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 `exports` map が `./package.json` を塞いでいても root を見つける(実物の duckdb-wasm / chart.js と同じ形)', () => {
    const root = makeRoot({
      blocked: { license: 'MIT', blockPackageJsonExport: true },
    });
    try {
      const got = collectOssNotices(root);
      expect(got, '`exports` に塞がれて解決できていない').toEqual([
        { name: 'blocked', license: 'MIT', text: null },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 空振り防止(下限):dependencies が 0 件なら build を止める', () => {
    const root = makeRoot({});
    try {
      expect(() => collectOssNotices(root), '0 件なのに通っている').toThrow('0 件');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 解決できない依存(node_modules に実体が無い)は、黙って落とさず止める', () => {
    const root = makeRoot({ ghost: { missing: true } });
    try {
      expect(() => collectOssNotices(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 license field が無い依存は、黙って UNKNOWN にせず止める', () => {
    const root = makeRoot({ 'no-license-field': { omitLicense: true } });
    try {
      expect(() => collectOssNotices(root)).toThrow('license がありません');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 依存を 1 つ増やすと、一覧もその場で増える(手書きの一覧ではない証拠)', () => {
    const before = makeRoot({ a: { license: 'MIT' } });
    const after = makeRoot({ a: { license: 'MIT' }, b: { license: 'ISC' } });
    try {
      expect(collectOssNotices(before).map((n) => n.name)).toEqual(['a']);
      expect(collectOssNotices(after).map((n) => n.name)).toEqual(['a', 'b']);
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(after, { recursive: true, force: true });
    }
  });
});

/** Rollup の plugin context の最小の代役(この plugin が触る 2 つだけ)。 */
function context(): { addWatchFile: ReturnType<typeof vi.fn> } {
  return { addWatchFile: vi.fn() };
}

describe('ossNoticesPlugin() の配線', () => {
  const plugin = ossNoticesPlugin();
  const resolveId = plugin.resolveId as unknown as (this: unknown, id: string) => string | null;
  const load = plugin.load as unknown as (this: ReturnType<typeof context>, id: string) => string | null;

  it('名前を解決する(解決後の id は他の plugin が触らない印を持つ)', () => {
    const id = resolveId.call(context(), OSS_NOTICES_ID);
    expect(id, '名前が解決していない').toBeTruthy();
    expect(id!.charCodeAt(0), '解決後の id に NUL の印が無い').toBe(0);
  });

  it('⚠ 他の id は掴まない', () => {
    expect(resolveId.call(context(), 'virtual:something-else')).toBeNull();
    expect(load.call(context(), '/src/main.ts')).toBeNull();
  });

  it('🔴 実物の root(このリポジトリ自身)で、7 件の依存を default export で返す', () => {
    const ctx = context();
    const id = resolveId.call(ctx, OSS_NOTICES_ID)!;
    const code = load.call(ctx, id)!;
    expect(code, 'default export になっていない').toMatch(/^export default \[/);
    const notices = JSON.parse(code.replace(/^export default /, '').replace(/;$/, '')) as unknown[];
    expect(notices.length, '実物の package.json と件数が違う').toBeGreaterThan(0);
  });

  it('🔴 package.json の変更を監視に載せる', () => {
    const ctx = context();
    const id = resolveId.call(ctx, OSS_NOTICES_ID)!;
    load.call(ctx, id);
    const watched = ctx.addWatchFile.mock.calls.map((c) => String(c[0]));
    expect(watched.some((p) => p.endsWith('package.json')), 'package.json を監視していない').toBe(
      true,
    );
  });

  /**
   * 🔴 **不合格のときに本当に build が止まる**(`body-css-plugin.test.ts` と同じ形)。
   * ⚠ ここが繋がっていないと、`collectOssNotices` をどれだけ厳しくしても
   * **出荷は止まらない**。
   */
  it('🔴 root を差し替えて 0 件になったら、load が例外を投げる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-oss-notices-empty-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
    const p = ossNoticesPlugin();
    (p.configResolved as (c: { root: string }) => void).call(undefined, { root: dir });
    const id = (p.resolveId as unknown as (id: string) => string | null).call(undefined, OSS_NOTICES_ID)!;
    const ld = p.load as unknown as (this: ReturnType<typeof context>, id: string) => string | null;
    try {
      expect(() => ld.call(context(), id)).toThrow('0 件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 🔴 **配り先 3 つのどれかから、この plugin が抜け落ちたら落ちる**(#948)。
 *
 * ⚠ `help.ts` が `virtual:pkc-oss-notices` を静的 import するので、この plugin が
 * 抜けている経路は **import 解決そのものが失敗する**(build が止まる/描画が壊れる)。
 * 🔑 3 か所すべてに実際に `npm run build` / `npm run build:portable` を通して
 *   確かめてある(手順書に記録)── ここは**その配線が消えていないか**の pin。
 */
describe('🔴 配り先 3 つに配線されている', () => {
  const readSrc = (path: string): string => readFileSync(path, 'utf8');

  it('vite.config.ts(dist)', () => {
    expect(readSrc('vite.config.ts')).toContain('ossNoticesPlugin(');
  });

  it('build/portable.config.ts(持ち歩ける 1 枚)', () => {
    expect(readSrc('build/portable.config.ts')).toContain('ossNoticesPlugin(');
  });

  it('build/manual-page-plugin.ts の bakeWithServer(help.ts を ssrLoadModule する内側の使い捨てサーバ)', () => {
    const src = readSrc('build/manual-page-plugin.ts');
    // ⚠ `bodyCssPlugin()` と同じ配列に居ることを見る(その配列がまさに
    //   `help.ts` を読む使い捨てサーバの plugins である)
    const at = src.indexOf('plugins: [bodyCssPlugin()');
    expect(at, '使い捨てサーバの plugins 配列が見つからない(空振り)').toBeGreaterThanOrEqual(0);
    expect(src.slice(at, at + 80)).toContain('ossNoticesPlugin()');
  });
});
