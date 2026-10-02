/**
 * bundle-runtime.mjs の**門**(束ねの結果が、取る側の前提と食い違っていたら止める)。
 *
 * ⚠ 本物の esbuild を回さずに test できるよう、判定だけをここへ出した
 *   (bundle-runtime.mjs は esbuild を静的に import するので、本体の CI では読めない)。
 */

/**
 * transformers が名指しする onnxruntime-web の版と、入っている版が同じであること。
 * 🔑 別の版の wasm と js を組み合わせると、**実行時にだけ**壊れる(ビルドは通る)。
 */
export function assertOrtVersionMatches(pkgTransformers, pkgOrt) {
  const want = pkgTransformers.dependencies?.['onnxruntime-web'];
  if (want !== pkgOrt.version) {
    throw new Error(
      `onnxruntime-web の版が合っていません: transformers@${pkgTransformers.version} は ${want} を名指ししているが、`
        + `入っているのは ${pkgOrt.version}(build/asr-pack/package.json を揃える)`,
    );
  }
}

/**
 * 置いた実行の部品の名前が、取る側の正本(`ASR_RUNTIME_FILES`)と同じであること。
 * 🔑 名前を書き写して置かない ── 正本の側が変わった日に、置いた物が目録に載らなくなる。
 */
export function assertRuntimeNamesMatch(canonical, placed) {
  const want = [...canonical].sort().join(', ');
  const got = [...placed].sort().join(', ');
  if (want !== got) {
    throw new Error(`置いた実行の部品が asr-parts.ts の ASR_RUNTIME_FILES と違います(正本: ${want} / 置いた: ${got})`);
  }
}
