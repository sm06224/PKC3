/**
 * 🔴 **PowerPoint(.pptx)へ書き出す**(#187 の残り。段①)。
 *
 * 設計と根拠は `docs/development/pptx-export-design-2026-08.md`。要点だけ:
 *
 * - 🔑 **入力は docx と同じ塊の列**(`html-blocks.ts` が画面と同じ HTML から作る)。
 *   ⚠ **レンダラを 2 本にしない** ── PKC2 は画面(markdown-it)と書き出し(AST 系)で
 *   別々に描いており、記録されている不具合はほぼ全部その土台に乗っていた
 * - 🔑 **切れ方は PKC2 と同じ**にする ── user が PKC2 で書いた資料が同じ切れ方で出る
 * - ⚠ **依存を足さない**(pptxgenjs を持ち込まない)。手書き OOXML + 既存の zip 書き手
 *
 * ⚠ ここは**純関数**である。DOM も FS も zip も触らない ── 返すのは
 * 「zip に並べる部品(名前と中身の文字列)」だけで、並べるのは呼び側である
 * (docx と同じ形。不可侵指示 2026-07-27「ゼロコピー」)。
 */

import type { DocxBlock, DocxRun } from './docx';
import { xmlEscape } from './docx';

/**
 * 🔑 **塊の列は形式に依らない**(見出し・段落・箇条書き・表・画像・写せなかったもの)。
 * ⚠ 型の名前が `Docx…` なのは docx が先に作ったからで、**中身は共通**である。
 * ここでは読む側の名前で呼ぶ ── 型を 2 つに割ると、片方だけ直す事故が起きる。
 */
export type ExportBlock = DocxBlock;
export type ExportRun = DocxRun;

/** zip に並べる部品(name と中身の文字列)。⚠ docx と同じ形。 */
export interface PptxPart {
  readonly name: string;
  readonly text: string;
}

export interface PptxResult {
  readonly parts: readonly PptxPart[];
  /** user に見せる注意(写せなかったものの件数)。 */
  readonly warnings: readonly string[];
  /** 診断(test の観測点)。 */
  readonly counts: {
    readonly blocks: number;
    readonly slides: number;
    readonly sectionSlides: number;
    readonly lines: number;
    readonly skipped: number;
  };
}

/**
 * 版面(EMU)。⚠ 既定は **16:9**(12192000 × 6858000)。
 * 1 インチ = 914400 EMU。
 */
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const EMU_PER_INCH = 914400;
const inch = (v: number): number => Math.round(v * EMU_PER_INCH);

/**
 * 🔴 **枠の表**(設計 doc §5)。docx は本文の流れに置くが、スライドは**箱の位置**が要る。
 * ⚠ **1 か所にまとめる** ── PKC2 は呼び出し地点ごとに数値を直書きしていた。
 */
const FRAME = {
  /** 扉スライドの題名 / 副題。 */
  coverTitle: { x: inch(0.9), y: inch(2.4), w: inch(11.5), h: inch(1.6) },
  coverSubtitle: { x: inch(0.9), y: inch(4.1), w: inch(11.5), h: inch(0.9) },
  /** 本文スライドの題名帯と本文。 */
  title: { x: inch(0.6), y: inch(0.4), w: inch(12.1), h: inch(0.9) },
  body: { x: inch(0.6), y: inch(1.5), w: inch(12.1), h: inch(5.1) },
} as const;

/** 文字の大きさ(1/100 pt。OOXML の `sz` は 100 倍)。 */
const SZ = { coverTitle: 4400, coverSubtitle: 2400, title: 3200, body: 1800 } as const;

/** 箇条書きの深さの上限。⚠ 超えた分は最深に丸める(行ごと落とさない)。 */
export const PPTX_LIST_DEPTH_MAX = 8;

/** スライド 1 枚の下書き。 */
export interface SlideDraft {
  readonly kind: 'section' | 'content';
  title: string;
  subtitle?: string;
  readonly lines: SlideLine[];
}

