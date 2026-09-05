/** @vitest-environment happy-dom */
/**
 * 🔴 **書式の帯のボタンは、全部「何が起きるか」の説明を持ち、字は重複しない**(#717)。
 *
 * ## なぜ要るか
 *
 * 直す前、帯の書式ボタン 14 個は `title` を 1 つも持たなかった(道具の列 ── 日付 / 雛形 /
 * 置換 ── は持っていた)。しかも「番号」の字が 2 つ並んでいた ── 左は「行を番号付き
 * リストにする」、右は「番号を振り直す」で、押すまで違いが読めない。
 *
 * ## 守る主張
 *
 * 1. 🔴 帯の**全ボタン**が空でない `title` を持つ(表の側の hint が**実際に載った**こと)
 * 2. 🔴 帯の字(`[data-pkc-field=label]`)は**帯全体で**重複しない(表だけでなく、
 *    道具の列の「番号を振り直す」も含めて見る ── 直す前はここで 2 つあった)
 * 3. 鍵が割り当たっている op(太字)は**いまの割当**が括弧で併記され、
 *    無い op(見出し1)は素の説明だけ(空の `()` を出さない)
 *
 * ⚠ `tests/features/text-ops-hints.test.ts` は**表**を見る。ここは**描いた帯**を見る ──
 *   表に hint が在っても、描き手が `title` に写し忘れれば user には届かない(§7)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFormatBar } from '../../src/adapter/ui/render/format-bar';
import { FORMAT_OPS } from '../../src/features/markdown/text-ops';
import { chordHint } from '../../src/adapter/ui/render/shortcut-hint';

beforeEach(() => {
  document.body.textContent = '';
});

function buttons(): HTMLButtonElement[] {
  const bar = buildFormatBar();
  document.body.append(bar);
  return [...bar.querySelectorAll<HTMLButtonElement>('button')];
}

describe('書式の帯の説明と字(#717)', () => {
  it('🔴 帯の全ボタンが空でない説明(title)を持つ', () => {
    const all = buttons();
    // 空振り防止 ── 帯が空なら「全部持っている」は自明に通る
    expect(all.length, '帯のボタンが少なすぎる').toBeGreaterThan(14);
    const bare = all
      .filter((b) => b.title.trim() === '')
      .map((b) => b.getAttribute('data-pkc-format') ?? b.getAttribute('data-pkc-action') ?? '?');
    expect(bare, '説明の無いボタンがある(乗せても何が起きるか読めない)').toEqual([]);
  });

  it('🔴 帯の字は帯全体で重複しない(「番号」が 2 つ、を作らない)', () => {
    const labels = buttons().map((b) => b.querySelector('[data-pkc-field="label"]')?.textContent ?? '');
    expect(labels.filter((l) => l === ''), '字の無いボタンがある').toEqual([]);
    const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(dup, '同じ字のボタンが 2 つ並んでいる').toEqual([]);
    // ⚠ 直した当の 2 つが両方在ること(片方を消して「重複が無い」にしない)
    expect(labels).toContain('番号');
    expect(labels).toContain('番号を振り直す');
  });

  it('🔴 説明は表の hint から来ていて、鍵のある op だけ割当が併記される', () => {
    const all = buttons();
    const byOp = (op: string) => all.find((b) => b.getAttribute('data-pkc-format') === op)!;
    const hintOf = (op: string) => FORMAT_OPS.find((o) => o.op === op)!.hint;
    // 鍵あり(太字 = format-bold)── 既定の割当が括弧で付く
    const bold = byOp('bold');
    const chord = chordHint('format-bold');
    expect(chord, '前提が崩れている(format-bold に既定の割当が無い)').not.toBeNull();
    expect(bold.title).toBe(`${hintOf('bold')}(${chord})`);
    // ⚠ 割当が変わったら書き直せるよう名乗っていること(置換のボタンと同じ作法)
    expect(bold.getAttribute('data-pkc-hint-command')).toBe('format-bold');
    // 鍵なし(見出し1)── 素の説明。空の括弧を出さない
    const h1 = byOp('h1');
    expect(h1.title).toBe(hintOf('h1'));
    expect(h1.getAttribute('data-pkc-hint-command')).toBeNull();
  });
});
