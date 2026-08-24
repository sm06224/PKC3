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

import type { DocxBlock, DocxCell, DocxRun } from './docx';
import { xmlEscape } from './docx';

/**
 * 🔑 **塊の列は形式に依らない**(見出し・段落・箇条書き・表・画像・写せなかったもの)。
 * ⚠ 型の名前が `Docx…` なのは docx が先に作ったからで、**中身は共通**である。
 * ここでは読む側の名前で呼ぶ ── 型を 2 つに割ると、片方だけ直す事故が起きる。
 */
export type ExportBlock = DocxBlock;
export type ExportRun = DocxRun;
export type ExportCell = DocxCell;

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
    readonly links: number;
    readonly images: number;
    readonly tables: number;
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
  /**
   * 🔴 **扉に落ちた本文の置き場**(#187、2026-08-24 に足した)。
   * ⚠ これが無かった間、`# 章` の直後に書いた本文と画像は
   * **生成物から黙って消えていた**(下の `slideXml` の注意)。
   */
  coverBody: { x: inch(0.9), y: inch(5.2), w: inch(11.5), h: inch(1.5) },
  /** 本文スライドの題名帯と本文。 */
  title: { x: inch(0.6), y: inch(0.4), w: inch(12.1), h: inch(0.9) },
  body: { x: inch(0.6), y: inch(1.5), w: inch(12.1), h: inch(5.1) },
} as const;

/** 文字の大きさ(1/100 pt。OOXML の `sz` は 100 倍)。 */
const SZ = { coverTitle: 4400, coverSubtitle: 2400, title: 3200, body: 1800, cell: 1400 } as const;

/** px → EMU。⚠ 96dpi の px なら 9525 倍(docx と同じ換算)。 */
const EMU_PER_PX = 9525;

/** 箇条書きの深さの上限。⚠ 超えた分は最深に丸める(行ごと落とさない)。 */
export const PPTX_LIST_DEPTH_MAX = 8;

/**
 * 🔴 **自分の箱を持つもの**(#187 段③)。
 *
 * 本文の文字は 1 つの箱に流し込めるが、**表と画像は位置と大きさが要る** ──
 * docx(本文の流れ)との一番大きな違いがここである(設計 doc §5)。
 */
export type SlideBox =
  | { readonly kind: 'table'; readonly rows: readonly (readonly ExportCell[])[] }
  | {
      readonly kind: 'image';
      readonly media: string;
      readonly widthPx: number;
      readonly heightPx: number;
      readonly alt: string;
    };

/** スライド 1 枚の下書き。 */
export interface SlideDraft {
  readonly kind: 'section' | 'content';
  title: string;
  subtitle?: string;
  readonly lines: SlideLine[];
  /** 🔴 自分の箱を持つもの(表・画像)。⚠ 本文の下に縦に積む。 */
  readonly boxes: SlideBox[];
}

