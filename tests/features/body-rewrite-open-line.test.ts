/**
 * 🔴 **押した時点の行の中身(`openLine`)が違えば、書換は書かない**(#1087)。
 *
 * > 起きる場面:窓 A で別のノート X を編集中に、窓 B がノート Y のチェックリストの上へ 1 行足す。
 * > 窓 A に残っている古い Y の表示(横に留めた枠・予定の札)で項目を押すと、行番号だけでは
 * > 押していない別の項目が切り替わっていた(編集中のタブは他のノートの変更を取りに行かない)。
 *
 * ⚠ ここは**自動で埋める版(`tests/helpers/open-line.ts`)ではなく実物**の `applyBodyRewrite` に
 *   `openLine` を自分で渡す ── 埋める版は「いまの本文のその行」を添えるので、行ずれは検査できない。
 * 🔑 どの kind も同じ組:①**押した時点の本文**に当てれば書ける(対照群 ── 門が閉じっぱなしでない)
 *   ②**1 行足された本文**に同じ手を当てると `null`(別の項目を書かない)。
 */
import { describe, expect, it } from 'vitest';
import {
  applyBodyRewrite,
  bodyLineAt,
  isRepeatAlreadyDone,
} from '../../src/features/markdown/body-rewrite';

// 窓 A が見ている古い本文と、窓 B が先頭へ 1 行足した後の disk
const SHOWN = '- [ ] A\n- [ ] B\n';
const DISK = '- [ ] 新規\n- [ ] A\n- [ ] B\n';
const RULE_SHOWN = '- [ ] ゴミ出し @2026-09-07 毎週\n';
const RULE = '- [ ] ゴミ出し @2026-09-07 毎週';
// 窓 B が先頭へ足したのが「別の繰り返しの規則」だった形 ── 規則かどうかの門に救われない
// (「規則でない行だから書けない」で断られる形では、行の中身の門が無くても緑になる)
const RULE_DISK = `- [ ] 掃除 @2026-09-07 毎週\n${RULE_SHOWN}`;

describe('task ── チェックの切り替え', () => {
  it('🔴 報告された再現:1 行足された本文の 0 行目は A ではなく「新規」', () => {
    // 窓 A の画面では 0 行目が A。押した時点の中身 `- [ ] A` を運ぶ
    const rw = { kind: 'task' as const, line: 0, openLine: '- [ ] A' };
    expect(applyBodyRewrite(SHOWN, rw), '対照群:押した時点の本文には書ける').toBe('- [x] A\n- [ ] B\n');
    expect(applyBodyRewrite(DISK, rw), '押していない「新規」が切り替わった').toBeNull();
  });

  it('⚠ 運び忘れ(空文字)は書かない', () => {
    expect(applyBodyRewrite(SHOWN, { kind: 'task', line: 0, openLine: '' })).toBeNull();
  });

  it('🔴 byte 一致 ── 字下げ違いの同じ項目でも書かない', () => {
    expect(applyBodyRewrite(SHOWN, { kind: 'task', line: 0, openLine: '-   [ ] A' })).toBeNull();
  });

  it('🔴 印の向きが違う行も書かない(別の窓が先に押していた)', () => {
    // 窓 A の画面では未完了(`[ ]`)。disk では別の窓が既に完了にしている
    expect(applyBodyRewrite('- [x] A\n', { kind: 'task', line: 0, openLine: '- [ ] A' })).toBeNull();
  });
});

