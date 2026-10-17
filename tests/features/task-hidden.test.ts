/** @vitest-environment node */
/**
 * 🔴 **読む側が読まない行を、書く側も書かない**(#1087)。
 *
 * ノートに見えていない行(隠しメモ・コード・数式)のチェック項目が、予定表・通知・完了数に出ていた。
 * ⚠ 期待値は**描く側の真値**(`renderMarkdown` が焼く `data-pkc-task-line`)から取る ──
 *   自前の規則で組むと、実装と同じ盲点を共有する(CLAUDE.md 検証の規律 §1.10)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripComments } from '../../src/features/markdown/markdown-render';
import { listTaskItems, countTaskCandidates } from '../../src/features/markdown/task-count';
import { hiddenTaskMask } from '../../src/features/markdown/task-hidden';
import { isTaskLine } from '../../src/features/markdown/body-rewrite';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { applyOpened } from '../helpers/open-line';

function drawnLines(body: string): number[] {
  const html = renderMarkdown(body, { interactiveTasks: true });
  return [...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]));
}

/** [名前, 本文]。⚠ 隠れる形と、隠れない対照(同じ本文に「見える」を置く)。 */
const CASES: ReadonlyArray<readonly [string, string]> = [
  ['%%% ブロック', '%%%\n- [ ] 隠れ @2026-10-20\n%%%\n\n- [ ] 見える @2026-10-21\n'],
  ['%%%text で始まるブロック', '%%%メモ\n- [ ] 隠れ @2026-10-20\n%%%\n- [ ] 見える @2026-10-21\n'],
  ['単一行 %%%x%%%', '%%%- [ ] 隠れ%%%\n- [ ] 見える @2026-10-21\n'],
  [':::comment', ':::comment\n- [ ] 隠れ @2026-10-20\n:::\n- [ ] 見える @2026-10-21\n'],
  [':::comment{attrs}', ':::comment{a=1}\n- [ ] 隠れ\n:::\n- [ ] 見える\n'],
  ['閉じの無い :::comment は本文として戻る', ':::comment\n- [ ] 戻る\n'],
  ['fence の中の %%%(生きない)', '```\n%%%\n```\n- [ ] 見える\n'],
  ['インライン %%…%%(行頭)', '%% - [ ] 隠れ @2026-10-20 %%\n- [ ] 見える @2026-10-21\n'],
  ['字下げコード(空行の後)', 'para\n\n    - [ ] コード @2026-10-20\n\n- [ ] 見える\n'],
  ['字下げコード(文書の先頭)', '    - [ ] コード\n- [ ] 見える\n'],
  ['字下げコードの続き(空行をまたぐ)', 'a\n\n    x\n\n    - [ ] コード\n- [ ] 見える\n'],
  ['リストの続きの字下げ(コードではない)', '- x\n\n    - [ ] 入れ子\n'],
  ['リストの中の深い字下げ(コード)', '- x\n\n          - [ ] コード\n- [ ] 見える\n'],
  ['引用の中の fence', '> ```\n> - [ ] 隠れ @2026-10-20\n> ```\n- [ ] 見える @2026-10-21\n'],
  ['引用の外で終わる fence', '> ```\n> - [ ] 隠れ\n\n- [ ] 見える\n'],
  ['引用の中のチェックは見える', '> - [ ] 引用 @2026-10-20\n'],
  ['$$ 数式の塊', '$$\n- [ ] 隠れ @2026-10-20\n$$\n- [ ] 見える @2026-10-21\n'],
  ['閉じの無い $$ は段落', '$$\n- [ ] 見える\n'],
  ['fence の中の $$ は対にならない', '```\n$$\n```\n- [ ] 見える\n$$\n'],
  ['入れ子のチェック', '- [ ] 親\n  - [ ] 子\n    - [ ] 孫\n'],
  ['番号つき', '1. [ ] a\n2) [x] b\n'],
  ['CRLF の %%%', '%%%\r\n- [ ] 隠れ\r\n%%%\r\n- [ ] 見える\r\n'],
];

