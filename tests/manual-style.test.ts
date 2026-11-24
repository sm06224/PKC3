/**
 * マニュアルの書き方の門(`docs/development/manual-style-2026-09.md`、2026-11 改定)。
 *
 * 🔑 マニュアルの書き直し(PR 3)で**移行期は終わった** ── 規約の違反(見出し・日付・経緯・古い位置)は
 *   0 件で等値に pin し、規模(行数・H3)は上限(`FINAL`)以下で見る。
 * ⚠ 検査の関数(`tests/helpers/manual-style.ts`)は**自前の原稿**にも当てて、効いていることを見る
 *   (実物のマニュアルに当てるだけでは、検査が壊れていても緑になる)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HEADING_MAX_CHARS,
  bannedEndingHeadings,
  commaHeadings,
  dateStampLines,
  h3Count,
  historyWordLines,
  longHeadings,
  paragraphAround,
  scanHeadings,
  sectionByTitle,
  sectionContaining,
  occurrences,
  stripQuoted,
  headingCore,
  staleUiLines,
  totalLines,
} from './helpers/manual-style';

const MANUAL = readFileSync('docs/manual.md', 'utf-8');

/** 最終の値。⚠ 件数は 0、規模は上限。 */
const FINAL = {
  longHeadings: 0,
  commaHeadings: 0,
  bannedEndings: 0,
  dateStamps: 0,
  staleUi: 0,
  historyWords: 0,
  lines: 3500,
  h3: 150,
} as const;

/**
 * 書き直し(PR 3)が終わった時点の実測(2026-11-24。囲みの外のみ。画面の字の逐語引用「…」/ `…` / **太字の画面の字** は数えない)。
 * 🔑 **違反の件数は FINAL(= 0)と同じ値で、等値で見る**(1 件でも出たら落ちる)。
 * 🔑 **規模(行数・H3)は上限(FINAL)で見る** ── 書き足すたびにテストの数字を直させないため。BASELINE は実測の記録で、上限より下であることだけ pin する。
 */
const BASELINE = {
  longHeadings: 0,
  commaHeadings: 0,
  bannedEndings: 0,
  dateStamps: 0,
  staleUi: 0,
  historyWords: 0,
  lines: 2930, // 実測(目標 2,000〜2,800 の少し上。上限 3,500 は FINAL)
  h3: 131, // 実測(目標約 100。上限 150 は FINAL)
} as const;

/** 違反の件数の門。⚠ 0 件(= FINAL)から増えたら本文を直す。 */
function expectRatchet(name: keyof typeof BASELINE, actual: number): void {
  const base = BASELINE[name];
  expect(actual, `${name}: ${actual} 件で、基準(${base})より増えた ── 本文を直す(増やさない)`).toBe(base);
}

/** 規模の門。⚠ 上限(FINAL)を超えたら、先に既存の節を削る・畳む。 */
function expectUnderCap(name: 'lines' | 'h3', actual: number): void {
  expect(actual, `${name}: ${actual} が上限(${FINAL[name]})を超えた ── 先に既存の節を削る・畳む`).toBeLessThanOrEqual(FINAL[name]);
}

