import { fenceTransition, type FenceState } from './var-expand';

/**
 * 🔴 **行頭の全角の空白を、箇条書きの字下げとして読む**(#1163 依頼 136。Gemini 回答は案どおり)。
 *
 * ```
 * - a
 * (全角の空白)- b      ← 行頭が全角の空白
 * ```
 *
 * 日本語入力のまま字下げすると全角の空白になる。直す前は `b` が入れ子にならず、1 行目の続きとして
 * `a  - b` のように表示された(半角の空白やタブなら入れ子になる。`:::` の囲みの開きの行は全角の空白でも受けている)。
 * 全角の空白 1 つを**半角の空白 2 つ**として読む(入れ子の幅の標準)。
 *
 * ## 守ること
 * - ⚠ **本文は書き換えない** ── 描く前の字だけを揃える(`markdown-render.ts` の前処理の 1 段)。
 * - ⚠ **行数を変えない**(行の対応表がずれない)。
 * - ⚠ **直すのは「全角の空白の後ろに箇条書き・番号の印が続く行」だけ** ── 全角の空白で字下げしただけの普通の段落は、そのまま。
 * - ⚠ **囲みコード(``` / ~~~)の中は触らない**。
 * - 🔑 全角の空白が本文に 1 つも無ければ、走査せずに元の字をそのまま返す(配るノートの大半)。
 */

/** 行頭の字下げ(半角の空白・タブ・全角の空白)+ 箇条書き / 番号の印 + 空白。字下げに全角が混じる行だけを直す。 */
const LINE = /^([ \t\u3000]*)([-*+]|\d+[.)])([ \t\u3000]+|$)/;

/** 字下げの全角の空白を半角 2 つへ。タブと半角の空白はそのまま。 */
function fold(indent: string): string {
  return indent.replace(/\u3000/g, '  ');
}

export function foldIdeographicIndent(text: string): string {
  if (text.indexOf('\u3000') === -1) return text;
  const lines = text.split('\n');
  let fence: FenceState = { inFence: false, marker: '' };
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) continue;
    const m = LINE.exec(line);
    if (m === null || !m[1]!.includes('\u3000')) continue;
    // 水平線(`- - -`)は記号と空白の並びなので、リストの項目にしない
    if (/^[ \t\u3000]*([-*_])(?:[ \t\u3000]*\1){2,}[ \t\u3000]*$/.test(line)) continue;
    // 記号の後ろの全角の空白も半角へ(`(全角の空白)-(全角の空白)b` を `  - b` と読む。記号の後ろの空白は 1 つで足りる)
    lines[i] = `${fold(m[1]!)}${m[2]!}${m[3]! === '' ? '' : ' '}${line.slice(m[0].length)}`;
    changed = true;
  }
  return changed ? lines.join('\n') : text;
}
