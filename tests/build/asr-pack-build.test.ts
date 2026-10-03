/** @vitest-environment node */
/**
 * 🔴 **音声認識の部品(asr-pack)を組む script**(#772 段 1)。
 *
 * 守るもの:
 *  ① `make-pack.mjs` が書く目録を、**取る側の正本 `readAsrPack`** が受ける(等値 ── 件数や「ok だった」ではなく中身)
 *  ② `version` が**内容由来**(1 byte で変わる / 日時や `build` では変わらない / 既知の値)
 *  ③ 未知の field `build` を足しても読める(`readAsrPack` は読み捨てる)
 *  ④ `check-pack.mjs` の**門ごとに別の文言で落ちる**(門を N 個置いたので N 通り鳴らす ── どの門が鳴ったかを名前で見る)
 *  ⑤ 目録の規則を `check-pack` が**書き写していない**(`readAsrPack` の断り文をそのまま運ぶ)
 *  ⑥ ライセンス収集の**閉包・捏造しない・上流の取れなさの扱い**(合成した node_modules と偽の fetch で)
 *
 * ⚠ 守っていない物(正直に):`bundle-runtime.mjs` が**本物の** esbuild で束ねる経路は、esbuild が
 *   `build/asr-pack/node_modules` にしか無い(本体の CI には無い)ので、**入れてある箱でだけ**走る
 *   (`describe.skipIf`)。CI では「束ね」は検品されない ── 検品するのは組み上がった一式の側(④)。
 *   同じ理由で `bare-import` の門も esbuild が在る箱でだけ鳴らす。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASR_PARTS, ASR_RUNTIME_FILES, readAsrPack } from '../../src/features/asr/asr-parts';
// @ts-expect-error -- build script は素の .mjs(ビルド対象外)
import { makePack, contentVersion } from '../../build/asr-pack/make-pack.mjs';
// @ts-expect-error -- build script は素の .mjs(ビルド対象外)
import { checkPack } from '../../build/asr-pack/check-pack.mjs';
// @ts-expect-error -- build script は素の .mjs(ビルド対象外)
import { assertOrtVersionMatches, assertRuntimeNamesMatch } from '../../build/asr-pack/runtime-guards.mjs';
// @ts-expect-error -- build script は素の .mjs(ビルド対象外)
import { closeOverDependencies, collectLicenses, packageOfInput, upstreamSources } from '../../build/asr-pack/collect-licenses.mjs';

interface Problem { gate: string; message: string }
const make = makePack as (o: { outDir: string; now?: Date; env?: Record<string, string> }) => Promise<{
  version: string; build: Record<string, unknown>; runtime: unknown[]; models: Record<string, unknown[]>;
}>;
const check = checkPack as (o: { outDir: string; strictModelLicense?: boolean }) => Promise<{ problems: Problem[]; notes: string[] }>;
const version = contentVersion as (rows: { path: string; sha256: string }[]) => string;
const closure = closeOverDependencies as (roots: string[], nmRoot: string) => { dir: string; name: string; how: string }[];
const pkgOfInput = packageOfInput as (p: string) => { name: string; dir: string } | null;
const sources = upstreamSources as (o: { transformersVersion: string; ortCommit: string }) => { id: string; url: string }[];
const collect = collectLicenses as (o: Record<string, unknown>) => Promise<{
  packages: { name: string; version: string; license: string | null; how: string; files: string[] }[];
  sources: { id: string; status: string; sha256: string | null; error: string | null; url: string }[];
  models: { id: string; status: string; license: string | null; sha: string | null; error: string | null }[];
}>;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_CLI = join(HERE, '..', '..', 'build', 'asr-pack', 'check-pack.mjs');
const ESBUILD = join(HERE, '..', '..', 'build', 'asr-pack', 'node_modules', 'esbuild', 'package.json');

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pkc3-asr-pack-'));
  made.push(d);
  return d;
}

const MIT_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n';
const APACHE_TEXT = '                                 Apache License\n                           Version 2.0, January 2004\n';
const MODEL_DIR = 'models/openai/whisper-base';
const ONNX = `${MODEL_DIR}/onnx/encoder_model_quantized.onnx`;

function put(root: string, path: string, content: string | number): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  if (typeof content === 'number') {
    writeFileSync(abs, '');
    truncateSync(abs, content); // 0 で埋めた疎な file(中身は決まっている ── 毎回同じ sha256)
  } else {
    writeFileSync(abs, content);
  }
}

/** 下限(`readAsrPack`)を超える最小の一式。⚠ 重みは疎な file(52,000,000 byte。軽い = 103,007,956 の半分 51,503,978 を超える)。 */
function fakePack(opts: { model?: boolean; jsBytes?: number } = {}): string {
  const root = tmp();
  // ⚠ 本物の JS として読める形にする(esbuild が在る箱では裸の指定子を数えるため)
  const js = 'export default 1;\n';
  put(root, 'runtime/transformers.mjs', js + '//'.padEnd((opts.jsBytes ?? 120_000) - js.length, '/'));
  put(root, 'runtime/ort-wasm.mjs', '//'.padEnd(6_000, '/'));
  put(root, 'runtime/ort-wasm.wasm', 5_100_000);
  if (opts.model !== false) {
    put(root, ONNX, 52_000_000);
    put(root, `${MODEL_DIR}/config.json`, '{"dummy":true}');
  }
  put(root, 'LICENSES/upstream/mit.txt', MIT_TEXT);
  put(root, 'LICENSES/upstream/apache.txt', APACHE_TEXT);
  put(root, 'LICENSES/MODELS.json', JSON.stringify([{ id: 'openai/whisper-base', status: 'ok', license: 'apache-2.0', sha: 'abc' }]));
  return root;
}

