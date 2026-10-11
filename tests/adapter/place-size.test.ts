/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋の文字の大きさ**(#530 段⑤a。Gemini 裁定 2026-10-11 依頼 19 Q1)── 画面側。
 *
 * 守る主張:
 * 1. 付箋を右クリックすると「文字の大きさ: 小 / 標準 / 大 / 特大」の 4 つが**いつも**並び、いまの物だけ `aria-checked="true"`
 *    (札が無い・読めない字 = 標準)。字は設定の「文字の大きさ」と同じ表(`text-scale.ts`)から引く
 * 2. 選ぶと `size=` が開き行に書かれ、「標準」は札を**消す**(片道にしない)。色の札・他の行は 1 字も動かない
 * 3. 「色を外す」は色の札があるときだけ ── `size=` だけの付箋には出ない(押しても何も起きない口を作らない)
 * 4. 描画: 札は `data-pkc-size` として焼かれ、受け皿(`app.css`)は **`em` の倍率**(絶対値ではない)で当たる。標準には規則が無い
 * 5. 編集中は書かず理由を言う / 属性を書き換えられた読めない値は書かない
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const MENU = '[data-pkc-region="context-menu"]';
const SIZE_LABELS = ['文字の大きさ: 小', '文字の大きさ: 標準', '文字の大きさ: 大', '文字の大きさ: 特大'];

const meta = (lid: string): never =>
  ({
    lid, title: lid, archetype: 'text', created_at: null, updated_at: null, entry_order: 1,
    status: null, date: null, archived: 0,
  }) as never;

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
const items = (root: Element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`${MENU} button[data-pkc-action]`),
];
const sizeItems = (root: Element): HTMLElement[] =>
  items(root).filter((b) => b.getAttribute('data-pkc-action') === 'place-size');
const checkedOf = (root: Element): string[] =>
  sizeItems(root)
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.textContent ?? '');
function rewriteOf(asks: DomainEvent[], at: number) {
  const ev = asks[at]!;
  if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
  return ev.rewrite;
}

const OPEN = ':::format{#a .pkc-place x=0 y=0 w=100 h=60}';
const withOpen = (open: string): string =>
  [open, '左', ':::', '', ':::format{#b .pkc-place x=300 y=0 w=100 h=60}', '右', ':::', ''].join('\n');
const BOARD = withOpen(OPEN);

