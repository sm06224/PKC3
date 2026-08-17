/** @vitest-environment happy-dom */
/**
 * 🔴 **Word 書き出しの中身を、開いて見る**(#187 段①)。
 *
 * 設計 doc の「検証の型」:
 * > 🔴 **生成物を開いて中を見る**。⚠ PKC2 は `word/numbering.xml` を 1 度も読まなかった
 * > ため、箇条書きの実装が**マニュアルの記述と食い違ったまま 3 ヶ月**残った
 *
 * だからここは「関数が何か返した」ではなく、**どの part にどの XML が入ったか**を見る。
 * ⚠ HTML → 塊の畳み込み(adapter)も同じ file で通す ── 2 つを別々に見ると、
 * 「塊は正しいのに XML が空」「XML は正しいのに塊が落ちている」を見分けられない。
 */
import { describe, expect, it } from 'vitest';
import { buildDocx, DOCX_LIST_DEPTH_MAX, type DocxBlock } from '@features/export/docx';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { renderMarkdown } from '@features/markdown/markdown-render';

const ISO = '2026-08-17T00:00:00.000Z';

/** part を名前で引く(⚠ 無ければ test を落とす ── undefined を素通りさせない)。 */
function part(res: ReturnType<typeof buildDocx>, name: string): string {
  const hit = res.parts.find((p) => p.name === name);
  expect(hit, `${name} が無い`).toBeDefined();
  return hit!.text;
}

/** HTML(画面と同じもの)から塊を作る。 */
function blocksOf(html: string): ReturnType<typeof htmlToDocxBlocks> {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return htmlToDocxBlocks(doc);
}

describe('docx の骨(package)', () => {
  const res = buildDocx([{ kind: 'p', runs: [{ text: 'あ' }] }], '題名', ISO);

  it('🔴 Word が要る part が全部在る(1 つ欠けると開けない)', () => {
    expect(res.parts.map((p) => p.name).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/app.xml',
        'docProps/core.xml',
        'word/_rels/document.xml.rels',
        'word/document.xml',
        'word/footer1.xml',
        'word/numbering.xml',
        'word/styles.xml',
      ].sort(),
    );
  });

  it('🔴 [Content_Types] が実在する part を全部宣言している(宣言漏れは「読み取れない」で全損)', () => {
    const types = part(res, '[Content_Types].xml');
    for (const p of res.parts) {
      if (p.name === '[Content_Types].xml' || p.name.endsWith('.rels')) continue;
      expect(types, `${p.name} が Content_Types に無い`).toContain(`/${p.name}`);
    }
  });

  it('題名と作成日時が core properties に入る(PKC2 は空だった)', () => {
    const core = part(res, 'docProps/core.xml');
    expect(core).toContain('<dc:title>題名</dc:title>');
    expect(core).toContain(ISO);
  });

  it('紙は A4 縦(既定 Letter で開かせない)', () => {
    expect(part(res, 'word/document.xml')).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  });
});

