/**
 * 音声認識の「中身」(#772 段②)── ワーカーの中で動く。
 *
 * 守りたい主張:
 *  ① 🔴 **網へ 1 本も出ない** ── 実行の部品も重みも、端末の Blob から出る。
 *     取り先を端末の中に絞る行が **`pipeline()` より前**に全部済んでいる(CDN を使う既定のまま
 *     起動しない)/ 一致しない path は**素の fetch へ落とさず 404**
 *  ② 部品の import は blob: の URL(`createObjectURL` した Blob)
 *  ③ 読み込んだ model は**同じ worker の間は使い回す**(続けて押したとき読み込みをやり直さない)/
 *     別の model へ替わるときは**先に前の物を手放す**(2 つ分の常駐を重ねない)
 *  ④ 言語の指定(`null` = 自動判定は language を渡さない)
 *  ⑤ 実行の部品が欠けていれば理由つきで断る
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASR_FETCH_PREFIX,
  ASR_LOCAL_MODEL_PATH,
  AsrRunner,
  type AsrJob,
  type RuntimeModule,
} from '../../src/adapter/platform/asr/asr-run';
import {
  ASR_PARTS,
  ASR_RUNTIME_JS,
  ASR_RUNTIME_WASM,
  ASR_RUNTIME_WASM_LOADER,
  asrModelDir,
} from '../../src/features/asr/asr-parts';

const part = ASR_PARTS[0]!;

interface Seen {
  importedUrls: string[];
  /** `pipeline()` が呼ばれた時点の環境の写し。 */
  envAtPipeline: Array<Record<string, unknown>>;
  pipelineCalls: Array<{ task: string; model: string; options: Record<string, unknown> }>;
  runCalls: Array<Record<string, unknown>>;
  disposed: string[];
  events: string[];
}

function fakeRuntime(seen: Seen, output: unknown = { text: 'こんにちは' }): RuntimeModule {
  const env = {
    allowRemoteModels: true,
    allowLocalModels: false,
    localModelPath: '/default/',
    useBrowserCache: true,
    useWasmCache: true,
    fetch: (() => Promise.reject(new Error('既定の fetch'))) as (i: unknown) => Promise<Response>,
    backends: { onnx: { wasm: { wasmPaths: undefined as unknown } } },
  };
  return {
    env,
    pipeline: (task, model, options) => {
      seen.events.push(`pipeline:${model}`);
      seen.pipelineCalls.push({ task, model, options });
      seen.envAtPipeline.push({
        allowRemoteModels: env.allowRemoteModels,
        allowLocalModels: env.allowLocalModels,
        localModelPath: env.localModelPath,
        useBrowserCache: env.useBrowserCache,
        useWasmCache: env.useWasmCache,
        wasmPaths: env.backends.onnx.wasm.wasmPaths,
      });
      const pipe = Object.assign(
        (_pcm: Float32Array, opts: Record<string, unknown>) => {
          seen.runCalls.push(opts);
          return Promise.resolve(output);
        },
        {
          dispose: () => {
            seen.disposed.push(model);
            seen.events.push(`dispose:${model}`);
            return Promise.resolve();
          },
        },
      );
      return Promise.resolve(pipe);
    },
  };
}

function setup(output?: unknown) {
  const seen: Seen = { importedUrls: [], envAtPipeline: [], pipelineCalls: [], runCalls: [], disposed: [], events: [] };
  const urls = new Map<string, Blob>();
  let n = 0;
  const rt = fakeRuntime(seen, output);
  let clock = 0;
  const runner = new AsrRunner({
    importModule: (url) => {
      seen.importedUrls.push(url);
      return Promise.resolve(rt);
    },
    createObjectURL: (b) => {
      const u = `blob:fake/${(n += 1)}`;
      urls.set(u, b);
      return u;
    },
    now: () => (clock += 100),
  });
  return { runner, seen, urls, rt };
}

const blob = (s: string): Blob => new Blob([s]);
function job(over: Partial<AsrJob> = {}): AsrJob {
  return {
    files: [
      [ASR_RUNTIME_JS, blob('js')],
      [ASR_RUNTIME_WASM_LOADER, blob('loader')],
      [ASR_RUNTIME_WASM, blob('wasm')],
      [`${asrModelDir(part)}config.json`, blob('{"a":1}')],
    ],
    modelId: part.modelId,
    language: 'japanese',
    pcm: new Float32Array(16000),
    ...over,
  };
}

