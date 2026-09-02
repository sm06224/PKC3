/** @vitest-environment happy-dom */
/**
 * 🔴 **焼いたマニュアル(`manual.html`)の組み立て**(#645 段②)。
 *
 * ここが守るのは 4 つ:
 * 1. **目次の `<a>` は、必ず本文の見出しへ着く**(押しても何も起きない行を出さない)
 * 2. **配色 9 種が全部入り、起動時に保存された配色が当たる**(段①の窓に届かなかった当の点)
 * 3. **1 枚で完結している**(script 1 本 / style 1 本 / `<body>` の前に配色が立つ)
 * 4. **綴りが 1 か所**(file 名は検品 `dist-inspect.mjs` と、鍵は `theme.ts` と同じ)
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildManualPage,
  MANUAL_BUILT_ATTR,
  MANUAL_CHROME_CSS,
  MANUAL_PAGE_FILE,
  MANUAL_TIP,
  MANUAL_WINDOW_TITLE,
  themeBootScript,
  themeIdsIn,
} from '../../src/features/help/manual-page';
import { manualSections } from '../../src/features/help/manual-find';
import { MANUAL_TEXT } from '../../src/adapter/ui/render/help';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { THEMES, THEME_STORAGE_KEY } from '../../src/adapter/ui/render/theme';
import { extractBodyCss } from '../../build/body-css';
// @ts-expect-error -- 検品規則は素の .mjs(ビルド対象外の CI script 群)
import { MANUAL_PAGE } from '../../scripts/dist-inspect.mjs';

const TOKENS = readFileSync('src/styles/tokens.css', 'utf8');
const APP = readFileSync('src/styles/app.css', 'utf8');
const RENDERED = renderMarkdown(MANUAL_TEXT, {});

function bake(over: Partial<Parameters<typeof buildManualPage>[0]> = {}) {
  return buildManualPage({
    title: MANUAL_WINDOW_TITLE,
    version: 'pkc3 v9.9.9',
    html: RENDERED,
    sections: manualSections(MANUAL_TEXT),
    tokensCss: TOKENS,
    bodyCss: extractBodyCss(APP, TOKENS).css,
    themeStorageKey: THEME_STORAGE_KEY,
    ...over,
  });
}

/** 出来上がった HTML を**別に**読み直す(実装の綴りを見ない観測 ── CLAUDE.md §1)。 */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('焼いたマニュアル — 目次と本文', () => {
  it('🔴 目次の行は、すべて本文の見出しへ着く(実物のマニュアルで)', () => {
    const page = bake();
    const doc = parse(page.html);
    const rows = [...doc.querySelectorAll<HTMLAnchorElement>('[data-pkc-region="manual-window-toc"] a')];
    expect(rows.length, '目次が空(空振り)').toBeGreaterThan(100);
    expect(rows.length, '目次の行数が組み立ての報告と違う').toBe(page.toc);
    const main = doc.querySelector('[data-pkc-region="manual-window-main"]')!;
    const dead = rows.filter((a) => {
      const href = a.getAttribute('href') ?? '';
      return !href.startsWith('#') || main.querySelector(`[id="${href.slice(1)}"]`) === null;
    });
    expect(dead.map((a) => a.textContent), '押しても何も起きない行がある').toEqual([]);
  });

  it('🔴 目次は `<a href="#…">`(実 URL なので断片は page の中で解決する)', () => {
    const doc = parse(bake().html);
    const toc = doc.querySelector('[data-pkc-region="manual-window-toc"]')!;
    // ⚠ 段①(about:blank)は button で出す ── こちらは実 URL なので素の `<a>` でよい
    expect(toc.querySelectorAll('button')).toHaveLength(0);
    expect(toc.querySelectorAll('a').length).toBeGreaterThan(100);
  });

  it('🔴 コピーのボタンを落とす(この page に受け手は居ない)', () => {
    // ⚠ 対照群 ── 描いた側には在る(無ければ「落とした」は何も言わない)
    expect(RENDERED, '前提が崩れている(描画がコピーのボタンを出していない)').toContain(
      'copy-md-block',
    );
    expect(bake().html).not.toContain('copy-md-block');
  });

  it('帯に題名・版・Ctrl+F の取り分が出て、body に版を刻む', () => {
    const doc = parse(bake().html);
    const head = doc.querySelector('[data-pkc-field="manual-window-head"]')!;
    expect(head.textContent).toContain(MANUAL_WINDOW_TITLE);
    expect(head.textContent).toContain('pkc3 v9.9.9');
    expect(head.textContent).toContain(MANUAL_TIP);
    expect(doc.title).toBe(MANUAL_WINDOW_TITLE);
    // 🔑 opener は**この属性**で「同じ版で組んであるか」を見る(段①の窓と同じ式)
    expect(doc.body.getAttribute(MANUAL_BUILT_ATTR)).toBe('pkc3 v9.9.9');
  });

  it('⚠ 版や題名の `"` `<` を escape する(属性が壊れて版の判定が外れない)', () => {
    const doc = parse(bake({ version: 'v"1<2' }).html);
    expect(doc.body.getAttribute(MANUAL_BUILT_ATTR)).toBe('v"1<2');
  });
});