describe('塊 → OOXML の写像', () => {
  it('見出しは Heading1〜6(Word の標準名)へ', () => {
    const res = buildDocx(
      [
        { kind: 'h', level: 1, runs: [{ text: 'おおきい' }] },
        { kind: 'h', level: 3, runs: [{ text: 'ちいさい' }] },
      ],
      't',
      ISO,
    );
    const xml = part(res, 'word/document.xml');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading3"/>');
    // 空振り防止 ── 文字が本当に入っていること
    expect(xml).toContain('おおきい');
  });

  it('🔴 箇条書きは numbering を指し、その numId が numbering.xml に在る', () => {
    const res = buildDocx(
      [
        { kind: 'li', ordered: false, depth: 0, runs: [{ text: 'あ' }] },
        { kind: 'li', ordered: true, depth: 1, runs: [{ text: 'い' }] },
      ],
      't',
      ISO,
    );
    const xml = part(res, 'word/document.xml');
    const num = part(res, 'word/numbering.xml');
    const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]!);
    expect(ids.length, '箇条書きが numbering を指していない').toBeGreaterThan(0);
    for (const id of ids) {
      // 🔴 **指している先が実在するか**(PKC2 が読み返さなかった当の part)
      expect(num, `numId ${id} の宣言が numbering.xml に無い`).toContain(
        `<w:num w:numId="${id}">`,
      );
    }
    expect(xml).toContain('<w:ilvl w:val="1"/>');
  });

  it('🔴 黒丸の字が空でない(記号が落ちると印の無い箇条書きになる)', () => {
    const num = buildDocx([], 't', ISO).parts.find((p) => p.name === 'word/numbering.xml')!.text;
    const bullets = [...num.matchAll(/<w:numFmt w:val="bullet"\/><w:lvlText w:val="([^"]*)"\/>/g)];
    expect(bullets.length, '黒丸の定義が無い').toBe(DOCX_LIST_DEPTH_MAX);
    for (const b of bullets) expect(b[1], '黒丸の字が空').not.toBe('');
  });

  it('コードは 1 行 1 段落(網掛けが塊全体に掛かる形)', () => {
    const res = buildDocx([{ kind: 'code', text: 'a\nb\nc\n', lang: 'ts' }], 't', ISO);
    const xml = part(res, 'word/document.xml');
    expect((xml.match(/<w:pStyle w:val="PkcCode"\/>/g) ?? []).length).toBe(3);
    expect(xml, '言語名が出ていない').toContain('PkcCodeLang');
  });

  it('表は行 × セルで出て、見出しセルは太字になる', () => {
    const res = buildDocx(
      [
        {
          kind: 'table',
          rows: [
            [{ runs: [{ text: 'あ' }], header: true }, { runs: [{ text: 'い' }], header: true }],
            [{ runs: [{ text: '1' }] }, { runs: [{ text: '2' }] }],
          ],
        },
      ],
      't',
      ISO,
    );
    const xml = part(res, 'word/document.xml');
    expect((xml.match(/<w:tr>/g) ?? []).length).toBe(2);
    expect((xml.match(/<w:tc>/g) ?? []).length).toBe(4);
    expect(xml, '見出しセルが太字でない').toContain('<w:b/>');
  });

  it('🔴 リンクは rel を張り、その id が rels に実在する(壊れたリンクを作らない)', () => {
    const res = buildDocx(
      [{ kind: 'p', runs: [{ text: 'ここ', href: 'https://example.com/a' }] }],
      't',
      ISO,
    );
    const xml = part(res, 'word/document.xml');
    const rels = part(res, 'word/_rels/document.xml.rels');
    const id = /<w:hyperlink r:id="([^"]+)">/.exec(xml)?.[1];
    expect(id, 'リンクが hyperlink になっていない').toBeDefined();
    expect(rels).toContain(`Id="${id!}"`);
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('https://example.com/a');
  });

  it('styles.xml は document が指す style を全部持っている', () => {
    const res = buildDocx(
      [
        { kind: 'h', level: 2, runs: [{ text: 'h' }] },
        { kind: 'quote', runs: [{ text: 'q' }] },
        { kind: 'li', ordered: false, depth: 0, runs: [{ text: 'l' }] },
        { kind: 'code', text: 'c' },
        { kind: 'skipped', what: '画像', why: '段②' },
      ],
      't',
      ISO,
    );
    const xml = part(res, 'word/document.xml');
    const styles = part(res, 'word/styles.xml');
    const used = new Set([...xml.matchAll(/w:val="([A-Za-z0-9]+)"\/><\/w:pPr>|<w:pStyle w:val="([^"]+)"\/>/g)]
      .map((m) => m[2] ?? m[1])
      .filter((s): s is string => s !== undefined));
    expect(used.size, 'style を 1 つも拾えていない').toBeGreaterThan(3);
    for (const s of used)
      expect(styles, `${s} の定義が styles.xml に無い`).toContain(`w:styleId="${s}"`);
  });

  it('🔴 XML に入れられない文字は落とす(1 文字で Word が全損する)', () => {
    // ⚠ 制御文字は **escape で書く**(生バイトを置かない ── repo-hygiene が止める)
    const res = buildDocx([{ kind: 'p', runs: [{ text: 'あ\u0000い\u0007う' }] }], 't', ISO);
    const xml = part(res, 'word/document.xml');
    expect(xml).toContain('あいう');
    expect(xml.includes('\u0000'), 'NUL が残っている').toBe(false);
    expect(xml.includes('\u0007'), 'BEL が残っている').toBe(false);
  });

  it('🔴 写せなかったものは、本文にも注意にも出る(黙って落とさない)', () => {
    const res = buildDocx(
      [
        { kind: 'skipped', what: '画像', why: 'この版では画像を Word に入れていません' },
        { kind: 'skipped', what: '画像', why: 'この版では画像を Word に入れていません' },
      ],
      't',
      ISO,
    );
    expect(part(res, 'word/document.xml')).toContain('写せませんでした');
    expect(res.warnings.join(' ')).toContain('画像 2 件');
    expect(res.counts.skipped).toBe(2);
  });
});

