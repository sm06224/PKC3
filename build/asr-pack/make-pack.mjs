/**
 * 🔴 **`pack.json`(目録)を作る**(#772 段 1)。
 *
 * `--out <dir>`(既定 `dist-asr-pack/`)の下に在る物を**そのまま数えて**書く(予定を書かない)。
 *
 *   runtime/…                 `ASR_RUNTIME_FILES` の 3 file(bundle-runtime.mjs が置く)
 *   models/<modelId>/…        段 2(変換)の出力。`ASR_PARTS` の `modelId` ごと。置かれていない 2 択は目録に入れない
 *                             (一方だけ配る日があってよい ── `readAsrPack` の規則)
 *
 * 目録の形は `src/features/asr/asr-parts.ts` の `readAsrPack` が決める(その関数が読める形で書く):
 *
 *   { version, build, runtime: [{path,bytes,sha256}], models: { light: [...], accurate: [...] } }
 *
 * 🔴 **`version` は内容由来**:`(path, sha256)` を path 順に並べた列の sha256 の先頭 12 桁。
 *   ⚠ 日時・run id・tag のような**使い回す名前**にしない(同じ名前で中身が入れ替わる ── office-pack で
 *   `lo-wasm-dev` が実際にそうだった)。1 byte 変われば変わり、同じ中身なら同じ。
 *   人が読む素性(版・HF の sha・日時・run id)は別 field `build` へ ── `readAsrPack` は未知の field を
 *   読み捨てる(test で pin)。
 * ⚠ `sha256` は **`createReadStream` で流す**(157MB の file を heap に載せない ── 不可侵指示
 *   「ゼロコピー・速やかな破棄」と同じ向き)。`bytes` は `statSync`。
 * ⚠ 検品はここでしない(`check-pack.mjs`)。0 byte の file も**在るままに**書く ── 隠さずに検品で名前を言って落とす。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT, loadAsrParts } from './src-loader.mjs';

/** file を流して sha256(小文字 hex)を出す。 */
export function sha256File(path) {
  return new Promise((ok, ng) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('error', ng)
      .on('data', (c) => h.update(c))
      .on('end', () => ok(h.digest('hex')));
  });
}

/** directory 以下の file を、pack 内の相対 path(`/` 区切り)で、**コードユニット順**に返す。 */
export function listFiles(root, dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(base);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function describe(root, paths) {
  const rows = [];
  for (const path of paths) {
    const abs = join(root, path);
    rows.push({ path, bytes: statSync(abs).size, sha256: await sha256File(abs) });
  }
  return rows;
}

/** 内容由来の版。⚠ 引数は `{path, sha256}` を持つ行の配列(順不同でよい ── 中で整列する)。 */
export function contentVersion(rows) {
  const lines = rows
    .map((r) => `${r.path}\t${r.sha256}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(lines.join('')).digest('hex').slice(0, 12);
}

function readJsonIfAny(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 人が読む素性。⚠ 版の判定には使わない(`readAsrPack` は無視する)。
 * 在る物だけ入れる(無い物を `unknown` で埋めない ── 「書いていない」と「分からない」を混ぜない)。
 */
export function buildInfoOf(outDir, now, env = process.env) {
  const bundle = readJsonIfAny(join(outDir, 'bundle-info.json'));
  const models = readJsonIfAny(join(outDir, 'LICENSES', 'MODELS.json'));
  const build = {};
  if (bundle !== null) {
    build.transformers = bundle.transformers ?? null;
    build.onnxruntimeWeb = bundle.onnxruntimeWeb ?? null;
    build.esbuild = bundle.esbuild ?? null;
  }
  if (Array.isArray(models)) {
    // 重みの配布元が宣言している物(取れなかった行は status: failed のまま ── 隠さない)
    build.weights = models.map((m) => ({ id: m.id, status: m.status, license: m.license ?? null, sha: m.sha ?? null }));
  }
  build.builtAt = now.toISOString();
  build.runId = typeof env['GITHUB_RUN_ID'] === 'string' && env['GITHUB_RUN_ID'] !== '' ? env['GITHUB_RUN_ID'] : null;
  return build;
}

export async function makePack({ outDir = DEFAULT_OUT, now = new Date(), env = process.env } = {}) {
  const { mod, close } = await loadAsrParts();
  try {
    for (const need of mod.ASR_RUNTIME_FILES) {
      if (!existsSync(join(outDir, need))) throw new Error(`実行の部品がありません: ${need}(先に bundle-runtime.mjs)`);
    }
    const runtime = await describe(outDir, [...mod.ASR_RUNTIME_FILES]);
    const models = {};
    for (const part of mod.ASR_PARTS) {
      const dir = mod.asrModelDir(part).replace(/\/$/, '');
      const files = listFiles(outDir, dir);
      if (files.length === 0) continue; // 置かれていない 2 択は入れない
      models[part.id] = await describe(outDir, files);
    }
    const all = [...runtime, ...Object.values(models).flat()];
    const pack = {
      version: contentVersion(all),
      build: buildInfoOf(outDir, now, env),
      runtime,
      models,
    };
    writeFileSync(join(outDir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
    return pack;
  } finally {
    await close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const outDir = i >= 0 ? resolve(process.argv[i + 1]) : DEFAULT_OUT;
  const pack = await makePack({ outDir });
  const n = pack.runtime.length + Object.values(pack.models).reduce((s, f) => s + f.length, 0);
  console.log(`pack.json を書きました: ${outDir}`);
  console.log(`  version ${pack.version}  file ${n} 件  models: ${Object.keys(pack.models).join(', ') || '(なし)'}`);
}
