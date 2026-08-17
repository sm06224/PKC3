/**
 * 🔴 **Word(.docx)の組み立て**(#187 段①。設計 doc `office-export-design-2026-08.md` の (b))。
 *
 * ## なぜ手書きの OOXML なのか
 *
 * PKC2 の失敗の根は**ライブラリではなく「レンダラが 2 本あったこと」**だった ──
 * 画面は markdown-it、書き出しは別の AST 系で、「Word で直した」が PDF に届かない。
 * 一方で **唯一うまくいったのは依存 0 の手書き OOXML(xlsx)** で、因果は「軽いから」
 * ではなく **自分で組んだから実パーサで読み返す test が書けた**ことである。
 *
 * 🔑 だからここは **画面と同じ HTML から**塊の列(`DocxBlock[]`)を作り、それを
 * OOXML へ写す。⚠ HTML を読む所は adapter(`html-blocks.ts`)に置く ──
 * この file は **DOM も Blob も触らない純関数**で、`tests/features/` から素で叩ける。
 *
 * ## 守ること
 *
 * - 🔴 **写せない塊は、その場に理由を出す**(設計 doc 段① の「落ちたときの断り方」)。
 *   ⚠ PKC2 は失敗を `console.warn` にだけ書いており、user から見ると
 *   **「ボタンを押して何も起きない」が正常動作**だった
 * - 🔴 **`word/numbering.xml` を実際に書く。** PKC2 は 1 度も読み返さず、箇条書きの
 *   実装がマニュアルの記述と食い違ったまま 3 ヶ月残った
 * - ⚠ **core properties を入れる**(PKC2 は無し)── 題名と作成日時が空の docx は、
 *   Word の一覧で見分けが付かない
 * - ⚠ 1 個の巨大な文字列を作らない ── 部品(`DocxPart[]`)で返し、zip へは
 *   `zip-writer.ts` が並べるだけにする(不可侵指示 2026-07-27「ゼロコピー」)
 */

/** 文字の並び(強調・傾き・等幅・リンク)。⚠ 入れ子は**畳んで**持つ。 */
export interface DocxRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  /** 等幅(`code`)。⚠ 段落ごと等幅にする `code` 塊とは別物。 */
  readonly mono?: boolean;
  /** 外部リンクの URL(空なら素の文字)。 */
  readonly href?: string;
}

/** 表の 1 セル。 */
export interface DocxCell {
  readonly runs: readonly DocxRun[];
  readonly header?: boolean;
}

/**
 * 写す単位。⚠ **入れ子は `depth` で持つ**(木にしない)── OOXML の段落は
 * 平らな列で、箇条書きの階層は `w:ilvl` という**属性**である。木で持つと
 * 「木を平らにする」段が増え、そこが PKC2 の食い違いの温床だった。
 */
export type DocxBlock =
  | { readonly kind: 'p'; readonly runs: readonly DocxRun[] }
  | { readonly kind: 'h'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly runs: readonly DocxRun[] }
  | {
      readonly kind: 'li';
      readonly ordered: boolean;
      /** 0 起点。⚠ OOXML の `w:ilvl` と同じ数え方に揃える。 */
      readonly depth: number;
      readonly runs: readonly DocxRun[];
    }
  | { readonly kind: 'quote'; readonly runs: readonly DocxRun[] }
  | { readonly kind: 'code'; readonly text: string; readonly lang?: string }
  | { readonly kind: 'hr' }
  | { readonly kind: 'table'; readonly rows: readonly (readonly DocxCell[])[] }
  /**
   * 🔴 **画像**(#187 段②)。⚠ **縦横比を保つ** ── PKC2 は全画像を 480×360 px に
   * 潰しており、doc にもコメントにも記録が無かった(調査で初めて分かった)。
   * ⚠ bytes はここに持たない ── 純関数のままにするため、**zip へ入れるのは呼び側**。
   */
  | {
      readonly kind: 'image';
      /** zip の中の名前(`media/image1.png` 等)。⚠ rels と一致させる。 */
      readonly media: string;
      /** 実寸(px)。⚠ 0 以下なら**入れない**(呼び側が `skipped` に倒す)。 */
      readonly widthPx: number;
      readonly heightPx: number;
      /** 読み上げと、写せなかったときの手掛かり。 */
      readonly alt: string;
    }
  /**
   * 🔴 **写せなかったもの**。⚠ 黙って落とさず、**その場に理由を段落として出す**。
   */
  | { readonly kind: 'skipped'; readonly what: string; readonly why: string };

/** zip に並べる部品(name と中身の文字列)。 */
export interface DocxPart {
  readonly name: string;
  readonly text: string;
}

