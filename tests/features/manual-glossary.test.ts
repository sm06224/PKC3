/**
 * 🔴 **マニュアルの「言葉の意味」が、使わない語を見出し語として教えない**
 * (#1017 段⑤、設計 doc `ui-total-design-2026-09.md` §6.3)。
 *
 * ⚠ 守るのは**表の見出し語**(1 列目)だけ。意味の列で「以前は『小窓』と呼んでいました」
 *   と説明するのは許す ── 読み手が古い呼び方に出会ったとき、ここへ辿り着けるようにするため。
 * ⚠ 守っていないもの:マニュアルの**他の節**の本文(古い呼び方はまだ残っている。
 *   画面の字は `ui-terms.test.ts` の burn-down が見る)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANNED_TERMS } from '../../src/features/ui-terms';

const MANUAL = readFileSync('docs/manual.md', 'utf-8');

/** 「## 言葉の意味」から次の `## ` までの本文。見つからなければ空。 */
function glossarySection(manual: string): string {
  const start = manual.indexOf('\n## 言葉の意味');
  if (start < 0) return '';
  const rest = manual.slice(start + 1);
  const next = rest.indexOf('\n## ', 3);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * 表の見出し語(1 列目)。`**面**(めん)` → `面` と `めん`。
 * ⚠ 見出し行(`| 言葉 |`)と区切り行(`|---|`)は除く。
 */
function headwords(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const first = line.split('|')[1]?.trim() ?? '';
    if (first === '' || first === '言葉' || /^-+$/.test(first)) continue;
    const m = /^\*\*(.+?)\*\*(?:\((.+?)\))?$/.exec(first);
    out.push(m ? (m[1] as string) : first);
    if (m?.[2]) out.push(m[2]);
  }
  return out;
}

function bannedIn(words: readonly string[]): string[] {
  const hits: string[] = [];
  for (const w of words)
    for (const t of BANNED_TERMS) if (t.pattern().test(w)) hits.push(`${w} ⊃ ${t.banned}`);
  return hits;
}

describe('マニュアル「言葉の意味」── 見出し語に使わない語を使わない', () => {
  const words = headwords(glossarySection(MANUAL));

  it('空振り防止:節が実在し、見出し語が 1 つ以上ある', () => {
    expect(glossarySection(MANUAL), '節が見つからない').toContain('| 言葉 | 意味 |');
    expect(words.length).toBeGreaterThan(8);
    expect(words).toContain('ペイン');
  });

  it('self-test:古い見出し語(面・札・小窓・器・居場所・解放)は検出できる', () => {
    const old = [
      '| **面**(めん) | x | y |',
      '| **札**(ふだ) | x | y |',
      '| **小窓**(こまど) | x | y |',
      '| **器**(うつわ) | x | y |',
      '| **居場所**(いばしょ) | x | y |',
      '| **解放**(かいほう) | x | y |',
    ].join('\n');
    expect(bannedIn(headwords(old)).map((h) => h.split(' ⊃ ')[1])).toEqual([
      '面',
      '札',
      '小窓',
      '器',
      '居場所',
      '解放',
    ]);
    // 対照群:実在の複合語(画面)は誤検知しない
    expect(bannedIn(['画面', 'パネル'])).toEqual([]);
  });

  it('🔴 見出し語に、使わない語が出ていない', () => {
    expect(bannedIn(words)).toEqual([]);
  });

  it('言い換えた先が、見出し語として載っている(用語集の言い換えと対)', () => {
    // 期待値は言い換えの対を直に書く(`ui-terms.ts` の `instead` を種にループしない)
    const pairs: [banned: string, now: string][] = [
      ['面', 'パネル'],
      ['小窓', '別ウィンドウ'],
      ['居場所', 'フォルダ'],
      ['解放', '編集を終える'],
    ];
    for (const [banned, now] of pairs) {
      const t = BANNED_TERMS.find((b) => b.banned === banned);
      expect(t, `${banned} が使わない語に無い`).toBeDefined();
      expect(t?.instead, `${banned} の言い換え`).toContain(now);
      expect(words, `${now} が見出し語に無い`).toContain(now);
    }
  });
});
