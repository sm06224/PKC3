/**
 * 🔴 #1446 ② ── WebGPU を先に試す部品の実行(`AsrJob.gpu`)と、WebGPU の可否の測り方。
 *
 * 守りたい主張:
 *  ① `gpu` の依頼は WebGPU(fp16)を先に試し、通ればその実行器で動く
 *  ② 実行の部品が WebGPU に対応していない(`pipeline` が落ちる)ときは、CPU(wasm / q8)へ戻って動く
 *  ③ 対照群: `gpu` でない依頼は WebGPU を試さない / WebGPU が無い場所では試さない
 *  ④ 可否は「在る」ではなく「アダプタが取れた」で測る
 */
import { describe, expect, it } from 'vitest';
import { AsrRunner, type AsrJob, type RuntimeModule } from '../../src/adapter/platform/asr/asr-run';
import { probeWebGpu } from '../../src/adapter/platform/asr/webgpu-probe';
import {
  ASR_RUNTIME_JS,
  ASR_RUNTIME_WASM,
  ASR_RUNTIME_WASM_LOADER,
} from '../../src/features/asr/asr-parts';

function setup(opts: { webgpuWorks: boolean; hasWebGpu: boolean; webgpuRunFails?: boolean }) {
  const devices: unknown[] = [];
  const dtypes: unknown[] = [];
  const disposed: unknown[] = [];
  const rt: RuntimeModule = {
    env: {
      allowRemoteModels: true,
      allowLocalModels: false,
      localModelPath: '',
      useBrowserCache: true,
      useWasmCache: true,
      fetch: () => Promise.reject(new Error('x')),
      backends: { onnx: { wasm: { wasmPaths: undefined as unknown } } },
    },
    pipeline: (_task, _model, options) => {
      devices.push(options['device']);
      dtypes.push(options['dtype']);
      const dev = options['device'];
      if (options['device'] === 'webgpu' && !opts.webgpuWorks) return Promise.reject(new Error('webgpu 非対応'));
      return Promise.resolve(
        Object.assign(
          () => (dev === 'webgpu' && opts.webgpuRunFails ? Promise.reject(new Error('device lost')) : Promise.resolve({ text: 'ok' })),
          { dispose: () => { disposed.push(dev); return Promise.resolve(); } },
        ),
      );
    },
  };
  const runner = new AsrRunner({
    importModule: () => Promise.resolve(rt),
    createObjectURL: () => 'blob:x',
    hasWebGpu: () => opts.hasWebGpu,
  });
  return { runner, devices, dtypes, disposed };
}

const job = (over: Partial<AsrJob>): AsrJob => ({
  files: [
    [ASR_RUNTIME_JS, new Blob(['js'])],
    [ASR_RUNTIME_WASM_LOADER, new Blob(['l'])],
    [ASR_RUNTIME_WASM, new Blob(['w'])],
  ],
  modelId: 'm',
  language: null,
  pcm: new Float32Array(16),
  ...over,
});

describe('gpu の部品の実行器', () => {
  it('WebGPU が通れば webgpu で動く', async () => {
    const { runner, devices } = setup({ webgpuWorks: true, hasWebGpu: true });
    const r = await runner.run(job({ gpu: true }));
    expect(devices).toEqual(['webgpu']);
    expect(r.device).toBe('webgpu');
  });

  it('🔴 WebGPU で作れなければ CPU(wasm)へ戻って動く', async () => {
    const { runner, devices } = setup({ webgpuWorks: false, hasWebGpu: true });
    const r = await runner.run(job({ gpu: true }));
    expect(devices).toEqual(['webgpu', 'wasm']);
    expect(r.device).toBe('wasm');
    expect(r.text).toBe('ok');
  });

  it('🔴 WebGPU の dtype は fp16、CPU は q8(目録に fp16 が無い重みを WebGPU 用の設定で読まない)', async () => {
    const { runner, dtypes } = setup({ webgpuWorks: false, hasWebGpu: true });
    await runner.run(job({ gpu: true }));
    expect(dtypes).toEqual(['fp16', 'q8']);
  });

  it('🔴 作れても推論で落ちたら、壊れた pipe を捨てて CPU で作り直し、同じ依頼をやり直す(以後も CPU)', async () => {
    const { runner, devices, disposed } = setup({ webgpuWorks: true, hasWebGpu: true, webgpuRunFails: true });
    const r = await runner.run(job({ gpu: true }));
    expect(r.text).toBe('ok');
    expect(r.device).toBe('wasm');
    expect(devices).toEqual(['webgpu', 'wasm']);
    expect(disposed, '壊れた pipe を捨てていない').toEqual(['webgpu']);
    const r2 = await runner.run(job({ gpu: true }));
    expect(r2.device).toBe('wasm');
    expect(devices, '以後も壊れた WebGPU を試し直した').toEqual(['webgpu', 'wasm']);
  });

  it('対照群:CPU の推論の失敗は握りつぶさず投げる', async () => {
    const { runner } = setup({ webgpuWorks: true, hasWebGpu: false });
    // CPU の pipe が落ちる状況を作る
    (runner as unknown as { loaded: unknown }).loaded = { modelId: 'm', device: 'wasm', pipe: () => Promise.reject(new Error('boom')) };
    await expect(runner.run(job({}))).rejects.toThrow('boom');
  });

  it('対照群:gpu でない依頼・WebGPU の無い場所では、WebGPU を試さない', async () => {
    const a = setup({ webgpuWorks: true, hasWebGpu: true });
    expect((await a.runner.run(job({}))).device).toBe('wasm');
    expect(a.devices).toEqual(['wasm']);
    const b = setup({ webgpuWorks: true, hasWebGpu: false });
    expect((await b.runner.run(job({ gpu: true }))).device).toBe('wasm');
    expect(b.devices).toEqual(['wasm']);
  });
});

describe('WebGPU の可否の測り方', () => {
  it('アダプタが取れたときだけ true(在るだけ・null・例外・API 無しは false)', async () => {
    expect(await probeWebGpu({ requestAdapter: async () => ({}) })).toBe(true);
    expect(await probeWebGpu({ requestAdapter: async () => null }), 'API が在るだけで使えると言った').toBe(false);
    expect(await probeWebGpu({ requestAdapter: () => Promise.reject(new Error('x')) })).toBe(false);
    // 引数を渡さなければ実機の navigator.gpu(happy-dom には無い)
    expect(await probeWebGpu(undefined)).toBe(false);
  });
});
