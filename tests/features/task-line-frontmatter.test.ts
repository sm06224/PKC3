/**
 * 🔴 **チェックの印は、押した項目と同じ行を書き換える**(N1)。
 *
 * ## 何が起きていたか
 *
 * | 段 | 何をしているか | 行番号の基準 |
 * |---|---|---|
 * | 焼く | `markdown-render.ts` の `data-pkc-task-line` | 読む面は **`fm.body`**(frontmatter を剥がした本文)を描く |
 * | 受ける | `binder.ts` の `toggle-task` → `TOGGLE_TASK` → `body-rewrite.ts` | **原文**(`body.split('\n')[line]` を splice) |
 *
 * ⇒ frontmatter が N 行あると、**N 行ぶん上の別の行**が書き換わる。
 * ⚠ しかも live editor は同じ補正を**明示的に持っている**(`detail.ts` の
 *   `startLine + fmLines`。docstring に「そのまま splice すると frontmatter の行を
 *   書き潰す」と戒めまで書いてある)── **`toggle-task` だけがその規則の外に居た**
 *   (CLAUDE.md §7「同じ判定が複数の場所にある」)。
 *
 * ## ⚠ かんばんは**ずらさない**側である(混ぜない)
 *
 * かんばんの札は `listTaskItems(row.body)` = **原文**から行を採る
 * (`app-state.ts` の `replaceTaskCards`)。つまり同じ `toggle-task` を
 * **2 つの面が逆の約束で撃っていた**。だから直しは受け手ではなく
 * **剥がして描く面の側**に置く(`taskLineOffset`。既定は `0` = 何も変えない)。
 *
 * ## ⚠ 既存 fixture が測っていなかった次元
 *
 * `tests/features/task-checkbox.test.ts` も `task-checkbox.smoke.spec.ts` も
 * **frontmatter 0 行**の本文しか使っていない ── ゼロ件の次元は「測っていない次元」
 * (CLAUDE.md §2)。ここがその次元を埋める。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';

/** 焼かれた `data-pkc-task-line` を出た順に読む。 */
const lines = (html: string): number[] =>
  [...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]));

/** 読む面と同じ描き方(剥がして描き、ずらしを渡す)。 */
function renderReadSurface(body: string): string {
  const fm = parseFrontmatter(body);
  return renderMarkdown(fm.body, {
    interactiveTasks: true,
    taskLineOffset: frontmatterLineCount(body),
  });
}

const FM = '---\ntags: [買い物]\nstatus: open\n---\n';
const DOC = '# 題\n\n- [ ] あ\n- [ ] い\n- [ ] う\n';

describe('チェックの印の行番号は、原文の行を指す(N1)', () => {
  /**
   * 🔴 **対照群**(空振り防止)。frontmatter が無ければずらしは 0 で、
   * 直す前と 1 バイトも変わらない ── ここが落ちるなら以下は別の理由で通っている。
   */
  it('対照群: frontmatter が無い本文では、行番号は今までどおり', () => {
    expect(frontmatterLineCount(DOC), '前提が崩れている').toBe(0);
    expect(lines(renderReadSurface(DOC))).toEqual(lines(renderMarkdown(DOC, { interactiveTasks: true })));
  });

  it('🔴 frontmatter がある本文では、原文の行を指す(剥がした行ではない)', () => {
    const body = FM + DOC;
    const fmLines = frontmatterLineCount(body);
    expect(fmLines, '前提が崩れている(frontmatter を数えられていない)').toBe(4);

    const got = lines(renderReadSurface(body));
    expect(got.length, 'チェック項目が焼けていない(この検査は空振り)').toBe(3);

    // 🔑 **原文で数え直す** ── 期待値を手で書かない(手で書くと、実装と同じ
    //    間違いをして「合っている」ことにできる)
    const raw = body.split('\n');
    for (const at of got) {
      expect(raw[at], `原文の ${at} 行目がチェック項目でない(別の行を指している)`).toMatch(
        /^- \[[ x]\] /,
      );
    }
  });

  /**
   * 🔴 **直す前に何が起きていたか**を、そのまま表にして残す。
   * ⚠ ずらしを渡さないと、指す先は**frontmatter の中**になる ── つまり
   *   押すと `tags:` の行が `- [x] …` に書き換わる。
   */
  it('🔴 ずらしを渡さないと frontmatter の中を指す(直す前の症状)', () => {
    const body = FM + DOC;
    const bad = lines(renderMarkdown(parseFrontmatter(body).body, { interactiveTasks: true }));
    const raw = body.split('\n');
    expect(bad.length, '前提が崩れている').toBe(3);
    // 直す前の 1 件目は原文の 2 行目 = `status: open`(チェック項目ではない)
    expect(raw[bad[0]!], 'この test の前提が崩れている(症状が再現しない)').not.toMatch(
      /^- \[[ x]\] /,
    );
  });

  /**
   * ⚠ **ずらしは frontmatter の行数と一致する** ── 2 本目の計算を置かない
   * (`detail.ts` の live editor も同じ 1 つを使う)。
   */
  it('🔴 ずらした量が frontmatter の行数と一致する', () => {
    const body = FM + DOC;
    const withFm = lines(renderReadSurface(body));
    const without = lines(renderMarkdown(DOC, { interactiveTasks: true }));
    expect(withFm.length).toBe(without.length);
    for (let i = 0; i < withFm.length; i++) {
      expect(withFm[i]! - without[i]!, `${i} 件目のずれが frontmatter の行数と違う`).toBe(
        frontmatterLineCount(body),
      );
    }
  });
});

/**
 * 🔴 **読む面が実際にずらしを渡しているか**(渡し忘れの検出)。
 * ⚠ option を足しただけで渡さなければ、この直しは 1 ミリも効かない ──
 *   optional な引数は「落としても tsc が黙る」ので、原文で pin する
 *   (CLAUDE.md §1「材料が実際に届いていることを pin する」)。
 */
describe('読む面が、ずらしを実際に渡している', () => {
  it('🔴 detail.ts の読む面が taskLineOffset を渡している', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/adapter/ui/render/detail.ts', 'utf-8');
    // ⚠ コメントに満たされない形で見る ── 実行する行そのものを探す
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code, '読む面がずらしを渡していない(option が死んでいる)').toMatch(
      /taskLineOffset:\s*frontmatterLineCount\(body\)/,
    );
    expect(code, 'ずらしの計算が 2 本目に増えている').not.toMatch(/taskLineOffset:\s*\d/);
  });
});
