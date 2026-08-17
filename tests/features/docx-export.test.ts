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

const ISO = '2026-08-17T00:00:00.000Z';

/** part を名前で引く(⚠ 無ければ test を落とす ── undefined を素通りさせない)。 */
function part(res: ReturnType<typeof buildDocx>, name: string): string {
  const hit = res.parts.find((p) => p.name === name);
  expect(hit, `${name} が無い`).toBeDefined();
  return hit!.text;
}

/** HTML(画面と同じもの)から塊を作る。 */
function blocksOf(html: string): { blocks: DocxBlock[]; skipped: number } {
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
