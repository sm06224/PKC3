/** @vitest-environment node */
/**
 * 🔴 **Three.js が初期の読み込みに 1 バイトも混ざらないこと**を、実物のビルド(vite の `build()`)で確かめる(PR-11)。
 *
 * ⚠ この PR の時点では、アプリの画面から `gpu-lease.ts` を呼ぶ所がまだ無い(3D ビューアは PR-12)── だから
 *   `npm run build` の `dist/` を見ても three は**そもそも入らず**、「entry に three が無い」は空振りで緑になる。
 *   ここでは `gpu-lease.ts` を**静的に import する entry** を 1 つ作ってビルドし、
 *   ① 通常の版: three は entry とは別の遅延 chunk に分かれる(しかも three の chunk は**在る** ── 空振りしない)
 *   ② 1 枚にまとめた版(`__PKC_PORTABLE__ = true` + `inlineDynamicImports`): three は**どこにも無い**
 *   の 2 つを、出力の中身で見る。
 * 🔑 three の目印は、縮小しても残る文字列(エラー文の `THREE.WebGLRenderer` / `THREE.Mesh` など)。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build, type Plugin, type Rollup } from 'vite';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LEASE = fileURLToPath(new URL('../../src/adapter/platform/render/gpu-lease.ts', import.meta.url));
const ENTRY_ID = 'virtual:gpu-lease-entry';
const THREE_MARK = /THREE\.(?:WebGLRenderer|Renderer|Mesh|Vector3|BufferGeometry)\b/;

function entryPlugin(): Plugin {
  return {
    name: 'gpu-lease-entry',
    resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
    load: (id) =>
      id === `\0${ENTRY_ID}`
        ? `import { createGpuSurface, loadThree, loadThreeWebGpu, gpuLeaseStats } from ${JSON.stringify(LEASE)};\n` +
          'export { createGpuSurface, loadThree, loadThreeWebGpu, gpuLeaseStats };\n'
        : null,
  };
}

async function bundle(portable: boolean): Promise<Rollup.OutputChunk[]> {
  const out = await build({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    define: { __PKC_PORTABLE__: portable ? 'true' : 'false' },
    plugins: [entryPlugin()],
    resolve: {
      alias: {
        '@core': fileURLToPath(new URL('../../src/core', import.meta.url)),
        '@features': fileURLToPath(new URL('../../src/features', import.meta.url)),
        '@adapter': fileURLToPath(new URL('../../src/adapter', import.meta.url)),
        '@runtime': fileURLToPath(new URL('../../src/runtime', import.meta.url)),
      },
    },
    build: {
      write: false,
      target: 'es2022',
      sourcemap: false,
      minify: true,
      rollupOptions: {
        input: ENTRY_ID,
        preserveEntrySignatures: 'strict',
        // ⚠ `build/portable.config.ts` の `inlineDynamicImports: true` と同じ意味(rolldown の新しい名前。古い名前は警告を出す)
        output: portable ? { codeSplitting: false } : {},
      },
    },
  });
  const results = (Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[];
  return results.flatMap((r) => r.output.filter((o): o is Rollup.OutputChunk => o.type === 'chunk'));
}

describe('🔴 gpu-lease の three は初期の読み込みに混ざらない(実物のビルド)', () => {
  it('通常の版: entry には three が無く、three は別の遅延 chunk に在る', async () => {
    const chunks = await bundle(false);
    const entries = chunks.filter((c) => c.isEntry);
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.code).not.toMatch(THREE_MARK);
    // entry が静的に読む chunk(初期の読み込み)にも three は無い
    const initial = new Set([entry.fileName, ...entry.imports]);
    for (const c of chunks) if (initial.has(c.fileName)) expect(c.code, c.fileName).not.toMatch(THREE_MARK);
    // 🔴 空振り防止: three の chunk は確かに出ていて、entry からは動的 import でだけ指される
    const threeChunks = chunks.filter((c) => !initial.has(c.fileName) && THREE_MARK.test(c.code));
    expect(threeChunks.length).toBeGreaterThan(0);
    expect(entry.dynamicImports.length).toBeGreaterThan(0);
    const reachable = new Set<string>();
    const walk = (name: string): void => {
      if (reachable.has(name)) return;
      reachable.add(name);
      const c = chunks.find((x) => x.fileName === name);
      for (const n of [...(c?.imports ?? []), ...(c?.dynamicImports ?? [])]) walk(n);
    };
    for (const d of entry.dynamicImports) walk(d);
    for (const c of threeChunks) expect(reachable.has(c.fileName), c.fileName).toBe(true);
  }, 180_000);

  it('1 枚にまとめた版: three はどこにも入らない(枝ごと落ちる)', async () => {
    const chunks = await bundle(true);
    expect(chunks.length).toBeGreaterThan(0);
    const all = chunks.map((c) => c.code).join('\n');
    expect(all).not.toMatch(THREE_MARK);
    // 🔴 空振り防止: gpu-lease 本体は入っている(退避の字が残る)
    expect(all).toContain('1 枚にまとめた版');
    // 1 枚の中に動的 import は残らない
    expect(all).not.toMatch(/import\(\s*["'`]/);
  }, 180_000);
});
