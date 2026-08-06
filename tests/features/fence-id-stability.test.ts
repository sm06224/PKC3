/**
 * 🔴 **無関係な編集で fence の id を動かさない**(2026-08-05。ライブエディタ設計 S1)。
 *
 * ## 直す前に実測したこと
 * `both` モードの fence(mermaid / html / csv)は「ソース / レンダリング切替」の
 * `<input id>` を持ち、その id は**中身から決める**ようになっていた ── ただし
 * salt が **token 添字**だった。すると図の**前**に段落を 1 つ足すだけで添字がずれ、
 * id が変わり、**図を含む塊の HTML が変わる**。`apply-blocks.ts` は塊 HTML の
 * 完全一致で差分を取るので「その塊は変わった」ことになり、作り直される ──
 * **生きている `<img>` が捨てられて絵が一度消える**(ObjectURL の作り直し +
 * IDB の読み直し + decode)。
 *
 * 実測(直す前 / 直した後、同じ入力):
 * ```
 * 前: diff = { prefix: 2, suffix: 1, middle: [挿入した段落, 図の塊], removed: 1 }
 * 後: diff = { prefix: 2, suffix: 2, middle: [挿入した段落],       removed: 0 }
 * ```
 * ⚠ これは `sourceLineAnchors` を切っている**今日のプレビューでも起きていた**
 * (誰も守っていなかった ── 既存 smoke は末尾追記しか見ていない)。
 *
 * ## ここで守ること
 * ① 前に何を足しても引いても、その塊は **byte 一致**のまま
 * ② それでも**同じ内容の fence 同士は区別される**(当初の目的を落とさない)
 * ③ `<label for>` は**自分の** checkbox を指す(数え間違いを許さない)
 * ④ カウンタは render ごとにリセットされる(module スコープに置くと元の病気に戻る)
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@features/markdown/markdown-render';
import { diffBlocks, splitTopLevelBlocks } from '@features/markdown/html-blocks';

const DIAGRAM = '```mermaid\ngraph TD\n  A-->B\n```\n';
const HTML_FENCE = '```html\n<b>強調</b>\n```\n';

const blocks = (text: string): string[] => splitTopLevelBlocks(renderMarkdown(text, {}));
const pick = (bs: readonly string[], needle: string): string => {
  const hit = bs.filter((b) => b.includes(needle));
  expect(hit, `${needle} を含む塊が 1 つではない`).toHaveLength(1);
  return hit[0]!;
};

describe('fence の id は無関係な編集で動かない', () => {
  it('🔴 図の**前**に段落を足しても、図の塊は byte 一致のまま', () => {
    const before = blocks(`# 見出し\n\n段落 1\n\n${DIAGRAM}\n本文の続き\n`);
    const after = blocks(`# 見出し\n\n段落 1\n\n挿入した段落\n\n${DIAGRAM}\n本文の続き\n`);
    expect(pick(after, 'mermaid-placeholder')).toBe(pick(before, 'mermaid-placeholder'));
    // 🔑 差分の観測点まで見る ── 「塊が一致」だけだと、差分器が別の理由で
    //    全部作り直していても気づけない
    const d = diffBlocks(before, after);
    expect(d.middle, '図の塊が作り直されている').toEqual(['<p>挿入した段落</p>\n']);
    expect(d.removed).toBe(0);
  });

  it('🔴 図の**前**の段落を消しても、図の塊は byte 一致のまま(逆向き)', () => {
    const before = blocks(`段落 1\n\n消える段落\n\n${DIAGRAM}`);
    const after = blocks(`段落 1\n\n${DIAGRAM}`);
    expect(pick(after, 'mermaid-placeholder')).toBe(pick(before, 'mermaid-placeholder'));
  });

  it('🔴 html fence(iframe)でも同じ ── 前に足しても id が動かない', () => {
    // iframe が読み直されると中身が一度消える(図と同じ壊れ方)
    const before = blocks(`段落\n\n${HTML_FENCE}`);
    const after = blocks(`段落\n\n足した段落\n\n${HTML_FENCE}`);
    expect(pick(after, 'pkc-html-render-')).toBe(pick(before, 'pkc-html-render-'));
  });

  it('🔴 **同じ言語の別の図**を前に足しても動かない(数え方そのものの pin)', () => {
    // 🔴 ここが 1 巡目に抜けていた次元(変異試験で 2 件生き延びた)。
    //    段落しか前に足していなかったので、**鍵に中身を混ぜない**変異と
    //    **1 fence で 2 回数える**変異が両方素通りしていた ──
    //    どちらも「同じ言語の fence の本数」で id が動く壊れ方をする。
    // ⚠ fixture のゼロ件の次元は「測っていない次元」(CLAUDE.md)
    const other = '```mermaid\ngraph LR\n  X-->Y\n```\n';
    const target = (bs: readonly string[]): string =>
      bs.filter((b) => b.includes('A--&gt;B'))[0]!;
    const before = blocks(`段落\n\n${DIAGRAM}`);
    const after = blocks(`段落\n\n${other}\n${DIAGRAM}`);
    expect(target(after), '同じ言語の別の図を前に足したら id が動いた').toBe(target(before));
  });

  it('🔴 同じ内容の図が並んでいても、前に別の図を足せば全部そのまま', () => {
    // 「同じ内容の n 番目」で数えているなら、別内容の図は数に影響しない
    const other = '```mermaid\ngraph LR\n  X-->Y\n```\n';
    const two = `${DIAGRAM}\n${DIAGRAM}`;
    const before = blocks(two).filter((b) => b.includes('A--&gt;B'));
    const after = blocks(`${other}\n${two}`).filter((b) => b.includes('A--&gt;B'));
    expect(before).toHaveLength(2);
    expect(after).toEqual(before);
  });

  it('🔴 見出しの階層が変わっても動かない(前処理が行を挿す経路)', () => {
    // 見出し番号 / align prefix の前処理は行を挿すので token 添字はよく動く
    const before = blocks(`# 見出し\n\n${DIAGRAM}`);
    const after = blocks(`# 見出し\n\n## 小見出し\n\n${DIAGRAM}`);
    expect(pick(after, 'mermaid-placeholder')).toBe(pick(before, 'mermaid-placeholder'));
  });
});

describe('それでも同じ内容の fence は区別される(当初の目的)', () => {
  const ids = (html: string): string[] => [...html.matchAll(/id="(pkc-rv-[a-z0-9]+)"/g)].map((m) => m[1]!);

  it('🔴 同じ中身の図が 2 つあれば、id は別になる', () => {
    // 同じ id になると、片方の切替がもう片方も動かす(CSS-only トグルなので)
    const html = renderMarkdown(`${DIAGRAM}\n${DIAGRAM}`, {});
    const got = ids(html);
    expect(got).toHaveLength(2);
    expect(new Set(got).size, '同じ中身の図が同じ id になった').toBe(2);
  });

  it('🔴 `<label for>` は**自分の** checkbox を指す(数え間違いを許さない)', () => {
    // ⚠ 出現順を 2 度数えると slot と wrapper で別の id になり、label が
    //    自分の checkbox を指さなくなる(切替が無反応の飾りになる)
    const html = renderMarkdown(`${DIAGRAM}\n${DIAGRAM}\n${HTML_FENCE}`, {});
    const pairs = [...html.matchAll(/id="(pkc-rv-[a-z0-9]+)"[\s\S]*?for="(pkc-rv-[a-z0-9]+)"/g)];
    expect(pairs.length).toBeGreaterThan(0);
    for (const [, id, forAttr] of pairs) expect(forAttr).toBe(id);
  });

  it('内容が違えば id も違う', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\n A-->B\n```\n\n```mermaid\ngraph TD\n C-->D\n```\n', {});
    expect(new Set(ids(html)).size).toBe(2);
  });
});

describe('カウンタは render ごとにリセットされる', () => {
  it('🔴 同じ入力を 2 回描いたら **完全に同じ HTML**(module スコープに数えない)', () => {
    // ⚠ ここを落とすと「毎回ちがう HTML」= 元の病気(毎回全部作り直し)に戻る。
    //    render は module 内で共有された markdown-it を使うので、カウンタの
    //    置き場所を間違えると render を跨いで増え続ける
    const text = `${DIAGRAM}\n${HTML_FENCE}\n${DIAGRAM}`;
    const first = renderMarkdown(text, {});
    const second = renderMarkdown(text, {});
    expect(second).toBe(first);
    // 3 回目も(1 回目と 2 回目だけ偶然一致する形を落とす)
    expect(renderMarkdown(text, {})).toBe(first);
  });
});
