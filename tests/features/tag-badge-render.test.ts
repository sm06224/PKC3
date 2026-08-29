/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の中のタグ行を、バッジで描く**(#550 段③。user 要望 2026-08-29)。
 *
 * > 「**そして、タグはバッジ化して表示が必要**」
 *
 * 🔑 ここで守る主張は 3 つ:
 * 1. タグ行が**札の骨組み**で出る(CSS が当たる形になっている)
 * 2. 🔴 **押せるのは受け手が居る面だけ**(書き出した HTML に dead click を配らない)
 * 3. 🔴 **走査(索引・スマートフォルダ)と描画が同じタグを見ている**
 *    ── 片方だけ拾うと「集まるのに画面に出ない」/「出るのに集まらない」になる
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { scanBodyTags } from '../../src/features/flavor/body-tags';

/** 描いた HTML から `data-pkc-tag` を全部拾う。 */
function renderedTags(body: string, interactive = false): string[] {
  const html = renderMarkdown(body, interactive ? { interactiveTags: true } : {});
  return [...html.matchAll(/data-pkc-tag="([^"]*)"/g)].map((m) => m[1]!);
}

describe('本文の中のタグ行を描く(#550 段③)', () => {
  it('🔴 タグ行が札の骨組みで出る', () => {
    const html = renderMarkdown('#買い物 #家事\n');
    expect(html, '行の器が無い(CSS が当たらない)').toContain('data-pkc-tagline');
    expect(html, '札の class が無い').toContain('class="pkc-tag"');
    expect(html, '井桁が消えている').toContain('#買い物');
  });

  it('🔴 既定では押せない(書き出した HTML に dead click を配らない)', () => {
    const html = renderMarkdown('#買い物\n');
    expect(html, '受け手が居ないのに押せる形で出た').not.toContain('data-pkc-action');
    // ⚠ **対照群** ── 頼めば押せる形になる(常に無い、で緑になっていない)
    const on = renderMarkdown('#買い物\n', { interactiveTags: true });
    expect(on, '頼んでも押せる形にならない').toContain('data-pkc-action="filter-by-tag"');
  });

  it('⚠ 数字だけの行は本文のまま(`#117 #121` を守る)', () => {
    const html = renderMarkdown('#117 #121\n');
    expect(html, '番号の行が札になった').not.toContain('data-pkc-tagline');
  });

  it('⚠ 見出しは見出しのまま(井桁の後ろに空白がある)', () => {
    const html = renderMarkdown('# 買い物\n');
    expect(html, '見出しが札になった').not.toContain('data-pkc-tagline');
    expect(html, '見出しでなくなった').toMatch(/<h1/);
  });

  it('⚠ 名前は escape される(本文から属性を割らせない)', () => {
    const html = renderMarkdown('#a"onx=1\n');
    expect(html, '属性が割れている').not.toContain('data-pkc-tag="a"onx=1"');
    expect(html, 'escape されていない').toContain('&quot;');
  });

  /**
   * 🔴 **走査と描画の parity**(CLAUDE.md §7)。
   *
   * ⚠ 片方だけが拾うと、user から見て
   *   「**スマートフォルダには集まるのに、本文では普通の字**」/
   *   「**札になっているのに、探しても出てこない**」になる。
   * 🔑 期待値は**別の観測**から作る ── 描画の綴りを 1 行も参照せず、
   *   `scanBodyTags`(索引が使う当のもの)の結果と突き合わせる。
   */
  describe('🔴 走査が拾うタグと、画面に出る札が一致する', () => {
    const CASES: ReadonlyArray<readonly [string, string]> = [
      ['単独の行', '#買い物 #家事\n'],
      ['見出しの下', '# 章\n\n#買い物\n'],
      ['段落の 2 行目(改行で続いた行)', '本文です\n#買い物\n'],
      ['段落の途中の行', '前\n#買い物\n後\n'],
      ['全角空白で区切る', '#買い物　#家事\n'],
      ['タブで区切る', '#買い物\t#家事\n'],
      ['fence の中は拾わない', '```\n#にせもの\n```\n\n#本物\n'],
      ['数字だけは拾わない', '#117 #121\n\n#本物\n'],
      ['数字混じりは拾う', '#no117\n'],
      ['タグが 1 つも無い', '# 章\n\nただの本文\n'],
      ['引用の中(> で始まる)', '> #買い物\n'],
      ['箇条書きの中', '- #買い物\n'],
      ['4 つ下げた行(markdown ではコード)', '    #買い物\n'],
      ['3 つ下げた行(ここまでは本文)', '   #買い物\n'],
      ['行頭がタブ(markdown ではコード)', '\t#買い物\n'],
      ['行頭が全角空白(日本語では普通に打つ)', '\u3000#買い物\n'],
    ];
    for (const [name, body] of CASES) {
      it(name, () => {
        const scanned = scanBodyTags(body).map((u) => u.name);
        expect(renderedTags(body), '走査と画面が食い違っている').toEqual(scanned);
      });
    }
  });
});

/**
 * 🔴 **設定の select が、いまの見せ方を映す**(#550 段③)。
 *
 * ⚠ 器は 1 度しか組まないので、映さないと**別の面へ行って戻ったとき古い値が見える**
 *   ── user は「選んだのに戻っている」と読む(CLAUDE.md §7「設定画面の値の同期」)。
 * ⚠ **正本は DOM**(`applyTagBadge` が当てた印)── 保存を読み直さない。
 */
describe('🔴 設定の select が、いまの見せ方を映す(#550 段③)', () => {
  it('当てた値が select に出る(器を組み直さなくても)', async () => {
    const { SettingsRenderer } = await import('../../src/adapter/ui/render/settings');
    const { initialState } = await import('../../src/adapter/state/app-state');
    const { applyTagBadge } = await import('../../src/adapter/ui/render/tag-badge');
    const host = document.createElement('div');
    document.body.append(host);
    const s = new SettingsRenderer(host);
    applyTagBadge(document.documentElement, 'chip');
    s.render(initialState); // 1 度目 = 器を組む
    const sel = host.querySelector<HTMLSelectElement>('[data-pkc-field="tag-badge-select"]');
    expect(sel, '設定に「本文のタグの見せ方」が無い').not.toBeNull();
    expect(sel!.value, '既定が映っていない').toBe('chip');

    // 画面の外で値が変わる(別のタブ / 復元)
    applyTagBadge(document.documentElement, 'plain');
    s.render(initialState); // 2 度目 = 器は組み直さない
    expect(sel!.value, '古い値のまま見えている(選んだのに戻ったと読まれる)').toBe('plain');
    host.remove();
  });
});

/**
 * 🔴 **書き出した HTML でも札で出る**(#550 段③)。
 *
 * ⚠ お知らせとマニュアルに「**書き出した HTML でも札で出ます**」と書いた ──
 *   だから**それが本当かを見る検査**が要る(CLAUDE.md「これが無いと壊れると
 *   書く前に、外して壊れるのを見る」)。
 * 🔴 実際 1 稿目は**外れていた** ── 素の `.pkc-tagline { … }` で書いていたが、
 *   書き出しへ運ばれるのは **`.pkc-md-rendered` 起点の規則だけ**である
 *   (`build/body-css.ts` の `isBodyRule`)。書き出すと**ただの字**で出ていた。
 */
describe('🔴 書き出し HTML に札の CSS が運ばれる(#550 段③)', () => {
  it('本文の規則として抜き出される', async () => {
    const { readFileSync } = await import('node:fs');
    const { extractBodyCss } = await import('../../build/body-css');
    const css = extractBodyCss(
      readFileSync('src/styles/app.css', 'utf-8'),
      readFileSync('src/styles/tokens.css', 'utf-8'),
    );
    const text = typeof css === 'string' ? css : JSON.stringify(css);
    expect(text, '札の器が書き出しへ運ばれていない').toContain('.pkc-tagline');
    expect(text, '札そのものが書き出しへ運ばれていない').toContain('.pkc-tag');
    // ⚠ **下地の宣言まで運ばれている**(名前だけ在って空、で緑にしない)
    expect(text, '下地の宣言が落ちている').toMatch(/\.pkc-md-rendered \.pkc-tag[^{]*\{[^}]*background/);
  });
});
