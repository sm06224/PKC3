/**
 * 文字にした結果を、ノートへ足す形に直す(#772 段②)。⚠ **pure**。
 *
 * 🔑 足し先は **添付(録音)のノートの説明** ── 本文を上書きしない。足すのは既存の追記
 * (`APPEND_TO_ENTRY`)の 1 本で、見出し 1 つ + 文字の塊である(裁定 2026-10-01 の ③ =
 * 「そのノートの本文の末尾に追記、日時見出しつき」)。
 */

import { elapsedText } from '../elapsed-text';

/** 画面に出る入口の名前。⚠ 設定の節の見出し・案内の字は、全部ここから引く(§7)。 */
export const ASR_SECTION_LABEL = '音声認識';

/** 「文字にする」ボタンの字。 */
export const ASR_TRANSCRIBE_LABEL = '文字にする';
export const ASR_TRANSCRIBING_LABEL = '文字にしています…';

const two = (n: number): string => String(n).padStart(2, '0');

/** 追記の見出し。例: `## 文字起こし 2026-10-02 12:34`。⚠ 端末の現地時刻。 */
export function transcriptHeading(at: Date): string {
  return (
    `## 文字起こし ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
    + ` ${two(at.getHours())}:${two(at.getMinutes())}`
  );
}

/**
 * 認識結果を本文へ足す字にする。**空なら `null`**(= 足さない)。
 *
 * ⚠ 前後の空白を落とし、**行の途中の改行・連続する空白は 1 つの空白へ**まとめる
 *   (whisper は 1 続きの文を返す。本文の記法を壊す改行を混ぜない)。
 */
export function transcriptText(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/**
 * 時刻つきの区切りを、**1 行 = `時刻 字`** の本文にする(#1232 段 a)。**使える行が無ければ `null`**
 * (呼び側は `transcriptText` の 1 段落へ倒す)。
 *
 * 🔑 時刻の綴りは `elapsedText`(`0:07` / `12:34` / `1:02:03`)── 割り算を書き足さない。
 * 🔑 行は `\n` で並べる(markdown は `breaks: true` なので 1 段落の中で行ごとに見える)。
 * ⚠ 字の正規化は `transcriptText` と同じ。出た字は**そのまま**(同じ字の繰り返しも畳まない)。
 */
export function transcriptLines(
  segments: ReadonlyArray<{ readonly startMs: number; readonly text: string }> | undefined,
): string | null {
  if (segments === undefined) return null;
  const lines: string[] = [];
  for (const seg of segments) {
    const t = transcriptText(seg.text);
    if (t !== null) lines.push(`${elapsedText(seg.startMs)} ${t}`);
  }
  return lines.length === 0 ? null : lines.join('\n');
}