const NOW = new Date('2026-10-02T00:00:00Z');
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const gates = (r: { problems: Problem[] }): string[] => r.problems.map((p) => p.gate).sort();
const readManifest = (root: string): { version: string; build: Record<string, unknown>; models: Record<string, unknown[]> } =>
  JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')) as never;

describe('make-pack ── 目録を作る', () => {
  it('作った目録を readAsrPack が受け、中身が実 file と等しい(runtime は正本の名前・models は置いた 2 択だけ)', async () => {
    const root = fakePack();
    await make({ outDir: root, now: NOW });
    const text = readFileSync(join(root, 'pack.json'), 'utf8');
    const r = readAsrPack(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 独立の観測(`createHash` を test 側で回す / `statSync`)で期待値を組む
    const row = (path: string): { path: string; bytes: number; sha256: string } => ({
      path, bytes: statSync(join(root, path)).size, sha256: sha256(join(root, path)),
    });
    expect(r.pack.runtime).toEqual(ASR_RUNTIME_FILES.map(row));
    expect(r.pack.models).toEqual({ light: [`${MODEL_DIR}/config.json`, ONNX].map(row) });
    // 配っていない 2 択(accurate)は目録に入らない
    expect(Object.keys(r.pack.models)).toEqual(['light']);
    expect(ASR_PARTS.map((p) => p.id)).toContain('accurate');
  });

  it('2 択を両方置けば、目録の light / accurate に**別々に**入る(model ごとの dir で振り分ける)', async () => {
    const root = fakePack();
    // small の下限は 288,448,143 の半分 = 144,224,071 ── 超える疎な file
    put(root, 'models/openai/whisper-small/onnx/decoder_model_merged_quantized.onnx', 145_000_000);
    put(root, 'models/openai/whisper-small/config.json', '{"small":true}');
    await make({ outDir: root, now: NOW });
    const r = readAsrPack(readFileSync(join(root, 'pack.json'), 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.pack.models).sort()).toEqual(['accurate', 'light']);
    expect(r.pack.models.light?.map((f) => f.path)).toEqual([`${MODEL_DIR}/config.json`, ONNX]);
    expect(r.pack.models.accurate?.map((f) => f.path)).toEqual([
      'models/openai/whisper-small/config.json',
      'models/openai/whisper-small/onnx/decoder_model_merged_quantized.onnx',
    ]);
    expect((await check({ outDir: root })).problems).toEqual([]);
  });

  it('version は内容由来:既知の値 / 同じ中身なら日時や run id が違っても同じ / 1 byte 変えると変わる', async () => {
    const a = fakePack();
    const b = fakePack();
    // ⚠ env を渡さないと process.env を読む ── CI では GITHUB_RUN_ID が在るので「無い」側の対照群にならない
    //   (2026-10-02 に CI で踏んだ: expected '36969955893' to be null)。空の env を明示する
    const pa = await make({ outDir: a, now: NOW, env: {} });
    const pb = await make({ outDir: b, now: new Date('2030-01-01T00:00:00Z'), env: { GITHUB_RUN_ID: '999' } });
    // 同じ中身 ── 日時 / run id は build にだけ入り、version には入らない
    expect(pb.version).toBe(pa.version);
    expect(pb.build['runId']).toBe('999');
    expect(pa.build['runId']).toBeNull();
    expect(pb.build['builtAt']).not.toBe(pa.build['builtAt']);
    // 既知の値(算法の取り違え ── path を落とす / 先頭 12 桁でなくなる ── を殺す錨)
    expect(pa.version).toMatch(/^[0-9a-f]{12}$/);
    expect(pa.version).toBe('07a2b853fb18'); // 2026-10-03: 疎 file の大きさを新しい下限(配っている物の実測の半分)へ上げたので値も動いた(算法は同じ。その前は path の変更で bfc4d0451a19)

    // 1 byte 違う(大きさも同じ)
    const c = fakePack();
    writeFileSync(join(c, `${MODEL_DIR}/config.json`), '{"dummy":false}'.slice(0, 14));
    expect((await make({ outDir: c, now: NOW })).version).not.toBe(pa.version);
    // 名前だけ違う(中身は同じ)でも変わる
    const d = fakePack();
    rmSync(join(d, `${MODEL_DIR}/config.json`));
    put(d, `${MODEL_DIR}/config2.json`, '{"dummy":true}');
    expect((await make({ outDir: d, now: NOW })).version).not.toBe(pa.version);
  });

  it('contentVersion は並びに依らない(整列は中で行う)', () => {
    const rows = [
      { path: 'a', sha256: '1'.repeat(64) },
      { path: 'b', sha256: '2'.repeat(64) },
    ];
    expect(version([...rows].reverse())).toBe(version(rows));
  });

  it('未知の field(build / 任意の追加)を足しても readAsrPack は読める', async () => {
    const root = fakePack();
    await make({ outDir: root, now: NOW });
    const o = readManifest(root);
    expect(o.build).toBeTypeOf('object'); // make-pack は build を書く
    const text = JSON.stringify({ ...o, build: { anything: [1, 2, 3] }, futureField: { x: 1 } });
    const r = readAsrPack(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pack.version).toBe(o.version);
  });

  it('build は在る物だけ書く(bundle-info が無いのに transformers の版を unknown で埋めない)', async () => {
    const root = fakePack();
    rmSync(join(root, 'LICENSES/MODELS.json'));
    const p = await make({ outDir: root, now: NOW });
    expect(Object.keys(p.build).sort()).toEqual(['builtAt', 'runId']);
    // bundle-info.json と MODELS.json が在れば写す
    const q = fakePack();
    writeFileSync(join(q, 'bundle-info.json'), JSON.stringify({ transformers: '4.3.0', onnxruntimeWeb: '1.31.0-dev', esbuild: '0.25.12' }));
    const pq = await make({ outDir: q, now: NOW });
    expect(pq.build['transformers']).toBe('4.3.0');
    expect(pq.build['onnxruntimeWeb']).toBe('1.31.0-dev');
    expect(pq.build['weights']).toEqual([{ id: 'openai/whisper-base', status: 'ok', license: 'apache-2.0', sha: 'abc' }]);
  });

  it('実行の部品が欠けていたら目録を書かずに止まる(名前を言う)', async () => {
    const root = fakePack();
    rmSync(join(root, 'runtime/ort-wasm.wasm'));
    await expect(make({ outDir: root, now: NOW })).rejects.toThrow('runtime/ort-wasm.wasm');
    expect(existsSync(join(root, 'pack.json'))).toBe(false);
  });
});

describe('check-pack ── 門ごとに別の文言で落ちる', () => {
  it('対照群:正しく組んだ一式は 0 件で通る(重みの宣言が取れていれば警告も無い)', async () => {
    const root = fakePack();
    await make({ outDir: root, now: NOW });
    const r = await check({ outDir: root, strictModelLicense: true });
    expect(r.problems).toEqual([]);
    expect(r.notes.filter((n) => n.startsWith('⚠'))).toEqual([]);
  });

  /** 落とし方 1 つにつき、鳴る門を**名前で**言う。⚠ 他の門が余計に鳴らないことも見る(別の物に満たされない)。 */
  const cases: {
    name: string;
    gate: string[];
    spoil: (root: string) => void;
    text: string;
    strict?: boolean;
    pack?: (root: string) => string;
    fake?: { model?: boolean };
  }[] = [
    {
      name: '0 byte の file',
      gate: ['zero-byte'],
      spoil: (r) => writeFileSync(join(r, `${MODEL_DIR}/config.json`), ''),
      text: '0 byte の file があります: models/openai/whisper-base/config.json',
    },
    {
      name: '目録に無い file',
      gate: ['unlisted'],
      spoil: (r) => put(r, `${MODEL_DIR}/tokenizer.json`, '{}'),
      text: '目録に載っていない file があります: models/openai/whisper-base/tokenizer.json',
    },
    {
      name: '目録に無い file(runtime の下)',
      gate: ['unlisted'],
      spoil: (r) => put(r, 'runtime/extra.js', 'x'),
      text: '目録に載っていない file があります: runtime/extra.js',
    },
    {
      name: '実在しない file',
      gate: ['missing'],
      spoil: (r) => rmSync(join(r, `${MODEL_DIR}/config.json`)),
      text: '目録が指す file が実在しません: models/openai/whisper-base/config.json',
    },
    {
      name: '大きさが違う(0 ではない)',
      gate: ['sha256', 'size', 'version'],
      spoil: (r) => writeFileSync(join(r, `${MODEL_DIR}/config.json`), '{}'),
      text: 'models/openai/whisper-base/config.json の大きさが目録と合いません(目録 14 / 実 2)',
    },
    {
      name: '大きさは同じで中身が違う',
      gate: ['sha256', 'version'],
      spoil: (r) => writeFileSync(join(r, `${MODEL_DIR}/config.json`), '{"dummy":fals}'),
      text: 'models/openai/whisper-base/config.json の sha256 が目録と合いません',
    },
    {
      name: 'version だけ内容と合わない',
      gate: ['version'],
      spoil: () => undefined,
      pack: (r) => {
        const o = readManifest(r);
        writeFileSync(join(r, 'pack.json'), JSON.stringify({ ...o, version: 'aaaaaaaaaaaa' }));
        return r;
      },
      text: 'version が内容と合いません(目録 aaaaaaaaaaaa /',
    },
    {
      name: '重みが無い(runtime だけ)',
      gate: ['no-model'],
      fake: { model: false },
      spoil: () => undefined,
      text: '重みが 1 つも入っていません',
    },
    {
      name: 'MIT の全文が無い',
      gate: ['license-mit'],
      spoil: (r) => writeFileSync(join(r, 'LICENSES/upstream/mit.txt'), 'MIT License\n(全文ではない)\n'),
      text: 'LICENSES/ に MIT の全文がありません',
    },
    {
      name: 'Apache-2.0 の全文が無い',
      gate: ['license-apache'],
      spoil: (r) => writeFileSync(join(r, 'LICENSES/upstream/apache.txt'), 'Apache-2.0(全文ではない)\n'),
      text: 'LICENSES/ に Apache-2.0 の全文がありません',
    },
    {
      name: '重みの宣言が取れていない(strict)',
      gate: ['model-license'],
      strict: true,
      spoil: (r) => writeFileSync(
        join(r, 'LICENSES/MODELS.json'),
        JSON.stringify([{ id: 'openai/whisper-base', status: 'failed', license: null, sha: null, error: '届かない' }]),
      ),
      text: '重みのライセンス(Hugging Face の宣言)を確認できていません',
    },
  ];

  for (const c of cases) {
    it(`${c.name} → [${c.gate.join(', ')}]`, async () => {
      const root = fakePack(c.fake);
      await make({ outDir: root, now: NOW });
      c.spoil(root);
      if (c.pack) c.pack(root);
      const r = await check({ outDir: root, strictModelLicense: c.strict === true });
      expect(gates(r)).toEqual(c.gate);
      // 文言は門ごとに違う ── 落ちた理由を名前で言えている
      expect(r.problems.some((p) => p.message.includes(c.text))).toBe(true);
    });
  }

  it('pack.json が無い → [manifest]', async () => {
    const root = fakePack();
    const r = await check({ outDir: root });
    expect(gates(r)).toEqual(['manifest']);
    expect(r.problems[0]?.message).toContain('pack.json がありません');
  });

  it('全部の門の文言が互いに違う(同じ文言を使い回していない)', () => {
    const texts = cases.map((c) => c.text);
    expect(new Set(texts).size).toBe(texts.length);
    // 門の名前も、ここで鳴らす物(+ manifest / reader / bare-import)で全部を覆う
    const named = new Set(cases.flatMap((c) => c.gate).concat(['manifest', 'reader', 'bare-import']));
    expect([...named].sort()).toEqual([
      'bare-import', 'license-apache', 'license-mit', 'manifest', 'missing', 'model-license',
      'no-model', 'reader', 'sha256', 'size', 'unlisted', 'version', 'zero-byte',
    ]);
  });

  it('重みの宣言が取れていないのは、既定では警告(止めない)・strict で止める', async () => {
    const root = fakePack();
    writeFileSync(join(root, 'LICENSES/MODELS.json'), JSON.stringify([{ id: 'x', status: 'failed', error: '届かない' }]));
    await make({ outDir: root, now: NOW });
    const soft = await check({ outDir: root });
    expect(soft.problems).toEqual([]);
    expect(soft.notes.some((n) => n.includes('重みのライセンス'))).toBe(true);
    expect(gates(await check({ outDir: root, strictModelLicense: true }))).toEqual(['model-license']);
  });

  it('目録の規則は readAsrPack に任せる:断り文をそのまま運ぶ(下限を書き写していない)', async () => {
    // runtime/transformers.mjs が下限(100,000)未満 ── 目録も実物も一貫しているので、鳴るのは reader だけ
    const root = fakePack({ jsBytes: 50_000 });
    await make({ outDir: root, now: NOW });
    const r = await check({ outDir: root });
    expect(gates(r)).toEqual(['reader']);
    const why = readAsrPack(readFileSync(join(root, 'pack.json'), 'utf8'));
    expect(why.ok).toBe(false);
    if (!why.ok) {
      expect(r.problems[0]?.message).toContain(why.why);
      expect(why.why).toContain('runtime/transformers.mjs が小さすぎます');
    }
    // 重みが半分に満たない(別の model の取り違え)も reader の言葉
    const small = fakePack();
    put(small, ONNX, 1_000_000);
    await make({ outDir: small, now: NOW });
    const rs = await check({ outDir: small });
    expect(gates(rs)).toEqual(['reader']);
    expect(rs.problems[0]?.message).toContain('重みが小さすぎます');
    // `.onnx` が 1 つも無い model
    const none = fakePack();
    rmSync(join(none, ONNX));
    put(none, `${MODEL_DIR}/weights.bin`, 41_000_000);
    await make({ outDir: none, now: NOW });
    const rn = await check({ outDir: none });
    expect(gates(rn)).toEqual(['reader']);
    expect(rn.problems[0]?.message).toContain('重み(.onnx)がありません');
  });

  it.skipIf(!existsSync(ESBUILD))('裸の指定子が残った transformers.mjs → [bare-import](esbuild が在る箱でだけ)', async () => {
    const root = fakePack();
    put(root, 'runtime/transformers.mjs', 'import x from "onnxruntime-common";\n' + '//'.padEnd(120_000, '/'));
    await make({ outDir: root, now: NOW });
    const r = await check({ outDir: root });
    expect(gates(r)).toEqual(['bare-import']);
    expect(r.problems[0]?.message).toContain('onnxruntime-common');
  });

  /**
   * ⚠ この 1 件だけ timeout を伸ばす ── node を子プロセスで 2 回起動する(通る回 / 落ちる回)ので、
   *   箱で別の仕事が並走すると 5 秒の既定を超えて落ちる(2026-10-02 に実測。単独なら緑)。
   */
  it('CLI:通れば 0 / 落ちれば 1 で、stderr に門の名前と文言が出る', { timeout: 20_000 }, async () => {
    const ok = fakePack();
    await make({ outDir: ok, now: NOW });
    const out = execFileSync('node', [CHECK_CLI, '--out', ok], { encoding: 'utf8', stdio: 'pipe' });
    expect(out).toContain('ok');

    const bad = fakePack();
    await make({ outDir: bad, now: NOW });
    writeFileSync(join(bad, `${MODEL_DIR}/config.json`), '');
    let status = 0;
    let stderr = '';
    try {
      execFileSync('node', [CHECK_CLI, '--out', bad], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      const err = e as { status: number; stderr: string };
      status = err.status;
      stderr = err.stderr;
    }
    expect(status).toBe(1);
    expect(stderr).toContain('[zero-byte]');
    expect(stderr).toContain('0 byte の file があります');
  });
});

describe('collect-licenses ── 閉包・捏造しない・取れなさの扱い', () => {
  it('packageOfInput:scoped 名 / 入れ子の node_modules / 外', () => {
    expect(pkgOfInput('node_modules/@huggingface/transformers/dist/transformers.web.js')).toEqual({
      name: '@huggingface/transformers', dir: 'node_modules/@huggingface/transformers',
    });
    expect(pkgOfInput('node_modules/a/node_modules/b/x.js')).toEqual({ name: 'b', dir: 'node_modules/a/node_modules/b' });
    expect(pkgOfInput('src/x.js')).toBeNull();
  });

  it('上流の URL:ORT は束ねた版の commit で固定 / transformers.js は版 tag', () => {
    const s = sources({ transformersVersion: '4.3.0', ortCommit: '8d85527a010e294a26b274749f74294b2a32cec5' });
    const byId = Object.fromEntries(s.map((x) => [x.id, x.url]));
    expect(byId['transformers.js-LICENSE']).toBe('https://raw.githubusercontent.com/huggingface/transformers.js/4.3.0/LICENSE');
    expect(byId['onnxruntime-LICENSE']).toBe('https://raw.githubusercontent.com/microsoft/onnxruntime/8d85527a010e294a26b274749f74294b2a32cec5/LICENSE');
    expect(byId['onnxruntime-ThirdPartyNotices']).toContain('/8d85527a010e294a26b274749f74294b2a32cec5/ThirdPartyNotices.txt');
    expect(byId['whisper-LICENSE']).toContain('/openai/whisper/');
    expect(s).toHaveLength(4);
  });

  /** 合成した node_modules:root(web)→ a(全文あり)→ b(全文なし)/ sharp・@types/x(外す)/ 入れ子の c。 */
  function fakeNodeModules(): string {
    const nm = join(tmp(), 'node_modules');
    const pkg = (name: string, meta: Record<string, unknown>, files: Record<string, string> = {}, at = nm): void => {
      const dir = join(at, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...meta }));
      for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    };
    pkg('@huggingface/transformers', { license: 'Apache-2.0', dependencies: { a: '1', sharp: '1', '@types/x': '1' } }, { LICENSE: APACHE_TEXT });
    pkg('a', { license: 'MIT', dependencies: { b: '1', c: '1' } }, { LICENSE: MIT_TEXT, 'index.js': 'x' });
    pkg('b', { license: 'ISC' }); // 全文なし ── 捏造しない
    pkg('sharp', { license: 'Apache-2.0' }, { LICENSE: APACHE_TEXT });
    pkg('@types/x', { license: 'MIT' }, { LICENSE: MIT_TEXT });
    pkg('onnxruntime-web', { license: 'MIT', dependencies: { c: '2' } }, {});
    // onnxruntime-web の入れ子の c@2(a が引く c@1 とは別物)
    pkg('c', { license: 'BSD-3-Clause', version: '2.0.0' }, { 'LICENSE.md': 'c2' }, join(nm, 'onnxruntime-web', 'node_modules'));
    pkg('c', { license: 'BSD-2-Clause', version: '1.0.0' }, { COPYING: 'c1' });
    writeFileSync(join(nm, 'onnxruntime-web', '__commit.txt'), 'deadbeef');
    return nm;
  }

  it('閉包:宣言された依存を辿る / Node 専用と @types は外す / 入れ子は入れ子のほうを引く', () => {
    const nm = fakeNodeModules();
    const rows = closure(['@huggingface/transformers', 'onnxruntime-web'], nm);
    const names = rows.map((r) => `${r.name}:${r.how}:${r.dir.replace(nm, '')}`).sort();
    expect(names).toEqual([
      '@huggingface/transformers:direct:/@huggingface/transformers',
      'a:inlined:/a',
      'b:inlined:/b',
      'c:inlined:/c',
      'c:inlined:/onnxruntime-web/node_modules/c',
      'onnxruntime-web:direct:/onnxruntime-web',
    ]);
    expect(rows.map((r) => r.name)).not.toContain('sharp');
    expect(rows.map((r) => r.name)).not.toContain('@types/x');
  });

  function textRes(body: string, status = 200): Response {
    return new Response(body, { status });
  }

  /** 偽の fetch。url の末尾で返す物を分ける。 */
  function fakeFetch(over: Record<string, () => Response | Promise<Response>> = {}): (url: string) => Promise<Response> {
    return async (url: string) => {
      for (const [k, f] of Object.entries(over)) if (url.includes(k)) return f();
      if (url.includes('/openai/whisper/')) return textRes(MIT_TEXT);
      if (url.includes('transformers.js')) return textRes(APACHE_TEXT);
      if (url.includes('ThirdPartyNotices')) return textRes('x'.repeat(2000));
      if (url.includes('microsoft/onnxruntime')) return textRes(MIT_TEXT);
      if (url.includes('huggingface.co/api/models/')) {
        return textRes(JSON.stringify({ sha: 'cafe', cardData: { license: 'apache-2.0' }, lastModified: 'x' }));
      }
      return textRes('', 404);
    };
  }

  function outWithInfo(): string {
    const out = tmp();
    writeFileSync(join(out, 'bundle-info.json'), JSON.stringify({
      transformers: '4.3.0', onnxruntimeWeb: '1.0.0',
      bundledPackages: [{ name: '@huggingface/transformers' }, { name: 'onnxruntime-web' }],
    }));
    return out;
  }

  it('集める:LICENSE を持たない package は files: [] のまま(捏造しない)/ 上流の sha256 と URL を記録 / HF の宣言を写す', async () => {
    const out = outWithInfo();
    const r = await collect({ outDir: out, nmRoot: fakeNodeModules(), fetchFn: fakeFetch(), hfModels: ['openai/whisper-base'] });
    const b = r.packages.find((p) => p.name === 'b');
    expect(b).toMatchObject({ license: 'ISC', files: [] });
    // 写した file は実在する(目録が指す物が実在する)
    const a = r.packages.find((p) => p.name === 'a');
    expect(a?.files).toHaveLength(1); // `index.js` は LICENSE ではない
    expect(readFileSync(join(out, 'LICENSES', a?.files[0] ?? ''), 'utf8')).toBe(MIT_TEXT);
    // COPYING も LICENSE 系として写す
    expect(r.packages.filter((p) => p.name === 'c').map((p) => p.files.length)).toEqual([1, 1]);

    const src = JSON.parse(readFileSync(join(out, 'LICENSES/SOURCES.json'), 'utf8')) as { ortCommit: string; sources: { id: string; url: string; sha256: string; bytes: number }[] };
    expect(src.ortCommit).toBe('deadbeef');
    const w = src.sources.find((s) => s.id === 'whisper-LICENSE');
    expect(w?.sha256).toBe(createHash('sha256').update(MIT_TEXT).digest('hex'));
    expect(w?.bytes).toBe(Buffer.byteLength(MIT_TEXT));
    expect(readFileSync(join(out, 'LICENSES/upstream/whisper-LICENSE.txt'), 'utf8')).toBe(MIT_TEXT);

    expect(r.models).toEqual([expect.objectContaining({ id: 'openai/whisper-base', status: 'ok', license: 'apache-2.0', sha: 'cafe' })]);
  });

  it('HF が取れなくても止まらず、「取れなかった」と理由を MODELS.json に残す(MIT と決めつけて埋めない)', async () => {
    const out = outWithInfo();
    const r = await collect({
      outDir: out,
      nmRoot: fakeNodeModules(),
      fetchFn: fakeFetch({ 'huggingface.co': () => textRes('forbidden', 403) }),
      hfModels: ['openai/whisper-base'],
    });
    expect(r.models[0]).toMatchObject({ status: 'failed', license: null, sha: null, error: 'HTTP 403' });
    const saved = JSON.parse(readFileSync(join(out, 'LICENSES/MODELS.json'), 'utf8')) as { status: string; license: string | null }[];
    expect(saved).toEqual([expect.objectContaining({ status: 'failed', license: null })]);
  });

  it('上流の全文が取れなければ止まる(404 の HTML を全文と数えない)/ --allow-offline なら記録して続ける', async () => {
    const html = fakeFetch({ '/openai/whisper/': () => textRes('<html>404: Not Found</html>') });
    await expect(collect({ outDir: outWithInfo(), nmRoot: fakeNodeModules(), fetchFn: html, hfModels: [] }))
      .rejects.toThrow('whisper-LICENSE(全文ではない');
    // 記録は残る(止まる前に SOURCES.json を書く)
    const out = outWithInfo();
    const r = await collect({ outDir: out, nmRoot: fakeNodeModules(), fetchFn: html, hfModels: [], allowOffline: true });
    expect(r.sources.find((s) => s.id === 'whisper-LICENSE')).toMatchObject({ status: 'failed', sha256: null });
    expect(r.sources.filter((s) => s.status === 'ok')).toHaveLength(3);
    expect(existsSync(join(out, 'LICENSES/upstream/whisper-LICENSE.txt'))).toBe(false);
  });

  it('license の宣言も LICENSE file も持たない package は配らない(止まる)', async () => {
    const nm = fakeNodeModules();
    writeFileSync(join(nm, 'b', 'package.json'), JSON.stringify({ name: 'b', version: '1.0.0' }));
    await expect(collect({ outDir: outWithInfo(), nmRoot: nm, fetchFn: fakeFetch(), hfModels: [] }))
      .rejects.toThrow('b は license の宣言も LICENSE file も持たない');
  });
});

