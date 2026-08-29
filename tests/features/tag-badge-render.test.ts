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
import { bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';

/**
 * 描いた HTML から `data-pkc-tag` を全部拾う。
 *
 * 🔴 **本番と同じ入力を渡す**(2026-08-29 の着地後レビューで判明)。
 * ⚠ 本文の面は `bodyBelowFrontmatter(body)` を描く(`detail.ts`)のに、この test は
 *   **生の本文**を渡していた ── だから **`---` の中に書いた `#下書き` が
 *   索引にだけ入る**という食い違いを、この検査は**原理的に見られなかった**
 *   (CLAUDE.md §4「自分が測った量と、user が見る量が違うことがある」)。
 */
function renderedTags(body: string, interactive = false): string[] {
  const html = renderMarkdown(
    bodyBelowFrontmatter(body),
    interactive ? { interactiveTags: true } : {},
  );
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
    /**
     * 🔴 **前処理を通る形を必ず入れる**(2026-08-29 の着地後レビュー)。
     *
     * ⚠ 1 稿目の 16 例は **`renderMarkdown` の前処理を 1 段も発火させない**入力
     *   ばかりで、実測すると **15 形**で食い違っていた ── 検査は緑のままだった。
     * 🔑 だから「引き金を持つ形」を名指しで入れる:frontmatter / `%%%` /
     *   `:::comment` / `:::if` / 表 / csv の囲み / 脚注 / hardbreak / 箇条書きの継続行。
     * ⚠ **対照群(A 群)を同じ表に置く** ── 全部 `[]` を返す実装でも緑、を避ける。
     */
    const CASES: ReadonlyArray<readonly [string, string]> = [
      // ── A 群: 拾うべきもの(空振り防止の対照群) ──
      ['単独の行', '#買い物 #家事\n'],
      ['見出しの下', '# 章\n\n#買い物\n'],
      ['段落の 2 行目(改行で続いた行)', '本文です\n#買い物\n'],
      ['段落の途中の行', '前\n#買い物\n後\n'],
      ['全角空白で区切る', '#買い物\u3000#家事\n'],
      ['タブで区切る', '#買い物\t#家事\n'],
      ['数字混じりは拾う', '#no117\n'],
      ['行頭が全角空白(日本語では普通に打つ)', '\u3000#買い物\n'],
      ['3 つ下げた行(ここまでは本文)', '   #買い物\n'],
      ['frontmatter の**下**に書いた行', '---\ntitle: x\n---\n\n#買い物\n'],
      ['段落の 2 行目を 4 つ下げ(コードではなく続き)', '本文\n    #買い物\n'],
      ['行末に半角 2 つ(hardbreak)の次の行', '本文  \n#買い物\n'],
      ['描かれる囲みの中(`:::note`)', ':::note\n#見える\n:::\n'],
      ['画面向けの `:::if` の中', ':::if{format=html}\n#画面用\n:::\n'],
      ['箇条書きが終わった後の行', '- 項目\n\n#買い物\n'],
      ['引用が終わった後の行', '> 引用\n\n#買い物\n'],
      // ── B 群: 拾ってはいけないもの ──
      ['タグが 1 つも無い', '# 章\n\nただの本文\n'],
      ['数字だけは拾わない', '#117 #121\n\n#本物\n'],
      ['fence の中は拾わない', '```\n#にせもの\n```\n\n#本物\n'],
      ['引用の中(> で始まる)', '> #買い物\n'],
      ['箇条書きの中', '- #買い物\n'],
      ['4 つ下げた行(markdown ではコード)', '    #買い物\n'],
      ['行頭がタブ(markdown ではコード)', '\t#買い物\n'],
      ['frontmatter の**中**(YAML のコメント)', '---\ntitle: x\n#下書き\n---\n\n本文\n'],
      ['索引の区切り(`|`)を名前に含む', '#設計|検討\n'],
      ['表のセル', '| #タグ | x |\n| --- | --- |\n| a | b |\n'],
      ['`:::comment` の中(画面に出ない)', ':::comment\n#隠したタグ\n:::\n'],
      ['`%%%` の中(画面に出ない)', '%%%\n#隠したタグ\n%%%\n'],
      ['画面以外を指した `:::if` の中', ':::if{format=docx}\n#docx専用\n:::\n'],
      ['空行の後の 4 つ下げ(コードブロック)', '本文\n\n    #コード\n'],
      ['脚注の定義の中', '本文[^1]\n\n[^1]: #買い物\n'],
      ['csv の囲みのセル', '```csv\n#にせもの,ふつう\n```\n'],
      ['箇条書きの項目の継続行', '1. 本文\n   #買い物\n'],
      ['箇条書きの項目の継続行(空行つき)', '- 本文\n\n  #買い物\n'],
    ];
    for (const [name, body] of CASES) {
      it(name, () => {
        const scanned = scanBodyTags(body).map((u) => u.name);
        expect(renderedTags(body), '走査と画面が食い違っている').toEqual(scanned);
      });
    }

    /**
     * 🔴 **索引の往復で名前が変わらない**(2026-08-29。**parity では見えない穴**)。
     *
     * ⚠ すぐ上の parity は、走査と描画が**同じ `parseTagLine` を共有**しているので、
     *   名前の規則をどちらへ変えても**両辺が揃って動く** ── つまり
     *   「`|` を名前に許す」変異は parity では**殺せない**(CLAUDE.md §1
     *   「期待値は別の綴りではなく別の観測から作る」)。
     * 🔑 だから**別の観測**を置く:索引は `|` で連結して保存する(`encodeTags`)ので、
     *   **往復して同じ並びに戻るか**を見る。戻らない名前は、保存した直後だけ
     *   当たって次の起動で黙って消える。
     */
    it('🔴 拾ったタグは、索引へ入れて読み直しても同じ名前のまま', async () => {
      const { encodeTags, decodeTags } = await import('../../src/features/flavor/tags');
      const broken: string[] = [];
      for (const [name, body] of CASES) {
        const scanned = scanBodyTags(body).map((u) => u.name);
        const round = decodeTags(encodeTags(scanned));
        if (JSON.stringify(round) !== JSON.stringify(scanned)) {
          broken.push(`${name}: ${JSON.stringify(scanned)} → ${JSON.stringify(round)}`);
        }
      }
      expect(broken, '索引の往復で名前が変わるタグが在る').toEqual([]);
      // ⚠ 空振り防止 ── 1 つも拾っていなければ、この検査は何も言っていない
      const total = CASES.reduce((n2, [, b]) => n2 + scanBodyTags(b).length, 0);
      expect(total, '1 つも拾っていない(空振り)').toBeGreaterThan(0);
    });

    it('🔑 空振り防止 ── この表は「拾う形」と「拾わない形」の両方を持つ', () => {
      // ⚠ 全部 `[]` を返す実装でも緑になる表を作らない(CLAUDE.md §1)
      const picked = CASES.filter(([, b]) => scanBodyTags(b).length > 0);
      const skipped = CASES.filter(([, b]) => scanBodyTags(b).length === 0);
      expect(picked.length, '拾う形が 1 つも無い = 常に空でも緑').toBeGreaterThanOrEqual(10);
      expect(skipped.length, '拾わない形が 1 つも無い = 常に拾っても緑').toBeGreaterThanOrEqual(10);
    });
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
    /**
     * 🔴 **選択子を丸ごと一致で拾う**(2026-08-29 の着地後レビューで直した)。
     *
     * ⚠ 1 稿目は `/\.pkc-md-rendered \.pkc-tag[^{]*\{[^}]*background/` と書いていたが、
     *   `[^{]*` が `[data-pkc-action]:hover` を飲むので、**`:hover` の規則に満たされて**
     *   いた ── 札の下地(素の規則の `background`)を消しても緑だった(変異で確認)。
     * 🔑 CSS は**構文で**拾う(CLAUDE.md §1 の 3〜5 度目と同じ罠)。
     */
    const { blocksFor, withoutMedia, stripComments } = await import('../../tests/helpers/css-blocks');
    const plain = withoutMedia(stripComments(text));
    const tagRules = blocksFor(plain, '.pkc-md-rendered .pkc-tag');
    expect(tagRules.length, '素の札の規則が書き出しに 1 本も無い').toBeGreaterThan(0);
    expect(
      tagRules.join('\n'),
      '下地の宣言が落ちている(:hover の規則に満たされていないか)',
    ).toMatch(/background/);
  });
});
