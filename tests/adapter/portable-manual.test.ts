/** @vitest-environment happy-dom */
/**
 * 🔴 **持ち歩ける 1 枚に焼き込んだマニュアルの page を、`blob:` で開く**(#648 段③)。
 *
 * ここが守るのは 4 つ:
 * 1. 🔴 **封筒を組む実物(`fold.mjs` の `manualPageTag`)が出した物を、読む実物
 *    (`takeEmbeddedManualPage`)が丸ごと戻せる** ── `</script>` も `</body>` も入った
 *    本物の page で(CLAUDE.md §7「本物どうしを繋ぐ test を 1 本置く」。間に立つのは
 *    `DOMParser` だけで、封筒を 1 バイトも作らせない)
 * 2. 取り出したら DOM から外す(350 KB の字を document の寿命ぶん抱えない)
 * 3. `blob:` URL は document ごとに 1 回だけ作り、2 回目は同じ URL(F5 する窓を壊さない)
 * 4. 見え方(配色 / 文字の大きさ)を blob に焼いてから開く(`file://` 由来の blob は
 *    保存に触れないことがある)── 焼いた属性を boot script が採ることは
 *    `tests/features/manual-page.test.ts` が見る
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bakeAppearance,
  MANUAL_PAGE_SELECTOR,
  portableManualPage,
  takeEmbeddedManualPage,
} from '../../src/adapter/platform/portable-manual';
import { writePortableBundle, bundleTagHtml } from '../../src/features/export/portable-bundle';
import { buildManualPage, MANUAL_WINDOW_TITLE } from '../../src/features/help/manual-page';
import { manualSections } from '../../src/features/help/manual-find';
import { MANUAL_TEXT } from '../../src/adapter/ui/render/help';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { THEME_STORAGE_KEY } from '../../src/adapter/ui/render/theme';
import { TEXT_SCALE_STORAGE_KEY } from '../../src/adapter/ui/render/text-scale';
import { extractBodyCss } from '../../build/body-css';
// @ts-expect-error -- build script(型定義を持たない .mjs)を実際に走らせて見る
import { manualPageTag, manualPageTagCount, shellOf, MANUAL_PAGE_ATTR } from '../../build/portable/shell-scan.mjs';

const TOKENS = readFileSync('src/styles/tokens.css', 'utf8');
const APP = readFileSync('src/styles/app.css', 'utf8');

/** 実物の page(`</script>` も `</body>` も `<` も日本語も入っている)。 */
const PAGE = buildManualPage({
  title: MANUAL_WINDOW_TITLE,
  version: 'pkc3 v9.9.9',
  tag: 'pkc3 v9.9.9 #deadbeef',
  html: renderMarkdown(MANUAL_TEXT, {}),
  sections: manualSections(MANUAL_TEXT),
  tokensCss: TOKENS,
  bodyCss: extractBodyCss(APP, TOKENS).css,
  themeStorageKey: THEME_STORAGE_KEY,
  textScaleStorageKey: TEXT_SCALE_STORAGE_KEY,
}).html;

/** 畳んだ 1 枚の器の代役 ── 封筒は**実物**(`manualPageTag`)に組ませる。 */
function folded(pageHtml: string = PAGE): string {
  return (
    `<!doctype html><html lang="ja"><head>${bundleTagHtml({ id: 'pkcb-template', exportedAt: 0 })}` +
    `<script type="module">var s='data-pkc-manual-page';</script></head>` +
    `<body><div data-pkc-slot="root"></div>${manualPageTag(pageHtml)}</body></html>`
  );
}

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

describe('焼き込み ── 封筒を組む実物 → 読む実物(往復)', () => {
  it('🔴 実物の page が丸ごと戻る(`</script>` / `</body>` / `<` を含んだまま 1 バイトも欠けない)', () => {
    // ⚠ 前提 ── 素のままでは切れる字が本当に入っている(入っていなければ、この検査は何も言わない)
    expect(PAGE).toContain('</script>');
    expect(PAGE).toContain('</body>');
    expect(PAGE.length).toBeGreaterThan(100_000);
    const doc = parse(folded());
    expect(takeEmbeddedManualPage(doc)).toBe(PAGE);
  });

  it('🔴 封筒の中に `<` が 1 つも残らない(`</script>` で切れず、書き出しの `</body>` 探しにも当たらない)', () => {
    const tag: string = manualPageTag(PAGE);
    const inner = tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>'));
    expect(inner, '封筒の中に生の < が在る').not.toContain('<');
    // ⚠ 器全体で `</body>` は器の 1 件だけ(書き出しの lastIndexOf が器に当たる)
    expect(folded().match(/<\/body>/gu)).toHaveLength(1);
  });

  it('🔑 読む側の selector と、封筒を組む側の属性名が同じ綴り', () => {
    expect(MANUAL_PAGE_SELECTOR).toBe(`script[${MANUAL_PAGE_ATTR}]`);
    // ⚠ 器の走査(fold の門)も同じ綴りで数える
    expect(manualPageTagCount(shellOf(folded()))).toBe(1);
    // JS の中の同じ綴りは数えない(shell は script の中身を抜いている)
    expect(manualPageTagCount(shellOf(folded().replace(manualPageTag(PAGE), '')))).toBe(0);
  });

  it('🔴 取り出したら DOM から外す(2 回目は null ── 抱え続けない)', () => {
    const doc = parse(folded());
    expect(doc.querySelector(MANUAL_PAGE_SELECTOR)).not.toBeNull();
    expect(takeEmbeddedManualPage(doc)).toBe(PAGE);
    expect(doc.querySelector(MANUAL_PAGE_SELECTOR), '取り出した後も DOM に残っている').toBeNull();
    expect(takeEmbeddedManualPage(doc)).toBeNull();
  });

  it('無い / 壊れている(JSON でない・空)なら null(逃げ道へ落ちる。落ちない)', () => {
    expect(takeEmbeddedManualPage(parse('<html><body></body></html>'))).toBeNull();
    const broken = parse('<html><body><script type="application/json" data-pkc-manual-page>{oops</script></body></html>');
    expect(takeEmbeddedManualPage(broken)).toBeNull();
    // ⚠ 壊れていても外す(読めない物を抱え続けない)
    expect(broken.querySelector(MANUAL_PAGE_SELECTOR)).toBeNull();
    const empty = parse('<html><body><script type="application/json" data-pkc-manual-page>""</script></body></html>');
    expect(takeEmbeddedManualPage(empty)).toBeNull();
  });

  /**
   * 🔴 **書き出した 1 枚にも page が残る**(雛形 → `writePortableBundle` → 読む実物)。
   * ⚠ 書き出しは DB 画像と添付を `</body>` の前へ差し込む ── 封筒の中の `</body>`
   *   (JSON で逃がしてある)に当たると、page が JS の途中で切れて読めなくなる。
   */
  it('🔴 書き出した 1 枚(段④)にも、焼き込んだ page がそのまま残る', async () => {
    async function* none(): AsyncGenerator<{ key: string; mime: string; blob: Blob }> {}
    const out = await writePortableBundle({
      template: folded(),
      bundle: { id: 'pkcb-0011223344556677', exportedAt: 1_700_000_000_000 },
      image: new Uint8Array([1, 2, 3]),
      assets: none(),
    });
    const doc = parse(await out.blob.text());
    // 前提 ── 書き出しの差し込みは効いている(DB 画像が在る)
    expect(doc.querySelector('script[data-pkc-db-image]'), '前提が崩れている(書き出しが差し込んでいない)').not.toBeNull();
    expect(takeEmbeddedManualPage(doc)).toBe(PAGE);
  });
});

