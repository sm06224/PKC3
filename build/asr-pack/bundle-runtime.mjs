/**
 * 🔴 **音声認識の「実行の部品」を 1 枚に束ねる**(#772 段 1)。
 *
 * 出力(`--out <dir>` の下。既定 `dist-asr-pack/`)── 名前は `src/features/asr/asr-parts.ts` の
 * `ASR_RUNTIME_FILES` と**同じ**である(取る側が目録で名指しする物):
 *
 *   runtime/transformers.mjs   transformers.js(web 版)+ onnxruntime-web を 1 枚の ESM に束ねた物
 *   runtime/ort-wasm.mjs       ORT の `ort-wasm-simd-threaded.mjs`(wasm の読み込み役)
 *   runtime/ort-wasm.wasm      ORT の `ort-wasm-simd-threaded.wasm`(素の wasm。14.3MB)
 *   bundle-info.json           何を束ねたか(版 / 束ねに入った package 全数 / bytes)── make-pack が `build` に写す
 *
 * ⚠ **依存は `build/asr-pack/package.json` の物を使う**(PKC3 本体の `package.json` に混ぜない ──
 *   `build/oss-notices-plugin.ts` が本体の `dependencies` を「使っている OSS」として数えるため)。
 * ⚠ **版は transformers が名指しする onnxruntime-web に揃える**(`@huggingface/transformers@4.3.0` →
 *   ORT-web `1.31.0-dev.20260914-8d85527a0`)。揃っていなければここで止める ── 別の版の
 *   wasm と js を組み合わせると、実行時にだけ壊れる。
 * 🔴 **bare import を残さない**:束ねた後の出力を esbuild で読み直し、`import 'xxx'` / `require('xxx')` の
 *   裸の指定子が 1 件でも在れば止める(ブラウザの worker は解決できない ── 開いた瞬間に落ちる)。
 *   ⚠ 検める対象は**出力**であって、束ねる前の設定ではない(設定が正しくても残ることがある)。
 */
import { build, transform } from 'esbuild';
import { assertNoBareImports } from './bare-imports.mjs';
import { packageOfInput } from './collect-licenses.mjs';
import { assertOrtVersionMatches, assertRuntimeNamesMatch } from './runtime-guards.mjs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT, REPO_ROOT, loadAsrParts } from './src-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export { DEFAULT_OUT, REPO_ROOT };

const NM = join(HERE, 'node_modules');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function bundleRuntime({ outDir = DEFAULT_OUT } = {}) {
  const pkgTransformers = readJson(join(NM, '@huggingface', 'transformers', 'package.json'));
  const pkgOrt = readJson(join(NM, 'onnxruntime-web', 'package.json'));
  assertOrtVersionMatches(pkgTransformers, pkgOrt);

  const ortBundle = join(NM, 'onnxruntime-web', 'dist', 'ort.webgpu.bundle.min.mjs');
  const entry = join(NM, '@huggingface', 'transformers', 'dist', 'transformers.web.js');
  for (const f of [entry, ortBundle]) {
    if (!existsSync(f)) throw new Error(`束ねる元がありません: ${f}(build/asr-pack で npm ci したか)`);
  }

  mkdirSync(join(outDir, 'runtime'), { recursive: true });
  const outJs = join(outDir, 'runtime', 'transformers.mjs');

  const res = await build({
    entryPoints: [entry],
    outfile: outJs,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    // ⚠ 動いた形(`docs/development/asr-measure-2026-10.md` §8)。2 つとも同じ 1 枚へ向ける
    alias: {
      'onnxruntime-web/webgpu': ortBundle,
      'onnxruntime-common': ortBundle,
    },
    metafile: true,
    absWorkingDir: HERE,
    logLevel: 'warning',
  });

  // 束ねに入った package を**全数**出す(metafile の入力から引く。推測しない)
  const pkgs = new Map();
  for (const [path, info] of Object.entries(res.metafile.inputs)) {
    const p = packageOfInput(path);
    if (p === null) continue;
    const abs = join(HERE, p.dir);
    const meta = existsSync(join(abs, 'package.json')) ? readJson(join(abs, 'package.json')) : {};
    const row = pkgs.get(p.name) ?? {
      name: p.name,
      version: typeof meta.version === 'string' ? meta.version : null,
      license: typeof meta.license === 'string' ? meta.license : null,
      dir: abs,
      inputBytes: 0,
    };
    row.inputBytes += info.bytes;
    pkgs.set(p.name, row);
  }
  const packages = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (packages.length === 0) throw new Error('束ねに入った package が 0 件(metafile が空)');
  for (const need of ['@huggingface/transformers', 'onnxruntime-web']) {
    if (!pkgs.has(need)) throw new Error(`束ねに ${need} が入っていません(alias が当たっていない)`);
  }

  // 🔴 裸の指定子を残さない(出力を読み直す)
  const code = readFileSync(outJs, 'utf8');
  await assertNoBareImports(code, '束ねた transformers.mjs');
  // 構文として読めること(壊れた出力を「出た」と数えない)
  await transform(code, { loader: 'js', format: 'esm' });

  // ORT の wasm と読み込み役を写す(名前は asr-parts.ts の ASR_RUNTIME_* と同じ)
  const dist = join(NM, 'onnxruntime-web', 'dist');
  const loader = join(dist, 'ort-wasm-simd-threaded.mjs');
  const wasm = join(dist, 'ort-wasm-simd-threaded.wasm');
  for (const f of [loader, wasm]) {
    if (!existsSync(f)) throw new Error(`ORT の部品がありません: ${f}`);
  }
  copyFileSync(loader, join(outDir, 'runtime', 'ort-wasm.mjs'));
  copyFileSync(wasm, join(outDir, 'runtime', 'ort-wasm.wasm'));

  const info = {
    transformers: pkgTransformers.version,
    onnxruntimeWeb: pkgOrt.version,
    esbuild: readJson(join(NM, 'esbuild', 'package.json')).version,
    runtime: {
      'runtime/transformers.mjs': statSync(outJs).size,
      'runtime/ort-wasm.mjs': statSync(join(outDir, 'runtime', 'ort-wasm.mjs')).size,
      'runtime/ort-wasm.wasm': statSync(join(outDir, 'runtime', 'ort-wasm.wasm')).size,
    },
    bundledPackages: packages.map(({ name, version, license, inputBytes }) => ({
      name,
      version,
      license,
      inputBytes,
    })),
  };
  // 🔴 置いた名前が、取る側の正本(`ASR_RUNTIME_FILES`)と同じであること ── 書き写した名前で置かない
  const { mod, close } = await loadAsrParts();
  try {
    assertRuntimeNamesMatch(mod.ASR_RUNTIME_FILES, Object.keys(info.runtime));
  } finally {
    await close();
  }
  writeFileSync(join(outDir, 'bundle-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { info, packages, outDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const outDir = i >= 0 ? resolve(process.argv[i + 1]) : DEFAULT_OUT;
  const { info } = await bundleRuntime({ outDir });
  console.log(`出力: ${outDir}`);
  for (const [k, v] of Object.entries(info.runtime)) console.log(`  ${k.padEnd(28)} ${v.toLocaleString('en-US')} byte`);
  console.log(`束ねに入った package(${info.bundledPackages.length} 件):`);
  for (const p of info.bundledPackages) {
    console.log(`  ${p.name}@${p.version}  ${p.license ?? '(license 不明)'}  入力 ${p.inputBytes.toLocaleString('en-US')} byte`);
  }
}
