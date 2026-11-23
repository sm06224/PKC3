/**
 * マニュアルの書き方の門(`docs/development/manual-style-2026-09.md`、2026-11 改定)。
 *
 * 🔑 **移行期のあいだは「増やさない」の門(ratchet)**である ── 本文の書き直し(PR 3)が終わるまでは
 *   いまの違反数(`BASELINE`)を上限にし、増やしたら落とす。書き直しが終わったら
 *   `BASELINE` を `FINAL` と同じ値にする(= 0 件 / 3,500 行 / 150 節)。
 * ⚠ `BASELINE` は**下げる方向にしか動かせない**(`FINAL` 以上であることを下で見ている)。
 *   直したら数字も下げる ── 上限のままだと、直した分だけ「また増やしてよい余地」が残る。
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
  sectionsByTitle,
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

/** いまの違反数(2026-11-23 に実測。囲みの外のみ)。⚠ PR 3(本文の書き直し)で FINAL へ揃える。 */
const BASELINE = {
  longHeadings: 40, // PR 3 で 0 にする
  commaHeadings: 170, // PR 3 で 0 にする
  bannedEndings: 112, // PR 3 で 0 にする
  dateStamps: 160, // PR 3 で 0 にする
  staleUi: 94, // PR 3 で 0 にする
  historyWords: 20, // PR 3 で 0 にする
  lines: 10800, // PR 3 で 3,500 にする(実測 10773 + 余白)
  h3: 680, // PR 3 で 150 にする
} as const;

describe('マニュアルの書き方 ── 移行期の門(ratchet)', () => {
  it('BASELINE は FINAL 以上(門は下げる方向にしか動かせない)', () => {
    for (const k of Object.keys(FINAL) as Array<keyof typeof FINAL>) {
      expect(BASELINE[k], `${k}: BASELINE が FINAL を下回っている`).toBeGreaterThanOrEqual(FINAL[k]);
    }
  });

  it('空振り防止 ── 実物のマニュアルを読めている', () => {
    expect(scanHeadings(MANUAL).length).toBeGreaterThan(60);
    expect(totalLines(MANUAL)).toBeGreaterThan(1000);
  });

  it('条 3 ── 30 字を超える見出しを増やさない', () => {
    expect(longHeadings(MANUAL).length).toBeLessThanOrEqual(BASELINE.longHeadings);
  });
  it('条 3 ── 読点「、」を含む見出しを増やさない', () => {
    expect(commaHeadings(MANUAL).length).toBeLessThanOrEqual(BASELINE.commaHeadings);
  });
  it('条 3 ── 「〜を知る」「〜を確かめる」「〜のとき」で終わる見出しを増やさない', () => {
    expect(bannedEndingHeadings(MANUAL).length).toBeLessThanOrEqual(BASELINE.bannedEndings);
  });
  it('本文 ── 日付の印を含む行を増やさない', () => {
    expect(dateStampLines(MANUAL).length).toBeLessThanOrEqual(BASELINE.dateStamps);
  });
  it('本文 ── 古い画面の位置の言い方を増やさない', () => {
    expect(staleUiLines(MANUAL).length).toBeLessThanOrEqual(BASELINE.staleUi);
  });
  it('本文 ── 経緯の言い回しを増やさない', () => {
    expect(historyWordLines(MANUAL).length).toBeLessThanOrEqual(BASELINE.historyWords);
  });
  it('全体 ── 行数を増やさない', () => {
    expect(totalLines(MANUAL)).toBeLessThanOrEqual(BASELINE.lines);
  });
  it('全体 ── H3 の数を増やさない', () => {
    expect(h3Count(MANUAL)).toBeLessThanOrEqual(BASELINE.h3);
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
    expect(bannedEndingHeadings('### 開いたとき')).toHaveLength(0);
    expect(bannedEndingHeadings('### 保存のとき')).toHaveLength(1);
    expect(bannedEndingHeadings('### 困ったとき')).toEqual([]);
  });

  it('本文の日付の印・古い位置・経緯が鳴る', () => {
    expect(dateStampLines('入れます(2026-09-25)。')).toHaveLength(1);
    expect(dateStampLines('入れます（2026-09-25 から）。')).toHaveLength(1);
    expect(dateStampLines('例: 2026-09-25 のメモ')).toEqual([]);
    expect(staleUiLines('画面の下に出ます')).toHaveLength(1);
    expect(staleUiLines('ステータスバーに出ます')).toHaveLength(1);
    expect(staleUiLines('状態バーに出ます')).toHaveLength(1);
    expect(staleUiLines('上のタブを押す')).toHaveLength(1);
    expect(historyWordLines('以前は左にありました')).toHaveLength(1);
    expect(historyWordLines('従来どおり')).toHaveLength(1);
    expect(historyWordLines('旧版の仕様')).toHaveLength(1);
    expect(historyWordLines('こうなりました')).toEqual([]);
    expect(historyWordLines('名前が変わりました')).toEqual([]);
    expect(historyWordLines('ボタンが増えになりました')).toHaveLength(1);
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
    const after = ['## 章', '#### ショートカットの割り当てを変更する', '手順 A', '##### 小', '詳細', '## 次', '別'].join('\n');
    for (const t of [before, after]) {
      const s = sectionByTitle(t, '割り当て');
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

  it('題名が当たる節を全部つなぐ(入れ子は重ねない / 当たらなければ null)', () => {
    const doc = ['## 窓 A', 'あ', '### 窓の中', 'い', '## 無関係', 'う', '## 窓 B', 'え'].join('\n');
    const s = sectionsByTitle(doc, /窓/)!;
    expect(s.split('い').length - 1).toBe(1);
    expect(s).toContain('あ');
    expect(s).toContain('え');
    expect(s).not.toContain('う');
    expect(sectionsByTitle(doc, /存在しない/)).toBeNull();
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
