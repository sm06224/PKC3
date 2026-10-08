/**
 * 🔴 **文字起こしを字幕ファイル(SRT)にする**(#1447。🟣 Gemini 提案)。⚠ **pure**。
 *
 * > user の物語:録音を「文字にする」と、本文に `0:15 こんにちは` の行が並ぶ(#1232 段 a)。
 * > それを**時刻つきのまま外へ渡したい**(動画の字幕にする / AI に議事録を作らせる)。
 *
 * 🔑 **新しい保存の形は作らない** ── 本文に既に在る「行頭に時刻のある行」から組む。
 *   時刻つきの行の読みは `ELAPSED_LINE_HEAD` + `parseElapsed`(画面で押せる字にする側と同じ 1 本)。
 *   ⚠ 画面の側は markdown の **inline の行頭**で当てる(`pkc-seek-link`)ので、箇条書き(`- 0:15 …`)・
 *   引用(`> 0:15 …`)・見出し(`## 0:15 …`)の中の行も押せる字になる ── ここも同じ行を拾う
 *   (`LINE_PREFIX`)。⚠ 4 つ以上の空白で始まる行は markdown では code なので拾わない。
 *   「押せる行 = 字幕になる行」は `tests/features/srt.test.ts` が**実物の描画を対照群**にして見る。
 * ⚠ 本文は**開始時刻しか持たない**(#1232 段 a は `endMs` を捨てた)。だから**終了 = 次の行の開始**、
 *   次の行が無い・次の行の時刻が進んでいない(同じ秒 / 手で並べ替えた)ときは `LAST_CUE_MS` を足した
 *   **推定**である(呼び側はそう知らせる)。⚠ 同じ秒の 2 行で `next.ms` を終了にすると長さ 0 の字幕になる。
 * ⚠ コードブロック(``` / ~~~)の中は読まない ── マニュアルの例をノートに貼った行が字幕になるのは期待と違う。
 *   閉じは markdown-it と同じ規則(**同じ字で、開いたときと同じ長さ以上**)── 開閉を数で数えると、
 *   長さの違う囲みで裏返る。
 * ⚠ 時刻の綴りは秒までなので、`,000` が付く(本文の精度そのまま。偽の精度を作らない)。
 */

import { ELAPSED_LINE_HEAD, parseElapsed, srtTime } from '../elapsed-text';

/** 次の行が無い(か、時刻が進んでいない)行に足す長さ。⚠ 推定である(呼び側の知らせの字と対で変える)。 */
export const LAST_CUE_MS = 5000;

/** 字幕 1 件。 */
export interface SrtCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** コードブロックの開き(3 つ以上の ``` か ~~~、字下げ 3 つまで)。 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/**
 * 行頭の markdown の印(引用 `>` / 箇条書き `-` `*` `+` / 番号 `1.` `1)` / 見出し `#`)。
 * ⚠ 画面はこの先の字を inline の行頭として読む(`pkc-seek-link`)── 剥いだ残りに時刻の綴りを当てる。
 */
const LINE_PREFIX = /^ {0,3}(?:>|[-*+] |\d{1,9}[.)] |#{1,6} ) ?/;

/** 1 行ずつ「行頭に時刻のある行」を出す(コードブロックの中は飛ばす)。 */
function* transcriptHeads(body: string): Generator<{ readonly ms: number; readonly text: string }> {
  let fence: { readonly ch: string; readonly len: number } | null = null;
  for (const line of body.split('\n')) {
    if (fence !== null) {
      // 閉じ ── 同じ字で、開いたとき以上の長さ、後ろは空白だけ
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m !== null && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      continue;
    }
    let rest = line;
    // ⚠ 印は何段でも剥ぐ(`- > 0:15` のような入れ子)── 変わらなくなったら止まる
    for (;;) {
      const next = rest.replace(LINE_PREFIX, '');
      if (next === rest) break;
      rest = next;
    }
    // ⚠ 4 つ以上の空白で始まる残りは code(markdown の字下げ code)── 画面でも押せない
    if (/^ {4}/.test(rest)) continue;
    rest = rest.replace(/^ {0,3}/, '');
    const m = ELAPSED_LINE_HEAD.exec(rest);
    if (m === null) continue;
    const ms = parseElapsed(m[1]!);
    if (ms === null) continue;
    const text = rest.slice(m[1]!.length).trim();
    // ⚠ 字が空の行(時刻だけ)は捨てる ── 空の字幕は再生機で「何も出ない区間」になるだけ
    if (text === '') continue;
    yield { ms, text };
  }
}

/** 時刻つきの行が 1 つでも在るか(一覧の「押せるか」が毎打鍵で呼ぶので、全文を組まずに最初の 1 件で返す)。 */
export function hasTranscriptCues(body: string): boolean {
  for (const _ of transcriptHeads(body)) return true;
  return false;
}

/**
 * 本文から「行頭に時刻のある行」を拾い、終了時刻を付ける。
 * ⚠ 字は時刻の後ろを**そのまま**(前後の空白だけ落とす。markdown の記号も剥がさない)。
 */
export function transcriptCues(body: string): readonly SrtCue[] {
  const heads = [...transcriptHeads(body)];
  return heads.map((h, i) => {
    const next = heads[i + 1];
    const endMs = next !== undefined && next.ms > h.ms ? next.ms : h.ms + LAST_CUE_MS;
    return { startMs: h.ms, endMs, text: h.text };
  });
}

/**
 * SRT の字(`1\n00:00:15,000 --> 00:00:30,000\nこんにちは\n\n…`)。**時刻つきの行が 1 つも無ければ `null`**。
 * ⚠ 行末は `\n`(CRLF にしない ── 主要な再生機は両方読むが、`\r` は本文の記法に混ぜない)。
 * ⚠ 件の間は空行、**最後の件の後にも空行 1 つ**(規格の読み手は「空行で件が終わる」と読む ──
 *   無くても ffmpeg / VLC は読むが、厳密な読み手は最後の件を落とす)。
 */
export function srtFromTranscript(body: string): string | null {
  const cues = transcriptCues(body);
  if (cues.length === 0) return null;
  return cues.map((c, i) => `${String(i + 1)}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text}\n`).join('\n') + '\n';
}
