/**
 * 🔴 **切り出した音に、範囲にかかる文字起こしの行だけを移す**(#1232。user 指示 2026-10-26「全部やるのです」)。
 *
 * > 切り出した音と字を、1 手でノートへ。範囲に含まれる字だけを、**時刻を差し引いて**移す。
 *
 * 元の録音のノートの本文末尾には、文字起こしが `## 文字起こし 日時` の下に `0:15 こんにちは` の行で並んでいる
 * (`asr-text.ts`)。切り出した新しい録音の `0:00` は元の `startMs` なので、行の時刻から `startMs` を引けば
 * 切り出した録音の中での位置になる ── 時刻を押すと、切り出した録音のその位置から鳴る。
 *
 * ## 決めたこと
 *
 * - 見るのは**いちばん最後の `## 文字起こし` の節**だけ(文字にし直した古い節の行を混ぜない)。
 * - **範囲に少しでもかかる行**を移す。行は「次の行の始まり」まで続く発言とみなす(最後の行と、次の行が遠い行は
 *   `LINE_SPAN_MS` まで)。切り出しの始まりが発言の途中でも、その発言は落とさず、`0:00` に置く
 *   (始まりの手前から続く発言を黙って失わない)。
 * - 行の綴りは本文の時刻リンクと**同じ 1 本**(`ELAPSED_LINE_HEAD` + `parseElapsed`)。読めない綴り(`0:75`)の行は移さない。
 * - 範囲にかかる行が無ければ `null`(何も足さない)。
 *
 * 🔑 **pure module**。時刻の綴りを作るのは `elapsedText` の 1 本(ここで割り算を書かない)。
 */
import { ELAPSED_LINE_HEAD, elapsedText, parseElapsed } from '../elapsed-text';

/** 文字起こしの節の見出し(`## 文字起こし 2026-10-02 12:34`)。⚠ `asr-text.ts` の `transcriptHeading` が作る形。 */
const SECTION_HEAD = /^##\s+文字起こし(?:\s|$)/;
/** 節を終える見出し(`#` か `##`)。 */
const ANY_HEAD = /^#{1,2}\s/;

/**
 * 1 行の発言が続くとみなす長さの上限(ms)。⚠ 認識の区切りは 30 秒の窓で切るので、それより長い発言は無い。
 * 最後の行と、次の行が遠い行が、録音の最後まで続くとはみなさない(無音の末尾を切り出して、前の発言が混ざらないように)。
 */
export const LINE_SPAN_MS = 30_000;

export interface ClippedTranscript {
  /** 移す本文(1 行 = `時刻 字`)。 */
  readonly text: string;
  /** 移した行数。 */
  readonly lines: number;
}

export function clipTranscript(body: string, startMs: number, endMs: number): ClippedTranscript | null {
  const lines = body.split('\n');
  let from = -1;
  for (let i = 0; i < lines.length; i++) if (SECTION_HEAD.test(lines[i]!.trimEnd())) from = i;
  if (from === -1) return null;
  const timed: { ms: number; rest: string }[] = [];
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (ANY_HEAD.test(line)) break;
    const m = ELAPSED_LINE_HEAD.exec(line);
    if (m === null) continue;
    const ms = parseElapsed(m[1]!);
    if (ms !== null) timed.push({ ms, rest: line.slice(m[1]!.length) });
  }
  const out: string[] = [];
  timed.forEach((t, i) => {
    const next = timed[i + 1];
    const last = Math.min(next === undefined ? t.ms + LINE_SPAN_MS : next.ms, t.ms + LINE_SPAN_MS);
    // 発言は [t.ms, last)。範囲 [startMs, endMs) に少しでもかかるものを移す
    if (last <= startMs || t.ms >= endMs) return;
    out.push(`${elapsedText(Math.max(0, t.ms - startMs))}${t.rest}`);
  });
  return out.length === 0 ? null : { text: out.join('\n'), lines: out.length };
}
