/** @vitest-environment node */
/**
 * 配信一式の**版**が、どこから来るか(#125)。
 *
 * 🔴 これは「静かに `unknown` を配り続けた」ことの回帰 test である。
 * `pack.json` の `version` は `PKC3_LO_TAG` だけを見ていたが、office-pack の
 * workflow が env を**取得の step にしか渡していなかった** ── 組み立ては別シェルなので
 * 届かず、**常に `unknown`** だった。⚠ しかも誰も落ちない:一式は正しく組み上がり、
 * 検品も通り、Pages へ配られる。**気づくのは検証の現場**である
 * (実際、新旧の判別を `soffice.js` のバイト数差でやる羽目になった)。
 *
 * ⚠ そして「tag を渡せば直る」でもない ── `lo-wasm-dev` は**使い回し**なので、
 * 中身が入れ替わっても名前が変わらない。だから **一式に同梱した `build-info.json`**
 * を最優先で読む。この test は**その優先順位そのもの**を pin する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⚠ **相対パスで書かない。** 初稿は `'build/office-wasm/make-pages-bundle.mjs'` と
 * 書いて、**shell の cwd 次第で 4 件とも落ちた**(直前の tool 呼び出しで cwd が
 * repo 外へ戻っていた)。落ち方は `execFileSync` の例外なので、
 * **中身の不具合と見分けが付かない** ── 実際、最初は flake だと思いかけた。
 * 🔑 test から呼ぶ外部プロセスの path は、**test file の位置から解決する**。
 */
const BUNDLER = fileURLToPath(
  new URL('../../build/office-wasm/make-pages-bundle.mjs', import.meta.url),
);

const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 起動に要る 5 つ + フォント 1 本を、中身だけ差し替えた極小の一式にする。 */
function fakePack(withBuildInfo: string | null): string {
  const src = mkdtempSync(join(tmpdir(), 'pkc3-pack-'));
  made.push(src);
  for (const f of [
    'soffice.js',
    'soffice.wasm',
    'soffice.data',
    'soffice.data.js.metadata',
    'qtloader.js',
  ]) {
    writeFileSync(join(src, f), `stub:${f}`);
  }
  mkdirSync(join(src, 'inject'));
  writeFileSync(join(src, 'inject', 'BIZUDGothic-Regular.ttf'), 'stub-font');
  if (withBuildInfo !== null) {
    writeFileSync(join(src, 'build-info.json'), withBuildInfo);
  }
  return src;
}

function build(src: string, env: Record<string, string> = {}): Record<string, unknown> {
  const out = mkdtempSync(join(tmpdir(), 'pkc3-site-'));
  made.push(out);
  execFileSync('node', [BUNDLER, src, out], {
    stdio: 'pipe',
    env: { ...process.env, PKC3_LO_TAG: '', ...env },
  });
  return JSON.parse(readFileSync(join(out, 'pack.json'), 'utf-8')) as Record<string, unknown>;
}

describe('配信一式の版', () => {
  it('🔴 一式に同梱された build-info.json を最優先で使う', () => {
    const info = JSON.stringify({ version: 'lo-abc123def456-run99', lo_sha: 'abc123def456' });
    // ⚠ env も**同時に**渡す ── 「env が無いから読めた」で通る形にしない
    const pack = build(fakePack(info), { PKC3_LO_TAG: 'lo-wasm-dev' });
    expect(pack.version, 'tag のほうを拾っている').toBe('lo-abc123def456-run99');
    // 🔑 出どころも残す(どの LO commit かを後から辿れる)
    expect((pack.build as { lo_sha?: string } | null)?.lo_sha).toBe('abc123def456');
  });

  it('build-info.json が無い古い一式では、tag へ落ちる', () => {
    const pack = build(fakePack(null), { PKC3_LO_TAG: 'lo-wasm-dev' });
    expect(pack.version).toBe('lo-wasm-dev');
    expect(pack.build).toBeNull();
  });

  it('どちらも無ければ unknown(ただし組み立ては続ける)', () => {
    const pack = build(fakePack(null));
    expect(pack.version).toBe('unknown');
    // ⚠ 空振り防止 ── 版が取れなくても一式そのものは出来ていること
    expect(Array.isArray(pack.files) && (pack.files as string[]).length).toBeGreaterThan(0);
  });

  it('⚠ build-info.json が壊れていても組み立てを止めない', () => {
    const pack = build(fakePack('{ this is not json'), { PKC3_LO_TAG: 'lo-wasm-dev' });
    expect(pack.version, '壊れた版を読んで落ちている').toBe('lo-wasm-dev');
  });
});
