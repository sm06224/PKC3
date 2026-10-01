/** @vitest-environment happy-dom */
/**
 * 🔴 **長いコード枠の畳み / 文中の短いコードのコピーを、設定で切れる**(#1087)。
 *
 * ⚠ 本文の塊は `applyBlocks` が**変わったものだけ**差し替えるので、設定を切り替えた直後の
 *   描き直し(`invalidate()` + `render()`)でも、**同じ節点が残る**。つまり
 *   「切ったら付けない」だけでは足りず、**付いていた物を外す**ところまでが門である。
 *   下の検査はどれも**同じ節点のまま**見る(描き直されていたら、外す経路を通っていない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import {
  appCodeCollapse,
  clearCodeCollapse,
  applyCodeCollapse,
} from '../../src/adapter/ui/render/code-collapse';
import {
  appInlineCodeCopy,
  applyInlineCodeCopy,
  clearInlineCodeCopy,
  INLINE_CODE_ATTR,
} from '../../src/adapter/ui/render/inline-code-copy';
import * as clipboard from '../../src/adapter/platform/clipboard';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LONG = Array.from({ length: 25 }, (_, i) => `const row${i} = ${i};`).join('\n');
const BODY = '文中の `inline-one` です。\n\n```js\n' + LONG + '\n```\n';

function base(): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  return reduce(s, { type: 'BODY_LOADED', lid: 'a', body: BODY }).state;
}

async function open() {
  const root = document.createElement('div');
  document.body.append(root);
  const detail = new DetailRenderer(buildShell(root).detail);
  const s0 = base();
  detail.render(s0);
  await settle();
  return { root, detail, s0 };
}

const blockOf = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('.pkc-md-block[data-pkc-md-block-kind="code"]')!;
const inlineOf = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-pkc-field="detail-body"] p code')!;

beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => {
  appCodeCollapse.setEnabled(true);
  appInlineCodeCopy.setEnabled(true);
  vi.restoreAllMocks();
});

describe('detail: 長いコード枠の最初の畳み(#1087)', () => {
  it('🔴 既定は入 ── 18 行以上は畳まれ、展開ボタンが出る(対照群)', async () => {
    const { root } = await open();
    const block = blockOf(root);
    expect(block, 'コード枠が描かれていない(前提)').not.toBeNull();
    expect(block.hasAttribute('data-pkc-code-collapsed')).toBe(true);
    expect(block.querySelector('.pkc-code-collapse-btn')).not.toBeNull();
  });

  it('🔴 切にして開き直すと、畳まれず、ボタンも出ない(字は全部見える)', async () => {
    appCodeCollapse.setEnabled(false);
    const { root } = await open();
    const block = blockOf(root);
    expect(block.hasAttribute('data-pkc-code-collapsed'), '切なのに畳まれている').toBe(false);
    expect(block.hasAttribute('data-pkc-code-collapsible')).toBe(false);
    expect(block.querySelector('.pkc-code-collapse-btn, .pkc-code-collapse-top-btn')).toBeNull();
    expect(block.textContent, '字が欠けている').toContain('const row24 = 24;');
  });

  it('🔴 読んでいるノートで切ると、同じ節点のまま畳みが外れ、入に戻すとまた畳まれる', async () => {
    const { root, detail, s0 } = await open();
    const block = blockOf(root);
    expect(block.hasAttribute('data-pkc-code-collapsed')).toBe(true);

    appCodeCollapse.setEnabled(false);
    detail.invalidate();
    detail.render(s0);
    await settle();
    expect(blockOf(root), '描き直されている(外す経路を通っていない)').toBe(block);
    expect(block.hasAttribute('data-pkc-code-collapsed'), '切ったのに畳まれたまま').toBe(false);
    expect(block.querySelector('.pkc-code-collapse-btn, .pkc-code-collapse-top-btn')).toBeNull();

    appCodeCollapse.setEnabled(true);
    detail.invalidate();
    detail.render(s0);
    await settle();
    expect(blockOf(root)).toBe(block);
    expect(block.hasAttribute('data-pkc-code-collapsed'), '入に戻しても畳まれない').toBe(true);
    expect(block.querySelectorAll('.pkc-code-collapse-btn').length, 'ボタンが重なった').toBe(1);
  });
});

describe('detail: 文中の短いコードを押すとコピー(#1087)', () => {
  it('🔴 既定は入 ── 押すとコピーされる(対照群)', async () => {
    const copy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const { root } = await open();
    const code = inlineOf(root);
    expect(code.hasAttribute(INLINE_CODE_ATTR)).toBe(true);
    code.click();
    expect(copy).toHaveBeenCalledWith('inline-one');
  });

  it('🔴 切にして開き直すと、押しても何も起きず、title も付かない', async () => {
    appInlineCodeCopy.setEnabled(false);
    const copy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const { root } = await open();
    const code = inlineOf(root);
    expect(code.hasAttribute(INLINE_CODE_ATTR)).toBe(false);
    expect(code.hasAttribute('title')).toBe(false);
    code.click();
    expect(copy, '切なのに押すとコピーされた').not.toHaveBeenCalled();
  });

  it('🔴 読んでいるノートで切ると、同じ節点のまま押してもコピーされず、入に戻すと 1 回だけコピーされる', async () => {
    const copy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const { root, detail, s0 } = await open();
    const code = inlineOf(root);

    appInlineCodeCopy.setEnabled(false);
    detail.invalidate();
    detail.render(s0);
    await settle();
    expect(inlineOf(root), '描き直されている(外す経路を通っていない)').toBe(code);
    code.click();
    expect(copy, '切ったのに、付いていた受け手が押しに応えた').not.toHaveBeenCalled();
    expect(code.hasAttribute('title'), '切ったのに「クリックでコピー」が残っている').toBe(false);

    appInlineCodeCopy.setEnabled(true);
    detail.invalidate();
    detail.render(s0);
    await settle();
    expect(inlineOf(root)).toBe(code);
    code.click();
    expect(copy, '入に戻しても効かない / 受け手が二重に付いた').toHaveBeenCalledTimes(1);
  });
});

describe('clear 関数(#1087)── 自分が付けた物だけ外す', () => {
  it('clearCodeCollapse: 畳みの属性・ボタン・バーを外し、コードの字には触れない', () => {
    const host = document.createElement('div');
    host.innerHTML = `<div class="pkc-md-block" data-pkc-md-block-kind="code"><pre><code>${LONG}</code></pre></div>`;
    applyCodeCollapse(host);
    expect(host.querySelector('.pkc-code-collapse-bar')).not.toBeNull();
    clearCodeCollapse(host);
    const block = host.querySelector<HTMLElement>('.pkc-md-block')!;
    expect(block.getAttributeNames().sort()).toEqual(['class', 'data-pkc-md-block-kind']);
    expect(block.querySelector('button, .pkc-code-collapse-bar')).toBeNull();
    expect(block.querySelector('code')!.textContent).toBe(LONG);
  });

  it('clearInlineCodeCopy: user が付けた title は潰さない', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p><code title="自前の説明">x</code> <code>y</code></p>';
    applyInlineCodeCopy(host);
    const [mine, plain] = [...host.querySelectorAll('code')];
    // 自前の title は apply が上書きする(従来どおり)── ここで見るのは外すときの規則
    mine!.setAttribute('title', '自前の説明');
    clearInlineCodeCopy(host);
    expect(mine!.getAttribute('title')).toBe('自前の説明');
    expect(plain!.hasAttribute('title')).toBe(false);
    expect(plain!.hasAttribute(INLINE_CODE_ATTR)).toBe(false);
  });
});
