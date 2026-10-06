/**
 * 🔴 **マニュアルの「言葉の意味」が、使わない語を見出し語として教えない**
 * (#1017 段⑤、設計 doc `ui-total-design-2026-09.md` §6.3)。
 *
 * ⚠ 守るのは**表の見出し語**(1 列目)だけ。意味の列で「以前は『小窓』と呼んでいました」
 *   と説明するのは許す ── 読み手が古い呼び方に出会ったとき、ここへ辿り着けるようにするため。
 * 🔴 **本文全体**も守る(2026-10-06、用語の総直し)── 用語集の節と「以前は〜と呼んでいました」の
 *   行を除いた本文に、`BANNED_TERMS` の**造語**(面・口・器・印・札・小窓・雛形 …)が 0 件。
 *   ⚠ 実在の複合語(場面・面積・文面)だけは、この file の `LEGIT_COMPOUNDS` で名指しして通す。
 * ⚠ 守っていないもの:①本文の**評価語・脅し語**(壊れ・拾う・捨てる …)── 見出しや画面の字に
 *   絡んでおり、まだ残っている ②画面の字(`ui-terms.test.ts` の burn-down が見る)。
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
      '窓', // 「小窓」は「窓」にも当たる(2026-10-06 に「窓」を使わない語へ足した)
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

/**
 * 本文(用語集の節と、「以前は『…』と呼んでいました」の行を除く)。
 * ⚠ 用語集の節は**古い呼び方を意味の列に書く場所**なので丸ごと外す(見出し語は上の検査が見る)。
 *   他の節に同じ形の行(以前の名前の注記)が在っても、その行は外す。
 */
function bodyWithoutOldNames(manual: string): string {
  const g = glossarySection(manual);
  const rest = g === '' ? manual : manual.replace(g, '');
  return rest
    .split('\n')
    .filter((l) => !/以前は「[^」]+」と(?:呼|書)んでいました/.test(l))
    .join('\n');
}

/** 使わない語(造語)を含む実在の複合語。⚠ 名指しで通す ── 本文から消えたら表からも消す。 */
const LEGIT_COMPOUNDS: readonly string[] = ['場面', '面積', '文面', '`:key:` 鍵', 'ゲーム・鍵'];

/** 本文から実在の複合語を落として、造語の当たりを `語\t前後` の形で返す。 */
function coinedHits(text: string): string[] {
  const cleaned = LEGIT_COMPOUNDS.reduce((acc, w) => acc.split(w).join('□'), text);
  const hits: string[] = [];
  for (const t of BANNED_TERMS) {
    if (t.reason !== '造語') continue;
    for (const m of cleaned.matchAll(t.pattern())) {
      const at = m.index ?? 0;
      hits.push(`${t.banned}\t${cleaned.slice(Math.max(0, at - 12), at + 12).replace(/\n/g, ' ')}`);
    }
  }
  return hits;
}

describe('マニュアル本文 ── 造語(使わない語)が 0 件', () => {
  const body = bodyWithoutOldNames(MANUAL);

  it('空振り防止:本文を切り出せていて、実在の複合語の表が生きている', () => {
    expect(body.length, '本文が短すぎる ── 切り出し方が壊れている').toBeGreaterThan(100_000);
    expect(body, '用語集の節が本文に残っている').not.toContain('## 言葉の意味');
    // 表に載せた複合語は本文に実在する(消えたら表から外す ── 通す必要の無い語を残さない)
    for (const w of LEGIT_COMPOUNDS) expect(body, `${w} が本文に無い ── 表から外す`).toContain(w);
  });

  it('self-test:造語は検出でき、実在の複合語と「以前は〜」の行は検出しない', () => {
    expect(coinedHits('小窓で開く').map((h) => h.split('\t')[0])).toEqual(['小窓', '窓']);
    expect(coinedHits('開いた面に出ます').map((h) => h.split('\t')[0])).toEqual(['面']);
    // 対照群:実在の複合語・画面は誤検知しない
    expect(coinedHits('出ない場面 / 面積で見る内訳 / 文面 / 画面')).toEqual([]);
    // 古い名前の注記の行は本文の検査から外れる
    const note = '| x | 別のウィンドウ(以前は「小窓」と呼んでいました) | y |';
    expect(coinedHits(bodyWithoutOldNames(note))).toEqual([]);
    // ⚠ 外すのは注記の行だけ ── 同じ語を普通の行に書けば当たる
    expect(coinedHits(bodyWithoutOldNames(`${note}\n小窓を開く`))).toHaveLength(2);
  });

  it('🔴 本文に、使わない語(造語)が 1 つも出ていない', () => {
    expect(coinedHits(body), '本文に造語が戻っている ── 用語集の言い換えへ直す').toEqual([]);
  });
});