describe('マニュアルの書き方 ── 門(違反 0 件・規模は上限)', () => {
  it('移行は終わっている ── 違反の件数の基準は FINAL(0 件)と同じで、規模の実測は上限以下', () => {
    for (const k of ['longHeadings', 'commaHeadings', 'bannedEndings', 'dateStamps', 'staleUi', 'historyWords'] as const) {
      expect(BASELINE[k], `${k}: 違反の基準が FINAL(0 件)から離れている`).toBe(FINAL[k]);
    }
    expect(BASELINE.lines).toBeLessThanOrEqual(FINAL.lines);
    expect(BASELINE.h3).toBeLessThanOrEqual(FINAL.h3);
  });

  it('空振り防止 ── 実物のマニュアルを読めている', () => {
    expect(scanHeadings(MANUAL).length).toBeGreaterThan(60);
    expect(totalLines(MANUAL)).toBeGreaterThan(1000);
  });

  it('条 3 ── 30 字を超える見出しを増やさない(等値)', () => {
    expectRatchet('longHeadings', longHeadings(MANUAL).length);
  });
  it('条 3 ── 読点「、」を含む見出しを増やさない(等値)', () => {
    expectRatchet('commaHeadings', commaHeadings(MANUAL).length);
  });
  it('条 3 ── 「〜を知る」「〜を確かめる」「〜のとき」で終わる見出しを増やさない(等値)', () => {
    expectRatchet('bannedEndings', bannedEndingHeadings(MANUAL).length);
  });
  it('本文 ── 日付の印を含む行を増やさない(等値)', () => {
    expectRatchet('dateStamps', dateStampLines(MANUAL).length);
  });
  it('本文 ── 古い画面の位置の言い方を増やさない(等値)', () => {
    expectRatchet('staleUi', staleUiLines(MANUAL).length);
  });
  it('本文 ── 経緯の言い回しを増やさない(等値)', () => {
    expectRatchet('historyWords', historyWordLines(MANUAL).length);
  });
  it('全体 ── 行数が上限(3,500 行)以下', () => {
    expectUnderCap('lines', totalLines(MANUAL));
  });
  it('全体 ── H3 の数が上限(150 個)以下', () => {
    expectUnderCap('h3', h3Count(MANUAL));
  });
});

