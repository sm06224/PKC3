/** @vitest-environment node */
/**
 * 🔴 **関係グラフ(`GraphRenderer`)を読み込んでも、Three.js は初期の読み込みに 1 バイトも混ざらない**
 * ことを、実物のビルド(vite の `build()`)で確かめる(v4.0 PR-13)。`viewer-3d-chunk.test.ts` と同じ作法。
 *
 * ① 通常の版: three は entry とは別の遅延 chunk に在り(在ることも確かめる ── 空振りしない)、entry から動的 import でだけ届く
 * ② 1 枚にまとめた版(`__PKC_PORTABLE__ = true` + 動的 import を畳む): three は**どこにも無い**が、大規模 / 3D の描き方(2D の簡易表示)は入っている
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build, type Plugin, type Rollup } from 'vite';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GRAPH = fileURLToPath(new URL('../../src/adapter/ui/render/graph.ts', import.meta.url));
const ENTRY_ID = 'virtual:graph-gpu-entry';
const THREE_MARK = /THREE\.(?:WebGLRenderer|Renderer|Mesh|Vector3|BufferGeometry)\b/;

function entryPlugin(): Plugin {
  return {
    name: 'graph-gpu-entry',
    resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
    load: (id) =>
      id === `\0${ENTRY_ID}`
        ? `import { GraphRenderer, graphViewOf } from ${JSON.stringify(GRAPH)};\n` +
          'export { GraphRenderer, graphViewOf };\n'
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
        output: portable ? { codeSplitting: false } : {},
      },
    },
  });
  const results = (Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[];
  return results.flatMap((r) => r.output.filter((o): o is Rollup.OutputChunk => o.type === 'chunk'));
}

describe('🔴 関係グラフを読み込んでも Three.js は初期の読み込みに混ざらない(実物のビルド)', () => {
  it('通常の版: entry と静的な依存に three は無く、three は entry から動的 import でだけ届く遅延 chunk に在る', async () => {
    const chunks = await bundle(false);
    const entry = chunks.find((c) => c.isEntry)!;
    expect(entry).toBeDefined();
    const initial = new Set([entry.fileName, ...entry.imports]);
    for (const c of chunks) {
      if (!initial.has(c.fileName)) continue;
      expect(c.code, c.fileName).not.toMatch(THREE_MARK);
    }
    // 空振り防止: 関係グラフの描画器は entry に在り(大規模 / 3D の切り替えの字が残る)
    expect([...initial].map((n) => chunks.find((c) => c.fileName === n)!.code).join('\n')).toContain('大規模表示で全部見る');
    // 空振り防止: three は確かに遅延 chunk に出ていて、entry から動的 import で辿れる
    const reachable = new Set<string>();
    const walk = (name: string): void => {
      if (reachable.has(name)) return;
      reachable.add(name);
      const c = chunks.find((x) => x.fileName === name);
      for (const n of [...(c?.imports ?? []), ...(c?.dynamicImports ?? [])]) walk(n);
    };
    for (const d of entry.dynamicImports) walk(d);
    const hit = chunks.filter((c) => !initial.has(c.fileName) && THREE_MARK.test(c.code));
    expect(hit.length, 'three の chunk が無い(この検査は空振り)').toBeGreaterThan(0);
    for (const c of hit) expect(reachable.has(c.fileName), c.fileName).toBe(true);
  }, 240_000);

  it('1 枚にまとめた版: three はどこにも入らない(枝ごと落ちる)が、大規模 / 3D の描き方は入っている', async () => {
    const chunks = await bundle(true);
    const all = chunks.map((c) => c.code).join('\n');
    expect(all).not.toMatch(THREE_MARK);
    expect(all).toContain('大規模表示で全部見る');
    expect(all).toContain('graph-gpu-canvas2d');
    expect(all).not.toMatch(/import\(\s*["'`]/);
  }, 240_000);
});