/** スライドの本文 1 行。 */
export interface SlideLine {
  readonly runs: readonly ExportRun[];
  /** 箇条書きの深さ(0 起点)。⚠ `null` は箇条書きでない。 */
  readonly bullet: number | null;
  /**
   * 🔴 **番号付きか**(#187 段②)。⚠ `bullet` が `null` でないときだけ意味を持つ。
   * ⚠ これを落とすと `1. 2. 3.` が**ただの点**になる ── user が書いた「順番」が消える。
   */
  readonly ordered?: boolean;
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
      current = { kind: 'content', title: fallbackTitle, lines: [], boxes: [] };
      slides.push(current);
    }
    return current;
  };
  // ⚠ 代入を**呼び側**で書く ── クロージャの中で代入すると、TS の絞り込みが
  //    `current` を `never` まで狭めて型が壊れる(実際に踏んだ)
  const open = (kind: 'section' | 'content', title: string): SlideDraft => {
    const s: SlideDraft = { kind, title, lines: [], boxes: [] };
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
    // 🔴 表と画像は**自分の箱**を持つ(段③)── 本文の行に潰さない
    if (b.kind === 'table') { ensure().boxes.push({ kind: 'table', rows: b.rows }); continue; }
    if (b.kind === 'image') {
      // ⚠ 実寸が取れていないものは箱にしない ── 縦横比が計算できないので、
      //    黙って潰さず**理由を本文に出す**(PKC2 は 480×360 に潰していた)
      if (b.widthPx > 0 && b.heightPx > 0) {
        ensure().boxes.push({
          kind: 'image', media: b.media, widthPx: b.widthPx, heightPx: b.heightPx, alt: b.alt,
        });
      } else {
        ensure().lines.push({
          runs: [{ text: `[画像: ${b.alt !== '' ? b.alt : b.media}(大きさが分からないので入れていません)]`, italic: true }],
          bullet: null,
        });
      }
      continue;
    }
    for (const line of blockToLines(b)) ensure().lines.push(line);
  }
  if (slides.length === 0) open('content', fallbackTitle);
  /**
   * 🔴 **中身が 1 つも無いスライドは畳む**(#187 段④)。
   *
   * ⚠ これは設計 doc §3「切れ方は PKC2 と同じ」から**わざと外した 1 点**である。
   * PKC2 も畳んでいない(`export-pptx.ts` の `splitIntoSlides` は `break` で必ず
   * push し、空を落とす処理が無い)が、markdown では **`---` を見出しの前に置くのが
   * ごく普通**なので、user の手元では**書くたびに白い紙が挟まる**。
   *
   * 🔑 畳んでも**書いたものは 1 文字も失われない** ── 題名も本文も箱も無い、
   *   つまり中身を 1 つも運んでいないスライドだけが対象である。
   * ⚠ 全部畳まれても **1 枚は残す**(0 枚の pptx は開けない)。
   */
  const kept = slides.filter((s) =>
    s.title !== '' || s.subtitle !== undefined || s.lines.length > 0 || s.boxes.length > 0);
  return kept.length > 0 ? kept : slides.slice(0, 1);
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
      return [{
        runs: b.runs,
        bullet: Math.min(b.depth, PPTX_LIST_DEPTH_MAX - 1),
        ...(b.ordered ? { ordered: true } : {}),
      }];
    case 'quote':
      return [{ runs: b.runs.map((r) => ({ ...r, italic: true })), bullet: null }];
    case 'code':
      // ⚠ 1 行ずつ ── 塊のまま渡すと改行が消える
      return b.text.split('\n').map((t) => ({ runs: [{ text: t }], bullet: null, mono: true }));
    // ⚠ `table` / `image` はここへ来ない ── `splitIntoSlides` が**箱**へ回す(段③)
    case 'skipped':
      return [{ runs: [{ text: `[${b.what}: ${b.why}]`, italic: true }], bullet: null }];
    default:
      return [];
  }
}

/**
 * 走り 1 本 → `<a:r>`(#187 段②)。
 *
 * 🔴 **リンクは rels の id が要る** ── `<a:hlinkClick r:id="rIdN"/>` は
 * **そのスライドの rels** に実体が無いと PowerPoint が file ごと拒む。
 * だから id を配るのは呼び側で、ここは**渡された id を書くだけ**にする。
 * ⚠ id が渡されていないリンクは**素の文字として出す**(消さない)。
 */
function runXml(r: ExportRun, sz: number, linkId?: string): string {
  const props: string[] = [`lang="ja-JP"`, `sz="${sz}"`];
  if (r.bold === true) props.push('b="1"');
  if (r.italic === true) props.push('i="1"');
  if (r.strike === true) props.push('strike="sngStrike"');
  const face = r.mono === true
    ? '<a:latin typeface="Consolas"/><a:ea typeface="Consolas"/>'
    : '';
  const link = linkId === undefined ? '' : `<a:hlinkClick r:id="${linkId}"/>`;
  return `<a:r><a:rPr ${props.join(' ')} dirty="0">${face}${link}</a:rPr>`
    + `<a:t>${xmlEscape(r.text)}</a:t></a:r>`;
}