export interface DocxResult {
  readonly parts: readonly DocxPart[];
  /** user に見せる注意(写せなかったものの件数)。 */
  readonly warnings: readonly string[];
  /** 診断(test の観測点)。 */
  readonly counts: {
    readonly blocks: number;
    readonly paragraphs: number;
    readonly tables: number;
    readonly links: number;
    readonly images: number;
    readonly skipped: number;
  };
}

/**
 * px → EMU(English Metric Unit)。⚠ Word の寸法は EMU で、**96dpi の px なら 9525 倍**。
 */
const EMU_PER_PX = 9525;
/**
 * 本文の幅(EMU)。A4 縦・左右余白 1134 twip → 9638 twip = **6.693 インチ**
 * (= 17.0cm。A4 の 21cm から余白 2cm を両側)。
 * ⚠ **これを超える画像は縮める**(はみ出すと Word が紙の外へ置く)。
 * 🔑 縮めるときは**縦横比を保つ**(PKC2 の 480×360 固定を繰り返さない)。
 */
const BODY_WIDTH_EMU = Math.round(9638 / 1440 * 914400);

/** 箇条書きの階層の上限。⚠ 超えた分は最深に丸める(段落ごと落とさない)。 */
export const DOCX_LIST_DEPTH_MAX = 8;
/** 番号付きの numId。⚠ `numbering.xml` の宣言と**この 2 つだけ**で揃える。 */
const NUM_BULLET = 1;
const NUM_ORDERED = 2;

/** XML の文字参照。⚠ 属性にも本文にも同じものを使う(`"` まで含める)。 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 🔴 **XML に入れられない文字を落とす。** ⚠ 落とさないと Word は
 * 「読み取れないコンテンツ」と言って**ファイルごと**開かない ── 1 文字で全損になる。
 * 許すのは XML 1.0 の範囲(tab / LF / CR と U+0020 以降)。
 */
function xmlSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0xfffe && c !== 0xffff))
      out += ch;
  }
  return out;
}

/** 走りの 1 つを `<w:r>` へ。⚠ 空白を保つ(`xml:space="preserve"`)。 */
function runXml(run: DocxRun, style: 'normal' | 'code' = 'normal'): string {
  const props: string[] = [];
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.strike) props.push('<w:strike/>');
  if (run.mono || style === 'code') props.push('<w:rStyle w:val="PkcCodeChar"/>');
  if (run.href) props.push('<w:rStyle w:val="PkcLinkChar"/>');
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  // ⚠ 改行は `<w:br/>` にする ── そのまま入れると Word は 1 行に潰す
  const text = xmlEscape(xmlSafe(run.text));
  const body = text
    .split('\n')
    .map((line) => `<w:t xml:space="preserve">${line}</w:t>`)
    .join('<w:br/>');
  return `<w:r>${rPr}${body}</w:r>`;
}

/**
 * リンクは **rel を 1 本足して** `<w:hyperlink>` で包む。
 * ⚠ rel を書き忘れると Word が「リンク先が壊れている」と言う(黙って素の文字に
 * ならない)ので、rels は**この関数が集めた分だけ**を書く。
 */
function runsXml(runs: readonly DocxRun[], rels: Map<string, string>, style: 'normal' | 'code' = 'normal'): string {
  let out = '';
  for (const run of runs) {
    if (run.href) {
      let id = rels.get(run.href);
      if (id === undefined) {
        id = `rIdL${rels.size + 1}`;
        rels.set(run.href, id);
      }
      out += `<w:hyperlink r:id="${xmlEscape(id)}">${runXml(run, style)}</w:hyperlink>`;
    } else {
      out += runXml(run, style);
    }
  }
  return out;
}

function paragraph(inner: string, styleId?: string, extraPr = ''): string {
  const style = styleId ? `<w:pStyle w:val="${styleId}"/>` : '';
  const pPr = style || extraPr ? `<w:pPr>${style}${extraPr}</w:pPr>` : '';
  return `<w:p>${pPr}${inner}</w:p>`;
}