/** スライドの本文 1 行。 */
export interface SlideLine {
  readonly runs: readonly ExportRun[];
  /** 箇条書きの深さ(0 起点)。⚠ `null` は箇条書きでない。 */
  readonly bullet: number | null;
  /** 等幅(コード)。 */
  readonly mono?: boolean;
}

/** 走りを 1 本の素の文字にする(題名に使う)。 */
function plain(runs: readonly ExportRun[]): string {
  return runs.map((r) => r.text).join('');
}

/**
 * 🔴 **切れ方**(設計 doc §3)。PKC2 の `splitIntoSlides` をそのまま写す。
 *
 * | 本文 | どうなるか |
 * |---|---|
 * | H1 | **扉スライド**を開始 |
 * | H2 | 直前が扉で副題が空なら**その副題**。そうでなければ**新しい本文スライド** |
 * | H3 | **新しい本文スライド** |
 * | `+++` / `---` | いまのスライドを閉じ、**題名の無い**新しいスライドを開始 |
 * | H4〜H6 / 段落 / 箇条書き / 表 / 画像 | **いまのスライドの本文** |
 * | (1 枚も作られなかったとき) | ノートの題名で 1 枚だけ作る |
 *
 * ⚠ **`role` は見ない。** PKC2 のマニュアルは「role に応じて」と書いているが、
 * 実装は見ていない(`export-pptx.ts:698`)── 字ではなく実装に合わせる。
 */
export function splitIntoSlides(
  blocks: readonly ExportBlock[],
  fallbackTitle: string,
): SlideDraft[] {
  const slides: SlideDraft[] = [];
  let current: SlideDraft | null = null;
  const ensure = (): SlideDraft => {
    if (current === null) {
      current = { kind: 'content', title: fallbackTitle, lines: [] };
      slides.push(current);
    }
    return current;
  };
  // ⚠ 代入を**呼び側**で書く ── クロージャの中で代入すると、TS の絞り込みが
  //    `current` を `never` まで狭めて型が壊れる(実際に踏んだ)
  const open = (kind: 'section' | 'content', title: string): SlideDraft => {
    const s: SlideDraft = { kind, title, lines: [] };
    slides.push(s);
    return s;
  };

  for (const b of blocks) {
    if (b.kind === 'h' && b.level === 1) {
      current = open('section', plain(b.runs));
      continue;
    }
    if (b.kind === 'h' && b.level === 2) {
      // ⚠ 扉の副題は **1 つだけ**(2 つ目の H2 は新しいスライドになる)
      if (current !== null && current.kind === 'section' && current.subtitle === undefined) {
        current.subtitle = plain(b.runs);
        continue;
      }
      current = open('content', plain(b.runs));
      continue;
    }
    if (b.kind === 'h' && b.level === 3) {
      current = open('content', plain(b.runs));
      continue;
    }
    // ⚠ `hr` も切る ── PKC2 は `page` と `rule` の**両方**で切っている
    if (b.kind === 'pagebreak' || b.kind === 'hr') {
      current = open('content', '');
      continue;
    }
    for (const line of blockToLines(b)) ensure().lines.push(line);
  }
  if (slides.length === 0) open('content', fallbackTitle);
  return slides;
}

/**
 * 塊 1 つ → 本文の行。
 *
 * ⚠ **黙って落とさない**(設計 doc §2)── 写せないものは**その場に理由を出す**。
 * PKC2 は失敗を `console.warn` だけに書き、user から見ると
 * 「押して何も起きない」が正常動作だった。
 */
