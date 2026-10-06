/**
 * 🔴 **マニュアルの「言葉の意味」が、使わない語を見出し語として教えない**
 * (#1017 段⑤、設計 doc `ui-total-design-2026-09.md` §6.3)。
 *
 * ⚠ 守るのは**表の見出し語**(1 列目)。旧い呼び方の一覧は、マニュアルには置かない
 *   (`docs/development/ui-terms-rename-2026-10.md` にだけ置く)。
 * 🔴 **本文全体**も守る(2026-10-06、用語の総直し)── 用語集の節も含めた本文に、
 *   `BANNED_TERMS` の**造語・英語の素通し・飾り記号**(面・口・器・印・札・小窓・雛形・file・lid・── …)が 0 件。
 *   ⚠ 実在の複合語・コード・図だけは、この file の `LEGIT_COMPOUNDS` / 罫線の行で名指しして通す。
 * ⚠ 守っていないもの:①本文の**評価語・脅し語**(壊れ・捨てる …)── 修復画面の言い方と一緒に
 *   別件(#1017)で設計する ②画面の字(`ui-terms.test.ts` の burn-down が見る)。
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
    expect(bannedIn(['画面', '入力画面'])).toEqual([]);
  });

  it('🔴 見出し語に、使わない語が出ていない', () => {
    expect(bannedIn(words)).toEqual([]);
  });

  it('言い換えた先が、見出し語として載っている(用語集の言い換えと対)', () => {
    // 期待値は言い換えの対を直に書く(`ui-terms.ts` の `instead` を種にループしない)
    const pairs: [banned: string, now: string][] = [
      ['面', '画面'],
      ['小窓', '別ウィンドウ'],
      ['居場所', 'フォルダ'],
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
 * 本文。⚠ 用語集の節も含める(旧い呼び方の一覧は置かないので、除く物が無い)。
 * 🔑 図(罫線の行)だけは数えない ── 罫線の `──` は文の区切りではなく図の部品である。
 */
function bodyForScan(manual: string): string {
  return manual
    .split('\n')
    .filter((l) => !/^[\s│┌└├┐┘┤─]*[┌└│├]/.test(l) || !/[─│┌└┐┘]/.test(l))
    .join('\n');
}

/**
 * 使わない語を含む実在の語・コード。⚠ 名指しで通す ── 本文から消えたら表からも消す。
 * (場面・面積・文面 = 実在の複合語 / アイコン名の鍵 / `file://` と SQL の列名 `lid` = コードの字 /
 *  `/entry/` `entry=` `container=` = アドレスの字、`entry_order` `entry_lid` = SQL の列名)
 */
const LEGIT_COMPOUNDS: readonly string[] = [
  '場面',
  '面積',
  '文面',
  '`:key:` 鍵',
  'ゲーム・鍵',
  '`file://`',
  '`cid` `lid`',
  'SELECT lid,',
  '/entry/',
  'entry=',
  'entry_order',
  'entry_lid',
  'container=',
];

/** 評価語・脅し語は別件(#1017)。ここで見るのは、それ以外の「使わない語」。 */
const SCANNED_REASONS = (r: string): boolean => r !== '評価語・脅し語';

/** 本文から実在の語を落として、使わない語の当たりを `語\t前後` の形で返す。 */
function coinedHits(text: string): string[] {
  const cleaned = LEGIT_COMPOUNDS.reduce((acc, w) => acc.split(w).join('□'), text);
  const hits: string[] = [];
  for (const t of BANNED_TERMS) {
    if (!SCANNED_REASONS(t.reason)) continue;
    for (const m of cleaned.matchAll(t.pattern())) {
      const at = m.index ?? 0;
      hits.push(`${t.banned}\t${cleaned.slice(Math.max(0, at - 12), at + 12).replace(/\n/g, ' ')}`);
    }
  }
  return hits;
}

describe('マニュアル本文 ── 使わない語が 0 件', () => {
  const body = bodyForScan(MANUAL);

  it('空振り防止:本文を切り出せていて、実在の語の表が生きている', () => {
    expect(body.length, '本文が短すぎる ── 切り出し方が壊れている').toBeGreaterThan(100_000);
    expect(body, '用語集の節が本文に無い').toContain('## 言葉の意味');
    // 表に載せた語は本文に実在する(消えたら表から外す ── 通す必要の無い語を残さない)
    for (const w of LEGIT_COMPOUNDS) expect(body, `${w} が本文に無い ── 表から外す`).toContain(w);
  });

  it('self-test:使わない語は検出でき、実在の複合語・図は検出しない', () => {
    expect(coinedHits('小窓で開く').map((h) => h.split('\t')[0])).toEqual(['小窓', '窓']);
    expect(coinedHits('開いた面に出ます').map((h) => h.split('\t')[0])).toEqual(['面']);
    expect(coinedHits('この file を選ぶ').map((h) => h.split('\t')[0])).toEqual(['file']);
    expect(coinedHits('押せません ── 理由').map((h) => h.split('\t')[0])).toEqual(['──']);
    // 対照群:実在の複合語・画面は誤検知しない
    expect(coinedHits('出ない場面 / 面積で見る内訳 / 文面 / 画面')).toEqual([]);
    // 図の罫線の行は本文の検査から外れる(⚠ 外すのは図の行だけ ── 文の中の `──` は当たる)
    const diagram = '┌ 予定 ─────────┐\n│ ─────────────── │\n└──────────────┘';
    expect(coinedHits(bodyForScan(diagram))).toEqual([]);
    expect(coinedHits(bodyForScan(`${diagram}\n理由 ── 説明`))).toHaveLength(1);
  });

  it('🔴 本文に、使わない語(評価語を除く)が 1 つも出ていない', () => {
    expect(coinedHits(body), '本文に使わない語が戻っている ── 用語集の言い換えへ直す').toEqual([]);
  });
});
