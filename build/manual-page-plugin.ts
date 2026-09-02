/**
 * 🔴 **マニュアルを `manual.html` に焼く Vite plugin**(#645 段②)。
 *
 * ## なぜ build 時に焼くのか
 *
 * 段①の窓(`about:blank` を opener が組む)は実 URL を持たないので、**F5 で白紙**になり、
 * **設定で選んだ配色が届かない**(`platform/manual-window.ts` / `features/help/manual-page.ts`
 * の表)。実 URL を持たせるには、**配る生成物の中に 1 枚在る**ことが要る。
 *
 * ## 🔑 描画は「Vite 自身に読ませる」── esbuild で bundle した config の中では解決できない
 *
 * ⚠ `vite.config.ts` は esbuild で bundle されるので、**tsconfig の path alias
 *   (`@features/*`)を解決できない**(実測: `markdown-render.ts` を直接 import した
 *   1 稿目は `@features/...` で落ちた)。
 * 🔑 だから `buildStart` で **`createServer({ middlewareMode: true })` を使い捨てで立て**、
 *   `ssrLoadModule('/src/…')` で描画を読む(実測 1.1 秒 / 見出し 163 本 / 346 KB)。
 *   alias も `?raw` も Vite の解決がそのまま効く。
 * ⚠ **`src/` を直接 import しない**(`manual-page.ts` も loader 経由)── config の bundle に
 *   `src/` の拡張子無し import が混じると、Vite が config の読み込みで毎回警告を出す
 *   (`configLoader: 'native'` の予告)。src の綴りは全部 loader から取る。
 * ⚠ 使い捨ての server に**この plugin を入れない**(`configFile: false`)── 入れると
 *   `buildStart` の中でまた server を立て、無限に潜る。
 * ⚠ 使い捨ての server で **依存の事前 bundle を切る**(`noDiscovery`)── 既定だと root 直下の
 *   `*.html` を全部 crawl し、`dist-portable/pkc3.html`(7 MB の 1 枚)を解析して落ちる
 *   (実測。SSR には事前 bundle が要らないので、切っても描画は変わらない)。
 *
 * ## 🔴 順番:`swPlugin` より**前**に置く
 *
 * `generateBundle` で `emitFile` した asset は、その時点の `bundle` に載る。`swPlugin` は
 * 自分の `generateBundle` で `Object.keys(bundle)` を precache 一覧にするので、
 * **この plugin が先に走っていないと `manual.html` はオフラインで読めない**
 * (⚠ しかも `dist-inspect.mjs` の「載っていない生成物」が鳴るので、黙っては通らない)。
 * 順番は `tests/build/manual-page-plugin.test.ts` が `vite.config.ts` の字面で pin する。
 *
 * ## dev(`npm run dev`)でも同じ 1 枚を配る
 *
 * ⚠ dev には生成物が無い ── `/manual.html` は Vite の SPA fallback で **`index.html` が返る**。
 *   それは「マニュアルの窓を押したら PKC がもう 1 枚開く」= #292 で user が否定した形そのもの。
 * 🔑 だから `configureServer` で同じ焼きを**その場で**返す(描画は 0.3 秒)。
 *
 * ## 🔴 焼けなかったら build を止める(下限)
 *
 * 見出しが 0 本でも HTML としては妥当なので、黙って通る。`MANUAL_MIN_HEADINGS` を下回ったら
 * `this.error` ── 出荷後に「目次が空の page」を配らない
 * (CLAUDE.md「tripwire は上限だけでなく下限も置く」)。
 * ⚠ これは**入力の側**の門である。**出力の側**(dist に在るか / 空でないか / precache に
 *   載ったか)は `scripts/dist-inspect.mjs` が別に見る(§8「入力を守る検査と、出力が届いたかを
 *   見る検査は別物」)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Plugin, type ResolvedConfig } from 'vite';
import { bodyCssPlugin } from './body-css-plugin.ts';
import { extractBodyCss } from './body-css.ts';

/**
 * 見出しの下限。実測 163 本(2026-09-02)。
 * ⚠ 実測ぴったりにしない ── 節を 1 つ削るだけで build が落ちると、まともな整理ができない。
 *   止めたいのは「描画が空振りして 0 本 / 数本」という**桁の事故**である。
 */
export const MANUAL_MIN_HEADINGS = 100;

/** `ssrLoadModule` を持つもの(Vite の dev server。test は代役を差せる)。 */
export interface ModuleLoader {
  ssrLoadModule(url: string): Promise<Record<string, unknown>>;
}

/** 焼けた 1 枚。 */
export interface BakedManual {
  /** 出す file 名(`features/help/manual-page.ts` の `MANUAL_PAGE_FILE`)。 */
  readonly fileName: string;
  readonly html: string;
  readonly headings: number;
  readonly toc: number;
}

/**
 * 焼く。⚠ **export している**のは test が「配線」を見られるようにするため
 * (`versionText(kind)` に **build の kind** が渡ること / 描画の口を呼ぶこと /
 * 綴りを src から取ること)。
 *
 * @param kind `VITE_PKC_KIND`(`product` / `stage` / それ以外は dev 扱い)。
 *   ⚠ **解決済み config から渡す**(`config.env`)── SSR 側の `import.meta.env` に
 *   頼ると、環境変数が届く経路が 2 本になる。
 */
