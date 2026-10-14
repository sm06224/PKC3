/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋の「消す」の確認と「色…」の窓を開いている間に本文が動いたら、別の付箋を消さない・塗らない**(#1087)
 *
 * ## user の物語
 * 付箋を右クリックして「消す」を押し、確認の窓を出したまま別のタブへ行く。別のタブが本文の上のほうへ
 * 行を足す(または消す)。戻って「この付箋を消す」を押すと、**行番号は窓を開いた時のまま**なので、
 * 同じ番号に来た**別の付箋**が消えていた(「色…」の窓も同じ)。`place-rect` / `place-group` は
 * 窓を開いた時点の本文と違えば書かない作法を持っていたが、この 2 つだけ抜けていた。
 *
 * 併せて、**閉じていない付箋の「消す」**は確認を出す前に本当の理由を言う(確認に答えたあとで
 * 「本文が変わっている(開き直してください)」と出て、開き直しても直らなかった)。
 *
 * 観測点は撃たれた `REQUEST_BODY_REWRITE` と、画面に出る断りの字。対照群は「本文が動かなければ書く」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLACE_LINE_REMOVE_OPEN_REFUSAL,
  PLACE_REMOVE_OPEN_REFUSAL,
  type DomainEvent,
} from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { answerDialog, openDialog } from './dialog-helper';

const MENU = '[data-pkc-region="context-menu"]';
const PICK = 'input[data-pkc-field="color-pick"]';

const meta = (lid: string): never =>
  ({
    lid, title: lid, archetype: 'text', created_at: null, updated_at: null, entry_order: 1,
    status: null, date: null, archived: 0,
  }) as never;

const open = (id: string, x: number): string => `:::format{#${id} .pkc-place x=${x} y=40 w=100 h=60}`;
const board = (...opens: string[]): string =>
  opens.flatMap((o, i) => [o, `付箋 ${i + 1}`, ':::', '']).join('\n');
// 付箋 i 枚目(0 始まり)の開き行の行番号(1 枚 4 行)
const at = (i: number): number => i * 4;

const BODY = board(open('a', 0), open('b', 200), open('c', 400));
/** 別のタブが本文の先頭へ 1 行足した後の本文(同じ行番号が 1 つ上の付箋を指す)。 */
const SHIFTED = `先頭に足された行\n${BODY}`;

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

beforeEach(() => resetAppDialogForTest());
afterEach(() => {
  document.body.textContent = '';
});

function rig(body: string) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), { sourceLineAnchors: true });
  applyPlaceLayout(host, () => null, frontmatterLineCount(body));
  root.append(host);
  document.body.append(root);
  const d = new Dispatcher();
  const asks: DomainEvent[] = [];
  d.onEvent((e) => {
    if (e.type === 'REQUEST_BODY_REWRITE') asks.push(e);
  });
  bindActions(root, d, { showStatus: () => {} });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  asks.length = 0;
  return { root, host, d, asks };
}

const rightClick = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
};
const menuItem = (root: Element, action: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>(`${MENU} button[data-pkc-action]`)].find(
    (b) => b.getAttribute('data-pkc-action') === action,
  );
const blockOf = (host: Element, id: string): HTMLElement => host.querySelector<HTMLElement>(`#${id}`)!;
const rewriteOf = (asks: DomainEvent[], i: number) => {
  const ev = asks[i];
  if (ev === undefined || ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼が出ていない');
  return ev.rewrite;
};

describe('「この付箋を消す」の確認 ── 確認の間に本文が動いたら消さない', () => {
  it('🔴 確認を出したまま本文が動いたら、別の付箋を消さず理由を言う', async () => {
    const { root, host, d, asks } = rig(BODY);
    rightClick(blockOf(host, 'b'));
    menuItem(root, 'remove-place')!.click();
    expect(openDialog(), '前提:確認が開いていない').not.toBeNull();
    // 別のタブが先頭へ 1 行足した ── 行番号 4 は、いまは付箋 a の `付箋 1` の行(別の物)
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: SHIFTED });
    await answerDialog('ok');
    await settle();
    expect(asks, '本文が動いたのに消す依頼を出した').toHaveLength(0);
    expect(d.getState().error ?? '').toContain('確認している間に本文が変わった');
  });

  it('対照群:本文が動かなければ、確認を開いた時点の付箋の行番号で消す', async () => {
    const { root, host, asks } = rig(BODY);
    rightClick(blockOf(host, 'b'));
    menuItem(root, 'remove-place')!.click();
    await answerDialog('ok');
    await settle();
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-remove', line: at(1) });
    expect(applyBodyRewrite(BODY, rewriteOf(asks, 0))).not.toContain('#b');
  });

  it('🔴 閉じていない付箋は、確認を出す前に本当の理由を言う(確認に答えたあとで嘘の理由を言わない)', async () => {
    const unclosed = ':::format{#a .pkc-place x=0 y=40 w=100 h=60}\n付箋 1\n'; // 閉じが無い
    const { root, host, d, asks } = rig(unclosed);
    const target = host.querySelector('.pkc-place') ?? blockOf(host, 'a');
    expect(target, '前提:閉じていない付箋が描かれていない').not.toBeNull();
    rightClick(target);
    const item = menuItem(root, 'remove-place');
    expect(item, '前提:消す項目が出ていない').toBeDefined();
    item!.click();
    await settle();
    expect(openDialog(), '確認を出してしまった').toBeNull();
    expect(asks).toHaveLength(0);
    expect(d.getState().error).toBe(PLACE_REMOVE_OPEN_REFUSAL);
    expect(PLACE_REMOVE_OPEN_REFUSAL).not.toBe(PLACE_LINE_REMOVE_OPEN_REFUSAL);
  });
});

describe('「色…」の窓 ── 窓を開いている間に本文が動いたら塗らない', () => {
  const pickInput = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>(PICK);

  it('🔴 窓を開いたまま本文が動いたら、別の付箋を塗らず理由を言う', () => {
    const { root, host, d, asks } = rig(BODY);
    rightClick(blockOf(host, 'b'));
    [...root.querySelectorAll<HTMLElement>(`${MENU} button`)].find((b) => b.textContent === '塗りの色…')!.click();
    const p = pickInput();
    expect(p, '前提:色の窓が開いていない').not.toBeNull();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: SHIFTED });
    p!.value = '#ff0000';
    p!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(asks, '本文が動いたのに塗る依頼を出した').toHaveLength(0);
    expect(d.getState().notice ?? '').toContain('開いている間に本文が変わった');
  });

  it('対照群:本文が動かなければ、開いた時点の付箋の行へ塗る', () => {
    const { root, host, asks } = rig(BODY);
    rightClick(blockOf(host, 'b'));
    [...root.querySelectorAll<HTMLElement>(`${MENU} button`)].find((b) => b.textContent === '塗りの色…')!.click();
    const p = pickInput()!;
    p.value = '#ff0000';
    p.dispatchEvent(new Event('change', { bubbles: true }));
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-style', line: at(1), style: { fill: '#ff0000' } });
  });
});
