/**
 * 🔴 **計った時間の行を読む・直す**(#683 ①)。正本は本文の 1 行:
 * `- 作業 2026-08-27 06:40–07:03(23:11)`(+ 終わりに名前)。
 *
 * 見るのは:①タイマーが本当に書く行(`workLogLine`)を読み戻せる(書く側と読む側が割れない)
 * ②名前の付け替え・外すが行頭の字下げ・記号を保つ ③書換(`work-log`)が行番号 + 押した時点の行で当たり、
 * 食い違えば書かない ④消すと前後の行・改行コードが保たれる ⑤日ごとの束ねと合計。
 */
import { describe, expect, it } from 'vitest';
import { workLogLine } from '../../src/features/timer/timer-run';
import {
  groupWorkRuns,
  relabelWorkLine,
  spanMs,
  visibleWorkRuns,
  workRunsOf,
} from '../../src/features/timer/work-log';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';

describe('読む', () => {
  it('🔴 タイマーが書く行をそのまま読み戻せる(日をまたぐ回も)', () => {
    const same = workLogLine(new Date(2026, 7, 27, 6, 40), new Date(2026, 7, 27, 7, 3, 11));
    const cross = workLogLine(new Date(2026, 7, 27, 23, 50), new Date(2026, 7, 28, 0, 20));
    const runs = workRunsOf('a', `メモ\n${same}\n${cross}\n`);
    expect(runs.map((r) => [r.line, r.from, r.to, r.label])).toEqual([
      [1, '2026-08-27 06:40', '2026-08-27 07:03', ''],
      [2, '2026-08-27 23:50', '2026-08-28 00:20', ''],
    ]);
    expect(runs[0]!.span).toBe('23:11');
    expect(runs[0]!.rawLine).toBe(same);
  });

  it('名前を読む / 字下げ・番号つきも読む / 形の違う行は読まない', () => {
    const body = [
      '- 作業 2026-08-27 06:40–07:03(23:11) 見積の作成',
      '  * 作業 2026-08-27 08:00–09:00(1:00:00)',
      '作業 2026-08-27 06:40–07:03(23:11)',
      '- 作業 2026-8-27 06:40–07:03(23:11)',
      '- 作業 メモ',
    ].join('\n');
    const runs = workRunsOf('a', body);
    expect(runs.map((r) => [r.line, r.label, r.span])).toEqual([
      [0, '見積の作成', '23:11'],
      [1, '', '1:00:00'],
    ]);
  });

  it('コードの囲みの中は読まない(予定と同じ規則)', () => {
    expect(workRunsOf('a', '```\n- 作業 2026-08-27 06:40–07:03(23:11)\n```\n')).toEqual([]);
    expect(workRunsOf('a', 'ただの文章\n')).toEqual([]);
  });

  it('CRLF の本文でも行番号が合う', () => {
    const runs = workRunsOf('a', 'x\r\n- 作業 2026-08-27 06:40–07:03(23:11)\r\n');
    expect(runs.map((r) => [r.line, r.rawLine])).toEqual([[1, '- 作業 2026-08-27 06:40–07:03(23:11)']]);
  });
});

describe('名前の付け替え', () => {
  const RAW = '- 作業 2026-08-27 06:40–07:03(23:11)';
  it('付ける / 直す / 外す', () => {
    const named = relabelWorkLine(RAW, '  見積   の作成 ')!;
    expect(named).toBe(`${RAW} 見積 の作成`);
    expect(relabelWorkLine(named, '請求')).toBe(`${RAW} 請求`);
    expect(relabelWorkLine(named, '')).toBe(RAW);
    // 外す → 付ける → 読み戻せる(往復)
    expect(workRunsOf('a', named)[0]!.label).toBe('見積 の作成');
  });
  it('字下げ・記号を保つ / 行でないものは null', () => {
    expect(relabelWorkLine('  * 作業 2026-08-27 06:40–07:03(23:11)', 'x')).toBe('  * 作業 2026-08-27 06:40–07:03(23:11) x');
    expect(relabelWorkLine('ただの文', 'x')).toBeNull();
  });
});

describe('本文の書換(work-log)', () => {
  const A = '- 作業 2026-08-27 06:40–07:03(23:11)';
  const B = '- 作業 2026-08-28 09:00–09:30(30:00) 請求';
  const body = `見出し\n${A}\n${B}\n終わり\n`;

  it('🔴 行を置き換える。前後の行は 1 バイトも動かない', () => {
    const next = relabelWorkLine(A, '見積')!;
    const out = applyBodyRewrite(body, { kind: 'work-log', line: 1, openLine: A, next });
    expect(out).toBe(`見出し\n${next}\n${B}\n終わり\n`);
  });

  it('🔴 消す: その行と改行だけが無くなる(最後の行・先頭の行・CRLF でも)', () => {
    expect(applyBodyRewrite(body, { kind: 'work-log', line: 1, openLine: A, next: null })).toBe(
      `見出し\n${B}\n終わり\n`,
    );
    // 最後の行(末尾に改行が無い本文)
    expect(applyBodyRewrite(`x\n${A}`, { kind: 'work-log', line: 1, openLine: A, next: null })).toBe('x');
    // 先頭の行
    expect(applyBodyRewrite(`${A}\nx`, { kind: 'work-log', line: 0, openLine: A, next: null })).toBe('x');
    // CRLF は保つ
    expect(
      applyBodyRewrite(`x\r\n${A}\r\ny\r\n`, { kind: 'work-log', line: 1, openLine: A, next: null }),
    ).toBe('x\r\ny\r\n');
  });

  it('🔴 押した時点の行と違えば書かない(別の窓が行を足した形で、別の行を消さない)', () => {
    const shifted = `新しい行\n${body}`;
    expect(applyBodyRewrite(shifted, { kind: 'work-log', line: 1, openLine: A, next: null })).toBeNull();
    expect(applyBodyRewrite(body, { kind: 'work-log', line: 99, openLine: A, next: null })).toBeNull();
  });
});

describe('日ごとの束ねと合計', () => {
  it('新しい日が先・日の中は終わりの新しい順・合計は経過の和', () => {
    const runs = workRunsOf(
      'a',
      [
        '- 作業 2026-08-27 06:40–07:03(23:11)',
        '- 作業 2026-08-28 09:00–09:30(30:00)',
        '- 作業 2026-08-27 13:00–14:00(1:00:00)',
      ].join('\n'),
    );
    const days = groupWorkRuns(runs);
    expect(days.map((d) => d.day)).toEqual(['2026-08-28', '2026-08-27']);
    expect(days[1]!.runs.map((r) => r.span)).toEqual(['1:00:00', '23:11']);
    expect(days[1]!.totalMs).toBe((23 * 60 + 11 + 3600) * 1000);
    expect(spanMs('1:02:03')).toBe(3723000);
    expect(spanMs('x:y')).toBe(0);
  });

  it('語で絞る(題名・名前・日付)', () => {
    const runs = [
      ...workRunsOf('a', '- 作業 2026-08-27 06:40–07:03(23:11) 見積'),
      ...workRunsOf('b', '- 作業 2026-09-01 06:40–07:03(23:11)'),
    ];
    const t = (lid: string): string => (lid === 'a' ? '会議' : '資料');
    expect(visibleWorkRuns(runs, '', t)).toHaveLength(2);
    expect(visibleWorkRuns(runs, '見積', t).map((r) => r.lid)).toEqual(['a']);
    expect(visibleWorkRuns(runs, '資料 2026-09', t).map((r) => r.lid)).toEqual(['b']);
    expect(visibleWorkRuns(runs, 'ない語', t)).toEqual([]);
  });
});
