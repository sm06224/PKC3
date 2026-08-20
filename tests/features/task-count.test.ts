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
import { countTaskCandidates, listTaskItems } from '../../src/features/markdown/task-count';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite, isTaskLine } from '../../src/features/markdown/body-rewrite';

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
  /**
   * 🔴 **字下げコードの中の fence 記号**(2026-08-19 のレビューで判明)。
   * CommonMark の fence は**字下げ 3 まで** ── 4 以上はコードの中身なので、
   * fence として数えると**そこから後の項目を全部落とす**(少なく数える = 禁じた向き)。
   */
  ['🔴 字下げ 4 の fence 記号', '    ```\n\n- [ ] 本物のやること\n'],
  ['🔴 リストの中の深い字下げ fence', '- 例:\n\n      ```\n\n- [ ] 本物\n'],
  ['字下げ 3 の fence(こちらは正規)', '   ```\n- [ ] 中\n   ```\n\n- [ ] 外\n'],
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

/**
 * 🔑 **描く側の真値(行番号つき)** ── `<input>` を**1 タグずつ**取り出して読む。
 * ⚠ HTML 全体に対して `includes('checked')` を書かない ── 別のタグの属性に
 *   満たされて、印の有無を取り違えても緑になる(CLAUDE.md §1、この repo で実際に踏んだ型)。
 */
function drawnLines(body: string): Array<{ line: number; done: boolean }> {
  const html = renderMarkdown(body, { interactiveTasks: true });
  const out: Array<{ line: number; done: boolean }> = [];
  for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
    const m = /data-pkc-task-line="(\d+)"/.exec(tag);
    if (m === null) continue;
    out.push({ line: Number(m[1]), done: / checked>/.test(tag) });
  }
  return out;
}

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

/**
 * 🔴 **取り出す側**(`listTaskItems` ── カンバンの札 1 枚ぶん)。
 *
 * 数える側との関係は「**同じ走査から出ている**」であって、たまたま一致して
 * いるのではない ── 別々に行を読むと、片方だけ直したときに
 * 「候補に入るのに札が 0 枚」のノートができる(CLAUDE.md §7)。
 */