describe('line-date ── 行の日付・刻み', () => {
  it('🔴 1 行足されたら日付を書かない', () => {
    const rw = { kind: 'line-date' as const, line: 0, openLine: '- [ ] A', date: '2026-09-10' };
    expect(applyBodyRewrite(SHOWN, rw), '対照群:押した時点の本文には書ける').toBe('- [ ] A @2026-09-10\n- [ ] B\n');
    expect(applyBodyRewrite(DISK, rw), '押していない行に日付が付いた').toBeNull();
  });

  it('🔴 刻みだけ付け替える形(`date` を省く)も同じ門を通る', () => {
    const rw = { kind: 'line-date' as const, line: 0, openLine: RULE, repeat: 'month' as const };
    expect(applyBodyRewrite(RULE_SHOWN, rw), '対照群').toBe('- [ ] ゴミ出し @2026-09-07 毎月\n');
    expect(applyBodyRewrite(RULE_DISK, rw)).toBeNull();
  });

  it('🔴 日付を外す形(`date: null`)も同じ門を通る', () => {
    const shown = '- [ ] A @2026-09-10\n';
    const rw = { kind: 'line-date' as const, line: 0, openLine: '- [ ] A @2026-09-10', date: null };
    expect(applyBodyRewrite(shown, rw), '対照群').toBe('- [ ] A\n');
    expect(applyBodyRewrite(`- [ ] 新規 @2026-09-11\n${shown}`, rw), '押していない行の日付が外れた').toBeNull();
  });
});

describe('repeat-done / repeat-move ── 繰り返しの回', () => {
  it('🔴 repeat-done ── 1 行足されたら、規則でない行の回を実体にしない', () => {
    const rw = { kind: 'repeat-done' as const, line: 0, openLine: RULE, date: '2026-09-14' };
    expect(applyBodyRewrite(RULE_SHOWN, rw), '対照群:押した時点の本文には書ける').toContain('- [x] ゴミ出し @2026-09-14');
    expect(applyBodyRewrite(RULE_DISK, rw)).toBeNull();
  });

  it('🔴 repeat-move ── 1 行足されたら、その回を動かさない', () => {
    const rw = {
      kind: 'repeat-move' as const,
      line: 0,
      openLine: RULE,
      from: '2026-09-14',
      to: '2026-09-16',
    };
    expect(applyBodyRewrite(RULE_SHOWN, rw), '対照群:押した時点の本文には書ける').toContain('振替2026-09-14');
    expect(applyBodyRewrite(RULE_DISK, rw)).toBeNull();
  });

  /**
   * ⚠ `store-effects` は断られたあとに `isRepeatAlreadyDone` を引く ──「もう完了しています」は
   *   **本当に同じ回が書かれている**ときだけ言う。行ずれで断られた回に言うと、押していない行を
   *   済ませた顔になる(嘘の安心)。既存の判定(二度押しの 2 度目)は壊れていない。
   */
  it('🔴 行がずれて断られた回を「もう完了」と言わない / 二度押しの 2 度目は今までどおり言う', () => {
    const rw = { kind: 'repeat-done' as const, line: 0, openLine: RULE, date: '2026-09-14' };
    const done = applyBodyRewrite(RULE_SHOWN, rw)!;
    expect(isRepeatAlreadyDone(done, rw), '対照群:同じ回が書かれていれば言う(二度押し)').toBe(true);
    // 別の規則(掃除)の 9/14 の回が既に実体になっている disk ── 行の中身の門が無いと「もう完了」と読まれる
    const other = '- [ ] 掃除 @2026-09-07 毎週\n- [x] 掃除 @2026-09-14\n';
    expect(isRepeatAlreadyDone(other, rw), '行ずれを「もう完了」と読んだ').toBe(false);
  });
});

