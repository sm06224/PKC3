/** @vitest-environment node */
/**
 * 🔴 **3D ビューアのローダー(GLTFLoader / STLLoader / OBJLoader)も Three.js も、初期の読み込みに 1 バイトも混ざらない**
 * ことを、実物のビルド(vite の `build()`)で確かめる(v4.0 PR-12)。`gpu-lease-chunk.test.ts` と同じ作法。
 *
 * ① 通常の版: ローダーは entry とは別の遅延 chunk に在り(在ることも確かめる ── 空振りしない)、entry から動的 import でだけ届く
 * ② 1 枚にまとめた版(`__PKC_PORTABLE__ = true` + 動的 import を畳む): three もローダーも**どこにも無い**
 * 🔑 目印は縮小しても残るエラー文(`THREE.GLTFLoader:` など)。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build, type Plugin, type Rollup } from 'vite';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VIEWER = fileURLToPath(new URL('../../src/adapter/ui/render/viewer-3d.ts', import.meta.url));
const ENTRY_ID = 'virtual:viewer-3d-entry';
const THREE_MARK = /THREE\.(?:WebGLRenderer|Renderer|Mesh|Vector3|BufferGeometry)\b/;
const LOADER_MARKS: Readonly<Record<string, RegExp>> = {
  gltf: /THREE\.GLTFLoader:/,
  stl: /THREE\.STLLoader:/,
  obj: /THREE\.OBJLoader:/,
};

function entryPlugin(): Plugin {
  return {
    name: 'viewer-3d-entry',
    resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
    load: (id) =>
      id === `\0${ENTRY_ID}`
        ? `import { mount3dViewer, hydrate3d, parseModel } from ${JSON.stringify(VIEWER)};\n` +
          'export { mount3dViewer, hydrate3d, parseModel };\n'
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

describe('🔴 3D ビューアのローダーは初期の読み込みに混ざらない(実物のビルド)', () => {
  it('通常の版: entry と静的な依存には three もローダーも無く、ローダーは遅延 chunk に在る', async () => {
    const chunks = await bundle(false);
    const entry = chunks.find((c) => c.isEntry)!;
    expect(entry).toBeDefined();
    const initial = new Set([entry.fileName, ...entry.imports]);
    for (const c of chunks) {
      if (!initial.has(c.fileName)) continue;
      expect(c.code, c.fileName).not.toMatch(THREE_MARK);
      for (const [k, re] of Object.entries(LOADER_MARKS)) expect(c.code, `${c.fileName} に ${k}`).not.toMatch(re);
    }
    // 空振り防止: 各ローダーは確かに遅延 chunk に出ていて、entry から動的 import で辿れる
    const reachable = new Set<string>();
    const walk = (name: string): void => {
      if (reachable.has(name)) return;
      reachable.add(name);
      const c = chunks.find((x) => x.fileName === name);
      for (const n of [...(c?.imports ?? []), ...(c?.dynamicImports ?? [])]) walk(n);
    };
    for (const d of entry.dynamicImports) walk(d);
    for (const [k, re] of Object.entries(LOADER_MARKS)) {
      const hit = chunks.filter((c) => !initial.has(c.fileName) && re.test(c.code));
      expect(hit.length, `${k} の chunk が無い(この検査は空振り)`).toBeGreaterThan(0);
      for (const c of hit) expect(reachable.has(c.fileName), c.fileName).toBe(true);
    }
  }, 240_000);

  it('1 枚にまとめた版: three もローダーもどこにも入らない(枝ごと落ちる)', async () => {
    const chunks = await bundle(true);
    const all = chunks.map((c) => c.code).join('\n');
    expect(all).not.toMatch(THREE_MARK);
    for (const [k, re] of Object.entries(LOADER_MARKS)) expect(all, k).not.toMatch(re);
    // 空振り防止: ビューア本体は入っている(ツールバーの字が残る)
    expect(all).toContain('視点をリセット');
    expect(all).not.toMatch(/import\(\s*["'`]/);
  }, 240_000);
});
