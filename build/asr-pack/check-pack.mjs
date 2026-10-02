/**
 * 🔴 **組み上がった一式を検品する**(#772 段 1)。落ちたら**理由を名前で言う**(門ごとに別の文言)。
 *
 * 作法は `build/office-wasm/make-pages-bundle.mjs` と同じ ── **「目録が指す物が実在するか」で書く**
 * (「file が 1 つ在る」「`.onnx` が在る」のような、別の物で満たせる条件にしない)。
 *
 * | 門 | 落ちる条件 |
 * |---|---|
 * | `manifest` | `pack.json` が無い |
 * | `missing` | 目録が指す file が実在しない |
 * | `zero-byte` | 実在するが 0 byte |
 * | `size` | 目録の `bytes` が実 file と違う |
 * | `sha256` | 目録の `sha256` が実 file の中身と違う(大きさは同じでも) |
 * | `unlisted` | `runtime/` `models/` の下に、目録に**載っていない** file が在る(端末へは取り込まれない) |
 * | `version` | 目録の `version` が内容(`path` と `sha256` の列)から作った値と違う |
 * | `reader` | **`readAsrPack`(src の正本)が読めない**(runtime 3 file の下限・`models/<modelId>/` の下・`.onnx` 1 つ以上・重みの合計・sha256 の綴り) |
 * | `no-model` | 重みが 1 つも入っていない(runtime だけの一式は取り込んでも何も字にできない) |
 * | `bare-import` | `runtime/transformers.mjs` に裸の指定子が残っている(esbuild が在るときだけ検査。無ければ**言う**) |
 * | `license-mit` / `license-apache` | `LICENSES/` に MIT / Apache-2.0 の全文が無い(**全文の印**で見る ── file が在るだけでは通さない) |
 * | `model-license` | `--strict-model-license` のとき、重みの配布元の宣言(`LICENSES/MODELS.json`)が取れていない |
 *
 * ⚠ **目録の規則(`reader`)をここへ書き写さない** ── `readAsrPack` を同じ関数のまま通す(`src-loader.mjs`)。
 *   規則が 2 か所に在ると、片方だけ直って食い違う。この script が自前で持つのは**目録と実物の突き合わせ**
 *   (`missing` から `version` まで)だけである。
 * ⚠ **最初の 1 件で止まらず、全部の問題を出す**(直す側が 1 回で全体を見られる)。
 * ⚠ 重みのライセンスが取れていない(`MODELS.json` の `failed`)のは、既定では**警告**(手元で HF に届かない箱が在る)。
 *   配る前の検品(Actions)は `--strict-model-license` で赤にする。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBareImports } from './bare-imports.mjs';
import { contentVersion, listFiles, sha256File } from './make-pack.mjs';
import { DEFAULT_OUT, loadAsrParts } from './src-loader.mjs';

const MIT_MARK = 'Permission is hereby granted';
const APACHE_MARK = 'Apache License';
/** 全文の印を探す file の大きさの上限(LICENSE は小さい。重みを読まない)。 */
const LICENSE_SCAN_MAX = 2 * 1024 * 1024;

/** `LICENSES/` の下(再帰)で、印を含む file が 1 つ在るか。 */
function licenseHas(dir, mark) {
  if (!existsSync(dir)) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (licenseHas(p, mark)) return true;
    } else if (e.isFile() && statSync(p).size <= LICENSE_SCAN_MAX) {
      if (readFileSync(p, 'utf8').includes(mark)) return true;
    }
  }
  return false;
}

/**
 * @returns {Promise<{ problems: {gate: string, message: string}[], notes: string[] }>}
 */