describe('csv-cell ── 表の升', () => {
  it('🔴 1 行足されたら、別の行の升を書き換えない', () => {
    const shown = '```csv\n品名,数\nりんご,3\n```\n';
    const disk = '```csv\n品名,数\nみかん,9\nりんご,3\n```\n';
    // 窓 A の画面では 2 行目(りんご,3)の 0 列目
    const rw = { kind: 'csv-cell' as const, line: 2, openLine: 'りんご,3', col: 0, value: 'ばなな' };
    expect(applyBodyRewrite(shown, rw), '対照群:押した時点の本文には書ける').toBe('```csv\n品名,数\nばなな,3\n```\n');
    expect(applyBodyRewrite(disk, rw), '押していない「みかん」の行が書き換わった').toBeNull();
  });

  it('🔴 markdown の表の升も同じ門を通る', () => {
    const shown = '| 品名 | 数 |\n| --- | --- |\n| りんご | 3 |\n';
    const disk = `| 品名 | 数 |\n| --- | --- |\n| みかん | 9 |\n| りんご | 3 |\n`;
    const rw = { kind: 'csv-cell' as const, line: 2, openLine: '| りんご | 3 |', col: 0, value: 'ばなな' };
    expect(applyBodyRewrite(shown, rw), '対照群').toContain('| ばなな | 3 |');
    expect(applyBodyRewrite(disk, rw)).toBeNull();
  });
});

describe('task-run ── リストをそろえる', () => {
  const SHOWN_LINES = ['- [ ] A', '- [ ] B', '- [ ] C'];
  const all = { kind: 'task-run' as const, lines: [0, 1, 2], openLines: SHOWN_LINES, to: 'done' as const };

  it('🔴 全部の行がずれていれば 1 行も書かない', () => {
    expect(applyBodyRewrite(`${SHOWN_LINES.join('\n')}\n`, all), '対照群:押した時点の本文には書ける').toBe(
      '- [x] A\n- [x] B\n- [x] C\n',
    );
    // disk の 0 行目は「新規」、1 行目 A ≠ 運んだ B、2 行目 B ≠ C ── 全部違う
    expect(applyBodyRewrite('- [ ] 新規\n- [ ] A\n- [ ] B\n- [ ] C\n', all), '押していない項目が完了になった').toBeNull();
  });

  it('🔴 合う行だけ書き、合わない行は飛ばす(1 行の食い違いで他を止めない)', () => {
    // 窓 B が末尾へ足しただけなら、見ていた 3 行はそのまま合う
    expect(applyBodyRewrite(`${SHOWN_LINES.join('\n')}\n- [ ] 末尾\n`, all)).toBe(
      '- [x] A\n- [x] B\n- [x] C\n- [ ] 末尾\n',
    );
    // 1 行だけ書き換わっていた(B → B 改): その行は飛ばし、A と C は書く
    expect(applyBodyRewrite('- [ ] A\n- [ ] B 改\n- [ ] C\n', all), '合わない行まで書いた').toBe(
      '- [x] A\n- [ ] B 改\n- [x] C\n',
    );
  });

  it('⚠ 運んだ中身の数が行の数と違えば、1 行も書かない(運び忘れは断る側)', () => {
    const rw = { kind: 'task-run' as const, lines: [0, 1], openLines: ['- [ ] A'], to: 'done' as const };
    expect(applyBodyRewrite(SHOWN, rw)).toBeNull();
  });
});

describe('bodyLineAt ── 押した時点の行を取り出す口', () => {
  it('書換が比べる行と同じ取り方(CRLF の復帰を落とす / 無い行は null)', () => {
    expect(bodyLineAt('a\r\nb\n', 0)).toBe('a');
    expect(bodyLineAt('a\r\nb\n', 1)).toBe('b');
    expect(bodyLineAt('a\r\nb\n', 2)).toBe('');
    expect(bodyLineAt('a\r\nb\n', 3)).toBeNull();
    expect(bodyLineAt('a', -1)).toBeNull();
    expect(bodyLineAt('a', 0.5)).toBeNull();
  });

  it('🔴 取った行は、そのまま書換の openLine に使える(CRLF の本文でも断られない)', () => {
    const crlf = '- [ ] a\r\n- [ ] b\r\n';
    const openLine = bodyLineAt(crlf, 1)!;
    expect(applyBodyRewrite(crlf, { kind: 'task', line: 1, openLine })).toBe('- [ ] a\r\n- [x] b\r\n');
  });
});
