/** @vitest-environment happy-dom */
/**
 * 🔴 **追記欄の打つ欄は、打った行数に合わせて伸びる**(#1443)。
 *
 * 見分けは SQL の欄(#918 段②b)と同じ 4 つ ── 伸びる / 上限で止まる /
 * 手で決めた高さが優先 / 空にしたら元へ戻る。
 * ⚠ happy-dom は `CSS.supports('field-sizing')` が偽なので、`rows` を書く経路が走る。
 *   `field-sizing` に任せる経路の見え方は smoke(`append-ui.smoke.spec.ts`)が見る。
 */
import { describe, expect, it } from 'vitest';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';

function setup() {
  const shell = document.createElement('div');
  shell.setAttribute('data-pkc-region', 'shell');
  const region = document.createElement('div');
  shell.append(region);
  document.body.append(shell);
  const box = new AppendBoxRenderer(region);
  const input = region.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { shell, box, input, type };
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `行${i}`).join('\n');

describe('追記欄の自動の高さ(#1443)', () => {
  it('🔴 打った行数に合わせて伸びる', () => {
    const { input, type } = setup();
    expect(Number(input.rows), '開いた直後は 2 行').toBe(2);
    type(lines(5));
    expect(Number(input.rows)).toBe(5);
    type(lines(7));
    expect(Number(input.rows)).toBe(7);
  });

  it('🔴 上限で止まる(本文を押しのけない)', () => {
    const { input, type } = setup();
    type(lines(12));
    expect(Number(input.rows)).toBe(12);
    type(lines(200));
    expect(Number(input.rows), '上限を超えて伸びた').toBe(12);
  });

  it('🔴 境目の帯で決めた高さが在れば、打っても変えない', () => {
    const { shell, input, type } = setup();
    shell.style.setProperty('--pkc-pane-append', '200px');
    type(lines(8));
    expect(Number(input.rows), '手で決めたのに自動で変えた').toBe(2);
    // ⚠ 対照群:決めた高さを外せば、また伸びる(「常に止まる」で通らない)
    shell.style.removeProperty('--pkc-pane-append');
    type(lines(8));
    expect(Number(input.rows)).toBe(8);
  });

  it('🔴 欄の角を掴んで引いた高さ(style.height)も、変えない', () => {
    const { input, type } = setup();
    input.style.height = '150px';
    type(lines(8));
    expect(Number(input.rows), '掴んで決めたのに自動で変えた').toBe(2);
  });

  it('🔴 追記が通って欄を空にしたら、元の高さへ戻る', () => {
    const { box, input, type } = setup();
    type(lines(9));
    expect(Number(input.rows)).toBe(9);
    box.clear();
    expect(input.value).toBe('');
    expect(Number(input.rows), '空にしても縮まない').toBe(2);
  });
});