function blockToLines(b: ExportBlock): SlideLine[] {
  switch (b.kind) {
    case 'p':
      return [{ runs: b.runs, bullet: null }];
    case 'h':
      // H4〜H6 は本文に落ちる(太字の 1 行)
      return [{ runs: b.runs.map((r) => ({ ...r, bold: true })), bullet: null }];
    case 'li':
      return [{ runs: b.runs, bullet: Math.min(b.depth, PPTX_LIST_DEPTH_MAX - 1) }];
    case 'quote':
      return [{ runs: b.runs.map((r) => ({ ...r, italic: true })), bullet: null }];
    case 'code':
      // ⚠ 1 行ずつ ── 塊のまま渡すと改行が消える
      return b.text.split('\n').map((t) => ({ runs: [{ text: t }], bullet: null, mono: true }));
    case 'table':
      // 段② で表として置く。⚠ それまでは**中身を捨てない**(素の行として出す)
      return b.rows.map((row) => ({
        runs: [{ text: row.map((c) => plain(c.runs)).join(' | ') }],
        bullet: null,
      }));
    case 'image':
      // 段③ で置く。⚠ それまでは**在ったことを言う**
      return [{ runs: [{ text: `[画像: ${b.alt !== '' ? b.alt : b.media}]`, italic: true }], bullet: null }];
    case 'skipped':
      return [{ runs: [{ text: `[${b.what}: ${b.why}]`, italic: true }], bullet: null }];
    default:
      return [];
  }
}

/** 走り 1 本 → `<a:r>`。 */
function runXml(r: ExportRun, sz: number): string {
  const props: string[] = [`lang="ja-JP"`, `sz="${sz}"`];
  if (r.bold === true) props.push('b="1"');
  if (r.italic === true) props.push('i="1"');
  if (r.strike === true) props.push('strike="sngStrike"');
  const face = r.mono === true
    ? '<a:latin typeface="Consolas"/><a:ea typeface="Consolas"/>'
    : '';
  return `<a:r><a:rPr ${props.join(' ')} dirty="0">${face}</a:rPr>`
    + `<a:t>${xmlEscape(r.text)}</a:t></a:r>`;
}

/** 本文の 1 行 → `<a:p>`。 */
function lineXml(line: SlideLine, sz: number): string {
  const runs = line.runs.length === 0 ? [{ text: '' } as ExportRun] : line.runs;
  const pPr = line.bullet === null
    ? '<a:pPr><a:buNone/></a:pPr>'
    : `<a:pPr lvl="${line.bullet}"/>`;
  const eff = line.mono === true ? runs.map((r) => ({ ...r, mono: true })) : runs;
  return `<a:p>${pPr}${eff.map((r) => runXml(r, sz)).join('')}</a:p>`;
}