/** 塊 1 つ → 段落(複数になることもある: 表・コード)。 */
function blockXml(block: DocxBlock, rels: Map<string, string>): string {
  switch (block.kind) {
    case 'p':
      return paragraph(runsXml(block.runs, rels));
    case 'h':
      return paragraph(runsXml(block.runs, rels), `Heading${block.level}`);
    case 'quote':
      return paragraph(runsXml(block.runs, rels), 'Quote');
    case 'li': {
      const ilvl = Math.min(Math.max(block.depth, 0), DOCX_LIST_DEPTH_MAX - 1);
      const numId = block.ordered ? NUM_ORDERED : NUM_BULLET;
      const numPr = `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
      return paragraph(runsXml(block.runs, rels), 'ListParagraph', numPr);
    }
    case 'code': {
      /**
       * ⚠ **1 行 1 段落**にする。1 段落に `<w:br/>` で詰めると、Word の
       * 「段落の網掛け」が塊全体に掛からず**見た目が崩れる**。
       * 🔑 言語名は段落として出す(色付けはしない ── 段① の約束)。
       */
      const lines = block.text.replace(/\n$/, '').split('\n');
      const head =
        block.lang !== undefined && block.lang !== ''
          ? paragraph(runXml({ text: block.lang, mono: true }), 'PkcCodeLang')
          : '';
      return head + lines.map((l) => paragraph(runXml({ text: l }, 'code'), 'PkcCode')).join('');
    }
    case 'hr':
      // 水平線は「下線だけの空段落」── OOXML に `<hr>` は無い
      return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>`;
    case 'table': {
      const grid = block.rows[0]?.length ?? 1;
      const cols = Array.from({ length: grid }, () => `<w:gridCol w:w="${Math.floor(9360 / grid)}"/>`).join('');
      const rows = block.rows
        .map((row) => {
          const cells = row
            .map((cell) => {
              const shade = cell.header
                ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>'
                : '';
              const runs = cell.header
                ? cell.runs.map((r) => ({ ...r, bold: true }))
                : cell.runs;
              return `<w:tc><w:tcPr>${shade}</w:tcPr>${paragraph(runsXml(runs, rels), 'PkcTableCell')}</w:tc>`;
            })
            .join('');
          return `<w:tr>${cells}</w:tr>`;
        })
        .join('');
      return `<w:tbl><w:tblPr><w:tblStyle w:val="PkcTable"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BBBBBB"/><w:left w:val="single" w:sz="4" w:color="BBBBBB"/><w:bottom w:val="single" w:sz="4" w:color="BBBBBB"/><w:right w:val="single" w:sz="4" w:color="BBBBBB"/><w:insideH w:val="single" w:sz="4" w:color="BBBBBB"/><w:insideV w:val="single" w:sz="4" w:color="BBBBBB"/></w:tblBorders></w:tblPr><w:tblGrid>${cols}</w:tblGrid>${rows}</w:tbl>`;
    }
    case 'image': {
      /**
       * 🔴 **縦横比を保って本文幅に収める**(#187 段②)。
       * ⚠ PKC2 は全画像を 480×360 px に潰していた ── 縦長の図が横に潰れて出る。
       * 🔑 収めるのは**幅だけ**を見て、高さは同じ比で落とす。
       */
      let cx = Math.max(1, Math.round(block.widthPx * EMU_PER_PX));
      let cy = Math.max(1, Math.round(block.heightPx * EMU_PER_PX));
      if (cx > BODY_WIDTH_EMU) {
        cy = Math.max(1, Math.round((cy * BODY_WIDTH_EMU) / cx));
        cx = BODY_WIDTH_EMU;
      }
      let id = rels.get(block.media);
      if (id === undefined) {
        id = `rIdM${rels.size + 1}`;
        rels.set(block.media, id);
      }
      const alt = xmlEscape(xmlSafe(block.alt));
      const n = rels.size;
      const drawing =
        `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${alt}"/>` +
        `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${xmlEscape(id)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
        `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
      return paragraph(`<w:r>${drawing}</w:r>`);
    }
    case 'skipped':
      /**
       * 🔴 **その場に理由を出す**(設計 doc 段①)。⚠ 黙って落とすと user は
       * 「Word に写らなかったこと」に気づけない ── PKC2 で実際にそうなっていた。
       */
      return paragraph(
        runXml({ text: `［${block.what} は写せませんでした: ${block.why}］`, italic: true }),
        'PkcSkipped',
      );
  }
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="webp" ContentType="image/webp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

/** 段落の書式。⚠ 見出しは `Heading1`〜`Heading6`(Word の標準名)に合わせる。 */
function stylesXml(): string {
  const heading = (n: number, sz: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/><w:spacing w:before="${240 - n * 20}" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Yu Gothic" w:eastAsia="Yu Gothic" w:hAnsi="Yu Gothic"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>${heading(1, 40)}${heading(2, 32)}${heading(3, 28)}${heading(4, 24)}${heading(5, 22)}${heading(6, 21)}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BBBBBB"/></w:pBdr></w:pPr><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="PkcCode"><w:name w:val="PKC Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="F4F4F4"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:eastAsia="MS Gothic" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="PkcCodeLang"><w:name w:val="PKC Code Language"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="17"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="PkcTableCell"><w:name w:val="PKC Table Cell"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="PkcSkipped"><w:name w:val="PKC Skipped"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="AA3333"/></w:rPr></w:style><w:style w:type="character" w:styleId="PkcCodeChar"><w:name w:val="PKC Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:eastAsia="MS Gothic" w:hAnsi="Consolas"/></w:rPr></w:style><w:style w:type="character" w:styleId="PkcLinkChar"><w:name w:val="PKC Link Char"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`;
}

/**
 * 🔴 **箇条書きの定義**(`word/numbering.xml`)。
 * ⚠ PKC2 はこの part を 1 度も読み返さず、実装とマニュアルが 3 ヶ月食い違っていた。
 * ここでは **黒丸 / 番号の 2 本**を宣言し、深さは `DOCX_LIST_DEPTH_MAX` まで作る。
 */
function numberingXml(): string {
  /**
   * ⚠ **記号は escape で書く**(CLAUDE.md「制御文字をソースに生バイトで埋めない」の
   * 同じ向き ── 編集ツールが文字を落とすと `w:lvlText` が空になり、**黒丸が消えた
   * 箇条書き**が出荷される。空でないことは test が pin する)。
   * `•` = 中黒 / `◦` = 白丸 / `▪` = 小さい黒四角。
   */
  const bulletChars = ['•', '◦', '▪'];
  const orderedFmt = ['decimal', 'lowerLetter', 'lowerRoman'];
  const lvl = (i: number, ordered: boolean): string => {
    const indent = 480 * (i + 1);
    if (ordered) {
      const fmt = orderedFmt[i % orderedFmt.length]!;
      return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
    }
    const ch = bulletChars[i % bulletChars.length]!;
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${ch}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol"/></w:rPr></w:lvl>`;
  };
  const levels = (ordered: boolean): string =>
    Array.from({ length: DOCX_LIST_DEPTH_MAX }, (_, i) => lvl(i, ordered)).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum><w:num w:numId="${NUM_BULLET}"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="${NUM_ORDERED}"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
}

/**
 * 塊の列から `.docx` の部品を組む。
 *
 * @param title 文書の題名(core properties にも入れる)
 * @param iso   作成日時(ISO)。⚠ **呼び側が渡す** ── ここで `new Date()` を呼ばない
 *              (純関数のままにして test が固定値で回せるようにする)
 */
export function buildDocx(
  blocks: readonly DocxBlock[],
  title: string,
  iso: string,
): DocxResult {
  const rels = new Map<string, string>();
  const body = blocks.map((b) => blockXml(b, rels)).join('');
  /**
   * ⚠ **紙面は段③**(設計 doc)。ここでは A4 縦の既定だけ置く ── 置かないと
   * Word は Letter で開き、日本語文書が右端で切れる。
   */
  const sectPr =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}${sectPr}</w:body></w:document>`;

  const relItems = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    // ⚠ **画像とリンクで Type も TargetMode も違う** ── 取り違えると Word が
    //    「リンク先が壊れている」/ 画像が出ない。id の前置き(`rIdM` / `rIdL`)で分ける
    ...[...rels].map(([target, id]) =>
      id.startsWith('rIdM')
        ? `<Relationship Id="${xmlEscape(id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${xmlEscape(target)}"/>`
        : `<Relationship Id="${xmlEscape(id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(target)}" TargetMode="External"/>`,
    ),
  ].join('');
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relItems}</Relationships>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(xmlSafe(title))}</dc:title><dc:creator>PKC3</dc:creator><cp:lastModifiedBy>PKC3</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${xmlEscape(iso)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xmlEscape(iso)}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PKC3</Application></Properties>`;

  const skipped = blocks.filter((b) => b.kind === 'skipped');
  const warnings: string[] = [];
  if (skipped.length > 0) {
    // 🔴 **件数で言う**(#213 の裁定 A と同じ向き ── 「片道です」だけでは損失量が測れない)
    const kinds = new Map<string, number>();
    for (const s of skipped) kinds.set(s.what, (kinds.get(s.what) ?? 0) + 1);
    const detail = [...kinds].map(([what, n]) => `${what} ${n} 件`).join(' / ');
    warnings.push(`Word に写せなかったものがあります(${detail})── 本文にその場所を書きました`);
  }

  return {
    parts: [
      { name: '[Content_Types].xml', text: CONTENT_TYPES },
      { name: '_rels/.rels', text: ROOT_RELS },
      { name: 'word/document.xml', text: document },
      { name: 'word/_rels/document.xml.rels', text: documentRels },
      { name: 'word/styles.xml', text: stylesXml() },
      { name: 'word/numbering.xml', text: numberingXml() },
      { name: 'docProps/core.xml', text: core },
      { name: 'docProps/app.xml', text: app },
    ],
    warnings,
    counts: {
      blocks: blocks.length,
      paragraphs: (document.match(/<w:p>|<w:p [^>]*>/g) ?? []).length,
      tables: blocks.filter((b) => b.kind === 'table').length,
      links: [...rels.values()].filter((id) => id.startsWith('rIdL')).length,
      images: blocks.filter((b) => b.kind === 'image').length,
      skipped: skipped.length,
    },
  };
}
