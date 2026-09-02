/** @vitest-environment node */
/**
 * 🔴 **`manual.html` を焼く plugin の配線**(#645 段②)。
 *
 * ⚠ plugin の hook は Vite を起こさないと走らない ── ここは**配線**を見る:
 * 1. 焼きが **build の kind** を版の行へ渡す(product で「(開発版)」が出ない)
 * 2. 下限を割ったら **build を止める**(黙って空の page を配らない)
 * 3. `generateBundle` が **src の綴り**で emit する
 * 4. 🔴 **`swPlugin` より前**に並んでいる(後ろだと precache から漏れる)
 * 5. dev の middleware が `/manual.html` **だけ**を掴む(他は素通し)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  bakeManualPage,
  manualPagePlugin,
  MANUAL_MIN_HEADINGS,
  type BakedManual,
  type ModuleLoader,
} from '../../build/manual-page-plugin';
import * as md from '../../src/features/markdown/markdown-render';
import * as help from '../../src/adapter/ui/render/help';
import * as find from '../../src/features/help/manual-find';
import * as page from '../../src/features/help/manual-page';
import * as theme from '../../src/adapter/ui/render/theme';

/**
 * Vite の loader の代役 ── **実物の module を、実物の綴りで**返す。
 * ⚠ stub を本物より甘くしない(CLAUDE.md §3)── 綴りを 1 つでも取り違えたら undefined で落ちる。
 */
function realLoader(): ModuleLoader & { asked: string[] } {
  const table: Record<string, Record<string, unknown>> = {
    '/src/features/markdown/markdown-render.ts': md,
    '/src/adapter/ui/render/help.ts': help,
    '/src/features/help/manual-find.ts': find,
    '/src/features/help/manual-page.ts': page,
    '/src/adapter/ui/render/theme.ts': theme,
  };
  const asked: string[] = [];
  return {
    asked,
    ssrLoadModule: async (url) => {
      asked.push(url);
      const mod = table[url];
      if (!mod) throw new Error(`loader: 知らない module ${url}`);
      return mod;
    },
  };
}

describe('焼き(bakeManualPage)', () => {
  it('🔴 build の kind が版の行に届く(product で「開発版」が出ない)', async () => {
    const prod = await bakeManualPage(realLoader(), process.cwd(), 'product');
    expect(prod.html).toContain(help.versionText('product'));
    expect(prod.html, 'product なのに開発版の刻印が出ている').not.toContain('(開発版)');
    // ⚠ 対照群 ── kind が無ければ dev 扱い(刻印が出る)
    const dev = await bakeManualPage(realLoader(), process.cwd(), undefined);
    expect(dev.html).toContain('(開発版)');
  });

  it('綴りは src から取る(file 名 / 題名 / 鍵)', async () => {
    const got = await bakeManualPage(realLoader(), process.cwd(), 'dev');
    expect(got.fileName).toBe(page.MANUAL_PAGE_FILE);
    expect(got.html).toContain(`<title>${page.MANUAL_WINDOW_TITLE}</title>`);
    expect(got.html).toContain(JSON.stringify(theme.THEME_STORAGE_KEY));
    expect(got.headings, '実物のマニュアルで下限を割っている').toBeGreaterThanOrEqual(
      MANUAL_MIN_HEADINGS,
    );
  });
});

/** hook の `this` の代役(この plugin が触る 2 つだけ)。 */
function ctx() {
  const emitted: unknown[] = [];
  return {
    emitted,
    emitFile: (f: unknown) => {
      emitted.push(f);
      return 'ref';
    },
    error: (m: string): never => {
      throw new Error(m);
    },
  };
}

const baked = (headings: number): BakedManual => ({
  fileName: 'manual.html',
  html: '<!doctype html>x',
  headings,
  toc: headings,
});

