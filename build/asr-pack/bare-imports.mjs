/**
 * 束ねた JS に残った**裸の指定子**を数える(bundle-runtime.mjs と check-pack.mjs が共有する 1 本)。
 *
 * ⚠ esbuild は**使うときに読む**(動的 import)── `build/asr-pack/node_modules` は本体の CI には無いので、
 *   静的に import すると、これを import する test / check-pack が esbuild の無い環境で丸ごと落ちる。
 *   ⚠ 読めなかったら**例外のまま投げる**(呼び側が「検査できなかった」と言う ── 0 件と読まない)。
 */
/**
 * 束ねた出力に残った**裸の指定子**を数える。
 * 🔑 esbuild に `bundle: false` で読み直させ、metafile の `imports`(静的 import / 動的 import の
 *   リテラル / require)を見る。⚠ 「相対(`./` `../`)・絶対 URL(`http(s):` `data:` `blob:`)・`/` 始まり」
 *   以外は全部裸と数える(`node:fs` も含む ── ブラウザの worker に `node:` は無い)。
 */
export async function findBareImports(code) {
  const { build } = await import('esbuild');
  const res = await build({
    stdin: { contents: code, loader: 'js', resolveDir: process.cwd(), sourcefile: 'bundle-check.mjs' },
    bundle: false,
    write: false,
    metafile: true,
    format: 'esm',
    logLevel: 'silent',
    outfile: 'out.mjs',
  });
  const bare = new Set();
  for (const out of Object.values(res.metafile.outputs)) {
    for (const imp of out.imports) {
      const p = imp.path;
      if (/^(\.\.?\/|\/|https?:|data:|blob:)/.test(p)) continue;
      bare.add(p);
    }
  }
  return [...bare].sort();
}

/** 1 件でも残っていたら止まる(bundle-runtime.mjs の門)。 */
export async function assertNoBareImports(code, label) {
  const bare = await findBareImports(code);
  if (bare.length > 0) throw new Error(`${label} に裸の指定子が残っています: ${bare.join(', ')}`);
}
