/**
 * 🔴 **話者の一覧を本文に書く・読む**(#952 B4 話者分離 / B6 話者を後から直す)── pure。
 *
 * 結果は録ったもののノートの本文に、見出しつきの 2 つの節として足す(別の保存形式を作らない。**本文が正本**):
 *
 * ```
 * ## 話者 2026-10-25 10:30
 * 0:00 話者A
 * 0:12 話者B
 *
 * ## 話者つき文字起こし 2026-10-25 10:30
 * 0:15 話者A: 今日は晴れです
 * ```
 *
 * - 「## 話者」の行は**話者が替わる時刻 + 名前**(次の行まで同じ話者)。行頭の時刻は文字起こしと同じ綴りなので、押すとその位置から再生する
 * - 名前は自由に書き換えられる(「田中」「話者A」など)。**同じ名前の行は同じ人**として扱う(2 人に分かれた 1 人は、名前を揃えれば 1 人になる)
 * - 「## 話者つき文字起こし」は、文字起こしの各行に、その時刻に話していた人を添えた物(文字起こしがあるときだけ作る)
 *
 * ⚠ 「話者」で始まる見出しだけを話者の節として読む(`## 話者` と `## 話者つき文字起こし`)。文字起こしの節には触れない。
 */
import { ELAPSED_LINE_HEAD, elapsedText, parseElapsed } from '../elapsed-text';
import type { SpeakerTurn } from '../audio/diarize';
import type { TimedLine } from './contact-sheet-layout';

const two = (n: number): string => String(n).padStart(2, '0');
const stamp = (at: Date): string =>
  `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;

/** 0 始まりの番号 → 「話者A」「話者B」…(27 人目以降は「話者27」)。 */
export function speakerName(index: number): string {
  return index < 26 ? `話者${String.fromCharCode(65 + index)}` : `話者${String(index + 1)}`;
}

export const SPEAKERS_HEADING_WORD = '話者';
export const SPEAKER_TRANSCRIPT_WORD = '話者つき文字起こし';

export const speakersHeading = (at: Date): string => `## ${SPEAKERS_HEADING_WORD} ${stamp(at)}`;
export const speakerTranscriptHeading = (at: Date): string => `## ${SPEAKER_TRANSCRIPT_WORD} ${stamp(at)}`;

/** 話者が替わる所だけを行にする(同じ話者が続く行は 1 行にまとめる)。 */
export function speakersText(turns: readonly SpeakerTurn[]): string {
  const lines: string[] = [];
  let prev = -1;
  for (const t of turns) {
    if (t.speaker === prev) continue;
    lines.push(`${elapsedText(t.startMs)} ${speakerName(t.speaker)}`);
    prev = t.speaker;
  }
  return lines.join('\n');
}

export interface NamedTurn {
  readonly ms: number;
  readonly name: string;
}

/** `ms` に話していた人(それ以前で最後の行の名前)。最初の行より前は `null`。`turns` は昇順。 */
export function speakerAt(turns: readonly NamedTurn[], ms: number): string | null {
  let name: string | null = null;
  for (const t of turns) {
    if (t.ms > ms) break;
    name = t.name;
  }
  return name;
}

/** 文字起こしの各行に話者を添える。行が無ければ `null`(節を作らない)。最初の話者より前の行は名前を付けない。 */
export function speakerTranscript(turns: readonly NamedTurn[], lines: readonly TimedLine[]): string | null {
  if (lines.length === 0) return null;
  return lines
    .map((l) => {
      const who = speakerAt(turns, l.ms);
      return `${elapsedText(l.ms)} ${who === null ? '' : `${who}: `}${l.text}`;
    })
    .join('\n');
}

/** 話者の節の見出しか(`## 話者` 単独、または `## 話者 日時`。`## 話者つき文字起こし` は別)。 */
export const isSpeakersHeading = (line: string): boolean => /^## 話者(?:\s.*)?$/.test(line.trimEnd());
export const isSpeakerTranscriptHeading = (line: string): boolean => /^## 話者つき文字起こし(?:\s.*)?$/.test(line.trimEnd());

export interface SectionSpan {
  /** 見出し行の番号(0 始まり)。 */
  readonly head: number;
  /** 次の見出しの行(または末尾)。 */
  readonly end: number;
}

/** 最後に出てくる、`isHead` に合う見出しの節。無ければ `null`。見出しは `#` 1〜6 個の行。 */
export function lastSection(lines: readonly string[], isHead: (line: string) => boolean): SectionSpan | null {
  let found: SectionSpan | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isHead(lines[i]!)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{1,6} /.test(lines[j]!)) {
        end = j;
        break;
      }
    }
    found = { head: i, end };
  }
  return found;
}

/** 本文の「## 話者」の節(最後のもの)から、時刻つきの行を読む。節が無い / 行が 0 件なら `null`。 */
export function readSpeakerTurns(body: string): NamedTurn[] | null {
  const lines = body.split('\n');
  const sec = lastSection(lines, isSpeakersHeading);
  if (sec === null) return null;
  const turns: NamedTurn[] = [];
  for (let i = sec.head + 1; i < sec.end; i += 1) {
    const m = ELAPSED_LINE_HEAD.exec(lines[i]!.trimEnd());
    if (m === null) continue;
    const ms = parseElapsed(m[1]!);
    const name = lines[i]!.slice(m[0].length).trim();
    if (ms !== null && name !== '') turns.push({ ms, name });
  }
  return turns.length === 0 ? null : turns.sort((a, b) => a.ms - b.ms);
}

