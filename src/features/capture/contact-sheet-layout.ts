/**
 * 🔴 **コンタクトシートの割り付け**(#952 A5)── 場面ごとの静止画と、その場面の文字起こしを 1 枚に並べる。
 *
 * 絵を描く所(OffscreenCanvas・復号)は adapter 側(`platform/video/contact-sheet.ts`)。ここは**どこに何を置くか**だけを
 * 決める pure module(`features/` 層。browser API を持たない)── 数字の根拠が 1 か所で、単体で確かめられる。
 */
import { ELAPSED_LINE_HEAD, parseElapsed } from '../elapsed-text';

export const SHEET = {
  /** 1 行に並べる数。 */
  cols: 3,
  /** 絵の幅(px)。 */
  thumbW: 320,
  margin: 16,
  gap: 12,
  /** 絵の下の「時刻 + 文字」の欄の高さ(px)。 */
  captionH: 76,
  /** 1 枚に載せる場面の上限(これを超えたら均等に間引く)。 */
  maxScenes: 24,
  /** 見出しの高さ。 */
  titleH: 32,
  fontPx: 13,
  lineH: 17,
  /** 欄に載せる文字の行数の上限(1 行目は時刻)。 */
  captionLines: 4,
} as const;

export interface SheetCell {
  /** 絵の左上と大きさ。 */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 欄の左上(絵の真下)。 */
  readonly captionX: number;
  readonly captionY: number;
}

export interface SheetLayout {
  readonly width: number;
  readonly height: number;
  readonly cells: readonly SheetCell[];
}

/** 絵の縦横比(幅 / 高さ)から割り付ける。⚠ 場面が 0 件なら呼ばない。 */
export function layoutSheet(count: number, aspect: number): SheetLayout {
  const cols = Math.min(SHEET.cols, Math.max(1, count));
  const thumbH = Math.max(1, Math.round(SHEET.thumbW / (aspect > 0 ? aspect : 16 / 9)));
  const rows = Math.ceil(count / cols);
  const cellH = thumbH + SHEET.captionH;
  const width = SHEET.margin * 2 + cols * SHEET.thumbW + (cols - 1) * SHEET.gap;
  const height = SHEET.margin * 2 + SHEET.titleH + rows * cellH + (rows - 1) * SHEET.gap;
  const cells: SheetCell[] = [];
  for (let i = 0; i < count; i += 1) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = SHEET.margin + c * (SHEET.thumbW + SHEET.gap);
    const y = SHEET.margin + SHEET.titleH + r * (cellH + SHEET.gap);
    cells.push({ x, y, w: SHEET.thumbW, h: thumbH, captionX: x, captionY: y + thumbH + 4 });
  }
  return { width, height, cells };
}

/** 場面の頭の一覧が上限を超えるとき、先頭と末尾を残して均等に間引く。昇順を保つ。 */
export function selectScenes(starts: readonly number[], max: number = SHEET.maxScenes): number[] {
  if (starts.length <= max) return [...starts];
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) out.push(starts[Math.round((i * (starts.length - 1)) / (max - 1))]!);
  return [...new Set(out)];
}

/** 場面が刻めない動画(動きが少ない)でも 1 枚だけにならないよう、長さを均等に割った時刻を使う。 */
export function evenStarts(durationMs: number, n: number): number[] {
  if (n <= 1 || durationMs <= 0) return [0];
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(Math.floor((durationMs * i) / n));
  return out;
}

export interface TimedLine {
  readonly ms: number;
  readonly text: string;
}

/** 「チャプター 3」などの、文字起こしではない時刻つきの行。 */
const NOT_TRANSCRIPT = /^(?:チャプター \d+|話者\S*)$/;

/**
 * ノートの本文から、時刻つきの文字起こしの行を拾う(文字起こしと同じ読み方 = `ELAPSED_LINE_HEAD` + `parseElapsed`)。
 * 「## 話者」「## チャプター」の行(時刻 + 名前だけ)は文字起こしではないので除く。
 */
export function transcriptLinesOf(body: string): TimedLine[] {
  const out: TimedLine[] = [];
  for (const line of body.split('\n')) {
    const m = ELAPSED_LINE_HEAD.exec(line.trimEnd());
    if (m === null) continue;
    const ms = parseElapsed(m[1]!);
    if (ms === null) continue;
    const text = line.slice(m[0].length).trim();
    if (text === '' || NOT_TRANSCRIPT.test(text)) continue;
    out.push({ ms, text });
  }
  return out;
}

/** 場面 `i`(`starts[i]` 以上 `starts[i+1]` 未満)の文字起こしを 1 本につなぐ。 */
export function sceneText(starts: readonly number[], i: number, lines: readonly TimedLine[]): string {
  const from = starts[i]!;
  const to = i + 1 < starts.length ? starts[i + 1]! : Number.POSITIVE_INFINITY;
  return lines
    .filter((l) => l.ms >= from && l.ms < to)
    .map((l) => l.text)
    .join(' ');
}

/**
 * 幅に合わせて折る(1 文字ずつ測る ── 日本語にも英単語にも使える)。`maxLines` を超える分は最後の行を「…」で切る。
 * `measure` は描く側の文字幅(canvas の `measureText`)。
 */
export function wrapByWidth(text: string, maxWidth: number, measure: (s: string) => number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let truncated = false;
  for (const ch of text) {
    if (measure(cur + ch) > maxWidth && cur !== '') {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    } else {
      cur += ch;
    }
  }
  if (!truncated && cur !== '') lines.push(cur);
  if (truncated) {
    let last = lines[maxLines - 1] ?? '';
    while (last !== '' && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}
