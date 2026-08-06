/** @vitest-environment happy-dom */
/**
 * P8 段⑩: **差分で当てる**(丸ごと作り直さない)。
 *
 * > user 指示 2026-08-03「**1 打鍵ではなく、3 秒周期で差分反映してください /
 * > 1 打鍵では、そんなことしたら、重たくなるし、レンダリングで画面がガクガクする**」
 *
 * 🔴 「ガクガク」は頻度ではなく**1 回の重さ**なので、観測点は
 * 「**触っていない要素が同じ実体のまま残るか**」に置く。
 * 「中身が正しいか」だけを見ると、丸ごと差し替えでも通ってしまう。
 */
import { describe, expect, it } from 'vitest';
import { applyBlocks, EMPTY_VIEW } from '../../src/adapter/ui/render/apply-blocks';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

const DOC = [
  '# 題',
  '',
  '最初の段落。',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '真ん中の段落。',
  '',
  '- 箇条 1',
  '- 箇条 2',
  '',
  '最後の段落。',
  '',
].join('\n');

const render = (md: string): string => renderMarkdown(md, { sourceLineAnchors: false });

describe('差分で当てる', () => {
  it('初回は丸ごと(基準が無い)', () => {
    const h = host();
    const r = applyBlocks(h, render(DOC), EMPTY_VIEW);
    expect(h.children.length).toBeGreaterThan(4);
    expect(r.inserted.length).toBe(h.children.length);
    expect(r.view.blocks.join('')).toBe(render(DOC));
  });

  it('🔴 変わっていなければ **DOM を 1 つも触らない**', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const before = [...h.children];
    const r = applyBlocks(h, render(DOC), first.view);
    expect(r.replaced, '変わっていないのに作り直した').toBe(0);
    expect(r.inserted).toEqual([]);
    // ⚠ **同じ実体**であること(innerHTML 比較では作り直しを見逃す)
    expect([...h.children]).toEqual(before);
  });

  it('🔴 1 段落を直したら、**その塊だけ**が新しくなる', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const before = [...h.children];
    const r = applyBlocks(h, render(DOC.replace('真ん中の段落。', '真ん中の段落。あ')), first.view);
    expect(r.replaced).toBeLessThanOrEqual(2);
    const after = [...h.children];
    // 触っていない要素は**同じ実体**のまま(= 図も scroll も生き残る)
    const same = after.filter((el) => before.includes(el)).length;
    expect(same, '触っていない要素まで作り直した').toBeGreaterThanOrEqual(before.length - 2);
    // 中身は正しい
    expect(h.innerHTML).toBe(render(DOC.replace('真ん中の段落。', '真ん中の段落。あ')));
  });

  it('🔴 当てた結果は**丸ごと描いたもの**と一致する(静かに欠けない)', () => {
    // ⚠ これが崩れると preview が「一部だけ消える」形で壊れる
    const h = host();
    let view = applyBlocks(h, render(DOC), EMPTY_VIEW).view;
    const edits = [
      DOC.replace('最初の段落。', '書き換えた。'),
      DOC.replace('- 箇条 2', '- 箇条 2\n- 箇条 3'),
      DOC.replace('| 1 | 2 |\n', ''),
      `${DOC}\n新しい段落。\n`,
      '# 全部消して\n\nこれだけ。\n',
      DOC,
    ];
    for (const md of edits) {
      const html = render(md);
      view = applyBlocks(h, html, view).view;
      expect(h.innerHTML, `編集後に食い違った: ${md.slice(0, 20)}`).toBe(html);
    }
  });

  it('末尾に足すと、前は全部そのまま', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const before = [...h.children];
    const r = applyBlocks(h, render(`${DOC}\n足した段落。\n`), first.view);
    expect(r.replaced).toBe(1);
    expect([...h.children].slice(0, before.length)).toEqual(before);
  });

  it('⚠ DOM が外から書き換わっていたら丸ごとに落ちる(図の hydrate 後など)', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    h.children[0]!.remove(); // 外から 1 個消えた状態を作る
    const r = applyBlocks(h, render(DOC), first.view);
    expect(r.replaced).toBe(first.view.blocks.length);
    expect(h.innerHTML).toBe(render(DOC));
  });

  it('🔴 外から要素が**増えて**いても丸ごとに落ちる', () => {
    // ⚠ 「覚えたノードが全部繋がっている」だけでは足りない ── 余分な子が
    // 増えていると、位置がずれたまま差分を当てて**中身が食い違う**
    // (変異試験で、件数の照合を消しても緑だった)
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    h.append(document.createElement('span')); // 外から 1 個増えた
    const r = applyBlocks(h, render(DOC), first.view);
    expect(r.replaced, '差分を当ててしまった').toBe(first.view.blocks.length);
    expect(h.innerHTML).toBe(render(DOC));
  });

  it('全部消しても壊れない', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const r = applyBlocks(h, '', first.view);
    expect(h.children.length).toBe(0);
    expect(r.view.blocks).toEqual([]);
  });
});