export async function checkPack({ outDir = DEFAULT_OUT, strictModelLicense = false } = {}) {
  const problems = [];
  const notes = [];
  const fail = (gate, message) => problems.push({ gate, message });

  const manifestPath = join(outDir, 'pack.json');
  if (!existsSync(manifestPath)) {
    fail('manifest', `pack.json がありません: ${manifestPath}`);
    return { problems, notes };
  }
  const text = readFileSync(manifestPath, 'utf8');

  // 目録の「listing」は readAsrPack を待たずに自前で読む(読めない目録は reader の門が言う)
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    // 読めない目録は reader の門が言う(ここでは listing を空のまま進める)
  }
  const listed = [];
  if (raw !== null && typeof raw === 'object') {
    if (Array.isArray(raw.runtime)) listed.push(...raw.runtime);
    if (raw.models !== null && typeof raw.models === 'object') {
      for (const files of Object.values(raw.models)) if (Array.isArray(files)) listed.push(...files);
    }
  }

  // ── 目録 ⇔ 実物 ──
  const actual = [];
  for (const f of listed) {
    if (typeof f !== 'object' || f === null || typeof f.path !== 'string') continue;
    const abs = join(outDir, f.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      fail('missing', `目録が指す file が実在しません: ${f.path}`);
      continue;
    }
    const real = statSync(abs).size;
    if (real === 0) {
      fail('zero-byte', `0 byte の file があります: ${f.path}`);
      continue;
    }
    if (real !== f.bytes) {
      fail('size', `${f.path} の大きさが目録と合いません(目録 ${f.bytes} / 実 ${real})`);
    }
    const sha = await sha256File(abs);
    if (sha !== f.sha256) fail('sha256', `${f.path} の sha256 が目録と合いません(中身が違います)`);
    actual.push({ path: f.path, sha256: sha });
  }

  const listedPaths = new Set(listed.map((f) => (f && typeof f.path === 'string' ? f.path : '')));
  for (const dir of ['runtime', 'models']) {
    for (const p of listFiles(outDir, dir)) {
      if (!listedPaths.has(p)) fail('unlisted', `目録に載っていない file があります: ${p}(端末へは取り込まれません)`);
    }
  }

  if (typeof raw?.version === 'string' && actual.length === listed.length) {
    const want = contentVersion(actual);
    if (raw.version !== want) {
      fail('version', `version が内容と合いません(目録 ${raw.version} / 内容から作ると ${want})`);
    }
  }

  // ── 目録の規則は src の正本に任せる ──
  const { mod, close } = await loadAsrParts();
  try {
    const read = mod.readAsrPack(text);
    if (!read.ok) {
      fail('reader', `readAsrPack が目録を断りました: ${read.why}`);
    } else if (Object.keys(read.pack.models).length === 0) {
      fail('no-model', '重みが 1 つも入っていません(runtime だけの一式)');
    }
  } finally {
    await close();
  }

  // ── 束ねの検品(裸の指定子) ──
  const js = join(outDir, 'runtime', 'transformers.mjs');
  if (existsSync(js)) {
    try {
      const bare = await findBareImports(readFileSync(js, 'utf8'));
      if (bare.length > 0) fail('bare-import', `runtime/transformers.mjs に裸の指定子が残っています: ${bare.join(', ')}`);
    } catch (e) {
      // ⚠ 検査できなかったことを「0 件」と読ませない
      notes.push(`bare-import 検査を省きました(esbuild が読めない): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── ライセンス ──
  const lic = join(outDir, 'LICENSES');
  if (!licenseHas(lic, MIT_MARK)) fail('license-mit', 'LICENSES/ に MIT の全文がありません');
  if (!licenseHas(lic, APACHE_MARK)) fail('license-apache', 'LICENSES/ に Apache-2.0 の全文がありません');

  const modelsJson = join(lic, 'MODELS.json');
  let weights = null;
  if (existsSync(modelsJson)) {
    try {
      weights = JSON.parse(readFileSync(modelsJson, 'utf8'));
    } catch {
      weights = null;
    }
  }
  const unsure = !Array.isArray(weights) || weights.length === 0 || weights.some((m) => m.status !== 'ok');
  if (unsure) {
    const msg = '重みのライセンス(Hugging Face の宣言)を確認できていません(LICENSES/MODELS.json が無いか、取れていない行がある)';
    if (strictModelLicense) fail('model-license', msg);
    else notes.push(`⚠ ${msg}`);
  }

  return { problems, notes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outDir = i >= 0 ? resolve(argv[i + 1]) : DEFAULT_OUT;
  const { problems, notes } = await checkPack({
    outDir,
    strictModelLicense: argv.includes('--strict-model-license'),
  });
  for (const n of notes) console.log(`  ${n}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ✗ [${p.gate}] ${p.message}`);
    console.error(`検品に落ちました(${problems.length} 件): ${outDir}`);
    process.exit(1);
  }
  console.log(`  ✓ ok: ${outDir}`);
}