describe('チェック項目を取り出す(#277 段②-b)', () => {
  /**
   * 🔴 **これが本丸** ── 描く側が出した**行番号**を、取り出す側が 1 つも落とさない。
   * ⚠ 落とすと、その項目はカンバンに出ない。⚠ そして**印の向きも合っている**
   *   こと(done を取り違えると、済んだ物が未完了の列に並ぶ)。
   */
  it('🔴 描く側の行番号を 1 つも落とさない(印の向きも合う)', () => {
    const bad: string[] = [];
    for (const [name, body] of CORPUS) {
      const mine = new Map(listTaskItems(body).map((i) => [i.line, i.done]));
      for (const d of drawnLines(body)) {
        if (!mine.has(d.line)) bad.push(`${name}: 行 ${d.line} が落ちている`);
        else if (mine.get(d.line) !== d.done) bad.push(`${name}: 行 ${d.line} の印が逆`);
      }
    }
    expect(bad, '描く側と食い違っている').toEqual([]);
  });

  /** ⚠ **空振り防止** ── corpus に行番号つきの項目が十分出ていること。 */
  it('⚠ corpus が行番号つきの項目を出している(空振り防止)', () => {
    const total = CORPUS.reduce((n, [, b]) => n + drawnLines(b).length, 0);
    expect(total, '描く側が行番号を 1 つも出していない').toBeGreaterThanOrEqual(12);
  });

  /**
   * 🔴 **数える側と取り出す側は同じ走査から出ている**(§7)。
   * ⚠ これが割れると、候補列で拾ったノートを開いても札が 0 枚になる
   *   (しかも「そういうノートもある」に見えるので誰も気づかない)。
   */
  it('🔴 数える側の total と、取り出す側の件数が全 corpus で一致する', () => {
    for (const [name, body] of CORPUS) {
      expect(listTaskItems(body).length, `${name}: 数と件数が割れた`).toBe(
        countTaskCandidates(body).total,
      );
      expect(listTaskItems(body).filter((i) => i.done).length, `${name}: 印の数が割れた`).toBe(
        countTaskCandidates(body).done,
      );
    }
  });

  it('中身を取り出す(印は落とし、前後の空白は削る)', () => {
    expect(listTaskItems('- [ ]   牛乳を買う  \n- [x] 卵\n')).toEqual([
      { line: 0, text: '牛乳を買う', done: false },
      { line: 1, text: '卵', done: true },
    ]);
  });

  it('引用の中も取り出す(記号は剥がす)', () => {
    expect(listTaskItems('> - [x] 引用の中\n')).toEqual([
      { line: 0, text: '引用の中', done: true },
    ]);
  });

  /** ⚠ 行番号は**原文のもの** ── 前に何行あっても、その行の番号がそのまま出る。 */
  it('🔴 行番号は原文の行(前置きがあってもずれない)', () => {
    const body = '# 題\n\n本文\n\n- [ ] 4 行目\n';
    expect(listTaskItems(body).map((i) => i.line)).toEqual([4]);
    // 🔑 描く側と突き合わせる(自前の数え直しにしない)
    expect(drawnLines(body).map((d) => d.line)).toEqual([4]);
  });

  it('中身が空でも札は出る(印だけの行)', () => {
    expect(listTaskItems('- [ ]\n')).toEqual([{ line: 0, text: '', done: false }]);
  });

  it('項目が無ければ空の配列', () => {
    expect(listTaskItems('')).toEqual([]);
    expect(listTaskItems('- ふつうの箇条書き\n')).toEqual([]);
  });

  /**
   * 🔴 **札に出た行は、必ず書き換えられる**(2026-08-19 のレビューで判明した穴)。
   *
   * ⚠ `task-count.ts` は引用記号を剥がしてから判定するのに、書き換える側
   * (`body-rewrite.ts` の `TASK_LINE`)は剥がしていなかった ── つまり
   * **`> - [ ] やること` は札に出るのに押しても書き換わらない**。
   * 押すとブラウザが印を付け、帯には「本文が変わっているため反映できませんでした
   * (開き直してください)」という**嘘の理由**が出て、開き直しても永久に直らない。
   * これは `markdown-render.ts` が明文で禁じている
   * 「押せるのに本文が変わらない = チェックしたのに消えた」そのものである。
   *
   * 🔑 **この parity はどこにも無かった。** `walkTaskLines` と `TASK_LINE` は
   *   別実装なので、これは同じ関数を 2 回呼ぶ偽の parity ではない(§7)。
   */
  it('🔴 札に出た行は必ず書き換えられる(押せない札を出さない)', () => {
    const dead: string[] = [];
    for (const [name, body] of CORPUS) {
      for (const item of listTaskItems(body)) {
        if (!isTaskLine(body, item.line)) dead.push(`${name}: 行 ${item.line}`);
        // ⚠ 「判定は通るが書き換わらない」も潰す ── 実際に当ててみる
        else if (applyBodyRewrite(body, { kind: 'task', line: item.line }) === null)
          dead.push(`${name}: 行 ${item.line}(判定は通るのに書換が null)`);
      }
    }
    expect(dead, '押しても何も起きない札を出している').toEqual([]);
  });

  /** ⚠ **空振り防止** ── 引用の札が実際に corpus から出ていること。 */
  it('⚠ 引用の中の札が corpus から出ている(空振り防止)', () => {
    expect(listTaskItems('> - [ ] 引用の中\n'), '引用の札が出ていない').toHaveLength(1);
    expect(listTaskItems('> > - [x] 二重\n'), '二重引用の札が出ていない').toHaveLength(1);
  });
});
