/**
 * P7 段④: `sw.js` を**生成物の一覧から作る** Vite plugin(設計 doc §2-2)。
 *
 * ⚠ 手書きの precache 一覧は**必ず腐る** ── ハッシュ付きファイル名なので
 * ビルドのたびに変わる。生成しない選択肢は無い。
 *
 * 🔑 **中身の規則は `src/adapter/platform/sw/sw-source.ts` の 1 か所**にある。
 * ここは「何を precache するか」を集めて渡すだけ。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { shouldPrecache, swSource } from '../src/adapter/platform/sw/sw-source.ts';

/** `public/` の中身を列挙する(`dist` へそのままコピーされる)。 */
function listPublic(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  try {
    walk(dir);
  } catch {
    return []; // public/ が無いビルドもありうる
  }
  return out;
}

/**
 * @param buildIdFor precache 一覧から cache 名の識別子を作る。⚠ **配る物が
 *   変わったときだけ変わる**必要がある ── 固定だと新しい版が古い cache を
 *   使い続け、毎回変わると中身が同じでも全 user が再 precache する(review M-1)
 */
export function swPlugin(buildIdFor: (precache: readonly string[]) => string): Plugin {
  let publicDir = '';
  return {
    name: 'pkc3-sw',
    apply: 'build',
    configResolved(config: ResolvedConfig) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(shouldPrecache);
      // 🔴 `public/` の静的コピーは bundle に現れないので**列挙する**。
      // ⚠ ここを手書きの一覧にすると、`public/` に 1 ファイル足しただけで
      // 検品が「precache に載っていない生成物がある」と鳴り、しかも
      // **エラーがこの file を指さない**(review M-3)── 一覧は必ず腐る
      const staticFiles = listPublic(publicDir).filter(shouldPrecache);
      // index.html は navigation の fallback として**必ず要る**ので先頭に置く
      const rest = [...staticFiles, ...files].filter((f) => f !== 'index.html');
      const precache = ['index.html', ...new Set(rest)].map((f) => `./${f}`);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js', // ⚠ hash を付けない(登録 URL が変わると別 SW になる)
        source: swSource({ buildId: buildIdFor(precache), precache }),
      });
    },
  };
}