describe('検査の関数そのもの(自前の原稿で効いていること)', () => {
  const ok = ['# 題', '## 章', '### ノートを作成する', '本文です。'].join('\n');

  it('対照群 ── 正しい原稿では何も鳴らない', () => {
    expect(longHeadings(ok)).toEqual([]);
    expect(commaHeadings(ok)).toEqual([]);
    expect(bannedEndingHeadings(ok)).toEqual([]);
    expect(dateStampLines(ok)).toEqual([]);
    expect(staleUiLines(ok)).toEqual([]);
    expect(historyWordLines(ok)).toEqual([]);
  });

  it('見出しは 30 字までは通り、31 字で鳴る', () => {
    const t30 = 'あ'.repeat(HEADING_MAX_CHARS);
    const t31 = 'あ'.repeat(HEADING_MAX_CHARS + 1);
    expect(longHeadings(`### ${t30}`)).toEqual([]);
    expect(longHeadings(`### ${t31}`)).toHaveLength(1);
    // 🔑 コードポイントで数える(サロゲートペアを 2 字に数えない)
    expect(longHeadings(`### ${'😀'.repeat(HEADING_MAX_CHARS)}`)).toEqual([]);
  });

  it('見出しの「、」と禁止の語尾が鳴る', () => {
    expect(commaHeadings('### 保存、復元')).toHaveLength(1);
    expect(bannedEndingHeadings('### 仕組みを知る')).toHaveLength(1);
    expect(bannedEndingHeadings('### 動きを確かめる')).toHaveLength(1);
    expect(bannedEndingHeadings('### 開いたとき')).toHaveLength(1);
    expect(bannedEndingHeadings('### 保存のとき')).toHaveLength(1);
    expect(bannedEndingHeadings('### 困ったとき')).toHaveLength(1);
    // 末尾のかっこの補足は外して見る(補足で逃げられない)
    expect(bannedEndingHeadings('### 開いたとき(Ctrl + O)')).toHaveLength(1);
    expect(bannedEndingHeadings('### 仕組みを知る(全角)')).toHaveLength(1);
    expect(bannedEndingHeadings('### 保存のとき(Ctrl + S)')).toHaveLength(1);
    expect(headingCore('ノートを作成する(Ctrl + N)')).toBe('ノートを作成する');
    expect(bannedEndingHeadings('### ノートを作成する')).toEqual([]);
    expect(bannedEndingHeadings('### 保存した結果(とき)を見る')).toEqual([]);
  });

  it('本文の日付の印・古い位置・経緯が鳴る', () => {
    expect(dateStampLines('入れます(2026-09-25)。')).toHaveLength(1);
    expect(dateStampLines('入れます（2026-09-25 から）。')).toHaveLength(1);
    expect(dateStampLines('例: 2026-09-25 のメモ')).toEqual([]);
    expect(staleUiLines('画面の下に出ます')).toHaveLength(1);
    expect(staleUiLines('ステータスバーに出ます')).toHaveLength(1);
    expect(staleUiLines('状態バーに出ます')).toHaveLength(1);
    // 「上のタブ」は左ペイン・スマホの正しい呼び名なので対象外
    expect(staleUiLines('上のタブを押す')).toEqual([]);
    expect(historyWordLines('以前は左にありました')).toHaveLength(1);
    expect(historyWordLines('従来どおり')).toHaveLength(1);
    // 「旧版 PKC の zip」は機能の名前なので対象外
    expect(historyWordLines('旧版 PKC の zip を取り込む')).toEqual([]);
    expect(historyWordLines('旧バージョンでは動きません')).toHaveLength(1);
    expect(historyWordLines('こうなりました')).toEqual([]);
    expect(historyWordLines('名前が変わりました')).toEqual([]);
    expect(historyWordLines('ボタンが増えになりました')).toHaveLength(1);
  });

  it('画面に出る字の逐語の引用は、日付・経緯・古い位置の対象外(「…」/ `…` / 太字の画面の字)', () => {
    expect(dateStampLines('**日付として読めません(2026-10-17 の形で書きます)**')).toEqual([]);
    expect(dateStampLines('「保存しました(2026-10-17)」と出ます')).toEqual([]);
    expect(dateStampLines('`(2026-10-17)` と書きます')).toEqual([]);
    expect(historyWordLines('「このタブがメインのタブになりました」と出ます')).toEqual([]);
    expect(historyWordLines('『従来どおり』と出ます')).toEqual([]);
    expect(staleUiLines('画面の下に **「n 件を移しました」** と出ます')).toHaveLength(1); // 位置の案内は引用の外
    expect(staleUiLines('「画面の下に出ます」と書いてある')).toEqual([]);
    // 打ち消しは古い位置の案内ではない
    expect(staleUiLines('(画面の下に常設のバーはありません)')).toEqual([]);
    expect(staleUiLines('画面の下に常設のバーが出ます')).toHaveLength(1);
    // ⚠ 1 文ぜんぶが太字のとき(「。」を含む)は引用ではない ── 逃げ道にしない
    expect(dateStampLines('**2026-08-28 に割り当てを変えました。** それまでは')).toHaveLength(1);
    expect(stripQuoted('a「b」c`d`e**f**g')).toBe('aceg');
  });

  it('括弧なしの日付 + 経緯の助詞も鳴る(日付だけの例は鳴らない)', () => {
    expect(dateStampLines('2026-08-28 に割り当てを変えました')).toHaveLength(1);
    expect(dateStampLines('2026-09-04 まではここが')).toHaveLength(1);
    expect(dateStampLines('2026-09-07 に直しました')).toHaveLength(1);
    expect(dateStampLines('日付は 2026-08-25 の形で書きます')).toEqual([]);
    expect(dateStampLines('題名は `2026-08-23` のように')).toEqual([]);
  });

  it('囲みの種類 ── ~~~ と 4 つのバッククォート / リストの中の囲み / 閉じの字と長さ', () => {
    const bad = '### ' + 'あ'.repeat(40);
    // ~~~ の囲み
    expect(longHeadings(['~~~', bad, '~~~', '### 外'].join('\n'))).toEqual([]);
    // 4 つの囲みの中の 3 つは閉じではない
    expect(longHeadings(['````', '```', bad, '```', '````', '### 外'].join('\n'))).toEqual([]);
    expect(scanHeadings(['````', '```', '### 中', '```', '````', '### 外'].join('\n')).map((h) => h.title)).toEqual(['外']);
    // ``` の囲みの中の ~~~ は閉じではない
    expect(scanHeadings(['```', '~~~', '### 中', '```', '### 外'].join('\n')).map((h) => h.title)).toEqual(['外']);
    // リスト(字下げ)の中の囲み
    expect(dateStampLines(['- 項目', '  ```', '  (2026-09-01)', '  ```', '  (2026-09-02)'].join('\n'))).toHaveLength(1);
    // 閉じていない囲みは最後まで囲み(以降を数えない)
    expect(scanHeadings(['```', '### 中'].join('\n'))).toEqual([]);
    // ⚠ ATX 形式(# 題)だけを見出しと数える(下線形式は数えない)
    expect(scanHeadings('題\n====').length).toBe(0);
  });

  it('節の探索 ── 一意でなければ例外 / 自分の本文だけ / 字の出現数', () => {
    const dup = ['## 設定 A', 'あ', '## 設定 B', 'い'].join('\n');
    expect(() => sectionByTitle(dup, '設定')).toThrow(/2 個/);
    expect(sectionByTitle(dup, '設定 A')).toContain('あ');
    // 「題名に含む」までは広げない
    expect(sectionByTitle('## 大きな設定', '設定')).toBeNull();
    const nested = ['## 章', '本文 1', '### 小', '本文 2'].join('\n');
    expect(sectionByTitle(nested, '章')).toContain('本文 2');
    expect(sectionByTitle(nested, '章', { ownBodyOnly: true })).not.toContain('本文 2');
    expect(sectionContaining(nested, '本文 1', { ownBodyOnly: true })).not.toContain('小');
    expect(occurrences('あ あ\n```\nあ\n```\nあ', 'あ')).toBe(3);
  });

  it('囲みの中は見出しとしても本文としても数えない', () => {
    const doc = ['```', '### ' + 'あ'.repeat(40), '以前は 画面の下に (2026-09-25)', '```', '### 外'].join('\n');
    expect(longHeadings(doc)).toEqual([]);
    expect(dateStampLines(doc)).toEqual([]);
    expect(staleUiLines(doc)).toEqual([]);
    expect(historyWordLines(doc)).toEqual([]);
    expect(scanHeadings(doc).map((h) => h.title)).toEqual(['外']);
    expect(h3Count(doc)).toBe(1);
  });

  it('行数と H3 の数', () => {
    expect(totalLines('a\nb\n')).toBe(2);
    expect(totalLines('a\nb')).toBe(2);
    expect(h3Count(['## 章', '### 節', '#### 小', '### 節 2'].join('\n'))).toBe(2);
  });

  it('見出しをキーワードで探す ── 段が変わっても、名前が変わっても同じ節を拾う', () => {
    const before = ['## 章', '### 割り当てを変える', '手順 A', '#### 小', '詳細', '### 次', '別'].join('\n');
    const after = ['## 章', '#### 割り当てを変更する手順', '手順 A', '##### 小', '詳細', '## 次', '別'].join('\n');
    for (const t of [before, after]) {
      const s = sectionByTitle(t, '割り当てを変');
      expect(s, '節を拾えていない').not.toBeNull();
      expect(s).toContain('手順 A');
      expect(s).toContain('詳細');
      expect(s).not.toContain('別');
    }
    expect(sectionByTitle(before, '存在しない語')).toBeNull();
    // 題名が一致するものを、先に出てくる「含む」ものより優先する
    const pri = ['### 割り当てを変える手順', '甲', '### 割り当てを変える', '乙'].join('\n');
    expect(sectionByTitle(pri, '割り当てを変える')).toContain('乙');
    expect(sectionByTitle(pri, '割り当てを変える')).not.toContain('甲');
  });

  it('内容で節を探す ── 見出しの名前に頼らない / 囲みの中と見出し行は数えない', () => {
    const doc = ['## 甲', '```', '目印', '```', '### 見出しに目印', '## 乙', '本文に目印があります', '### 小'].join('\n');
    const s = sectionContaining(doc, '目印');
    expect(s).toContain('本文に目印があります');
    expect(s).toContain('### 小');
    expect(s).not.toContain('## 甲');
    expect(sectionContaining('## 甲\n本文', '無い語')).toBeNull();
    expect(paragraphAround('あ\n**ラベル** い\nう', 'ラベル', 0, 1)).toBe('**ラベル** い\nう');
    expect(paragraphAround('あ', 'ラベル')).toBeNull();
  });
});