/** 文字の箱 1 つ。⚠ `<a:normAutofit/>` で **PowerPoint に縮めさせる**(設計 doc §4)。 */
function textBox(
  id: number,
  name: string,
  frame: { x: number; y: number; w: number; h: number },
  body: string,
  anchor: 'ctr' | 't',
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/>`
    + `<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${frame.x}" y="${frame.y}"/>`
    + `<a:ext cx="${frame.w}" cy="${frame.h}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr>`
    + `<a:lstStyle/>${body}</p:txBody></p:sp>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** スライド 1 枚の XML。 */
function slideXml(s: SlideDraft): string {
  const shapes: string[] = [];
  if (s.kind === 'section') {
    shapes.push(textBox(2, '題名', FRAME.coverTitle,
      lineXml({ runs: [{ text: s.title, bold: true }], bullet: null }, SZ.coverTitle), 'ctr'));
    if (s.subtitle !== undefined) {
      shapes.push(textBox(3, '副題', FRAME.coverSubtitle,
        lineXml({ runs: [{ text: s.subtitle }], bullet: null }, SZ.coverSubtitle), 'ctr'));
    }
  } else {
    if (s.title !== '') {
      shapes.push(textBox(2, '題名', FRAME.title,
        lineXml({ runs: [{ text: s.title, bold: true }], bullet: null }, SZ.title), 'ctr'));
    }
    if (s.lines.length > 0) {
      shapes.push(textBox(3, '本文', FRAME.body,
        s.lines.map((l) => lineXml(l, SZ.body)).join(''), 't'));
    }
  }
  return `${XML_HEAD}<p:sld ${NS_P}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr/>'
    + `${shapes.join('')}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"'
    + ' accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4"'
    + ' accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>'
    + '</p:sld>';
}

/**
 * 🔑 **最小の骨格**(設計 doc §6)── LibreOffice が書いた 1 枚の pptx を実測して数えた。
 * master と layout は **1 枚ずつで足りる**。増えるのは `slideN.xml` と `sldIdLst` だけ。
 */
const THEME_XML = `${XML_HEAD}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PKC3"><a:themeElements><a:clrScheme name="PKC3"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="000000"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="PKC3"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="PKC3"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:prstDash val="solid"/><a:miter/></a:ln><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:prstDash val="solid"/><a:miter/></a:ln><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:prstDash val="solid"/><a:miter/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/>'
  + '<p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"'
  + ' accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5"'
  + ' accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const MASTER_XML = `${XML_HEAD}<p:sldMaster ${NS_P}><p:cSld>${EMPTY_TREE}</p:cSld>${CLR_MAP}`
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

const LAYOUT_XML = `${XML_HEAD}<p:sldLayout ${NS_P} type="blank" preserve="1">`
  + `<p:cSld name="白紙">${EMPTY_TREE}</p:cSld></p:sldLayout>`;

const PRES_PROPS_XML = `${XML_HEAD}<p:presentationPr ${NS_P}/>`;

/**
 * 塊の列 → pptx の部品。⚠ zip には**しない**(呼び側の仕事)。
 */
export function buildPptx(
  blocks: readonly ExportBlock[],
  opts: { readonly title: string },
): PptxResult {
  const slides = splitIntoSlides(blocks, opts.title);
  const skipped = blocks.filter((b) => b.kind === 'skipped').length;
  const parts: PptxPart[] = [];

  // ① 入口
  parts.push({
    name: '[Content_Types].xml',
    text: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
      + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
      + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
      + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>'
      + slides.map((_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
      + '</Types>',
  });
  parts.push({
    name: '_rels/.rels',
    text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
      + '</Relationships>',
  });

  // ② 本体
  parts.push({
    name: 'ppt/presentation.xml',
    text: `${XML_HEAD}<p:presentation ${NS_P}>`
      + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
      + `<p:sldIdLst>${slides.map((_, i) =>
        `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst>`
      + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>`
      + `<p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/></p:presentation>`,
  });
  parts.push({
    name: 'ppt/_rels/presentation.xml.rels',
    text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
      + slides.map((_, i) =>
        `<Relationship Id="rId${i + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${slides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>`
      + '</Relationships>',
  });

  // ③ 型紙(1 枚ずつで足りる)
  parts.push({ name: 'ppt/slideMasters/slideMaster1.xml', text: MASTER_XML });
  parts.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
      + '</Relationships>',
  });
  parts.push({ name: 'ppt/slideLayouts/slideLayout1.xml', text: LAYOUT_XML });
  parts.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
      + '</Relationships>',
  });
  parts.push({ name: 'ppt/theme/theme1.xml', text: THEME_XML });
  parts.push({ name: 'ppt/presProps.xml', text: PRES_PROPS_XML });

  // ④ スライド
  slides.forEach((s, i) => {
    parts.push({ name: `ppt/slides/slide${i + 1}.xml`, text: slideXml(s) });
    parts.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        + '</Relationships>',
    });
  });

  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} 件は PowerPoint に入れていません(本文に理由を出しています)`);

  return {
    parts,
    warnings,
    counts: {
      blocks: blocks.length,
      slides: slides.length,
      sectionSlides: slides.filter((s) => s.kind === 'section').length,
      lines: slides.reduce((n, s) => n + s.lines.length, 0),
      skipped,
    },
  };
}
