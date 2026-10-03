/**
 * 🔴 **音声認識の部品に同梱するライセンスを集める**(#772 段 1)。
 *
 * 出力(`--out <dir>` の下の `LICENSES/`):
 *
 *   npm/<名前>@<版>/<LICENSE 系 file>   束ねに入った package(と、その中へ**インラインで入っている依存**)の実物
 *   packages.json                       上の一覧(名前 / 版 / SPDX 種別 / 写した file / 入り方)
 *   upstream/<id>.txt                   上流から取った全文(whisper MIT / transformers.js Apache-2.0 /
 *                                       onnxruntime の LICENSE と ThirdPartyNotices.txt)
 *   SOURCES.json                        取った URL・bytes・sha256(取れなかった物は `failed` と理由)
 *   MODELS.json                         重みの配布元(Hugging Face)が**宣言している**ライセンスと sha
 *
 * ⚠ **無い物を捏造しない**(`build/oss-notices-plugin.ts` と同じ作法)。LICENSE file を持たない package に
 *   標準のひな型を当てはめない ── `files: []` のまま事実だけを残す。
 * 🔴 **重みのライセンスを「MIT 確定」と書かない。** OpenAI の GitHub repo は MIT(コードと重み)と言うが、
 *   Hugging Face の model card が別の種別を宣言していることがある(2026-10-01 の実測でも再梱包側は
 *   Apache-2.0 で**食い違っていた**)。ここは**宣言の実物(`cardData.license`)と sha をそのまま記録**し、
 *   どちらが正かを決める判断は人に残す。HF の API は**この箱からは 403**(proxy が断る)なので、
 *   取れなかったら `status: "failed"` と理由を MODELS.json に残して止まらない ── Actions で取る形にする
 *   (`check-pack.mjs --strict-model-license` が「取れていない」を赤にする)。
 * 🔑 **束ねに入った物の数え方**:esbuild の metafile に出る入力(`bundle-info.json`)に加え、
 *   その package が宣言する `dependencies` の**閉包**を数える。⚠ transformers.js も ORT-web も
 *   配布 file が**上流で事前に束ねられていて**(`@huggingface/jinja` / `@huggingface/tokenizers` /
 *   `flatbuffers` / `protobufjs` …がインラインで入る)、metafile には出てこないため。
 *   広く拾う側(false-keep)に倒す ── 要らない表記が増えても、表記漏れよりよい。
 *   ⚠ 外すのは 2 種類だけ ── Node 専用の依存(`sharp` / `onnxruntime-node`。web 版の出力に入らない ──
 *   「裸の指定子が残っていない」検品で裏が取れている)と、型宣言だけの `@types/*`(コードが入らない)。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT } from './src-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NM = join(HERE, 'node_modules');

/** web 版の出力に入らない依存(閉包から外す)。 */
export const NODE_ONLY_DEPS = ['sharp', 'onnxruntime-node'];

/** 型宣言だけの package(出力にコードが 1 byte も入らない)── 閉包から外す。 */
const TYPES_SCOPE = '@types/';

/** LICENSE 系の file 名(`oss-notices-plugin.ts` に NOTICE / COPYING を足した)。 */
const LICENSE_FILE_NAME = /^(licen[cs]e|notice|copying)(\.|$)/iu;

/** 重みの配布元に問い合わせる model(⚠ 既定。`--hf-model` で差し替える)。 */
export const DEFAULT_HF_MODELS = [
  'openai/whisper-base',
  'openai/whisper-small',
  'openai/whisper-base',
  'openai/whisper-small',
];

/** 全文の印(取れた物が本当に全文かを見る。⚠ 404 の HTML や空を「取れた」と数えない)。 */
export const MIT_MARK = 'Permission is hereby granted';
export const APACHE_MARK = 'Apache License';