describe('HTML(画面と同じもの)→ 塊', () => {
  it('見出し・段落・強調・等幅を写す', () => {
    const { blocks } = blocksOf(
      '<h2>題</h2><p>ふつう<strong>太い</strong><em>傾き</em><code>等幅</code></p>',
    );
    expect(blocks[0]).toMatchObject({ kind: 'h', level: 2 });
    const p = blocks[1] as Extract<DocxBlock, { kind: 'p' }>;
    expect(p.runs.map((r) => r.text)).toEqual(['ふつう', '太い', '傾き', '等幅']);
    expect(p.runs[1]).toMatchObject({ bold: true });
    expect(p.runs[3]).toMatchObject({ mono: true });
  });

  it('🔴 入れ子の箇条書きは depth で平らになる(親の行に子の文字が混ざらない)', () => {
    const { blocks } = blocksOf('<ul><li>おや<ul><li>こ</li></ul></li><li>となり</li></ul>');
    expect(blocks).toEqual([
      { kind: 'li', ordered: false, depth: 0, runs: [{ text: 'おや' }] },
      { kind: 'li', ordered: false, depth: 1, runs: [{ text: 'こ' }] },
      { kind: 'li', ordered: false, depth: 0, runs: [{ text: 'となり' }] },
    ]);
  });

  it('番号付きの中の黒丸は ordered が切り替わる', () => {
    const { blocks } = blocksOf('<ol><li>1 番<ul><li>丸</li></ul></li></ol>');
    expect(blocks.map((b) => (b as { ordered?: boolean }).ordered)).toEqual([true, false]);
  });

  it('表は header セルを見分ける', () => {
    const { blocks } = blocksOf('<table><thead><tr><th>あ</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
    const t = blocks[0] as Extract<DocxBlock, { kind: 'table' }>;
    expect(t.rows[0]![0]).toMatchObject({ header: true });
    expect(t.rows[1]![0]!.header).toBeUndefined();
  });

  it('コード塊は言語名を拾う', () => {
    const { blocks } = blocksOf('<pre><code class="language-ts">let a = 1;</code></pre>');
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'ts', text: 'let a = 1;' });
  });

  it('🔴 外向きのリンクだけ rel を張る(#slug や pkc:// は素の文字)', () => {
    const { blocks } = blocksOf(
      '<p><a href="https://example.com">そと</a><a href="#midashi">なか</a><a href="pkc://x">添付</a></p>',
    );
    const p = blocks[0] as Extract<DocxBlock, { kind: 'p' }>;
    expect(p.runs[0]).toMatchObject({ href: 'https://example.com' });
    // ⚠ 素の文字になった 2 つは**1 つの走りへ畳まれる**(装飾が同じなので)。
    //    ここを 2 件と書くと、畳みを消す変異が緑のまま通る ── 畳んだ結果で pin する
    expect(p.runs).toHaveLength(2);
    expect(p.runs[1]).toEqual({ text: 'なか添付' });
  });

  it('🔴 画像はその場に理由が残る(黙って消えない)', () => {
    const { blocks, skipped } = blocksOf('<p><img src="a.png" alt="図 1"></p>');
    expect(skipped).toBe(1);
    const p = blocks[0] as Extract<DocxBlock, { kind: 'p' }>;
    expect(p.runs[0]!.text).toContain('図 1');
    expect(p.runs[0]!.text).toContain('写せませんでした');
  });

  it('🔴 知らない器の中へ降りる(囲みの中の塊が 1 つに潰れない)', () => {
    /**
     * ⚠ **中身を 2 種類にする**(2026-08-17 の変異試験で書き直した)。
     * 段落 1 つだけの器だと、**降りない実装でも同じ結果**になる(器の文字を
     * まとめて 1 段落にするので)── 降下を消す変異が生き延びた。
     * 🔑 見出し + 段落にすると、降りない実装は**1 つの段落に潰す**ので差が出る。
     */
    const { blocks } = blocksOf('<div class="pkc-callout"><h3>囲みの題</h3><p>中の文</p></div>');
    expect(blocks).toEqual([
      { kind: 'h', level: 3, runs: [{ text: '囲みの題' }] },
      { kind: 'p', runs: [{ text: '中の文' }] },
    ]);
  });

  it('引用は段落ごとに quote になる', () => {
    const { blocks } = blocksOf('<blockquote><p>1 行目</p><p>2 行目</p></blockquote>');
    expect(blocks.map((b) => b.kind)).toEqual(['quote', 'quote']);
  });
});

