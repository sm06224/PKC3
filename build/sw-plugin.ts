/**
 * P7 段④: `sw.js` を**生成物の一覧から作る** Vite plugin(設計 doc §2-2)。
 *
 * ⚠ 手書きの precache 一覧は**必ず腐る** ── ハッシュ付きファイル名なので
 * ビルドのたびに変わる。生成しない選択肢は無い。
 *
 * 🔑 **中身の規則は `src/adapter/platform/sw/sw-source.ts` の 1 か所**にある。
 * ここは「何を precache するか」を集めて渡すだけ。
 */
import type { Plugin } from 'vite';
import { shouldPrecache, swSource } from '../src/adapter/platform/sw/sw-source.ts';

/**
 * @param buildId cache 名に入れる識別子。⚠ **生成物ごとに変わる**必要がある ──
 *   固定だと新しい版が古い cache を使い続ける
 */
export function swPlugin(buildId: () => string): Plugin {
  return {
    name: 'pkc3-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(shouldPrecache);
      // ⚠ `public/` の静的コピーは bundle に現れない ── 手で足す。
      // index.html は navigation の fallback として**必ず要る**
      const staticFiles = ['manifest.webmanifest', 'icon.svg'];
      const precache = [
        'index.html',
        ...staticFiles,
        ...files.filter((f) => f !== 'index.html' && !staticFiles.includes(f)),
      ].map((f) => `./${f}`);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js', // ⚠ hash を付けない(登録 URL が変わると別 SW になる)
        source: swSource({ buildId: buildId(), precache }),
      });
    },
  };
}