describe('読む側は、描く側が出すチェック欄と同じ行を読む(#1087)', () => {
  for (const [name, body] of CASES) {
    it(name, () => {
      expect(listTaskItems(body).map((i) => i.line)).toEqual(drawnLines(body));
    });
  }

  it('⚠ 空振り防止:隠れ行を除かない素朴な読みより少ない形が、10 件以上ある', () => {
    let hiddenForms = 0;
    for (const [, body] of CASES) {
      const naive = body
        .split(/\r?\n/)
        .filter((l) => /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(l)).length;
      if (naive > drawnLines(body).length) hiddenForms++;
    }
    expect(hiddenForms).toBeGreaterThanOrEqual(10);
  });

  it('候補の数(保存時の列)も隠れ行を数えない', () => {
    expect(countTaskCandidates('%%%\n- [ ] a\n- [x] b\n%%%\n- [ ] c\n')).toEqual({ total: 1, done: 0 });
    expect(countTaskCandidates(':::comment\n- [ ] a\n:::\n').total).toBe(0);
    expect(countTaskCandidates('$$\n- [ ] a\n$$\n').total).toBe(0);
  });

  it('予定表の札も隠れ行から立たない', () => {
    const body =
      '%%%\n- [ ] 隠れ @2026-10-20\n%%%\n\n:::comment\n- [ ] 隠れ2 @2026-10-20\n:::\n- [ ] 見える @2026-10-21\n';
    expect(taskCardsOf('L', body).map((c) => c.date)).toEqual(['2026-10-21']);
  });
});

describe('隠しメモの範囲は、描く側の stripComments と同じ(#1087)', () => {
  const bodies = [
    '%%%\na\nb\n%%%\nc\n',
    ':::comment\na\n:::\nb\n',
    '%%%x\ny\n%%%\nz\n',
    'p\n```\n%%%\n```\n%%%\nq\n%%%\nr\n',
    ':::comment\na\n```\n:::\n```\n:::\nb\n',
    '%%%a%%%\nb\n',
  ];
  for (const body of bodies) {
    it(JSON.stringify(body), () => {
      const lines = body.split('\n');
      const kept = new Set(stripComments(body).lineMap);
      const mask = hiddenTaskMask(lines);
      let compared = 0;
      // 内容の行(マーカー行・fence の行・空行でない)だけ比べる:描く側が出力に残した行 = 隠れていない行
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '' || /^(?:%%%|:::comment|:::$|```)/.test(lines[i]!)) continue;
        compared++;
        expect(mask[i] === true, `行 ${i}: ${lines[i]}`).toBe(!kept.has(i));
      }
      expect(compared, '比べた行が 0 件(空振り)').toBeGreaterThan(0);
    });
  }
});

describe('書く側も、読む側が読まない行を書かない(#1087)', () => {
  const hiddenBodies: ReadonlyArray<readonly [string, string, number]> = [
    ['%%%', '%%%\n- [ ] 隠れ @2026-10-20\n%%%\n', 1],
    [':::comment', ':::comment\n- [ ] 隠れ @2026-10-20\n:::\n', 1],
    ['字下げコード', 'a\n\n    - [ ] コード @2026-10-20\n', 2],
    ['数式', '$$\n- [ ] 隠れ @2026-10-20\n$$\n', 1],
    ['引用の中の fence', '> ```\n> - [ ] 隠れ @2026-10-20\n> ```\n', 1],
  ];
  for (const [name, body, line] of hiddenBodies) {
    it(`${name}:印も日付も書かず、項目とも見なさない`, () => {
      expect(isTaskLine(body, line)).toBe(false);
      expect(applyOpened(body, { kind: 'task', line })).toBeNull();
      expect(applyOpened(body, { kind: 'line-date', line, date: '2026-10-25' })).toBeNull();
    });
  }

  it('対照:見える行は今までどおり書ける(印・日付)', () => {
    const body = '%%%\n- [ ] 隠れ\n%%%\n- [ ] 見える @2026-10-20\n';
    expect(isTaskLine(body, 3)).toBe(true);
    expect(applyOpened(body, { kind: 'task', line: 3 })).toBe(
      '%%%\n- [ ] 隠れ\n%%%\n- [x] 見える @2026-10-20\n',
    );
    expect(applyOpened(body, { kind: 'line-date', line: 3, date: '2026-10-25' })).toBe(
      '%%%\n- [ ] 隠れ\n%%%\n- [ ] 見える @2026-10-25\n',
    );
  });

  it('読む側が読む行の全部が、書く側でも書ける(CASES 全体で)', () => {
    let checked = 0;
    for (const [name, body] of CASES) {
      for (const item of listTaskItems(body)) {
        expect(isTaskLine(body, item.line), `${name}: 行 ${item.line}`).toBe(true);
        expect(applyOpened(body, { kind: 'task', line: item.line }), `${name}: 行 ${item.line}`).not.toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });
});
