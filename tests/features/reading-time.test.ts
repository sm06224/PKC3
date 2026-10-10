import { describe, expect, it } from 'vitest';
import {
  countReadingUnits,
  estimateReadingTime,
  READING_TIME_THRESHOLD_CHARS,
} from '../../src/features/markdown/reading-time';

describe('estimateReadingTime ── 読了目安時間と文字数の算出 (#1137)', () => {
  it('200文字未満の短文では label が null になる', () => {
    const text = '短いメモです。';
    const res = estimateReadingTime(text);
    expect(res.charCount).toBeLessThan(READING_TIME_THRESHOLD_CHARS);
    expect(res.label).toBeNull();
  });

  it('200文字以上の日本語で約 1 分と判定される', () => {
    // 250文字の日本語
    const text = 'あ'.repeat(250);
    const res = estimateReadingTime(text);
    expect(res.charCount).toBe(250);
    expect(res.minutes).toBe(1);
    expect(res.label).toBe('約 1 分 (250 文字)');
  });

  it('1,000文字の日本語で約 2 分と判定される (500文字/分)', () => {
    const text = 'あいうえおかきくけこさしすせそたちつてと'.repeat(50); // 20字 * 50 = 1000字
    const res = estimateReadingTime(text);
    expect(res.charCount).toBe(1000);
    expect(res.minutes).toBe(2);
    expect(res.label).toBe('約 2 分 (1,000 文字)');
  });

  it('英文中心の長文で単語数 (200語/分) に基づき推定される', () => {
    // 400単語の英文
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const res = estimateReadingTime(words);
    expect(res.minutes).toBe(2);
    expect(res.label).toContain('約 2 分');
  });

  it('frontmatter が含まれている場合、frontmatter を除外して本文のみをカウントする', () => {
    const frontmatter = '---\ntitle: 長大なフロントマター\ncategory: test\ntags: [a, b, c]\n---\n';
    const body = '短い本文。';
    const res = estimateReadingTime(frontmatter + body);
    expect(res.charCount).toBe(5);
    expect(res.label).toBeNull();
  });
});

/**
 * 🔴 **1 走査の実装は、旧い正規表現の実装と同じ答えを返す**(#1467 段 3-j)。
 *
 * 旧実装をここに**参照として写し**、手で組んだ端の形と、種を固定した疑似乱数の本文で突き合わせる。
 * ⚠ 期待値を新実装と同じ文法で書かない(CLAUDE.md『検証の規律』型 1「期待値が実装と同じ盲点を共有する」)
 * ── 参照は正規表現、実装は 1 文字ずつの走査で、文法が違う。
 */