describe('画像(#187 段②)', () => {
  it('🔴 縦横比を保って本文幅に収める(PKC2 は全部 480x360 に潰していた)', () => {
    // 本文幅は 9638 twip = 6.693in = 6,120,130 EMU(A4 21cm − 余白 2cm×2 = 17cm)。
    // それを**超える**幅(1200px = 11,430,000 EMU)を渡す
    const res = buildDocx(
      [{ kind: 'image', media: 'media/image1.png', widthPx: 1200, heightPx: 600, alt: 'ず' }],
      't',
      ISO,
    );
    const xml = part(res, 'word/document.xml');
    const ext = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
    expect(ext, '画像が入っていない').not.toBeNull();
    const cx = Number(ext![1]);
    const cy = Number(ext![2]);
    // ⚠ 幅は本文幅ちょうどへ収まる
    expect(cx).toBe(6_120_130);
    // 🔴 **比が保たれている**(2:1 のまま。潰れていない)
    expect(Math.abs(cx / cy - 2)).toBeLessThan(0.01);
  });

  it('本文幅に収まる画像はそのままの寸法(勝手に拡大しない)', () => {
    const res = buildDocx(
      [{ kind: 'image', media: 'media/image1.png', widthPx: 100, heightPx: 40, alt: 'ず' }],
      't',
      ISO,
    );
    const xml = part(res, 'word/document.xml');
    expect(xml).toContain('<wp:extent cx="952500" cy="381000"/>');
  });

  it('🔴 画像の rel は image 型で、リンクとは Type も TargetMode も違う', () => {
    const res = buildDocx(
      [
        { kind: 'image', media: 'media/image1.png', widthPx: 10, heightPx: 10, alt: 'ず' },
        { kind: 'p', runs: [{ text: 'そと', href: 'https://example.com' }] },
      ],
      't',
      ISO,
    );
    const rels = part(res, 'word/_rels/document.xml.rels');
    const img = /<Relationship Id="([^"]+)" Type="[^"]*\/image" Target="media\/image1.png"\/>/.exec(rels);
    expect(img, '画像の rel が image 型でない').not.toBeNull();
    // ⚠ 画像に TargetMode="External" が付くと Word は「外部の画像」として探しに行く
    expect(img![0]).not.toContain('TargetMode');
    expect(rels, 'リンクの rel が External でない').toContain('TargetMode="External"');
    // 🔴 document がその id を指している(指し先の実在)
    expect(part(res, 'word/document.xml')).toContain(`r:embed="${img![1]!}"`);
  });

  it('🔴 Content_Types が画像の拡張子を宣言している(宣言漏れは開けない)', () => {
    const types = part(buildDocx([], 't', ISO), '[Content_Types].xml');
    for (const ext of ['png', 'jpeg', 'gif', 'webp'])
      expect(types, `${ext} の宣言が無い`).toContain(`Extension="${ext}"`);
  });

  it('🔴 添付の画像は「場所」として預けられる(bytes は adapter が解く)', () => {
    const { blocks, images } = blocksOf(
      '<p><img data-pkc-asset-key="k1" data-pkc-asset-name="図.png"></p>',
    );
    expect(images).toEqual([{ at: 0, assetKey: 'k1', alt: '図.png' }]);
    // ⚠ 解けなかったときは **skipped のまま**(黙って消えない)
    expect(blocks[0]).toMatchObject({ kind: 'skipped' });
  });

  /**
   * 🔴 **段落に包まれていない画像も預ける**(2026-08-17 の変異試験 I6 で判明)。
   * ⚠ 添付の画像を拾う所は **2 か所**ある(段落の中を辿る側 / 塊を辿る側)。
   * 上の test は前者しか通らないので、後者を消す変異が**生き延びた**
   * (CLAUDE.md §7「同じ値を複数の経路へ渡すものは経路ごとに pin する」)。
   */
  it('🔴 段落に包まれていない画像も「場所」として預けられる', () => {
    const { blocks, images } = blocksOf('<img data-pkc-asset-key="k2" alt="直下の図">');
    expect(images).toEqual([{ at: 0, assetKey: 'k2', alt: '直下の図' }]);
    expect(blocks[0]).toMatchObject({ kind: 'skipped' });
  });
});