/** metafile の入力 path(`node_modules/` を含む)→ package の根の相対 path と名前。 */
export function packageOfInput(inputPath) {
  const marker = 'node_modules/';
  const at = inputPath.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = inputPath.slice(at + marker.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return { name, dir: inputPath.slice(0, at + marker.length) + name };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `fromDir` から node の解決と同じ順(入れ子 → 上へ)で依存の実体を探す。 */
export function resolveDep(fromDir, name, nmRoot = NM) {
  let dir = fromDir;
  for (let i = 0; i < 32; i += 1) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return cand;
    const parent = dirname(dir);
    if (parent === dir || dir === dirname(nmRoot)) break;
    dir = parent;
  }
  const top = join(nmRoot, name);
  return existsSync(join(top, 'package.json')) ? top : null;
}

function licenseIdOf(meta) {
  const raw = meta.license;
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  if (raw !== null && typeof raw === 'object' && typeof raw.type === 'string') return raw.type;
  return null;
}

/**
 * 束ねに入った package の閉包を作る。
 * @param roots `bundle-info.json` の `bundledPackages`(名前の配列)
 */
export function closeOverDependencies(roots, nmRoot = NM) {
  const out = new Map(); // dir → { name, via }
  const queue = [];
  for (const name of roots) {
    const dir = resolveDep(dirname(nmRoot), name, nmRoot);
    if (dir === null) throw new Error(`束ねに入った ${name} の実体が node_modules に見つかりません`);
    out.set(dir, { name, how: 'direct' });
    queue.push(dir);
  }
  while (queue.length > 0) {
    const dir = queue.shift();
    const meta = readJson(join(dir, 'package.json'));
    for (const dep of Object.keys(meta.dependencies ?? {})) {
      if (NODE_ONLY_DEPS.includes(dep) || dep.startsWith(TYPES_SCOPE)) continue;
      const d = resolveDep(dir, dep, nmRoot);
      if (d === null) continue; // 無い依存は数えない(optional の取りこぼしを捏造しない)
      if (out.has(d)) continue;
      out.set(d, { name: dep, how: 'inlined' });
      queue.push(d);
    }
  }
  return [...out.entries()].map(([dir, v]) => ({ dir, ...v }));
}

function safeName(name) {
  return name.replace(/^@/, '').replace(/\//g, '__');
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 上流から取る全文。ORT は**束ねた版の commit**で固定する(`__commit.txt`)。 */
export function upstreamSources({ transformersVersion, ortCommit }) {
  const raw = 'https://raw.githubusercontent.com';
  return [
    {
      id: 'whisper-LICENSE',
      url: `${raw}/openai/whisper/main/LICENSE`,
      mark: MIT_MARK,
      about: 'OpenAI Whisper(MIT)',
    },
    {
      id: 'transformers.js-LICENSE',
      url: `${raw}/huggingface/transformers.js/${transformersVersion}/LICENSE`,
      mark: APACHE_MARK,
      about: 'transformers.js(Apache-2.0)',
    },
    {
      id: 'onnxruntime-LICENSE',
      url: `${raw}/microsoft/onnxruntime/${ortCommit}/LICENSE`,
      mark: MIT_MARK,
      about: 'ONNX Runtime(MIT)',
    },
    {
      id: 'onnxruntime-ThirdPartyNotices',
      url: `${raw}/microsoft/onnxruntime/${ortCommit}/ThirdPartyNotices.txt`,
      mark: null,
      minBytes: 1000,
      about: 'ONNX Runtime が束ねる第三者の表記',
    },
  ];
}

async function getText(fetchFn, url) {
  let res;
  try {
    res = await fetchFn(url);
  } catch (e) {
    // ⚠ fetch の失敗は「fetch failed」だけで原因が消える。cause(CONNECT 403 など)まで残す
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
    throw new Error(`届かない${cause}`, { cause: e });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function collectLicenses({
  outDir = DEFAULT_OUT,
  fetchFn = fetch,
  allowOffline = false,
  hfModels = DEFAULT_HF_MODELS,
  nmRoot = NM,
} = {}) {
  const infoPath = join(outDir, 'bundle-info.json');
  if (!existsSync(infoPath)) throw new Error('bundle-info.json がありません(先に bundle-runtime.mjs を回す)');
  const info = readJson(infoPath);
  const lic = join(outDir, 'LICENSES');
  rmSync(lic, { recursive: true, force: true });
  mkdirSync(join(lic, 'npm'), { recursive: true });
  mkdirSync(join(lic, 'upstream'), { recursive: true });

  // ── 1. npm の実物 ──
  const closure = closeOverDependencies(info.bundledPackages.map((p) => p.name), nmRoot);
  const packages = [];
  for (const { dir, name, how } of closure) {
    const meta = readJson(join(dir, 'package.json'));
    const files = readdirSync(dir).filter((f) => LICENSE_FILE_NAME.test(f) && statSync(join(dir, f)).isFile());
    const id = licenseIdOf(meta);
    if (id === null && files.length === 0) {
      throw new Error(`${name} は license の宣言も LICENSE file も持たない(出どころの言えない物は配れない)`);
    }
    const dest = `npm/${safeName(name)}@${meta.version}`;
    mkdirSync(join(lic, dest), { recursive: true });
    for (const f of files) copyFileSync(join(dir, f), join(lic, dest, f));
    packages.push({
      name,
      version: meta.version ?? null,
      license: id,
      how,
      // ⚠ 全文を持たない package は空のまま ── 標準のひな型を当てはめて捏造しない
      files: files.map((f) => `${dest}/${f}`),
    });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  writeFileSync(join(lic, 'packages.json'), `${JSON.stringify(packages, null, 2)}\n`);

  // ── 2. 上流から ──
  const ortCommit = readFileSync(join(nmRoot, 'onnxruntime-web', '__commit.txt'), 'utf8').trim();
  const sources = [];
  for (const s of upstreamSources({ transformersVersion: info.transformers, ortCommit })) {
    const row = { id: s.id, url: s.url, about: s.about, status: 'ok', bytes: 0, sha256: null, error: null };
    try {
      const buf = await getText(fetchFn, s.url);
      const text = buf.toString('utf8');
      if (buf.length === 0) throw new Error('空');
      if (s.mark !== null && !text.includes(s.mark)) throw new Error(`全文ではない(「${s.mark}」が無い)`);
      if (s.minBytes !== undefined && buf.length < s.minBytes) throw new Error(`小さすぎる(${buf.length} byte)`);
      writeFileSync(join(lic, 'upstream', `${s.id}.txt`), buf);
      row.bytes = buf.length;
      row.sha256 = sha256Of(buf);
    } catch (e) {
      row.status = 'failed';
      row.error = e instanceof Error ? e.message : String(e);
    }
    sources.push(row);
  }
  writeFileSync(join(lic, 'SOURCES.json'), `${JSON.stringify({ ortCommit, sources }, null, 2)}\n`);

  // ── 3. 重みの宣言(Hugging Face の API) ──
  const models = [];
  for (const id of hfModels) {
    const url = `https://huggingface.co/api/models/${id}`;
    const row = { id, url, status: 'ok', license: null, sha: null, lastModified: null, error: null };
    try {
      const j = JSON.parse((await getText(fetchFn, url)).toString('utf8'));
      // ⚠ 宣言の実物をそのまま残す(`cardData.license` が無ければ tags の `license:` を見る ── どちらも宣言)
      const fromTag = Array.isArray(j.tags) ? j.tags.find((t) => typeof t === 'string' && t.startsWith('license:')) : undefined;
      row.license = (j.cardData && typeof j.cardData.license === 'string' && j.cardData.license)
        || (fromTag ? fromTag.slice('license:'.length) : null);
      row.sha = typeof j.sha === 'string' ? j.sha : null;
      row.lastModified = typeof j.lastModified === 'string' ? j.lastModified : null;
      if (row.license === null || row.sha === null) throw new Error('license か sha が応答に無い');
    } catch (e) {
      row.status = 'failed';
      row.error = e instanceof Error ? e.message : String(e);
    }
    models.push(row);
  }
  writeFileSync(join(lic, 'MODELS.json'), `${JSON.stringify(models, null, 2)}\n`);

  const failedSources = sources.filter((s) => s.status === 'failed');
  if (failedSources.length > 0 && !allowOffline) {
    throw new Error(
      `上流の全文が取れませんでした: ${failedSources.map((s) => `${s.id}(${s.error})`).join(', ')}`
        + '(記録は LICENSES/SOURCES.json。手元で網が無いときだけ --allow-offline)',
    );
  }
  return { packages, sources, models };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outDir = i >= 0 ? resolve(argv[i + 1]) : DEFAULT_OUT;
  const hf = [];
  for (let k = 0; k < argv.length; k += 1) if (argv[k] === '--hf-model') hf.push(argv[k + 1]);
  const { packages, sources, models } = await collectLicenses({
    outDir,
    allowOffline: argv.includes('--allow-offline'),
    ...(hf.length > 0 ? { hfModels: hf } : {}),
  });
  console.log(`npm の実物(${packages.length} 件):`);
  for (const p of packages) {
    console.log(`  ${p.name}@${p.version}  ${p.license ?? '(宣言なし)'}  [${p.how}]  file ${p.files.length}`);
  }
  console.log('上流:');
  for (const s of sources) console.log(`  ${s.status === 'ok' ? 'ok    ' : 'FAILED'} ${s.id}  ${s.sha256 ?? s.error}`);
  console.log('重みの宣言(HF):');
  for (const m of models) console.log(`  ${m.status === 'ok' ? 'ok    ' : 'FAILED'} ${m.id}  ${m.status === 'ok' ? `${m.license} @ ${m.sha}` : m.error}`);
}