describe('estimateReadingTime ── 1 走査は旧 regex と同じ答え(#1467 段 3-j)', () => {
  const CJK_REGEX = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g;
  const WORD_REGEX = /\b[a-zA-Z0-9_-]+\b/g;
  /**
   * 2026-10-10 まで `src/features/markdown/reading-time.ts` に在った実装の数え方(frontmatter の無い本文で呼ぶ)。
   * 3 つの数をそのまま返す ── 分数に丸める前の値で比べる。
   */
  const referenceUnits = (content: string) => ({
    charCount: content.replace(/\s+/g, '').length,
    cjkCount: (content.match(CJK_REGEX) ?? []).length,
    wordCount: (content.replace(CJK_REGEX, ' ').match(WORD_REGEX) ?? []).length,
  });
  const reference = (content: string) => {
    const { charCount, cjkCount, wordCount } = referenceUnits(content);
    if (charCount < READING_TIME_THRESHOLD_CHARS) return { minutes: 0, charCount, label: null as string | null };
    const minutes = Math.max(1, Math.ceil(cjkCount / 500 + wordCount / 200));
    return { minutes, charCount, label: `約 ${minutes} 分 (${charCount.toLocaleString('ja-JP')} 文字)` };
  };
  const pad = (s: string) => `${s}\n${'日'.repeat(200)}`; // 閾値を越えさせて minutes / label まで比べる

  it.each([
    'foo bar',
    'foo-bar',
    'foo--',
    '--foo',
    'a-_',
    'a_-',
    '-_',
    '___',
    '---',
    'café résumé',
    'naïve-approach',
    '漢字とenglishが混ざるtext',
    'カタカナ、ひらがな。english!',
    'word\u00a0word\u3000word\ufeffword',
    'a\tb\nc\rd\u2028e',
    '🙂 emoji 😀 surrogate pairs 😀😀',
    '12 345-678 _x_ -y- z',
    'x'.repeat(5000),
    'あ'.repeat(5000),
    '',
    '   \n\t  ',
  ])('端の形: %j', (s) => {
    // 🔑 丸める前の 3 つの数で比べる ── 分数(÷200 の切り上げ)だけでは語の 1 つの差が見えない
    expect(countReadingUnits(s)).toEqual(referenceUnits(s));
    const a = estimateReadingTime(pad(s));
    const b = reference(pad(s));
    expect({ minutes: a.minutes, charCount: a.charCount, label: a.label }).toEqual(b);
    // 閾値未満の形も(pad なし)
    const a2 = estimateReadingTime(s);
    expect({ minutes: a2.minutes, charCount: a2.charCount, label: a2.label }).toEqual(reference(s));
  });

  it('種を固定した疑似乱数の本文 400 本で一致する', () => {
    const alphabet = [
      ...'abcXYZ019_-',
      ' ',
      '\n',
      '\t',
      '\u00a0',
      '\u3000',
      ...'あいう漢字カナ',
      ...'éß。、!?.',
      ...'/:@[{`AzＡ',
      '\u00a0',
      '\u1680',
      '\u2000',
      '\u200a',
      '\u2028',
      '\u202f',
      '\u205f',
      '\u0085',
      '\u200b',
      '\u180e',
      '\ufaff',
      '\ufb00',
      '\u33ff',
      '\u3400',
      '\ua000',
      '😀',
      '䶿',
      '一',
      '鿿',
      '豈',
      '〿',
      '぀',
      'ヿ',
      '㄀',
    ];
    let seed = 20261010;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let diff = 0;
    let longEnough = 0;
    for (let n = 0; n < 400; n++) {
      const len = 1 + Math.floor(rnd() * 700);
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const a = estimateReadingTime(s);
      const b = reference(s);
      if (b.label !== null) longEnough += 1;
      if (a.minutes !== b.minutes || a.charCount !== b.charCount || a.label !== b.label) diff += 1;
      const ua = countReadingUnits(s);
      const ub = referenceUnits(s);
      if (ua.charCount !== ub.charCount || ua.cjkCount !== ub.cjkCount || ua.wordCount !== ub.wordCount) diff += 1;
    }
    expect(diff).toBe(0);
    // ⚠ 空振り防止 ── 閾値を越えて分数まで比べた本文が十分に在る(0 件なら charCount しか見ていない)
    expect(longEnough).toBeGreaterThan(100);
  });

  it('U+0000〜U+FFFF の全単位を 7 つの文脈で当てても、3 つの数が旧 regex と一致する', () => {
    // 🔑 alphabet の狭さを総当たりで埋める ── 境界の 1 字ずれ(CJK の端 / 空白の 1 つ / 語の字の端)は
    //    疑似乱数では当たらない(着地前レビュー 2026-10-10 で 25 変異中 12 件が生き延びた)
    const contexts = (ch: string) => [ch, `a ${ch} b`, `- ${ch} -`, `a- ${ch}`, `${ch} -a`, `a ${ch} -`, `_ ${ch} _`];
    const bad: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      for (const s of contexts(ch)) {
        const a = countReadingUnits(s);
        const b = referenceUnits(s);
        if (a.charCount !== b.charCount || a.cjkCount !== b.cjkCount || a.wordCount !== b.wordCount) {
          bad.push(`U+${c.toString(16).padStart(4, '0')} ${JSON.stringify(s)} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
          if (bad.length > 20) break;
        }
      }
      if (bad.length > 20) break;
    }
    expect(bad).toEqual([]);
  });
});
