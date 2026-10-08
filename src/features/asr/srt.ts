/**
 * 🔴 **文字起こしを字幕ファイル(SRT)にする**(#1447。🟣 Gemini 提案)。⚠ **pure**。
 *
 * > user の物語:録音を「文字にする」と、本文に `0:15 こんにちは` の行が並ぶ(#1232 段 a)。
 * > それを**時刻つきのまま外へ渡したい**(動画の字幕にする / AI に議事録を作らせる)。
 *
 * 🔑 **新しい保存の形は作らない** ── 本文に既に在る「行頭に時刻のある行」から組む。
 *   時刻つきの行の読みは `ELAPSED_LINE_HEAD` + `parseElapsed`(画面で押せる字にする側と同じ 1 本)。
 * ⚠ 本文は**開始時刻しか持たない**(#1232 段 a は `endMs` を捨てた)。だから**終了 = 次の行の開始**、
 *   最後の行だけ `LAST_CUE_MS` を足した**推定**である(呼び側はそう知らせる)。
 *   次の行の開始が前の行より後ろでない(手で並べ替えた本文)ときも、同じ推定で閉じる(負の長さを作らない)。
 * ⚠ 囲み(```)の中は読まない ── マニュアルの例をノートに貼った行が字幕になるのは期待と違う。
 * ⚠ 時刻の綴りは秒までなので、`,000` が付く(本文の精度そのまま。偽の精度を作らない)。
 */

import { ELAPSED_LINE_HEAD, parseElapsed, srtTime } from '../elapsed-text';

/** 最後の行(次の行が無い)に足す長さ。⚠ 推定である(呼び側の知らせの字と対で変える)。 */
export const LAST_CUE_MS = 5000;

/** 字幕 1 件。 */
export interface SrtCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/**
 * 本文から「行頭に時刻のある行」を拾う。⚠ 字は時刻の後ろを**そのまま**(前後の空白だけ落とす)。
 * 字が空の行(時刻だけ)は捨てる ── 空の字幕は再生機で「何も出ない区間」になるだけ。
 */
export function transcriptCues(body: string): readonly SrtCue[] {
  const heads: Array<{ ms: number; text: string }> = [];
  let inFence = false;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ELAPSED_LINE_HEAD.exec(line);
    if (m === null) continue;
    const ms = parseElapsed(m[1]!);
    if (ms === null) continue;
    const text = line.slice(m[1]!.length).trim();
    if (text === '') continue;
    heads.push({ ms, text });
  }
  return heads.map((h, i) => {
    const next = heads[i + 1];
    const endMs = next !== undefined && next.ms > h.ms ? next.ms : h.ms + LAST_CUE_MS;
    return { startMs: h.ms, endMs, text: h.text };
  });
}

/**
 * SRT の字(`1\n00:00:15,000 --> 00:00:30,000\nこんにちは\n\n…`)。**時刻つきの行が 1 つも無ければ `null`**。
 * ⚠ 行末は `\n`(CRLF にしない ── 主要な再生機は両方読むが、`\r` は本文の記法に混ぜない)。
 * ⚠ 末尾は空行 1 つで終わる(規格の「件と件の間は空行」をそのまま)。
 */
export function srtFromTranscript(body: string): string | null {
  const cues = transcriptCues(body);
  if (cues.length === 0) return null;
  return cues
    .map((c, i) => `${String(i + 1)}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text}\n`)
    .join('\n');
}