function pluginWith(bake: () => Promise<BakedManual>, command: 'build' | 'serve' = 'build') {
  const p = manualPagePlugin({ bake });
  (p.configResolved as (c: unknown) => void).call(null, { command, root: process.cwd(), env: {} });
  const buildStart = p.buildStart as unknown as (this: unknown) => Promise<void>;
  const generateBundle = p.generateBundle as unknown as (this: unknown) => void;
  return { buildStart, generateBundle };
}

describe('plugin の hook', () => {
  it('🔴 下限を割ったら build を止める(空の page を黙って配らない)', async () => {
    const { buildStart } = pluginWith(async () => baked(MANUAL_MIN_HEADINGS - 1));
    await expect(buildStart.call(ctx())).rejects.toThrow('下限');
  });

  it('下限の上なら emit する(file 名は焼きが返した綴り)', async () => {
    const { buildStart, generateBundle } = pluginWith(async () => baked(MANUAL_MIN_HEADINGS));
    const c = ctx();
    await buildStart.call(c);
    generateBundle.call(c);
    expect(c.emitted).toEqual([{ type: 'asset', fileName: 'manual.html', source: '<!doctype html>x' }]);
  });

  it('⚠ build 以外(vitest / dev)では焼かない ── emit も無い', async () => {
    const bake = vi.fn(async () => baked(200));
    const { buildStart, generateBundle } = pluginWith(bake, 'serve');
    const c = ctx();
    await buildStart.call(c);
    generateBundle.call(c);
    expect(bake).not.toHaveBeenCalled();
    expect(c.emitted).toEqual([]);
  });
});

describe('dev の middleware', () => {
  type Handler = (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (s: string) => void }, next: (e?: unknown) => void) => void;
  function serverWith(loader: ModuleLoader): { handler: Handler } {
    let handler: Handler | null = null;
    const p = manualPagePlugin();
    (p.configResolved as (c: unknown) => void).call(null, { command: 'serve', root: process.cwd(), env: {} });
    (p.configureServer as (s: unknown) => void).call(null, {
      ...loader,
      middlewares: { use: (h: Handler) => { handler = h; } },
    });
    if (!handler) throw new Error('middleware が登録されていない');
    return { handler };
  }
  const call = (handler: Handler, url: string) =>
    new Promise<{ body: string | null; next: number }>((resolve) => {
      let body: string | null = null;
      let next = 0;
      handler(
        { url },
        { setHeader: () => {}, end: (s) => { body = s; resolve({ body, next }); } },
        () => { next += 1; resolve({ body, next }); },
      );
    });

  it('🔴 /manual.html を掴んで、焼いた 1 枚を返す(SPA fallback に取られない)', async () => {
    const { handler } = serverWith(realLoader());
    const r = await call(handler, '/manual.html?x=1');
    expect(r.next).toBe(0);
    expect(r.body).toContain(`<title>${page.MANUAL_WINDOW_TITLE}</title>`);
  });

  it('他の URL は素通し(module も読まない)', async () => {
    const loader = realLoader();
    const { handler } = serverWith(loader);
    expect((await call(handler, '/assets/x.js')).next).toBe(1);
    expect(loader.asked, 'js の要求で module を読んでいる').toEqual([]);
    expect((await call(handler, '/index.html')).next).toBe(1);
  });
});

describe('🔴 vite.config.ts での順番', () => {
  it('manualPagePlugin は swPlugin より前(後ろだと precache から漏れる)', () => {
    const src = readFileSync('vite.config.ts', 'utf8');
    const line = src.split('\n').find((l) => /^\s*plugins:\s*\[/u.test(l));
    expect(line, 'plugins の行が読めない(空振り)').toBeDefined();
    const a = line!.indexOf('manualPagePlugin(');
    const b = line!.indexOf('swPlugin(');
    expect(a, 'manualPagePlugin が plugins に無い').toBeGreaterThanOrEqual(0);
    expect(b, 'swPlugin が plugins に無い(前提が崩れている)').toBeGreaterThanOrEqual(0);
    expect(a, 'manualPagePlugin が swPlugin より後ろ ── manual.html が precache から漏れる').toBeLessThan(b);
  });
});