/**
 * 🔴 **pin(作り直してはいけない塊)**(2026-08-05。ライブエディタ S4。設計 §7-7/8)。
 *
 * pin の中には**生きた `<textarea>`**(と IME の変換状態)が居る。差し替えると
 * composition が**例外もイベントも出さずに死ぬ**ので、ここは
 * 「同じ実体のまま残るか」を**ノードの同一性**で見る ── 中身の正しさでは検出できない。
 */
describe('pin ── 編集中の塊を作り直さない', () => {
  /** 活性塊の代わりに置く定数(中身が固定なので差分の対象から自然に外れる)。 */
  const SLOT = '<div data-pkc-row-slot="1"></div>';

  /**
   * 分割は**実装と同じもの**を使う(`applyBlocks` に 1 度通して塊を取る)──
   * test 側に 2 本目の分割規則を書くと、そちらだけ正しくて実装が壊れても緑になる。
   */
  const splitForTest = (html: string): string[] => {
    const h = host();
    const r = applyBlocks(h, html, EMPTY_VIEW);
    return [...r.view.blocks];
  };

  /** 塊 i を SLOT に差し替えた HTML を作る。 */
  const withSlot = (md: string, i: number): { html: string; index: number } => {
    const parts = splitForTest(render(md));
    expect(parts[i], `塊 ${i} が無い(fixture が短い)`).toBeDefined();
    parts[i] = SLOT;
    return { html: parts.join(''), index: i };
  };

  it('🔴 SLOT を入れると、その塊だけが差し替わる(pin が付く瞬間)', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const { html, index } = withSlot(DOC, 2);
    const before = [...h.children];
    const r = applyBlocks(h, html, first.view, [index]);
    expect(r.replaced, 'SLOT の 1 塊だけが入れ替わるはず').toBe(1);
    expect(h.querySelector('[data-pkc-row-slot]'), 'SLOT が入っていない').not.toBeNull();
    // 前後の塊は同じ実体のまま
    expect(h.children[0]).toBe(before[0]);
    expect(h.children[h.children.length - 1]).toBe(before[before.length - 1]);
    expect(r.view.pin).toEqual([index]);
  });

  it('🔴 **SLOT の孫**に要素を足しても `intact()` が崩れない(異物を差分の外へ出せる)', () => {
    // ⚠ ここが設計の要点 ── textarea を SLOT の**子**に置けば host の
    //    childNodes は動かないので、`intact()` を**緩めずに**守れる
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const { html, index } = withSlot(DOC, 2);
    const withPin = applyBlocks(h, html, first.view, [index]);
    const slot = h.querySelector('[data-pkc-row-slot]')!;
    const ta = document.createElement('textarea');
    slot.append(ta); // 異物(生きた入力欄)
    // もう一度同じものを当てても、丸ごとに落ちない
    const again = applyBlocks(h, html, withPin.view, [index]);
    expect(again.replaced, '丸ごと作り直しに落ちた(intact が崩れた)').toBe(0);
    expect(h.querySelector('textarea'), 'textarea が消えた').toBe(ta);
  });

  it('🔴 pin の**前後が両方変わっても** pin のノードは同じ実体のまま', () => {
    // ⚠ ここが pin の本体。`diffBlocks` は前後一致で真ん中を丸ごと入れ替えるので、
    //    区間に切らないと **pin のノードごと取り除かれる**
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const { html, index } = withSlot(DOC, 2);
    const withPin = applyBlocks(h, html, first.view, [index]);
    const slot = h.querySelector('[data-pkc-row-slot]')!;
    const ta = document.createElement('textarea');
    ta.value = '打っている途中';
    slot.append(ta);

    // pin の前(題)と後ろ(最後の段落)を**同時に**変える
    const changed = DOC.replace('# 題', '# 題(変えた)').replace('最後の段落。', '最後の段落(変えた)。');
    const parts = splitForTest(render(changed));
    parts[index] = SLOT;
    const r = applyBlocks(h, parts.join(''), withPin.view, [index]);

    expect(h.querySelector('[data-pkc-row-slot]'), 'SLOT が消えた').toBe(slot);
    expect(h.querySelector('textarea'), '打っていた入力欄が消えた').toBe(ta);
    expect((h.querySelector('textarea') as HTMLTextAreaElement).value).toBe('打っている途中');
    // 前後は実際に変わっている(空振り防止)
    expect(h.textContent).toContain('題(変えた)');
    expect(h.textContent).toContain('最後の段落(変えた)');
    expect(r.replaced, '前後の 2 塊が入れ替わるはず').toBe(2);
  });

  it('🔴 pin が外れる瞬間は普通に入れ替わる(確定して描き戻す当の操作)', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const { html, index } = withSlot(DOC, 2);
    const withPin = applyBlocks(h, html, first.view, [index]);
    const r = applyBlocks(h, render(DOC), withPin.view, []);
    expect(h.querySelector('[data-pkc-row-slot]')).toBeNull();
    expect(r.replaced).toBe(1);
    expect(r.view.pin).toEqual([]);
  });

  it('🔴 **2 回続けて守った後**でも台帳が壊れていない(次の適用で初めて出る型)', () => {
    // ⚠ 1 巡目の変異試験で 2 件生き延びた原因がこれ ── pin のノードを台帳に
    //    持ち越さない / pin を view に持ち越さない、はどちらも**その回は緑**で、
    //    **次の適用**で丸ごと作り直しに落ちる。だから守った後にもう 1 回当てる
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const { html, index } = withSlot(DOC, 2);
    const activated = applyBlocks(h, html, first.view, [index]);
    const slot = h.querySelector('[data-pkc-row-slot]')!;
    const ta = document.createElement('textarea');
    ta.value = '打っている途中';
    slot.append(ta);

    // 1 回目の「守る」適用(前を変える)
    const changed1 = DOC.replace('# 題', '# 題1');
    const p1 = splitForTest(render(changed1));
    p1[index] = SLOT;
    const g1 = applyBlocks(h, p1.join(''), activated.view, [index]);
    expect(h.querySelector('textarea'), '1 回目で消えた').toBe(ta);
    expect(g1.view.pin, 'pin を view に持ち越していない').toEqual([index]);

    // 2 回目の「守る」適用(後ろを変える)── ここで台帳の壊れが出る
    const changed2 = changed1.replace('最後の段落。', '最後の段落2。');
    const p2 = splitForTest(render(changed2));
    p2[index] = SLOT;
    const g2 = applyBlocks(h, p2.join(''), g1.view, [index]);
    expect(h.querySelector('textarea'), '2 回目で消えた(台帳がずれている)').toBe(ta);
    expect((h.querySelector('textarea') as HTMLTextAreaElement).value).toBe('打っている途中');
    // ⚠ 丸ごと作り直しに落ちていないこと(落ちると replaced が塊数になる)
    expect(g2.replaced, `丸ごとに落ちた(replaced=${g2.replaced})`).toBe(1);
    expect(h.textContent).toContain('最後の段落2');
  });

  it('🔴 pin の手前の区間は **pin の直前**に入る(並びが崩れない)', () => {
    // ⚠ 「中身が在るか」だけを見ると、末尾に足す実装でも通ってしまう ──
    //    **順序**を見る
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const { html, index } = withSlot(DOC, 2);
    const activated = applyBlocks(h, html, first.view, [index]);
    const slot = h.querySelector('[data-pkc-row-slot]')!;

    /**
     * ⚠ 変えるのは **pin の直前の塊**にする(2026-08-05 の変異試験で分かった)。
     * 離れた塊を変えても、`patchSegment` の中で「次の古いノード」が入れ先として
     * 見つかるので、**入れ先の指定が壊れていても通ってしまう**。
     * 入れ先が実際に使われるのは「区間の末尾まで変わったとき」だけである。
     */
    const changed = DOC.replace('最初の段落。', '最初の段落(変えた)。').replace(
      '最後の段落。',
      '最後の段落(変えた)。',
    );
    const parts = splitForTest(render(changed));
    parts[index] = SLOT;
    applyBlocks(h, parts.join(''), activated.view, [index]);

    const kids = [...h.children];
    const slotAt = kids.indexOf(slot as Element);
    const headAt = kids.findIndex((e) => e.textContent?.includes('最初の段落(変えた)'));
    const tailAt = kids.findIndex((e) => e.textContent?.includes('最後の段落(変えた)'));
    expect(headAt, '変えた段落が見つからない').toBeGreaterThanOrEqual(0);
    expect(headAt, '手前の塊が SLOT より後ろへ回った').toBeLessThan(slotAt);
    expect(tailAt, '後ろの塊が SLOT より前へ来た').toBeGreaterThan(slotAt);
  });

  it('🔴 pin が別の塊を指していたら守らない(差し替えるべき所を守らない)', () => {
    // pin の添字が指す塊が SLOT ではない = 前回と同じものではない ⇒ 普通に当てる
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const { html, index } = withSlot(DOC, 2);
    const activated = applyBlocks(h, html, first.view, [index]);
    // SLOT を戻さずに、その位置の塊を**別の中身**にして当てる
    const changed = DOC.replace('| 1 | 2 |', '| 9 | 9 |');
    const r = applyBlocks(h, render(changed), activated.view, [index]);
    expect(h.querySelector('[data-pkc-row-slot]'), 'SLOT が残った(守ってしまった)').toBeNull();
    expect(r.replaced, '差し替えが起きていない').toBeGreaterThan(0);
    expect(h.textContent).toContain('9');
  });

  it('pin を渡さない既存の呼び方は挙動が変わらない', () => {
    const h = host();
    const a = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const r = applyBlocks(h, render(DOC), a.view);
    expect(r.replaced).toBe(0);
    expect(r.view.pin).toEqual([]);
  });
});