describe('bundle-runtime の門(判定だけを取り出してある)', () => {
  const guardOrt = assertOrtVersionMatches as (t: unknown, o: unknown) => void;
  const guardNames = assertRuntimeNamesMatch as (c: readonly string[], p: readonly string[]) => void;

  it('ORT の版が transformers の名指しと違えば止まる(両方の版を言う)/ 同じなら通る', () => {
    const t = { version: '4.3.0', dependencies: { 'onnxruntime-web': '1.31.0-dev.A' } };
    expect(() => guardOrt(t, { version: '1.31.0-dev.A' })).not.toThrow();
    expect(() => guardOrt(t, { version: '1.31.0-dev.B' })).toThrow('transformers@4.3.0 は 1.31.0-dev.A を名指ししているが、入っているのは 1.31.0-dev.B');
    // 名指しが無い(読み違い)も通さない
    expect(() => guardOrt({ version: '4.3.0' }, { version: '1.31.0-dev.A' })).toThrow('版が合っていません');
  });

  it('置いた名前が正本の ASR_RUNTIME_FILES と違えば止まる(順不同・過不足とも)', () => {
    expect(() => guardNames(ASR_RUNTIME_FILES, [...ASR_RUNTIME_FILES].reverse())).not.toThrow();
    expect(() => guardNames(ASR_RUNTIME_FILES, ASR_RUNTIME_FILES.slice(1))).toThrow('正本:');
    expect(() => guardNames(ASR_RUNTIME_FILES, [...ASR_RUNTIME_FILES, 'runtime/x.js'])).toThrow('置いた:');
  });

  it('配線:bundle-runtime.mjs が 3 つの門を実際に呼んでいる(原文 pin ── 弱いと自覚して使う)', () => {
    // ⚠ 注釈を落としてから見る(解説コメントが検査を満たさないように)
    const code = readFileSync(join(HERE, '..', '..', 'build', 'asr-pack', 'bundle-runtime.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('assertOrtVersionMatches(pkgTransformers, pkgOrt);');
    expect(code).toContain("await assertNoBareImports(code, '束ねた transformers.mjs');");
    expect(code).toContain('assertRuntimeNamesMatch(mod.ASR_RUNTIME_FILES, Object.keys(info.runtime));');
  });

  it.skipIf(!existsSync(ESBUILD))('裸の指定子が残った出力は止まる(名前を言う)/ 無ければ通る(esbuild が在る箱でだけ)', async () => {
    // @ts-expect-error -- build script は素の .mjs(ビルド対象外)
    const { assertNoBareImports } = (await import('../../build/asr-pack/bare-imports.mjs')) as {
      assertNoBareImports: (code: string, label: string) => Promise<void>;
    };
    await expect(assertNoBareImports('export default 1;', 'x')).resolves.toBeUndefined();
    await expect(assertNoBareImports('import a from "onnxruntime-common"; import("node:fs");', '束ねた物'))
      .rejects.toThrow('束ねた物 に裸の指定子が残っています: node:fs, onnxruntime-common');
  });
});

describe.skipIf(!existsSync(ESBUILD))('bundle-runtime ── 本物の esbuild で束ねる(esbuild が在る箱でだけ)', () => {
  it('transformers.mjs が出て、裸の指定子が 0 件、置いた名前が正本の ASR_RUNTIME_FILES と同じ', async () => {
    // @ts-expect-error -- build script は素の .mjs(ビルド対象外)
    const { bundleRuntime } = (await import('../../build/asr-pack/bundle-runtime.mjs')) as {
      bundleRuntime: (o: { outDir: string }) => Promise<{ info: { runtime: Record<string, number>; bundledPackages: { name: string }[] } }>;
    };
    const out = tmp();
    const { info } = await bundleRuntime({ outDir: out });
    expect(Object.keys(info.runtime).sort()).toEqual([...ASR_RUNTIME_FILES].sort());
    for (const f of ASR_RUNTIME_FILES) expect(statSync(join(out, f)).size).toBeGreaterThan(5_000);
    // 実測 567,126(2026-10-02)── 桁(事故)だけ止める。ぴったりにしない
    expect(info.runtime['runtime/transformers.mjs']).toBeGreaterThan(400_000);
    expect(info.runtime['runtime/transformers.mjs']).toBeLessThan(900_000);
    expect(info.bundledPackages.map((p) => p.name)).toEqual(expect.arrayContaining(['@huggingface/transformers', 'onnxruntime-web']));
  }, 60_000);
});
