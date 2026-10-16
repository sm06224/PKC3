/**
 * 🔴 **マニュアルの本文にも、使わない語(`BANNED_TERMS`)を出さない**(#1087)。
 *
 * ⚠ 直す前は門(`ui-terms.test.ts`)が `src` だけを見ていたので、マニュアルに
 *   「壊れているときは」「Esc を押して捨てると」が残っていた(ヘルプの画面にそのまま出る)。
 * 🔑 見るのは**地の文だけ**:コードの囲み・`インラインのコード`・リンク先・URL・HTML の注釈は
 *   書き方の例やアドレスなので除く(画面の字ではない)。
 * ⚠ 残りは等値で pin する(burn-down)── 増えたら落ちる / 直したら pin も直す。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANNED_TERMS } from '../../src/features/ui-terms';

/** 地の文だけにする(囲み・コード・リンク先・URL・注釈を落とす)。 */
function proseLines(md: string): { no: number; text: string }[] {
  const out: { no: number; text: string }[] = [];
  let fence = false;
  md.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const text = raw
      .replace(/`[^`]*`/g, ' ')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/<!--.*?-->/g, ' ');
    out.push({ no: i + 1, text });
  });
  return out;
}

/**
 * 画面にその字のまま在る名前なので、使わない語でも残す物。
 * ⚠ `鍵` はアイコンの名前(`src/features/icon/tile-icons.ts` の `label: '鍵'`)── マニュアルは
 *   アイコンを選ぶ画面の字をそのまま引いている。
 */
const KNOWN: readonly string[] = ['鍵', '鍵'];

describe('マニュアルの地の文に使わない語が無い', () => {
  const md = readFileSync('docs/manual.md', 'utf8');
  const lines = proseLines(md);

  it('前提: 地の文を拾えている(空振り防止)', () => {
    expect(lines.length).toBeGreaterThan(1000);
    // コードの囲みの中は拾わない
    expect(proseLines('```\n壊れ\n```\n').map((l) => l.text)).toEqual(['']);
    expect(proseLines('a `壊れ` b').map((l) => l.text.trim())).toEqual(['a   b']);
  });

  it('使わない語の残りは既知の分だけ', () => {
    const hits: string[] = [];
    const where: string[] = [];
    for (const { no, text } of lines) {
      for (const t of BANNED_TERMS) {
        const n = text.match(t.pattern())?.length ?? 0;
        for (let k = 0; k < n; k++) {
          hits.push(t.banned);
          where.push(`${String(no)}: 「${t.banned}」→「${t.instead}」`);
        }
      }
    }
    expect(hits.sort(), where.join('\n')).toEqual([...KNOWN].sort());
  });

  it('アイコンの名前「鍵」は画面に実在する(KNOWN の理由が生きている)', () => {
    const src = readFileSync('src/features/icon/tile-icons.ts', 'utf8');
    expect(src).toContain("label: '鍵'");
  });
});