/**
 * 🔴 **図とグラフは「原文」ではなく絵で出す**(#187 段②)。
 *
 * ⚠ 段① はここが**素通し**だった ── 器の中には原文の `<pre><code>` が在るので、
 * 降りて拾って **`code` 塊(等幅の文字)**にしていた。これは PKC2 に
 * 「mermaid 等の図は原文が等幅で出る(黙って)」と記録されている失敗**そのもの**である。
 */
describe('図・グラフの器(#187 段②)', () => {
  const MERMAID =
    '<div class="pkc-mermaid-placeholder" data-pkc-mermaid-src="graph TD; A--&gt;B">' +
    '<pre class="pkc-mermaid-source"><code class="language-mermaid">graph TD; A--&gt;B</code></pre></div>';
  const CHART =
    '<div class="pkc-chart-placeholder" data-pkc-chart-src="bar: 1,2,3">' +
    '<pre class="pkc-chart-source"><code class="language-chart">bar: 1,2,3</code></pre></div>';

  it('🔴 図は「場所と原文」として預けられる(原文を等幅で出さない)', () => {
    const { blocks, figures } = blocksOf(MERMAID);
    expect(figures).toEqual([{ at: 0, kind: 'mermaid', source: 'graph TD; A-->B' }]);
    // ⚠ 焼けなければ skipped のまま(黙って消えない)
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'skipped', what: '図' });
    // 🔴 **器の中の原文まで降りていない**(降りると PKC2 と同じ顔になる)
    expect(blocks.some((b) => b.kind === 'code')).toBe(false);
  });

  it('🔴 グラフも同じ扱い(呼び名だけ変わる)', () => {
    const { blocks, figures } = blocksOf(CHART);
    expect(figures).toEqual([{ at: 0, kind: 'chart', source: 'bar: 1,2,3' }]);
    expect(blocks[0]).toMatchObject({ kind: 'skipped', what: 'グラフ' });
  });

  it('⚠ 本文の中の位置が保たれる(前後の段落と混ざらない)', () => {
    const { blocks, figures } = blocksOf(`<p>前</p>${MERMAID}<p>後</p>`);
    expect(figures).toEqual([{ at: 1, kind: 'mermaid', source: 'graph TD; A-->B' }]);
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'skipped', 'p']);
  });

  it('⚠ ふつうのコード塊は今までどおり code のまま(図と取り違えない)', () => {
    const { blocks, figures } = blocksOf('<pre><code class="language-js">let x = 1;</code></pre>');
    expect(figures).toEqual([]);
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'js' });
  });
});

/**
 * 🔴 **入力は「本物のレンダラが出した HTML」にする**(2026-08-17 に踏んだ)。
 *
 * ここより上の test は**手書きの HTML**を渡していた。だから段① は
 * 「実物では起きるが test では起きない」欠陥を 3 つ抱えたまま出荷していた ──
 * ① fence ごとにコピーの **⧉ が段落として**入る(ふつうのコード塊でも)
 * ② 切替の **‹/›** も入る
 * ③ **描画と原文が二重に**入る(表と csv 原文 / 図と図の原文)
 *
 * 🔑 空振りの型としては「代替物で満たせる条件」── 手書きの HTML は
 * **本物より素直**なので、素通しの欠陥をすり抜けさせる。
 */