/**
 * 本文の 1 行 → `<a:p>`。
 *
 * ⚠ **番号付きは `buAutoNum`、点は `buChar`** ── どちらも書かないと、PowerPoint は
 * 型紙の既定に従う(= 見た目が揃わない)。
 * ⚠ 箇条書きでない行には **`buNone`** を明示する ── 書かないと点が勝手に付く。
 */
function lineXml(line: SlideLine, sz: number, linkOf?: (r: ExportRun) => string | undefined): string {
  const runs = line.runs.length === 0 ? [{ text: '' } as ExportRun] : line.runs;
  const pPr = line.bullet === null
    ? '<a:pPr><a:buNone/></a:pPr>'
    : `<a:pPr lvl="${line.bullet}">`
      + (line.ordered === true
        ? '<a:buAutoNum type="arabicPeriod"/>'
        : '<a:buChar char="\u2022"/>')
      + '</a:pPr>';
  const eff = line.mono === true ? runs.map((r) => ({ ...r, mono: true })) : runs;
  return `<a:p>${pPr}${eff.map((r) => runXml(r, sz, linkOf?.(r))).join('')}</a:p>`;
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

/**
 * 画像の種類。⚠ **ここに無い拡張子は `application/octet-stream`** で宣言する ──
 * 落とすより「種類が分からない物」として渡すほうがまし(黙って消さない)。
 */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  /**
   * 🔴 **図はベクタ(EMF)で入る**(#238。#187 段⑤ で pptx にも回ってきた)。
   * ⚠ これを落とすと `application/octet-stream` で宣言され、PowerPoint は
   *   種類が分からず**図を出さない**(docx 側は `image/x-emf` で宣言済み)。
   */
  emf: 'image/x-emf',
};