describe('見え方を焼く(bakeAppearance)', () => {
  const a = { theme: 'dracula', textSize: '17px', bg: null, fg: null };

  it('🔴 配色と文字の大きさを `<html>` に焼く(boot script が保存を読めない blob でも効く)', () => {
    const doc = parse(bakeAppearance(PAGE, a));
    expect(doc.documentElement.getAttribute('data-pkc-theme')).toBe('dracula');
    expect(doc.documentElement.style.getPropertyValue('--pkc-text-size')).toBe('17px');
    // ⚠ 元の属性(lang)は残る
    expect(doc.documentElement.getAttribute('lang')).toBe('ja');
  });

  it('null の側は触らない / 何も無ければ 1 バイトも変えない', () => {
    const doc = parse(bakeAppearance(PAGE, { ...a, textSize: null }));
    expect(doc.documentElement.getAttribute('data-pkc-theme')).toBe('dracula');
    expect(doc.documentElement.getAttribute('style')).toBeNull();
    expect(bakeAppearance(PAGE, { theme: null, textSize: null, bg: null, fg: null })).toBe(PAGE);
    expect(bakeAppearance(PAGE, undefined)).toBe(PAGE);
  });

  it('⚠ 値の `"` を escape する(属性が壊れて page が崩れない)', () => {
    const doc = parse(bakeAppearance(PAGE, { ...a, theme: 'x"y' }));
    expect(doc.documentElement.getAttribute('data-pkc-theme')).toBe('x"y');
  });
});

describe('blob: URL(portableManualPage)', () => {
  const made: Blob[] = [];
  const createUrl = (b: Blob): string => {
    made.push(b);
    return `blob:null/${made.length}`;
  };

  it('🔴 1 回だけ作り、2 回目は同じ URL(F5 する窓の URL を殺さない)', async () => {
    made.length = 0;
    const page = portableManualPage(parse(folded()), createUrl);
    const first = page.url({ theme: 'nord', textSize: null, bg: null, fg: null });
    expect(first).toBe('blob:null/1');
    // 見え方を変えて押しても作り直さない(読んでいた所を失わせない ── 当て直しは窓の側)
    expect(page.url({ theme: 'dracula', textSize: '17px', bg: null, fg: null })).toBe(first);
    expect(made, 'blob を 2 回作った').toHaveLength(1);
    expect(made[0]!.type).toBe('text/html;charset=utf-8');
    const html = await made[0]!.text();
    expect(html).toContain('data-pkc-theme="nord"');
    expect(html.length).toBeGreaterThan(100_000);
  });

  it('焼き込みが無い 1 枚では null(段①の逃げ道へ。blob は作らない)', () => {
    made.length = 0;
    const page = portableManualPage(parse('<html><body></body></html>'), createUrl);
    expect(page.url()).toBeNull();
    expect(page.url()).toBeNull();
    expect(made).toHaveLength(0);
  });
});

/**
 * ⚠ 原文 pin(`main.ts` はどの test からも実行されない ── CLAUDE.md §2)。
 * 見るのは 1 本の配線 ── 持ち歩ける 1 枚(`readBundle` が印を読む側)で `pageUrl` に
 * `blob:` の口が繋がっていること。⚠ 弱いと自覚して使う(綴りが合っていることしか見ていない)。
 */
describe('main.ts の配線(原文 pin)', () => {
  it('🔴 持ち歩ける 1 枚では、焼き込んだ page の URL を窓へ渡す', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/portableManualPage\(document\)/);
    expect(code, '1 枚では pageUrl に blob の口が繋がっていない').toMatch(
      /pageUrl:\s*readBundle\(document\) === null\s*\?[\s\S]{0,120}:\s*portableManual\.url\(appearance\)/,
    );
  });
});
