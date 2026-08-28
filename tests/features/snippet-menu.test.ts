/**
 * 🔴 **雛形の一覧**(#196 / B-2 段②-b)。
 *
 * 🔑 守る主張は 2 つだけ:
 * 1. 🔴 **一覧は空にならない**(組み込みの雛形が常に居る)── 空だと
 *    「押しても何も無い」= dead click になる
 * 2. 🔴 **黙って減らさない / 無いときは作り方を言う**(`snippetMenuNote`)
 */
import { describe, expect, it } from 'vitest';
import { DIAGRAM_TEMPLATES, FORMAT_OPS } from '../../src/features/markdown/text-ops';
import {
  BUILTIN_SNIPPET_OPS,
  snippetMenu,
  snippetMenuNote,
} from '../../src/features/snippet/snippet-menu';
import { SNIPPET_LIMITS, type SnippetItem } from '../../src/features/snippet/snippet-table';

const item = (lid: string, title: string, abbr: string): SnippetItem => ({
  lid,
  title,
  abbr,
  body: '本文',
});

const scan = (items: readonly SnippetItem[], over: Partial<{ total: number; truncated: boolean }> = {}) => ({
  items,
  total: over.total ?? items.length,
  truncated: over.truncated ?? false,
});

describe('雛形の一覧 (#196 / B-2 段②-b)', () => {
  it('🔴 雛形を 1 つも作っていなくても、一覧は空にならない', () => {
    const menu = snippetMenu([]);
    // ⚠ **件数を等値で書かない**(#528 段① で UML の雛形が増えた)── 守りたいのは
    //    「組み込みが全部出ること」であって、総数ではない
    expect(menu.length, '空の一覧が出る(押しても何も無い)').toBeGreaterThanOrEqual(
      BUILTIN_SNIPPET_OPS.length,
    );
    expect(menu.every((c) => c.kind !== 'snippet'), '自分の雛形が無いのに出ている').toBe(true);
    expect(menu.filter((c) => c.kind === 'format')).toHaveLength(BUILTIN_SNIPPET_OPS.length);
  });

  it('🔴 自分の雛形が先、組み込みが後', () => {
    const menu = snippetMenu([item('s1', '住所', 'addr'), item('s2', '署名', '')]);
    expect(menu.map((c) => c.title).slice(0, 2)).toEqual(['住所', '署名']);
    expect(menu.slice(0, 2).every((c) => c.kind === 'snippet')).toBe(true);
    expect(menu.slice(2).every((c) => c.kind !== 'snippet'), '組み込みが先に来ている').toBe(true);
  });

  /**
   * ⚠ **字は `FORMAT_OPS` から引く**(打ち直さない)── 打ち直すと、帯のボタンと
   * 一覧で同じものが違う名前で出る(CLAUDE.md §7)。
   */
  it('⚠ 組み込みの字は書式の表と同じ', () => {
    const menu = snippetMenu([]);
    const expected = BUILTIN_SNIPPET_OPS.map(
      (op) => FORMAT_OPS.find((f) => f.op === op)?.label ?? '(無い)',
    );
    // ⚠ **組み込みの分だけ**を切り出して比べる(UML の雛形は別の表が正本)
    expect(menu.filter((c) => c.kind === 'format').map((c) => c.title)).toEqual(expected);
    expect(expected, '書式の表から引けていない').not.toContain('(無い)');
  });

  /**
   * ⚠ 一覧に出す組み込みは「**塊を入れる**」ものだけ ── 見出しや太字のような
   * トグルを混ぜると、一覧の意味(入れる物を選ぶ)が壊れる。
   */
  it('⚠ トグルの書式は一覧に出さない', () => {
    const ops = snippetMenu([]).map((c) => (c.kind === 'format' ? c.op : ''));
    for (const toggle of ['h1', 'bold', 'italic', 'ul', 'task']) {
      expect(ops, `トグルの「${toggle}」が一覧に出ている`).not.toContain(toggle);
    }
  });
});