describe('付箋の右クリック ── 文字の大きさ', () => {
  it.each([
    ['', '文字の大きさ: 標準'],
    [' size=small', '文字の大きさ: 小'],
    [' size=large', '文字の大きさ: 大'],
    [' size=xlarge', '文字の大きさ: 特大'],
    [' size=huge', '文字の大きさ: 標準'], // 読めない字は標準(描く規則と同じ)
  ])('🔴 付箋に「%s」と書いたとき、4 つ並び、「%s」だけが選ばれている', (extra, on) => {
    const { root, host } = rig(withOpen(OPEN.replace('}', `${extra}}`)));
    rightClick(host.querySelector('.pkc-place')!);
    expect(sizeItems(root).map((b) => b.textContent)).toEqual(SIZE_LABELS);
    expect(sizeItems(root).every((b) => b.getAttribute('role') === 'menuitemradio')).toBe(true);
    expect(checkedOf(root)).toEqual([on]);
  });

  it('🔴 大きさの項目は「消す」より前に並ぶ(確認を挟む物を真ん中に置かない)', () => {
    const { root, host } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    const acts = items(root).map((b) => b.getAttribute('data-pkc-action'));
    expect(acts.lastIndexOf('place-size')).toBeLessThan(acts.indexOf('remove-place'));
    // 4 つ(選択肢の数が増減したら落ちる)
    expect(acts.filter((a) => a === 'place-size')).toHaveLength(4);
  });

  it('🔴 特大を選ぶ → size=xlarge が書かれる。他の札・他の行は 1 字も動かない', () => {
    const body = withOpen(OPEN.replace('}', ' fill=#ffe08a}'));
    const { root, host, asks } = rig(body);
    rightClick(host.querySelector('.pkc-place')!);
    sizeItems(root).find((b) => b.textContent === '文字の大きさ: 特大')!.click();
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-style', line: 0, style: { size: 'xlarge' } });
    const next = applyBodyRewrite(body, rewriteOf(asks, 0))!;
    expect(next.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a size=xlarge}');
    expect(next.split('\n').slice(1)).toEqual(body.split('\n').slice(1));
  });

  it('🔴 標準を選ぶ → size= が消える(size=standard と書き足さない)。色は残る', () => {
    const body = withOpen(OPEN.replace('}', ' fill=#ffe08a size=large}'));
    const { root, host, asks } = rig(body);
    rightClick(host.querySelector('.pkc-place')!);
    sizeItems(root).find((b) => b.textContent === '文字の大きさ: 標準')!.click();
    expect(rewriteOf(asks, 0)).toMatchObject({ style: { size: null } });
    const next = applyBodyRewrite(body, rewriteOf(asks, 0))!;
    expect(next.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a}');
    expect(next).not.toContain('size');
  });

  it('🔴 「色を外す」は色の札があるときだけ ── size= だけの付箋には出ない(外しても何も起きない口)', () => {
    const only = rig(withOpen(OPEN.replace('}', ' size=large}')));
    rightClick(only.host.querySelector('.pkc-place')!);
    expect(items(only.root).map((b) => b.getAttribute('data-pkc-action'))).not.toContain('place-color-clear');
    // 対照群: 色が付いていれば出る
    const colored = rig(withOpen(OPEN.replace('}', ' size=large fill=#ffe08a}')));
    rightClick(colored.host.querySelector('.pkc-place')!);
    expect(items(colored.root).map((b) => b.getAttribute('data-pkc-action'))).toContain('place-color-clear');
  });

  it('🔴 描画: size= は data-pkc-size として焼かれ、書いていない付箋には焼かれない(対照群)', () => {
    const { host } = rig(withOpen(OPEN.replace('}', ' size=large}')));
    const [a, b] = [...host.querySelectorAll<HTMLElement>('.pkc-place')] as [HTMLElement, HTMLElement];
    expect(a.getAttribute('data-pkc-size')).toBe('large');
    expect(b.hasAttribute('data-pkc-size')).toBe(false);
  });

  it('🔴 編集中は書かず、理由を言う', () => {
    const { root, host, d, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    d.dispatch({ type: 'START_EDIT' });
    sizeItems(root).find((b) => b.textContent === '文字の大きさ: 大')!.click();
    expect(asks).toHaveLength(0);
    expect(d.getState().error ?? '').toContain('文字の大きさ');
  });

  it('⚠ 属性を書き換えられて読めない値になっても書かない', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    const btn = sizeItems(root).find((b) => b.textContent === '文字の大きさ: 大')!;
    btn.setAttribute('data-pkc-style-size', 'huge');
    btn.click();
    expect(asks).toHaveLength(0);
  });

  it('🔴 reducer: 線の行に size は書かない(付箋だけの札)', () => {
    expect(
      applyBodyRewrite(
        ':::format{.pkc-line from=a to=b}\n:::\n',
        { kind: 'place-style', line: 0, openLine: ':::format{.pkc-line from=a to=b}', style: { size: 'large' } },
      ),
    ).toBeNull();
  });
});

describe('受け皿(app.css)── 倍率で当てる', () => {
  const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
  const rule = (size: string): string => {
    const b = blocksFor(APP, `.pkc-md-rendered .pkc-format-block.pkc-place[data-pkc-size='${size}']`);
    expect(b, `size=${size} の規則が 1 つに決まらない`).toHaveLength(1);
    return b[0]!;
  };

  it('🔴 小 / 大 / 特大は em の倍率(設定の文字の大きさに追従する)。px で持たない', () => {
    expect(rule('small')).toMatch(decl('font-size', '0\\.85em'));
    expect(rule('large')).toMatch(decl('font-size', '1\\.25em'));
    expect(rule('xlarge')).toMatch(decl('font-size', '1\\.6em'));
  });

  it('🔴 標準の規則は無い(札が無い付箋は今までと 1 ドットも変わらない)。読めない字の規則も無い', () => {
    expect(blocksFor(APP, ".pkc-md-rendered .pkc-format-block.pkc-place[data-pkc-size='standard']")).toHaveLength(0);
    const sized = APP.match(/\.pkc-place\[data-pkc-size=[^\]]*\]/g) ?? [];
    expect([...new Set(sized)].sort()).toEqual([
      ".pkc-place[data-pkc-size='large']",
      ".pkc-place[data-pkc-size='small']",
      ".pkc-place[data-pkc-size='xlarge']",
    ]);
  });
});
