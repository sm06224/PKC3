/**
 * 🔴 **数える側は、描く側の superset である**(#277 段②)。
 *
 * カンバンは「チェック項目を持つノート」だけを候補にする。候補を決めるのが
 * `countTaskCandidates` で、実際に画面へ出る項目を決めるのは **markdown-it
 * (描く側)**である ── この 2 つがずれると:
 *
 * - **多く数える** → 候補に余分が入るだけ(本文を読んで 0 件と分かる)。無害
 * - 🔴 **少なく数える** → そのノートが候補から漏れ、**項目が永久に出ない**
 *
 * ⚠ だから等値ではなく **`数える側 >= 描く側`** を pin する。
 * ⚠ そして **描く側は自分で書き直さない** ── `renderMarkdown` が焼いた
 *   `data-pkc-task-line` を数える(#277 段① で入れた、画面と同じ値)。
 *   ここを自前の正規表現で書くと「同じ問いに答える口が 3 つ目」になる。
 */
import { describe, expect, it } from 'vitest';
import { countTaskCandidates } from '../../src/features/markdown/task-count';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/** 🔑 **描く側の真値** ── 画面に出るチェック欄の数(自前で数え直さない)。 */
function drawn(body: string): number {
  return [...renderMarkdown(body, { interactiveTasks: true }).matchAll(/data-pkc-task-line="/g)]
    .length;
}

/**
 * ⚠ **実測で見つけた食い違いを含める**(2026-08-19 に probe で当てた)。
 * `引用の中` と `字下げ 4 のコード` が、素朴な行走査だと割れる 2 件である。
 */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['素直な一覧', '- [ ] a\n- [x] b\n'],
  ['見出しの後', '# 題\n\n- [ ] a\n'],
  ['fence の中', '```\n- [ ] にせもの\n```\n\n- [ ] ほんもの\n'],
  ['~~~ fence', '~~~\n- [ ] にせもの\n~~~\n\n- [ ] ほんもの\n'],
  ['言語つき fence', '```ts\n- [ ] にせ\n```\n- [ ] 本\n'],
  ['fence を閉じ忘れ', '```\n- [ ] 中\n'],
  ['🔴 引用の中', '> - [ ] 引用の中\n'],
  ['🔴 引用の入れ子', '> > - [x] 二重の引用\n'],
  ['🔴 字下げ 4 のコード', '    - [ ] コード扱い\n\n- [ ] 本物\n'],
  ['入れ子', '- [ ] 親\n  - [ ] 子\n'],
  ['番号つき', '1. [ ] a\n2) [x] b\n'],
  ['印の後ろが空', '- [ ]\n'],
  ['ただの箇条書き', '- ふつう\n- [ ] これは task\n'],
  ['list でない角括弧', '[x] 行頭の角括弧\n'],
  ['表の中', '| a | b |\n|---|---|\n| - [ ] x | y |\n'],
  [':::note の中', ':::note\n- [ ] 中身\n:::\n'],
  ['寄せ記号の後', '|> 寄せた段落\n\n- [ ] a\n'],
  ['frontmatter の後', '---\ntags: [x]\n---\n- [ ] a\n'],
  ['大文字 X', '- [X] 大文字\n'],
  ['印の中に空白 2 つ', '- [  ] だめ\n'],
  ['空', ''],
  ['角括弧なし', '# 題\n\nただの本文。\n'],
];

describe('チェック項目の候補を数える(#277 段②)', () => {
  /**
   * 🔴 **これが本丸** ── 全 corpus で `数える側 >= 描く側`。
   * ⚠ 1 件でも下回ったら、そのノートはカンバンから**消える**。
   */
  it('🔴 描く側より少なく数えない(全 corpus)', () => {
    const under: string[] = [];
    for (const [name, body] of CORPUS) {
      const mine = countTaskCandidates(body).total;
      const theirs = drawn(body);
      if (mine < theirs) under.push(`${name}: 数える側=${mine} 描く側=${theirs}`);
    }
    expect(under, '少なく数えている(そのノートはカンバンから消える)').toEqual([]);
  });

  /**
   * ⚠ **空振り防止** ── corpus に「項目が実際に出る」形が十分入っていること。
   * これが無いと、`countTaskCandidates` が常に 0 を返す実装でも上の test は通る。
   */
  it('⚠ corpus が実際にチェック項目を含んでいる(空振り防止)', () => {
    const withTasks = CORPUS.filter(([, b]) => drawn(b) > 0);
    expect(withTasks.length, 'corpus に項目の出る形が少なすぎる').toBeGreaterThanOrEqual(12);
    // ⚠ そして数える側も、そのぶんちゃんと拾っていること(常に 0 を返す実装を弾く)
    for (const [name, body] of withTasks) {
      expect(countTaskCandidates(body).total, `${name}: 1 件も拾っていない`).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **引用の中は、実際に描かれる**(素朴な行走査が落とす 1 件目)。
   * ⚠ ここを落とすと、引用でチェックリストを書いた人のノートが丸ごと消える。
   */
  it('🔴 引用の中のチェックを拾う', () => {
    expect(drawn('> - [ ] 引用の中\n'), '前提が崩れている(描く側が拾っていない)').toBe(1);
    expect(countTaskCandidates('> - [ ] 引用の中\n')).toEqual({ total: 1, done: 0 });
    expect(countTaskCandidates('> > - [x] 二重\n')).toEqual({ total: 1, done: 1 });
  });

  /** ⚠ **多めに数えるのは許す**(字下げ 4 = 描く側はコード扱い)。 */
  it('多めに数えるのは許す(字下げ 4 のコード)', () => {
    const body = '    - [ ] コード扱い\n\n- [ ] 本物\n';
    expect(drawn(body), '描く側はコードとして数えない').toBe(1);
    expect(countTaskCandidates(body).total, '多め側に倒れていない').toBe(2);
  });

  it('fence の中は数えない(閉じ忘れも含む)', () => {
    expect(countTaskCandidates('```\n- [ ] にせ\n```\n- [ ] 本\n').total).toBe(1);
    expect(countTaskCandidates('```\n- [ ] 中\n').total, 'fence 閉じ忘れで漏れた').toBe(0);
    // ⚠ 短い fence は長い fence を閉じない
    expect(countTaskCandidates('````\n```\n- [ ] まだ中\n````\n').total).toBe(0);
  });

  it('印の数(done)も数える', () => {
    expect(countTaskCandidates('- [ ] a\n- [x] b\n- [X] c\n')).toEqual({ total: 3, done: 2 });
  });

  it('項目が無ければ 0(同じ object を返す)', () => {
    expect(countTaskCandidates('')).toEqual({ total: 0, done: 0 });
    expect(countTaskCandidates('# 題\n本文\n')).toEqual({ total: 0, done: 0 });
    expect(countTaskCandidates('- ふつうの箇条書き\n')).toEqual({ total: 0, done: 0 });
  });
});