/** 使った画像の拡張子(小文字・重複なし)。 */
function mediaExts(slides: readonly SlideDraft[]): string[] {
  const out = new Set<string>();
  for (const s of slides) {
    for (const b of s.boxes) {
      if (b.kind !== 'image') continue;
      const i = b.media.lastIndexOf('.');
      if (i >= 0) out.add(b.media.slice(i + 1).toLowerCase());
    }
  }
  return [...out];
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** そのスライドが要る関係(リンク / 画像)。⚠ 採番は 1 か所で持つ。 */
interface SlideRel { kind: 'hyperlink' | 'image'; target: string }

/** 箱を置く矩形(EMU)。 */
interface Rect { x: number; y: number; w: number; h: number }

/** 1 pt = 12700 EMU。 */
const EMU_PER_PT = 12700;
/** 本文 1 行の高さ。⚠ 行送りは字の 1.4 倍(見出しではないので詰めすぎない)。 */
const LINE_H = Math.round((SZ.body / 100) * 1.4 * EMU_PER_PT);
/** 表 1 行の高さ。⚠ セルの余白ぶんを見込んで字の 1.9 倍。 */
const ROW_H = Math.round((SZ.cell / 100) * 1.9 * EMU_PER_PT);
/** 積んだ物の間の余白。 */
const GAP = inch(0.15);

/**
 * 🔴 **その物が「素のままなら」欲しがる高さ**(#187 段④)。
 *
 * ⚠ 段③ は等分だったので、**1 行しか本文が無くても枠の 1/3 を取っていた**
 * (焼いて目で見て分かった)。⚠ 中身の量で配れば、余りは下の空きになる。
 */
function naturalH(b: SlideBox, w: number): number {
  if (b.kind === 'table') return Math.max(1, b.rows.length) * ROW_H;
  const wEmu = b.widthPx * EMU_PER_PX;
  const hEmu = b.heightPx * EMU_PER_PX;
  // ⚠ 幅にだけ合わせたときの高さ(縦は `fit` が改めて見る)
  return Math.max(1, Math.round(hEmu * Math.min(1, w / wEmu)));
}

/**
 * 🔴 **本文と箱を、本文の枠に縦へ積む**(#187 段③、配り方は段④)。
 *
 * ⚠ **重ならないことを保証する** ── 重なると下の物が読めなくなり、
 * user から見ると「消えた」のと同じである。
 * 🔑 欲しがる高さのまま置き、**収まらないときだけ全部を同じ率で縮める**
 *   (順番も比も変えない)。⚠ 余ったら**引き伸ばさず**、群ごと縦の中央へ置く。
 */
function stack(frame: Rect, wants: readonly number[]): Rect[] {
  const n = wants.length;
  if (n === 0) return [];
  const gaps = GAP * (n - 1);
  const avail = Math.max(1, frame.h - gaps);
  const sum = wants.reduce((a, b) => a + b, 0);
  const k = sum > avail ? avail / sum : 1;
  const hs = wants.map((want) => Math.max(1, Math.floor(want * k)));
  const used = hs.reduce((a, b) => a + b, 0) + gaps;
  let y = frame.y + Math.max(0, Math.floor((frame.h - used) / 2));
  const out: Rect[] = [];
  for (const h of hs) { out.push({ x: frame.x, y, w: frame.w, h }); y += h + GAP; }
  return out;
}

/** 本文と箱の置き場所を決める。⚠ 箱が無いときは本文が枠を丸ごと使う。 */
function layout(
  frame: Rect,
  lineCount: number,
  boxes: readonly SlideBox[],
): { text: Rect | null; boxes: Rect[] } {
  const hasText = lineCount > 0;
  if (boxes.length === 0) return { text: hasText ? frame : null, boxes: [] };
  const wants = [
    ...(hasText ? [Math.max(1, lineCount) * LINE_H] : []),
    ...boxes.map((b) => naturalH(b, frame.w)),
  ];
  const rects = stack(frame, wants);
  return hasText
    ? { text: rects[0]!, boxes: rects.slice(1) }
    : { text: null, boxes: rects };
}

/**
 * 🔴 **縦横比を保って枠に収める**(#187 段③)。
 *
 * ⚠ **PKC2 は全画像を 480×360 px に潰していた**(doc にもコメントにも記録が無く、
 * 調査で初めて分かった)。⚠ 同じことを繰り返さない ── 枠に対して**縮めるだけ**で、
 * 引き伸ばさず、比を変えない。中央に置く。
 */
function fit(box: Rect, widthPx: number, heightPx: number): Rect {
  const wEmu = widthPx * EMU_PER_PX;
  const hEmu = heightPx * EMU_PER_PX;
  // ⚠ 大きいときだけ縮める(小さい画像を引き伸ばして粗くしない)
  const scale = Math.min(1, box.w / wEmu, box.h / hEmu);
  const w = Math.round(wEmu * scale);
  const h = Math.round(hEmu * scale);
  return { x: box.x + Math.round((box.w - w) / 2), y: box.y + Math.round((box.h - h) / 2), w, h };
}

/**
 * 🔴 **字の見た目の幅**(#187 段④)。⚠ 全角を 2、半角を 1 と数える。
 * 正確さは要らない ── **列の取り分の重み**として使うだけである。
 */
function visualWidth(runs: readonly ExportRun[]): number {
  let n = 0;
  for (const r of runs) {
    for (const ch of r.text) n += /[\u0020-\u007e\uff61-\uff9f]/.test(ch) ? 1 : 2;
  }
  return n;
}

/** 列の重みの下限と上限。⚠ 下限が無いと空の列が潰れ、上限が無いと長い列が他を飢えさせる。 */
const COL_W_MIN = 4;
const COL_W_MAX = 30;

/**
 * 🔴 **列の取り分を中身の量で配る**(#187 段④)。
 * ⚠ 段③ は等幅だったので、「項目 / 長い説明」の表で説明が細い列に押し込まれていた。
 * 🔑 **合計は必ず `total` ちょうど**にする(最後の列で端数を吸う)── 端数が余ると
 *   表が枠より細くなり、右端が揃わない。
 */
function colWidths(rows: readonly (readonly ExportCell[])[], cols: number, total: number): number[] {
  const weights = Array.from({ length: cols }, (_, i) => {
    const w = rows.reduce((m, r) => {
      const c = r[i];
      return Math.max(m, c === undefined ? 0 : visualWidth(c.runs));
    }, 0);
    return Math.min(COL_W_MAX, Math.max(COL_W_MIN, w));
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let used = 0;
  for (let i = 0; i < cols; i += 1) {
    const w = i === cols - 1 ? total - used : Math.floor((total * weights[i]!) / sum);
    out.push(w);
    used += w;
  }
  return out;
}

/** 表 1 つ → `<p:graphicFrame>`。 */
function tableXml(id: number, rect: Rect, rows: readonly (readonly ExportCell[])[]): string {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  if (cols === 0 || rows.length === 0) return '';
  const rowH = Math.floor(rect.h / rows.length);
  const grid = colWidths(rows, cols, rect.w).map((w) => `<a:gridCol w="${w}"/>`).join('');
  const body = rows.map((row) => {
    // ⚠ 欠けた列は空セルで埋める(行ごとに列数が違うと PowerPoint が拒む)
    const cells = Array.from({ length: cols }, (_, i) => row[i]);
    return `<a:tr h="${rowH}">` + cells.map((c) => {
      const runs = c === undefined ? [] : c.runs;
      const head = c?.header === true;
      const line: SlideLine = {
        runs: head ? runs.map((r) => ({ ...r, bold: true })) : runs,
        bullet: null,
      };
      return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>'
        + lineXml(line, SZ.cell) + '</a:txBody><a:tcPr/></a:tc>';
    }).join('') + '</a:tr>';
  }).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="表"/>`
    + '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
    + `<p:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.w}" cy="${rect.h}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
    // ⚠ `tableStyleId` は書かない ── 指す先(`tableStyles.xml`)を出していないので、
    //    書くと「宣言したのに実在しない」になる
    + `<a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl>`
    + '</a:graphicData></a:graphic></p:graphicFrame>';
}

/** 画像 1 つ → `<p:pic>`。⚠ `r:embed` はそのスライドの rels に実体が要る。 */
function picXml(id: number, rect: Rect, relId: string, alt: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="画像" descr="${xmlEscape(alt)}"/>`
    + '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
    + `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.w}" cy="${rect.h}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}

/**
 * スライド 1 枚の XML と、そこで使ったリンクの一覧。
 *
 * 🔴 **リンクは rels と対で作る** ── `r:id` を書いても、そのスライドの rels に
 * 実体が無ければ PowerPoint は file ごと拒む。だから**同じ関数で両方**を返す
 * (2 か所で別々に組むと、片方だけ直す事故が起きる ── CLAUDE.md §7)。
 * ⚠ 同じ URL は 1 つの id に畳む(rels を無駄に増やさない)。
 */
function slideXml(s: SlideDraft): { xml: string; rels: SlideRel[] } {
  // ⚠ rId1 は型紙(slideLayout)なので、ここは **rId2 から**。
  //    🔑 リンクと画像で**同じ採番**を使う ── 別々に数えると衝突する
  const rels: SlideRel[] = [];
  const relFor = (kind: SlideRel['kind'], target: string): string => {
    const i = rels.findIndex((x) => x.kind === kind && x.target === target);
    if (i >= 0) return `rId${i + 2}`;
    rels.push({ kind, target });
    return `rId${rels.length + 1}`;
  };
  const linkOf = (r: ExportRun): string | undefined =>
    r.href === undefined || r.href === '' ? undefined : relFor('hyperlink', r.href);
  const shapes: string[] = [];
  /**
   * 箱(表・画像)を置く。⚠ **扉でも本文でも同じ手** ── 2 か所に書くと片方だけ直す。
   * @param first 図形の id の始まり。⚠ 重複した id は PowerPoint が拒む
   */
  const putBoxes = (rects: readonly Rect[], first: number): void => {
    s.boxes.forEach((b, i) => {
      const rect = rects[i]!;
      if (b.kind === 'table') shapes.push(tableXml(first + i, rect, b.rows));
      else {
        shapes.push(picXml(
          first + i, fit(rect, b.widthPx, b.heightPx), relFor('image', b.media), b.alt,
        ));
      }
    });
  };
  if (s.kind === 'section') {
    shapes.push(textBox(2, '題名', FRAME.coverTitle,
      lineXml({ runs: [{ text: s.title, bold: true }], bullet: null }, SZ.coverTitle), 'ctr'));
    if (s.subtitle !== undefined) {
      shapes.push(textBox(3, '副題', FRAME.coverSubtitle,
        lineXml({ runs: [{ text: s.subtitle }], bullet: null }, SZ.coverSubtitle), 'ctr'));
    }
    /**
     * 🔴 **扉に落ちた本文と箱も出す**(2026-08-24)。
     *
     * ⚠ **ここが無い間、`# 章` の直後に書いた本文・表・画像は生成物から
     *   黙って消えていた。** 切り分けの側(`splitIntoSlides`)は正しく
     *   扉の `lines` / `boxes` に入れていたが、**描く側が見ていなかった**。
     * ⚠ そして test は**下書き**(`slides[0].lines`)を見ていたので緑のままだった
     *   ── 「扉に落ちた段落は扉の本文になる(捨てない)」と書いてあったのに、
     *   出力では捨てていた(CLAUDE.md §4「観測点の選び方」)。
     */
    const lay = layout(FRAME.coverBody, s.lines.length, s.boxes);
    if (lay.text !== null) {
      shapes.push(textBox(4, '本文', lay.text,
        s.lines.map((l) => lineXml(l, SZ.body, linkOf)).join(''), 't'));
    }
    putBoxes(lay.boxes, 5);
  } else {
    if (s.title !== '') {
      shapes.push(textBox(2, '題名', FRAME.title,
        lineXml({ runs: [{ text: s.title, bold: true }], bullet: null }, SZ.title), 'ctr'));
    }
    // 🔴 本文と箱を、本文の枠に**縦へ積む**(重ならないことを保証する)
    const lay = layout(FRAME.body, s.lines.length, s.boxes);
    if (lay.text !== null) {
      shapes.push(textBox(3, '本文', lay.text,
        s.lines.map((l) => lineXml(l, SZ.body, linkOf)).join(''), 't'));
    }
    // ⚠ id は 4 から(2 = 題名 / 3 = 本文)── 重複した id は PowerPoint が拒む
    putBoxes(lay.boxes, 4);
  }
  const xml = `${XML_HEAD}<p:sld ${NS_P}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr/>'
    + `${shapes.join('')}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"'
    + ' accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4"'
    + ' accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>'
    + '</p:sld>';
  return { xml, rels };
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
      /**
       * 🔴 **画像の拡張子を宣言する**(#187 段③)。⚠ 宣言が無いと PowerPoint は
       * その部品の種類を決められず、**file ごと拒む**。
       * 🔑 実際に使った拡張子だけ書く(使っていない種類を宣言しない)。
       */
      + mediaExts(slides).map((e) =>
        `<Default Extension="${e}" ContentType="${MEDIA_TYPES[e] ?? 'application/octet-stream'}"/>`).join('')
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
  let links = 0;
  let images = 0;
  slides.forEach((s, i) => {
    const built = slideXml(s);
    links += built.rels.filter((x) => x.kind === 'hyperlink').length;
    images += built.rels.filter((x) => x.kind === 'image').length;
    parts.push({ name: `ppt/slides/slide${i + 1}.xml`, text: built.xml });
    parts.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        + built.rels.map((rel, k) => {
          const id = `rId${k + 2}`;
          // ⚠ **外部リンクは `TargetMode="External"`** ── 付けないと PowerPoint は
          //    package の中の部品を探し、見つからずに file ごと拒む
          if (rel.kind === 'hyperlink') {
            return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"`
              + ` Target="${xmlEscape(rel.target)}" TargetMode="External"/>`;
          }
          // ⚠ 画像は **package の中**を指す(`../media/...`)── bytes を入れるのは呼び側
          return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"`
            + ` Target="../${xmlEscape(rel.target)}"/>`;
        }).join('')
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
      links,
      images,
      tables: slides.reduce((n, s) => n + s.boxes.filter((b) => b.kind === 'table').length, 0),
      skipped,
    },
  };
}