export async function bakeManualPage(
  loader: ModuleLoader,
  root: string,
  kind: string | undefined,
): Promise<BakedManual> {
  const [md, help, find, page, theme, textScale] = await Promise.all([
    loader.ssrLoadModule('/src/features/markdown/markdown-render.ts'),
    loader.ssrLoadModule('/src/adapter/ui/render/help.ts'),
    loader.ssrLoadModule('/src/features/help/manual-find.ts'),
    loader.ssrLoadModule('/src/features/help/manual-page.ts'),
    loader.ssrLoadModule('/src/adapter/ui/render/theme.ts'),
    loader.ssrLoadModule('/src/adapter/ui/render/text-scale.ts'),
  ]);
  const renderMarkdown = md['renderMarkdown'] as (text: string, opts: object) => string;
  const versionText = help['versionText'] as (kind?: string) => string;
  const text = help['MANUAL_TEXT'] as string;
  const manualSections = find['manualSections'] as (text: string) => readonly unknown[];
  const buildManualPage = page['buildManualPage'] as (input: object) => {
    html: string;
    headings: number;
    toc: number;
  };
  const fileName = page['MANUAL_PAGE_FILE'] as string;
  const manualBuildTag = page['manualBuildTag'] as (version: string, text: string) => string;
  const tokensCss = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8');
  const appCss = readFileSync(join(root, 'src/styles/app.css'), 'utf8');
  // ⚠ kind を**明示で**渡す ── 既定引数(`BUILD_KIND`)は SSR の env に依る
  const version = versionText(kind ?? 'dev');
  const built = buildManualPage({
    title: page['MANUAL_WINDOW_TITLE'],
    version,
    // 🔑 opener(`main.ts`)と同じ関数・同じ材料 ── 印が食い違うと毎回読み直す
    tag: manualBuildTag(version, text),
    html: renderMarkdown(text, {}),
    sections: manualSections(text),
    tokensCss,
    bodyCss: extractBodyCss(appCss, tokensCss).css,
    themeStorageKey: theme['THEME_STORAGE_KEY'],
    textScaleStorageKey: textScale['TEXT_SCALE_STORAGE_KEY'],
  });
  return { fileName, ...built };
}

/** `config.env` から kind を取る(無ければ dev 扱い = `release-meta.ts` と同じ倒し方)。 */
function kindOf(config: ResolvedConfig): string | undefined {
  const v: unknown = config.env['VITE_PKC_KIND'];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 焼きの口。⚠ test が差し替える(実物は使い捨ての server を立てる ── 下の `bakeWithServer`)。
 */
export interface ManualPagePluginOptions {
  readonly bake?: (config: ResolvedConfig) => Promise<BakedManual>;
}

/** 実物:使い捨ての dev server を立てて焼き、必ず閉じる。 */
async function bakeWithServer(config: ResolvedConfig): Promise<BakedManual> {
  const server = await createServer({
    configFile: false,
    root: config.root,
    logLevel: 'error',
    server: { middlewareMode: true },
    resolve: { alias: config.resolve.alias },
    optimizeDeps: { noDiscovery: true, include: [] },
    // ⚠ 描画の import 木に `virtual:pkc-body-css` が現れても解決できるようにする
    plugins: [bodyCssPlugin()],
  });
  try {
    return await bakeManualPage(server, config.root, kindOf(config));
  } finally {
    await server.close();
  }
}

export function manualPagePlugin(opts: ManualPagePluginOptions = {}): Plugin {
  const bake = opts.bake ?? bakeWithServer;
  let config: ResolvedConfig;
  let page: BakedManual | null = null;
  return {
    name: 'pkc3-manual-page',
    configResolved(c) {
      config = c;
    },
    configureServer(server) {
      // dev: 同じ 1 枚をその場で焼いて返す(SPA fallback に取られる前に)
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        // ⚠ 安い門を先に ── `.html` 以外(chunk / HMR)は module を読まずに通す
        if (!path.endsWith('.html')) {
          next();
          return;
        }
        server.ssrLoadModule('/src/features/help/manual-page.ts').then(
          (mod) => {
            if (path !== `/${String(mod['MANUAL_PAGE_FILE'])}`) {
              next();
              return;
            }
            bakeManualPage(server, config.root, kindOf(config)).then(
              (p) => {
                res.setHeader('content-type', 'text/html; charset=utf-8');
                res.end(p.html);
              },
              (e: unknown) => next(e),
            );
          },
          (e: unknown) => next(e),
        );
      });
    },
    async buildStart() {
      // ⚠ vitest / dev でも `buildStart` は走る ── 焼くのは build のときだけ
      if (config.command !== 'build') return;
      page = await bake(config);
      if (page.headings < MANUAL_MIN_HEADINGS) {
        this.error(
          `${page.fileName} の焼き込みが壊れています: 見出しが ${page.headings} 本` +
            `(下限 ${MANUAL_MIN_HEADINGS})── 描画が空振りしている`,
        );
      }
    },
    generateBundle() {
      if (page === null) return;
      this.emitFile({ type: 'asset', fileName: page.fileName, source: page.html });
    },
  };
}