describe('一覧の上に出す 1 行 (#196 / B-2 段②-b)', () => {
  it('🔴 まだ 1 件も無ければ、作り方を出す', () => {
    const note = snippetMenuNote(scan([]));
    expect(note, '作り方が書いていない').toContain('作成');
    expect(note).toContain('雛形');
  });

  it('🔴 上限で切ったら、切ったと言う(黙って落とさない)', () => {
    const note = snippetMenuNote(scan([item('s1', '住所', 'addr')], { total: 999, truncated: true }));
    expect(note).toContain(String(SNIPPET_LIMITS.notes));
  });

  /**
   * 🔴 **「取れていない」と「まだ作っていない」を混ぜない**(#196 段②-b)。
   * ⚠ 混ぜると、worker が転んだ日に「作れば直る」と読ませる。
   */
  it('🔴 集められなかったときは「作り方」を出さない', () => {
    const note = snippetMenuNote(null);
    expect(note, '集められないのに「作れ」と言っている').not.toContain('作成');
    expect(note, '組み込みが使えることを言っていない').toContain('組み込み');
  });

  /** ⚠ 雛形の**ノートは在る**のに 1 件も載らない形(空 / 長すぎ)は、別の字で言う。 */
  it('⚠ ノートは在るのに載らないときは、そう言う', () => {
    const note = snippetMenuNote(scan([], { total: 3 }));
    expect(note, '「まだ無い」と混ざっている').not.toContain('作成');
    expect(note).toContain('長すぎ');
  });

  it('普通に 1 件以上あるときは何も出さない(邪魔しない)', () => {
    expect(snippetMenuNote(scan([item('s1', '住所', 'addr')]))).toBe('');
  });
});

/**
 * 🔴 **UML の雛形**(#528 段①。user 要望 2026-08-28「うちは UML とかもできるように
 * したいね」)。
 *
 * ⚠ **描き手は前から描けた** ── 足りていなかったのは**入れる口**である。
 *   「図」のボタンは `graph TD` しか入れないので、1 行目を書き換えられると
 *   知っている人しかクラス図を描けなかった。
 * 🔑 **雛形が本当に描けるか**は unit では見られない(文字列を pin しても、
 *   通らない雛形で緑になる)── 実ブラウザの smoke が PNG まで焼いて見る
 *   (`tests/smoke/mermaid.smoke.spec.ts`)。ここが守るのは**一覧の組み方**である。
 */
describe('UML の雛形 (#528 段①)', () => {
  it('🔴 user が名指しした 4 種が一覧に出る', () => {
    const titles = snippetMenu([]).map((c) => c.title);
    for (const want of ['クラス図', 'シーケンス図', '状態遷移図', 'ER 図'])
      expect(titles, `一覧に「${want}」が無い`).toContain(want);
  });

  /**
   * ⚠ **押した後に呼ぶ物が違う**ので kind を分けてある(`format` は `applyFormat`、
   *   `diagram` は `insertBlock`)。混ざると、押した側が自分で当てることになる。
   */
  it('⚠ 書式の op と混ざっていない', () => {
    const menu = snippetMenu([]);
    const diagrams = menu.filter((c) => c.kind === 'diagram');
    expect(diagrams).toHaveLength(DIAGRAM_TEMPLATES.length);
    expect(diagrams.map((d) => (d.kind === 'diagram' ? d.id : ''))).toEqual(
      DIAGRAM_TEMPLATES.map((d) => d.id),
    );
  });

  /**
   * 🔑 **「図」(フローチャート)のすぐ後ろに並ぶ** ── 図を探しに来た人が、
   *   隣で種類に気づく形にする。⚠ 自分の雛形の**前**に割り込ませない。
   */
  it('🔑 自分の雛形 → 組み込み → UML の順', () => {
    const menu = snippetMenu([item('s1', '住所', 'addr')]);
    const kinds = menu.map((c) => c.kind);
    expect(kinds.indexOf('diagram'), 'UML が組み込みより前に出ている').toBeGreaterThan(
      kinds.lastIndexOf('format'),
    );
    expect(kinds.indexOf('diagram'), 'UML が自分の雛形より前に出ている').toBeGreaterThan(
      kinds.lastIndexOf('snippet'),
    );
  });

  /**
   * ⚠ **字は表から引く**(打ち直さない)── 打ち直すと、一覧と表で名前が食い違う。
   */
  it('⚠ 字は DIAGRAM_TEMPLATES から引いている', () => {
    const menu = snippetMenu([]);
    expect(menu.filter((c) => c.kind === 'diagram').map((c) => c.title)).toEqual(
      DIAGRAM_TEMPLATES.map((d) => d.label),
    );
  });

  /**
   * 🔴 **1 行目が mermaid の種別名になっている**(空振り防止)。
   * ⚠ これだけでは「描ける」の証拠にならない(smoke が見る)── ここが見るのは
   *   「囲みの形になっていること」と「4 種が別の種別であること」である。
   */
  it('🔴 4 種とも mermaid の囲みで、種別が重なっていない', () => {
    const heads = DIAGRAM_TEMPLATES.map((d) => {
      const lines = d.block.text.split('\n');
      expect(lines[0], `${d.id} が mermaid の囲みで始まっていない`).toBe('```mermaid');
      return lines[1];
    });
    expect(new Set(heads).size, `種別が重なっている: ${heads.join(', ')}`).toBe(heads.length);
  });
});