describe('本物のレンダラの出力から写す', () => {
  const fromMarkdown = (md: string): ReturnType<typeof htmlToDocxBlocks> => {
    const doc = new DOMParser().parseFromString(`<body>${renderMarkdown(md)}</body>`, 'text/html');
    return htmlToDocxBlocks(doc);
  };

  it('🔴 コピーの ⧉ と切替の ‹/› は文書に入らない(画面の道具であって本文ではない)', () => {
    const text = JSON.stringify(fromMarkdown('```js\nlet x = 1;\n```\n\n```csv\na,b\n1,2\n```\n'));
    expect(text, 'コピーの器が本文に入っている').not.toContain('⧉');
    expect(text, '切替の器が本文に入っている').not.toContain('‹/›');
  });

  it('🔴 csv は表だけ入る(原文と二重にならない)', () => {
    const { blocks } = fromMarkdown('```csv\na,b\n1,2\n```\n');
    expect(blocks.map((b) => b.kind)).toEqual(['table']);
  });

  it('🔴 図は「図」だけ入る(原文と二重にならない)', () => {
    const { blocks, figures } = fromMarkdown('```mermaid\ngraph TD\n  A-->B\n```\n');
    expect(blocks.map((b) => b.kind)).toEqual(['skipped']);
    expect(figures).toHaveLength(1);
  });

  it('⚠ 原文で見せる指定(`-norender`)は原文が入る(切替の既定を取り違えない)', () => {
    const { blocks, figures } = fromMarkdown('```csv-norender\na,b\n1,2\n```\n');
    expect(blocks).toEqual([{ kind: 'code', text: 'a,b\n1,2\n', lang: 'csv' }]);
    expect(figures).toEqual([]);
  });

  it('⚠ ふつうの本文はそのまま通る(空振り防止 ── 全部落としていない)', () => {
    const { blocks } = fromMarkdown('# 題\n\n本文\n\n- あ\n- い\n');
    expect(blocks.map((b) => b.kind)).toEqual(['h', 'p', 'li', 'li']);
  });
});

/**
 * 🔴 **紙面・改頁・ページ番号**(#187 段③)。
 *
 * ⚠ 段② までは「A4 縦の既定」を焼き込んでいたので、**画面が A3 横でも Word だけ A4 縦**
 * だった。⚠ 改頁(`+++`)は `hr` と同じ塊に畳んでいたため、**Word でだけ水平線**になっていた
 * (画面と紙では `break-after: page` が効いている)。
 */
describe('紙面と改頁(#187 段③)', () => {
  const sect = (fmt?: Parameters<typeof buildDocx>[3]): string => {
    const xml = part(buildDocx([], 't', ISO, fmt), 'word/document.xml');
    const at = xml.indexOf('<w:sectPr>');
    expect(at, 'sectPr が無い').toBeGreaterThan(-1);
    return xml.slice(at);
  };

  it('🔴 画面の紙面設定が Word の紙になる(A3 横)', () => {
    expect(sect('a3-landscape')).toContain('<w:pgSz w:w="23811" w:h="16838" w:orient="landscape"/>');
  });

  it('🔴 A4 縦は今までどおり(既定を変えていない)', () => {
    expect(sect()).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(sect('a4-portrait')).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  });

  it('⚠ 紙を持たない形式(画面向け)は A4 縦に落ちる', () => {
    // フル HD / 4:3 は `paper: null`(印刷はブラウザの既定紙)── Word には
    // 「既定紙」が無いので、印刷と同じ既定へ倒す
    expect(sect('fullhd')).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(sect('43-portrait')).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  });

  it('🔴 改頁は改頁として入る(水平線に化けない)', () => {
    const xml = part(buildDocx([{ kind: 'pagebreak' }], 't', ISO), 'word/document.xml');
    expect(xml, '改頁が入っていない').toContain('<w:br w:type="page"/>');
    expect(xml, '改頁が水平線になっている').not.toContain('<w:pBdr>');
  });

  it('🔴 水平線は水平線のまま(改頁と取り違えない)', () => {
    const xml = part(buildDocx([{ kind: 'hr' }], 't', ISO), 'word/document.xml');
    expect(xml).toContain('<w:pBdr>');
    expect(xml).not.toContain('<w:br w:type="page"/>');
  });

  it('🔴 ページ番号の footer が「実在して・宣言されて・指されて」いる', () => {
    const res = buildDocx([], 't', ISO);
    const footer = part(res, 'word/footer1.xml');
    // ① 数字を焼かず field で入れる(1 行足したら嘘になる形にしない)
    expect(footer, 'PAGE の field が無い').toContain('PAGE');
    // ② Content_Types の宣言(欠けると Word はファイルごと開かない)
    expect(part(res, '[Content_Types].xml')).toContain('/word/footer1.xml');
    // ③ rels の実在と、④ sectPr がその id を指していること
    const id = /<Relationship Id="([^"]+)"[^>]*relationships\/footer"/.exec(
      part(res, 'word/_rels/document.xml.rels'),
    )?.[1];
    expect(id, 'footer の rel が無い').toBeDefined();
    expect(part(res, 'word/document.xml')).toContain(`<w:footerReference w:type="default" r:id="${id!}"/>`);
  });
});
