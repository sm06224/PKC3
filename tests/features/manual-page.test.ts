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
  manualBuildTag,
  textScaleSizes,
  themeBootScript,
  themeIdsIn,
} from '../../src/features/help/manual-page';
import { manualSections } from '../../src/features/help/manual-find';
import { MANUAL_TEXT } from '../../src/adapter/ui/render/help';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { initialTheme, THEMES, THEME_STORAGE_KEY } from '../../src/adapter/ui/render/theme';
import {
  chosenTextScale,
  initialTextScale,
  TEXT_SCALE_STORAGE_KEY,
} from '../../src/adapter/ui/render/text-scale';
import { TEXT_SCALES, textScaleSpec } from '../../src/features/text-scale';
import { extractBodyCss } from '../../build/body-css';
import { windowTitleFor } from '../../src/adapter/platform/deep-link';
import { manualTile } from '../../src/features/launcher/tiles';
// @ts-expect-error -- 検品規則は素の .mjs(ビルド対象外の CI script 群)
import { MANUAL_PAGE } from '../../scripts/dist-inspect.mjs';

const TOKENS = readFileSync('src/styles/tokens.css', 'utf8');
const APP = readFileSync('src/styles/app.css', 'utf8');
const RENDERED = renderMarkdown(MANUAL_TEXT, {});

function bake(over: Partial<Parameters<typeof buildManualPage>[0]> = {}) {
  return buildManualPage({
    title: MANUAL_WINDOW_TITLE,
    version: 'pkc3 v9.9.9',
    tag: 'pkc3 v9.9.9 #deadbeef',
    html: RENDERED,
    sections: manualSections(MANUAL_TEXT),
    tokensCss: TOKENS,
    bodyCss: extractBodyCss(APP, TOKENS).css,
    themeStorageKey: THEME_STORAGE_KEY,
    textScaleStorageKey: TEXT_SCALE_STORAGE_KEY,
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
    // 🔑 opener は**この属性**で「同じ印で組んであるか」を見る(段①の窓と同じ式)
    //    ⚠ 刻むのは版の行ではなく**印**(`tag`)── 版の行は帯に出るだけ
    expect(doc.body.getAttribute(MANUAL_BUILT_ATTR)).toBe('pkc3 v9.9.9 #deadbeef');
  });

  it('⚠ 印や題名の `"` `<` を escape する(属性が壊れて印の判定が外れない)', () => {
    const doc = parse(bake({ tag: 'v"1<2' }).html);
    expect(doc.body.getAttribute(MANUAL_BUILT_ATTR)).toBe('v"1<2');
  });
});

/**
 * 🔴 **窓に刻む印**(動線レビュー D2 が拾った ── `/dev/` では版の字が merge をまたいでも
 * 変わらないので、版だけで見分けると古い本文の窓が前に出続ける)。
 */
