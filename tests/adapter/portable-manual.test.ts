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
 * 3. `blob:` URL の寿命は**窓 1 枚** ── 開いている間は同じ URL(F5 する窓を壊さない)、
 *    閉じたら `revokeObjectURL` して器を空にし、次は新しく作る(不可侵指示「ObjectURL は
 *    表示の寿命終端で revoke」)。見張りは閉じたら止まる(常駐を残さない)
 * 4. 見え方(配色 / 文字の大きさ)を blob に焼いてから開く(`file://` 由来の blob は
 *    保存に触れないことがある)── 焼いた属性を boot script が採ることは
 *    `tests/features/manual-page.test.ts` が見る
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bakeAppearance,
  MANUAL_PAGE_SELECTOR,
  MANUAL_WINDOW_WATCH_MS,
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
  const revoked: string[] = [];
  const createUrl = (b: Blob): string => {
    made.push(b);
    return `blob:null/${made.length}`;
  };
  const revokeUrl = (u: string): void => {
    revoked.push(u);
  };
  const fresh = (html = folded()) => {
    made.length = 0;
    revoked.length = 0;
    return portableManualPage(parse(html), { createUrl, revokeUrl });
  };
  const nord = { theme: 'nord', textSize: null, bg: null, fg: null };
  afterEach(() => {
    vi.useRealTimers();
  });

  it('🔴 開いている間は同じ URL(F5 する窓の URL を殺さない)', async () => {
    const page = fresh();
    const first = page.url(nord);
    expect(first).toBe('blob:null/1');
    // 見え方を変えて押しても作り直さない(読んでいた所を失わせない ── 当て直しは窓の側)
    expect(page.url({ theme: 'dracula', textSize: '17px', bg: null, fg: null })).toBe(first);
    expect(made, 'blob を 2 回作った').toHaveLength(1);
    expect(made[0]!.type).toBe('text/html;charset=utf-8');
    const html = await made[0]!.text();
    expect(html).toContain('data-pkc-theme="nord"');
    expect(html.length).toBeGreaterThan(100_000);
  });

  /**
   * 🔴 **窓が閉じたら blob を返す**(不可侵指示「ObjectURL は表示の寿命終端で revoke」)。
   * 見るのは 3 つ ── revoke が **1 回**呼ばれる / 見張りが**止まる**(その後いくら時間が
   * 進んでも 2 度目は無い)/ 次の `url()` は**新しい blob**。
   */
  it('🔴 窓が閉じたら revoke が 1 回、見張りが止まり、次の url() は新しい blob', () => {
    vi.useFakeTimers();
    const page = fresh();
    const win = { closed: false };
    const first = page.url(nord);
    page.watch(win);
    win.closed = true;
    vi.advanceTimersByTime(MANUAL_WINDOW_WATCH_MS);
    expect(revoked, '閉じたのに revoke していない').toEqual([first]);
    // 見張りが止まっている ── 時間を進めても 2 度目の revoke は無い
    vi.advanceTimersByTime(MANUAL_WINDOW_WATCH_MS * 10);
    expect(revoked).toHaveLength(1);
    expect(vi.getTimerCount(), '見張りが残っている(常駐)').toBe(0);
    // 次に押したら新しく作る(古い URL は死んでいる)
    const second = page.url(nord);
    expect(second).toBe('blob:null/2');
    expect(second).not.toBe(first);
    expect(made).toHaveLength(2);
  });

  it('🔴 対照群 ── 開いている間は、いくら時間が進んでも revoke されない', () => {
    vi.useFakeTimers();
    const page = fresh();
    const win = { closed: false };
    const first = page.url(nord);
    page.watch(win);
    vi.advanceTimersByTime(MANUAL_WINDOW_WATCH_MS * 60);
    expect(revoked, '開いているのに revoke した(F5 が壊れる)').toEqual([]);
    expect(page.url(nord)).toBe(first);
    expect(made).toHaveLength(1);
    // 見張りは 1 本だけ生きている
    expect(vi.getTimerCount()).toBe(1);
  });

  it('同じ窓で watch を何度呼んでも(再利用の回)、見張りは 1 本のまま', () => {
    vi.useFakeTimers();
    const page = fresh();
    const win = { closed: false };
    page.url(nord);
    page.watch(win);
    page.watch(win);
    page.watch(win);
    expect(vi.getTimerCount()).toBe(1);
    win.closed = true;
    vi.advanceTimersByTime(MANUAL_WINDOW_WATCH_MS);
    expect(revoked).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * ⚠ 閉じてから見張りが鳴る前(1 秒の内)に押し直した回 ── 古い URL を返すと、新しい窓が
   *   その URL で開いた直後に見張りが鳴って**新しい窓の URL を消す**。`url()` は先に窓を検める。
   */
  it('🔴 閉じた直後(見張りが鳴る前)に押しても、古い URL を返さない', () => {
    vi.useFakeTimers();
    const page = fresh();
    const win = { closed: false };
    const first = page.url(nord);
    page.watch(win);
    win.closed = true;
    // 見張りはまだ鳴っていない
    const second = page.url(nord);
    expect(second).not.toBe(first);
    expect(revoked).toEqual([first]);
    // 新しい窓を見張る ── 古い見張りは止まっている(新しい URL を消す見張りが残っていない)
    const win2 = { closed: false };
    page.watch(win2);
    vi.advanceTimersByTime(MANUAL_WINDOW_WATCH_MS * 5);
    expect(revoked, '新しい窓の URL を消した').toEqual([first]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('焼き込みが無い 1 枚では null(段①の逃げ道へ。blob も見張りも作らない)', () => {
    vi.useFakeTimers();
    const page = fresh('<html><body></body></html>');
    expect(page.url()).toBeNull();
    expect(page.url()).toBeNull();
    page.watch({ closed: false });
    expect(made).toHaveLength(0);
    expect(vi.getTimerCount(), '素の PKC3 で見張りを作っている').toBe(0);
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
    // 🔴 開いた窓を見張る(閉じたら blob を返す)── 配線が落ちると blob が opener の寿命まで残る
    expect(code, '開いた窓を見張っていない').toMatch(/portableManual\.watch\(win\.window\)/);
  });
});