/** 名前の付け替え(`話者A=田中`)。空白・全角の `＝` / 読点 / 改行区切りを受ける。読めない部分は捨てる。 */
export function parseRenames(text: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const part of text.split(/[,、，\n;；]/)) {
    const m = /^\s*(.+?)\s*[=＝]\s*(.+?)\s*$/.exec(part);
    if (m !== null && m[1] !== m[2]) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/** 名前を付け替える(同じ行き先の名前は 1 人にまとまる)。付け替えが連鎖しない(A→B, B→C は 1 回ずつ)。 */
export function renameTurns(turns: readonly NamedTurn[], renames: ReadonlyArray<readonly [string, string]>): NamedTurn[] {
  const map = new Map(renames);
  return turns.map((t) => ({ ms: t.ms, name: map.get(t.name) ?? t.name }));
}

/** 同じ話者が続く行をまとめて、節の本文(時刻 + 名前の行)にする。 */
export function namedTurnsText(turns: readonly NamedTurn[]): string {
  const lines: string[] = [];
  let prev: string | null = null;
  for (const t of turns) {
    if (t.name === prev) continue;
    lines.push(`${elapsedText(t.ms)} ${t.name}`);
    prev = t.name;
  }
  return lines.join('\n');
}

/** 話者を直した回の知らせ。 */
export function speakersFixNotice(renamed: number, transcriptLines: number): string {
  const head = renamed > 0 ? `話者の名前を ${String(renamed)} 件直しました` : '話者の一覧は変わりませんでした';
  return transcriptLines > 0 ? `${head}(話者つき文字起こしを ${String(transcriptLines)} 行で作り直しました)` : head;
}

export interface FixResult {
  readonly body: string;
  /** 話者の名前を替えた行の数(統合で消えた行は数えない)。 */
  readonly renamed: number;
  /** 作り直した「話者つき文字起こし」の行数(0 = 文字起こしが無くて作っていない)。 */
  readonly transcriptLines: number;
}

/**
 * 🔴 **話者を直す**(B6)── 本文の「## 話者」の節を読み直して名前を付け替え、「## 話者つき文字起こし」を作り直した本文を返す。
 *
 * - 「## 話者」の節: 行ごとの名前を `renames` で替える(**本文の他の部分は 1 文字も変えない**)。同じ人が続く行はまとめる
 * - 「## 話者つき文字起こし」: 文字起こしの行(`lines`)に、直したあとの話者を添えて**同じ節を置き換える**(無ければ末尾に足す)。
 *   `lines` が空なら触らない
 * - 話者の節が無い・読めない本文は `null`(呼び手が理由を言う)
 * ⚠ 本文を直接書き換えるので、呼び手は書く直前に読んだ本文を渡し、その本文と一致するときだけ書く(`REQUEST_BODY_REWRITE` の門)。
 */
export function fixSpeakers(
  body: string,
  renames: ReadonlyArray<readonly [string, string]>,
  lines: readonly TimedLine[],
  headingAt: Date,
): FixResult | null {
  const turns = readSpeakerTurns(body);
  if (turns === null) return null;
  const all = body.split('\n');
  const sec = lastSection(all, isSpeakersHeading)!;
  const fixed = renameTurns(turns, renames);
  const renamed = fixed.filter((t, i) => t.name !== turns[i]!.name).length;
  const turnText = namedTurnsText(fixed);
  // 見出しの行はそのまま、中身だけを置き換える(節の中の読めない行・注釈は捨てない:時刻つきの行だけを差し替える)
  const keep = all.slice(sec.head + 1, sec.end).filter((l) => {
    const m = ELAPSED_LINE_HEAD.exec(l.trimEnd());
    return !(m !== null && parseElapsed(m[1]!) !== null);
  });
  // 節の終わりの空行は、数えて元のとおり戻す(次の節との間・末尾の改行を変えない)
  let trailing = 0;
  for (let j = sec.end - 1; j > sec.head && all[j]!.trim() === ''; j -= 1) trailing += 1;
  const sectionLines = [
    all[sec.head]!,
    ...turnText.split('\n'),
    ...keep.filter((l) => l.trim() !== ''),
    ...Array.from({ length: trailing }, () => ''),
  ];
  let next = [...all.slice(0, sec.head), ...sectionLines, ...all.slice(sec.end)];
  let transcriptLines = 0;
  const text = speakerTranscript(fixed, lines);
  if (text !== null) {
    transcriptLines = lines.length;
    const old = lastSection(next, isSpeakerTranscriptHeading);
    const block = [speakerTranscriptHeading(headingAt), ...text.split('\n')];
    if (old !== null) {
      next = [...next.slice(0, old.head), ...block, ...(old.end < next.length ? ['', ...next.slice(old.end)] : [])];
    } else {
      next = [...next.filter((_, i, a) => !(i === a.length - 1 && a[i] === '')), '', ...block, ''];
    }
  }
  return { body: next.join('\n'), renamed, transcriptLines };
}