describe('焼いたマニュアル — 入れ替えの印(manualBuildTag)', () => {
  it('同じ版・同じ原文なら同じ印(build 側と opener 側が同じ材料から組む)', () => {
    expect(manualBuildTag('pkc3 v3.2.0(開発版)', MANUAL_TEXT)).toBe(
      manualBuildTag('pkc3 v3.2.0(開発版)', MANUAL_TEXT),
    );
  });

  it('🔴 原文が 1 字でも変われば別の印(版の字が同じでも入れ替わる)', () => {
    const a = manualBuildTag('pkc3 v3.2.0(開発版)', MANUAL_TEXT);
    const b = manualBuildTag('pkc3 v3.2.0(開発版)', `${MANUAL_TEXT}\n追記`);
    expect(a).not.toBe(b);
    // ⚠ 版が変わっても別の印(対照群 ── 版の字が印に入っている)
    expect(manualBuildTag('pkc3 v3.2.1', MANUAL_TEXT)).not.toBe(a);
    expect(a.startsWith('pkc3 v3.2.0(開発版) #')).toBe(true);
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

    /**
     * 🔴 **アプリの「最初の配色」と同じ答えを出す**(着地前レビュー ⚠-3 ── 規則が
     * `initialTheme()` と script の 2 か所に生えたので、突き合わせる場所を 1 つ置く)。
     * ⚠ 片側だけ変えた日(既定を変える / 保存形式を変える)に、アプリと窓の配色が
     *   食い違ったまま全部緑、を作らない。
     */
    it('🔴 アプリの initialTheme() と同じ答え(保存 3 通り × OS 2 通り)', () => {
      for (const stored of [null, 'dracula', 'bogus']) {
        for (const dark of [true, false]) {
          localStorage.clear();
          if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored);
          vi.stubGlobal('matchMedia', () => ({ matches: dark }));
          expect(run(), `stored=${stored} dark=${dark}`).toBe(initialTheme(dark));
          document.documentElement.removeAttribute('data-pkc-theme');
        }
      }
    });
  });

  /**
   * 🔴 **字の大きさの設定も届く**(動線レビュー D3 ── 「特大」を選んだ user の窓だけ
   * 14px に戻っていた ── 当時の窓の既定)。倒し方は `text-scale.ts` の `initialTextScale()` と同じ。
   */
  describe('起動時に字の大きさを当てる script', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      localStorage.clear();
      document.documentElement.style.removeProperty('--pkc-text-size');
      document.documentElement.removeAttribute('data-pkc-theme');
    });
    const run = (): string => {
      new Function(
        themeBootScript(themeIdsIn(TOKENS), THEME_STORAGE_KEY, {
          storageKey: TEXT_SCALE_STORAGE_KEY,
          sizes: textScaleSizes(),
        }),
      )();
      return document.documentElement.style.getPropertyValue('--pkc-text-size');
    };

    it('🔴 選んだ大きさを当てる(4 段全部 ── 表は features/text-scale.ts から焼く)', () => {
      for (const t of TEXT_SCALES) {
        localStorage.setItem(TEXT_SCALE_STORAGE_KEY, t.id);
        expect(run(), t.id).toBe(textScaleSpec(t.id).size);
        // ⚠ アプリ側の読み(`initialTextScale`)と同じ id に解決している
        expect(initialTextScale()).toBe(t.id);
        // ⚠ 窓へ当て直す側(`chosenTextScale`)も同じ id ── 2 回目に押しても 1px も動かない
        expect(chosenTextScale()).toBe(t.id);
      }
      expect(TEXT_SCALES.length, '段が 4 未満(表が空振り)').toBeGreaterThanOrEqual(4);
    });

    it('選んでいなければ触らない(CSS の既定 = アプリと同じ「標準」のまま)', () => {
      expect(run()).toBe('');
      // 🔴 当て直す側も「選んでいない」と読む ── ここが食い違うと、何も変えずに押しただけで
      //    字が動く(2026-09-02 hotfix。当時は 14px → 13px に縮んだ)
      expect(chosenTextScale(), 'boot script は触らないのに、当て直す側は「選んだ」と読む').toBeNull();
    });

    it('⚠ 知らない値(壊れた保存)は触らない', () => {
      localStorage.setItem(TEXT_SCALE_STORAGE_KEY, 'huge');
      expect(run()).toBe('');
      // ⚠ prototype の名前でも触らない(`hasOwnProperty` で見る)
      localStorage.setItem(TEXT_SCALE_STORAGE_KEY, 'constructor');
      expect(run()).toBe('');
    });

    it('🔴 器の CSS が `--pkc-text-size` を読む(script が立てても CSS が見なければ効かない)', () => {
      expect(MANUAL_CHROME_CSS).toContain('font-size:var(--pkc-text-size,');
      expect(bake().html).toContain(JSON.stringify(TEXT_SCALE_STORAGE_KEY));
    });
  });
});

/**
 * 🔴 **URL の断片(見出しの字)へ、読み込みの後に送る**(#648 D4)。
 * ⚠ 印を見出しの字にしたので `location.hash` は percent-encode されて返る ──
 *   復号せずに `getElementById` へ渡すと**必ず外れて先頭に戻る**(F5 とブックマークの当の点)。
 */