describe('焼いたマニュアル — 配色', () => {
  it('🔴 tokens.css の配色と `THEMES` が 1 対 1(CSS に無い配色を当てない)', () => {
    expect(themeIdsIn(TOKENS).sort()).toEqual(THEMES.map((t) => t.id).sort());
    // 空振り防止 ── 9 種(2 種だけなら段①と変わらない)
    expect(themeIdsIn(TOKENS).length).toBeGreaterThan(2);
  });

  it('🔴 page の CSS に配色 9 種が全部入る(段①の窓には 2 種しか無かった)', () => {
    const page = bake();
    // ⚠ 圧縮で選択子が壊れていないことを、出来上がりから読み直して見る
    expect(themeIdsIn(page.html).sort()).toEqual(THEMES.map((t) => t.id).sort());
    expect(page.html, '地の色のトークンが無い(段①の欠陥がそのまま)').toContain('--bg:');
    expect(page.html).toContain(MANUAL_CHROME_CSS);
  });

  describe('起動時に配色の属性を立てる script', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      localStorage.clear();
      document.documentElement.removeAttribute('data-pkc-theme');
    });
    const run = (): string | null => {
      new Function(themeBootScript(themeIdsIn(TOKENS), THEME_STORAGE_KEY))();
      return document.documentElement.getAttribute('data-pkc-theme');
    };

    it('🔴 保存された配色を当てる(設定で選んだ配色がこの窓にも効く)', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dracula');
      expect(run()).toBe('dracula');
    });

    it('保存が無ければ OS に従う(暗ければ dark)', () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      expect(run()).toBe('dark');
    });

    it('保存が無く OS も明るければ light', () => {
      vi.stubGlobal('matchMedia', () => ({ matches: false }));
      expect(run()).toBe('light');
    });

    it('⚠ CSS に無い配色(古い / 壊れた値)は OS へ落ちる(`isTheme` と同じ門)', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'bogus');
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      expect(run()).toBe('dark');
    });

    it('⚠ localStorage が投げても属性は立つ(private mode で白紙にしない)', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('denied');
        },
      });
      vi.stubGlobal('matchMedia', () => ({ matches: false }));
      expect(run()).toBe('light');
    });

    it('🔴 読む鍵は theme.ts と同じ(綴りを写していない)', () => {
      // ⚠ 上の test は「同じ鍵で書いて同じ鍵で読む」ので、鍵を変えても通る ──
      //    製品の書き手(`chooseTheme`)と同じ鍵かは、字面で 1 度だけ pin する
      expect(themeBootScript(['light'], THEME_STORAGE_KEY)).toContain(
        JSON.stringify(THEME_STORAGE_KEY),
      );
      expect(bake().html).toContain(JSON.stringify(THEME_STORAGE_KEY));
    });
  });
});

describe('焼いたマニュアル — 1 枚で完結する', () => {
  it('完全な document で、script は 1 本、style は 1 本、配色は `<body>` の前に立つ', () => {
    const html = bake().html;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html.match(/<style>/gu)).toHaveLength(1);
    expect(html.match(/<script>/gu)).toHaveLength(1);
    // 🔑 最初の描画の前に属性が立つ ── script が body より前
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<body'));
    // ⚠ 外の資源を 1 つも指さない(オフラインで 1 枚だけで読める)
    expect(html).not.toMatch(/<link\b/u);
  });

  it('🔴 file 名の綴りが検品(dist-inspect.mjs)と同じ', () => {
    expect(MANUAL_PAGE_FILE).toBe(MANUAL_PAGE);
    expect(MANUAL_PAGE_FILE).toBe('manual.html');
  });

  it('見出しの数を報告する(build 側の下限の観測点)', () => {
    const page = bake();
    expect(page.headings).toBeGreaterThan(100);
    // ⚠ 描画が空なら 0 ── build の門はこれを見る
    expect(bake({ html: '' }).headings).toBe(0);
  });
});