describe('AsrRunner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('🔴 取り先を端末の中に絞る行は、pipeline() より前に全部済んでいる(CDN の既定のまま起動しない)', async () => {
    const { runner, seen, urls } = setup();
    await runner.run(job());
    const e = seen.envAtPipeline[0]!;
    expect(e['allowRemoteModels'], '外の model を許したまま').toBe(false);
    expect(e['allowLocalModels']).toBe(true);
    expect(e['localModelPath']).toBe(ASR_LOCAL_MODEL_PATH);
    expect(e['useBrowserCache'], 'ブラウザのキャッシュ経由で外へ出る道').toBe(false);
    expect(e['useWasmCache'], 'wasm を自分で取りに行く道').toBe(false);
    // 🔴 wasm の置き場を**明示で渡している**(渡さないと transformers は CDN から取りに行く)
    const wp = e['wasmPaths'] as { mjs: string; wasm: string };
    expect(wp.mjs.startsWith('blob:')).toBe(true);
    expect(wp.wasm.startsWith('blob:')).toBe(true);
    // 渡した blob の中身が、実行の部品の loader / wasm の Blob である(取り違えていない)
    expect(await urls.get(wp.mjs)!.text()).toBe('loader');
    expect(await urls.get(wp.wasm)!.text()).toBe('wasm');
  });

  /**
   * 🔴 **種類は配る側に依らず、こちらで決める**(実ブラウザの smoke が拾った欠陥)。
   * ES module を import する blob: の URL は、種類が JavaScript でなければ読めない ──
   * 保管の Blob は取ってきたときの Content-Type を持つので、配る側が種類を付けない / 別の種類で
   * 返すと、**取り込みは成功して、文字にする所で初めて落ちる**。
   */
  it('🔴 import する物には JavaScript の種類を、wasm には wasm の種類を付けて渡す(元の Blob の種類に依らない)', async () => {
    const { runner, urls } = setup();
    // 元の Blob は種類を持たない(= 配る側が Content-Type を付けなかった形)
    await runner.run(job());
    const types = new Map([...urls].map(([u, b]) => [u, b.type]));
    const vals = [...types.values()];
    expect(vals.filter((t) => t === 'text/javascript'), 'import する js / loader に種類が付いていない').toHaveLength(2);
    expect(vals.filter((t) => t === 'application/wasm')).toHaveLength(1);
    // 別の種類で渡されても直す(octet-stream で返す配り方)
    const odd = setup();
    const j = job();
    await odd.runner.run({
      ...j,
      files: j.files.map(([p, b]) => [p, new Blob([b], { type: 'application/octet-stream' })] as const),
    });
    expect([...odd.urls.values()].map((b) => b.type).sort()).toEqual(
      ['application/wasm', 'text/javascript', 'text/javascript'],
    );
  });

  it('② 実行の部品の import は blob: の URL で、渡した js の Blob である', async () => {
    const { runner, seen, urls } = setup();
    await runner.run(job());
    expect(seen.importedUrls).toHaveLength(1);
    expect(seen.importedUrls[0]!.startsWith('blob:')).toBe(true);
    expect(await urls.get(seen.importedUrls[0]!)!.text()).toBe('js');
  });

  it('🔴 env.fetch は Blob から返し、一致しない path は素の fetch へ落とさず 404 を返す', async () => {
    const outside = vi.fn();
    vi.stubGlobal('fetch', outside);
    const { runner, rt } = setup();
    await runner.run(job());
    const f = rt.env.fetch;
    const ok = await f(`${ASR_LOCAL_MODEL_PATH}openai/whisper-base/config.json`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('{"a":1}');
    expect(ok.headers.get('content-length')).toBe(String('{"a":1}'.length));
    // 取りこぼし = 外へ取りに行く、に化けない
    for (const miss of [
      `${ASR_LOCAL_MODEL_PATH}openai/whisper-base/nope.json`,
      'https://huggingface.co/openai/whisper-base/resolve/main/config.json',
      'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.wasm',
      '/somewhere/else',
    ]) {
      expect((await f(miss)).status, miss).toBe(404);
    }
    // URL / Request 形でも同じ
    expect((await f(new URL(`http://x${ASR_FETCH_PREFIX}models/openai/whisper-base/config.json`))).status).toBe(200);
    expect(outside, '網へ出た').not.toHaveBeenCalled();
  });

  it('③ 続けて頼むと、model の読み込みも実行の部品の import もやり直さない', async () => {
    const { runner, seen } = setup();
    const a = await runner.run(job());
    const b = await runner.run(job());
    expect(seen.importedUrls).toHaveLength(1);
    expect(seen.pipelineCalls).toHaveLength(1);
    expect(a.text).toBe('こんにちは');
    expect(b.text).toBe('こんにちは');
    expect(runner.loadedModel).toBe(part.modelId);
  });

  it('🔴 別の model へ替わるときは、前の物を先に手放してから読む(2 つ分を重ねない)', async () => {
    const { runner, seen } = setup();
    const other = ASR_PARTS[1]!;
    await runner.run(job());
    await runner.run(
      job({
        modelId: other.modelId,
        files: [...job().files, [`${asrModelDir(other)}config.json`, blob('{}')]],
      }),
    );
    expect(seen.events).toEqual([
      `pipeline:${part.modelId}`,
      `dispose:${part.modelId}`,
      `pipeline:${other.modelId}`,
    ]);
    expect(runner.loadedModel).toBe(other.modelId);
  });

  it('④ 言語を渡す / null なら渡さない(自動判定)', async () => {
    const a = setup();
    await a.runner.run(job({ language: 'japanese' }));
    expect(a.seen.runCalls[0]!['language']).toBe('japanese');
    const b = setup();
    await b.runner.run(job({ language: null }));
    expect('language' in b.seen.runCalls[0]!, '自動判定のはずが language を渡した').toBe(false);
    // 測った組み合わせから動かさない(chunk の切り方)
    expect(b.seen.runCalls[0]).toMatchObject({
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      // 🔑 #1232 段 a: 時刻つきの区切りを頼む(false に戻すと行の形が作れない)
      return_timestamps: true,
    });
    expect(b.seen.pipelineCalls[0]).toMatchObject({
      task: 'automatic-speech-recognition',
      options: { device: 'wasm', dtype: 'q8' },
    });
  });

  it('結果は 1 続きの字にそろう(配列で返る形も、前後の空白も)', async () => {
    const { runner } = setup([{ text: ' こんにちは。' }, { text: '今日は晴れです ' }]);
    expect((await runner.run(job())).text).toBe('こんにちは。 今日は晴れです');
    const e = setup({ nothing: 1 });
    expect((await e.runner.run(job())).text).toBe('');
  });

  it('🔴 #1232 段 a: chunks(秒)は segments(ms)になる ── 空の区切りは落とし、text は残す', async () => {
    const { runner } = setup({
      text: ' こんにちは。今日は',
      chunks: [
        { timestamp: [0, 2.5], text: ' こんにちは。' },
        { timestamp: [2.5, 4.25], text: '   ' },
        { timestamp: [15, 20.0004], text: '今日は' },
      ],
    });
    const r = await runner.run(job());
    expect(r.text).toBe('こんにちは。今日は');
    expect(r.segments).toEqual([
      { startMs: 0, endMs: 2500, text: ' こんにちは。' },
      { startMs: 15000, endMs: 20000, text: '今日は' },
    ]);
  });

  it('#1232: 最後の区切りの終わりが null なら endMs も null(0 や NaN にしない)', async () => {
    const { runner } = setup({ text: 'あ い', chunks: [{ timestamp: [1.5, 3], text: 'あ' }, { timestamp: [61.2, null], text: 'い' }] });
    const r = await runner.run(job());
    expect(r.segments).toEqual([
      { startMs: 1500, endMs: 3000, text: 'あ' },
      { startMs: 61200, endMs: null, text: 'い' },
    ]);
  });

  it('#1232: chunks が無い runtime でも text だけで動く(segments を持たない)', async () => {
    const { runner } = setup({ text: 'こんにちは' });
    const r = await runner.run(job());
    expect(r.text).toBe('こんにちは');
    expect('segments' in r, 'chunks が無いのに segments を足した').toBe(false);
    const e = setup({ text: 'あ', chunks: [{ timestamp: [0, 1], text: '  ' }] });
    expect('segments' in (await e.runner.run(job()))).toBe(false);
  });

  it('⑤ 実行の部品が欠けていれば、取り込み直しを促して断る(何も import しない)', async () => {
    const { runner, seen } = setup();
    const partial = job({ files: job().files.filter(([p]) => p !== ASR_RUNTIME_WASM) });
    await expect(runner.run(partial)).rejects.toThrow(/入れ直してください/);
    expect(seen.importedUrls).toEqual([]);
    expect(seen.pipelineCalls).toEqual([]);
  });

  it('読み込みと推論の時間を分けて返す', async () => {
    const { runner } = setup();
    const r = await runner.run(job());
    expect(r.loadMs).toBeGreaterThan(0);
    expect(r.runMs).toBeGreaterThan(0);
  });
});