describe('焼いたマニュアル — 断片へ送る script(D4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });
  const run = (hash: string): string[] => {
    vi.stubGlobal('location', { hash });
    // ⚠ 素の `addEventListener` は window に積み上がる(前の it の listener も鳴る)──
    //    script が登録した handler を**掴んで直に呼ぶ**(1 本だけ登録されることも見る)
    const handlers: Array<() => void> = [];
    vi.stubGlobal('addEventListener', (_type: string, fn: () => void) => handlers.push(fn));
    const landed: string[] = [];
    for (const id of ['4-4-ヘルプ', 'm-3']) {
      const h = document.createElement('h2');
      h.id = id;
      (h as unknown as { scrollIntoView: () => void }).scrollIntoView = () => landed.push(id);
      document.body.append(h);
    }
    new Function(themeBootScript(themeIdsIn(TOKENS), THEME_STORAGE_KEY))();
    expect(handlers, 'DOMContentLoaded の handler が 1 本でない').toHaveLength(1);
    handlers[0]!();
    return landed;
  };

  it('🔴 percent-encode された断片を復号して、その見出しへ送る', () => {
    expect(run(`#${encodeURIComponent('4-4-ヘルプ')}`)).toEqual(['4-4-ヘルプ']);
  });

  it('素の断片(ASCII)もそのまま送る(対照群)', () => {
    expect(run('#m-3')).toEqual(['m-3']);
  });

  it('断片が無い / 壊れた綴り / 無い id なら何もしない(先頭のまま。落ちない)', () => {
    expect(run('')).toEqual([]);
    expect(run('#%E3%81')).toEqual([]);
    expect(run(`#${encodeURIComponent('無い節')}`)).toEqual([]);
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

  /**
   * 🔴 **紙に出すときは器をほどく**(動線レビュー D6)。⚠ 頁数そのものは実ブラウザ
   * (`manual-window.smoke.spec.ts` の PDF)で見る ── ここは規則が焼かれていることだけ。
   */
  it('🔴 印刷の規則が焼かれている(スクロール箱をほどき、目次と帯を落とす)', () => {
    const html = bake().html;
    const print = html.slice(html.indexOf('@media print{html,body{height:auto}'));
    expect(print, '印刷の規則が無い').not.toBe('');
    expect(print).toContain('[data-pkc-region="manual-window-main"]{overflow:visible;height:auto');
    expect(print).toContain('[data-pkc-region="manual-window-toc"]{display:none}');
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

/**
 * 🔴 **窓の字はアプリと同じ書体・大きさ・行間**(2026-09-04、#648 I6)。
 *
 * ⚠ 段②までは `system-ui` / 14px / 行間 UA 任せで、**同じ本文がヘルプ面と窓で別の見え方**
 *   だった。期待値は **`app.css` の `body` 規則から読む**(実装と同じ綴りを test に写すと、
 *   両方を同時に変えても緑のまま ── CLAUDE.md §1「期待値は別の観測から」)。
 * 🔑 `body { … }` は**実行する行**で拾う(コメントを落としてから、最初の `body {` の
 *   宣言ブロックを取る ── `html, body {` の選択子リストは `body {` に当たらない)。
 */
describe('焼いたマニュアル — 字はアプリと同じ(I6)', () => {
  /** `app.css` の `body { … }` の宣言(コメントを落としてから拾う)。 */
  const appBody = (): string => {
    const code = APP.replace(/\/\*[\s\S]*?\*\//gu, '');
    const m = /(?:^|\})\s*body\s*\{([^}]*)\}/u.exec(code);
    if (!m) throw new Error('app.css に body の規則が無い(前提が崩れている)');
    return m[1]!;
  };
  /** 窓の器の `body{…}` の宣言(圧縮した 1 行の CSS から)。 */
  const chromeBody = (): string => {
    const m = /(?:^|\})body\{([^}]*)\}/u.exec(MANUAL_CHROME_CSS);
    if (!m) throw new Error('MANUAL_CHROME_CSS に body の規則が無い(前提が崩れている)');
    return m[1]!;
  };
  const decl = (block: string, name: string): string | null => {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'u').exec(block);
    return m ? m[1]!.trim().replace(/\s+/gu, '') : null;
  };

  it('🔴 大きさの既定が app.css の body と同じ(選んでいない人の窓がアプリと 1px も違わない)', () => {
    const app = decl(appBody(), 'font-size');
    const win = decl(chromeBody(), 'font-size');
    expect(app, 'app.css の body に font-size が無い').not.toBeNull();
    // 前提 ── どちらも設定の変数を通している(片方だけ直書きなら「同じ」は偶然)
    expect(app).toMatch(/^var\(--pkc-text-size,/u);
    expect(win).toBe(app);
    // 空振り防止 ── 既定は表の「標準」であり、段②の 14px ではない
    expect(win).toContain(textScaleSpec('standard').size);
    expect(win).not.toContain('14px');
  });

  it('🔴 行間が app.css の body と同じ', () => {
    const app = decl(appBody(), 'line-height');
    expect(app, 'app.css の body に line-height が無い').not.toBeNull();
    expect(decl(chromeBody(), 'line-height')).toBe(app);
  });

  it('🔴 書体は同じトークン(--font)を読み、焼いた page にそのトークンが在る', () => {
    const app = decl(appBody(), 'font-family');
    expect(app).toBe('var(--font)');
    expect(decl(chromeBody(), 'font-family'), '窓が --font を読んでいない').toMatch(/^var\(--font,/u);
    // 🔑 「読む」だけでは足りない ── 焼いた page に定義が届いている(無ければ fallback へ落ちる)
    expect(bake().html, '焼いた page に --font の定義が無い(system-ui へ落ちる)').toMatch(
      /--font:/u,
    );
  });
});

/**
 * 🔴 **窓の題名は他の窓と同じ並び**(2026-09-04、#648 I4)。
 * ⚠ 段②までは「PKC3 マニュアル」── タスクバーに「2 ペインで整理 — PKC3」と並んだとき
 *   この窓だけ頭が PKC3 で、名前で探す目が止まらなかった。
 * 🔑 期待値は**形の正本**(`deep-link.ts` の `windowTitleFor`)と**タイルの字**から組む
 *   ── 題名の綴りを test に写さない(片方だけ変えても緑、を作らない)。
 */
describe('マニュアルの窓 — 題名の並び(I4)', () => {
  it('🔴 「<タイルの字> — PKC3」── 他の窓と同じ形で、タイルの字と揃っている', () => {
    expect(MANUAL_WINDOW_TITLE).toBe(windowTitleFor('PKC3', manualTile().title));
    // 空振り防止 ── 旧い並び(頭が PKC3)ではない
    expect(MANUAL_WINDOW_TITLE).not.toMatch(/^PKC3/u);
    expect(manualTile().title, 'タイルの字が空(空振り)').not.toBe('');
  });
});
