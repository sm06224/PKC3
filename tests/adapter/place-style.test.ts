/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋と線の色・太さ**(#530 段④。Gemini 裁定 A、2026-10-02)── 画面側。
 *
 * 守る主張:
 * 1. 本文の `fill=` / `stroke=` / `width=` が CSS 変数として要素に置かれる(読めない値は**置かない**)
 * 2. 付箋 / 線を右クリックすると「色…」が出る。選ぶと**本文が書き換わる**(窓は既存の色の窓 1 つ)
 * 3. 外せる ── 色が付いているときだけ「色を外す」が出て、押すと札が消える(片道にしない)
 * 4. 編集中は書かず、理由を言う
 *
 * 🔑 台は本物の描画で組む(`place-connect.test.ts` と同じ ── 刻印は `renderMarkdown` が焼く)。
 * 書換の結果は `applyBodyRewrite`(store-effects が書く当の関数)に通して**本文の字**で見る。
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
import { blocksFor, decl, mediaBlock, stripComments, withoutMedia } from '../helpers/css-blocks';

const MENU = '[data-pkc-region="context-menu"]';
/** 色の変数 3 つ。⚠ `--pkc-place` の前方一致で見ない ── 位置の変数 `--pkc-place-x`(#529 Q3)は色ではない。 */
const COLOR_VARS = /--pkc-place-(?:fill|stroke|ink)/;
const PICK = 'input[data-pkc-field="color-pick"]';

const meta = (lid: string): never =>
  ({
    lid,
    title: lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date: null,
    archived: 0,
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
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
};
const items = (root: Element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`${MENU} button[data-pkc-action]`),
];
const acts = (root: Element): string[] => items(root).map((b) => b.getAttribute('data-pkc-action') ?? '');
const labels = (root: Element): string[] => items(root).map((b) => b.textContent ?? '');
const pick = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>(PICK);
const fire = (el: Element, type: 'input' | 'change'): void => {
  el.dispatchEvent(new Event(type, { bubbles: true }));
};
function rewriteOf(asks: DomainEvent[], at: number) {
  const ev = asks[at]!;
  if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
  return ev.rewrite;
}

const BOARD = [
  ':::format{#a .pkc-place x=0 y=0 w=100 h=60}', // 0
  '左', // 1
  ':::', // 2
  '', // 3
  ':::format{#b .pkc-place x=300 y=0 w=100 h=60}', // 4
  '右', // 5
  ':::', // 6
  '', // 7
  ':::format{.pkc-line from=a:right to=b:left}', // 8
  ':::', // 9
  '',
].join('\n');

describe('描画 ── 本文の札が CSS 変数として置かれる', () => {
  const COLORED = [
    ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a stroke=#B45309}',
    '左',
    ':::',
    '',
    ':::format{#b .pkc-place x=300 y=0 w=100 h=60}',
    '右',
    ':::',
    '',
    ':::format{.pkc-line from=a:right to=b:left stroke=#2563eb width=4}',
    ':::',
    '',
  ].join('\n');

  it('🔴 付箋: 塗り・枠・字の色が置かれ、色を付けていない付箋には 1 つも置かれない(対照群)', () => {
    const { host } = rig(COLORED);
    const [a, b] = [...host.querySelectorAll<HTMLElement>('.pkc-place')] as [HTMLElement, HTMLElement];
    expect(a.style.getPropertyValue('--pkc-place-fill')).toBe('#ffe08a');
    // 大文字で書かれても正規形(小文字)で置く
    expect(a.style.getPropertyValue('--pkc-place-stroke')).toBe('#b45309');
    // 明るい塗りには暗い字
    expect(a.style.getPropertyValue('--pkc-place-ink')).toBe('#1a1a1a');
    expect(b.getAttribute('style') ?? '', '色なしの付箋に色の変数が置かれた').not.toMatch(COLOR_VARS);
  });

  it('🔴 線: 色と太さが道に置かれる。当たりの太さは見える線より太い', () => {
    const { host } = rig(COLORED);
    const path = host.querySelector<SVGElement>('[data-pkc-field="place-lines"] path')!;
    expect(path.style.getPropertyValue('--pkc-line-stroke')).toBe('#2563eb');
    expect(path.style.getPropertyValue('--pkc-line-width')).toBe('4');
    const hit = host.querySelector<SVGElement>('[data-pkc-field="place-line-hits"] path')!;
    expect(Number(hit.style.getPropertyValue('--pkc-hit-width'))).toBeGreaterThanOrEqual(12);
  });

  /**
   * 🔴 **当たりの太さの下限と余白**(着地後レビューの変異 A: `Math.max(12, r.width + 8)`)。
   * ⚠ 上の `width=4` だけでは `12` も `+8` も区別できない(4 + 8 = 12 = 下限)。
   *   細い線(1)は**下限 12**で、いちばん太い線(16)は**見える線 + 8 = 24**(見える線より太い)。
   */
  it.each([
    [1, 12],
    [16, 24],
  ])('🔴 width=%i の線の当たりの太さは %i(細くても 12 以上 / 太くても見える線より太い)', (w, hitW) => {
    const body = BOARD.replace('to=b:left}', `to=b:left width=${w}}`);
    const { host } = rig(body);
    const hit = host.querySelector<SVGElement>('[data-pkc-field="place-line-hits"] path')!;
    const got = Number(hit.style.getPropertyValue('--pkc-hit-width'));
    expect(got).toBe(hitW);
    expect(got, '当たりが見える線より細い').toBeGreaterThan(w);
  });

  it('🔴 色も太さも無い線には 1 つも置かれない(今までと同じ)', () => {
    const { host } = rig(BOARD);
    const path = host.querySelector<SVGElement>('[data-pkc-field="place-lines"] path')!;
    expect(path.getAttribute('style') ?? '').not.toContain('--pkc-');
    const hit = host.querySelector<SVGElement>('[data-pkc-field="place-line-hits"] path')!;
    expect(hit.getAttribute('style') ?? '').not.toContain('--pkc-');
  });

  it('🔴 受けない値は無視して描く(CSS へ素通ししない・本文は消えない)', () => {
    const body = [
      ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=javascript:alert(1) stroke=url(x)}',
      '左',
      ':::',
      '',
      ':::format{#b .pkc-place x=300 y=0 w=100 h=60 fill=red}',
      '右',
      ':::',
      '',
      ':::format{.pkc-line from=a to=b stroke=expression(1) width=99}',
      ':::',
      '',
    ].join('\n');
    const { host } = rig(body);
    for (const el of host.querySelectorAll<HTMLElement>('.pkc-place')) {
      expect(el.getAttribute('style') ?? '', '読めない色が CSS へ入った').not.toMatch(COLOR_VARS);
      expect(el.getAttribute('style') ?? '').not.toMatch(/javascript|url|red/);
    }
    const path = host.querySelector<SVGElement>('[data-pkc-field="place-lines"] path')!;
    expect(path.getAttribute('style') ?? '').not.toContain('--pkc-line');
  });

  it('🔴 色を付けた付箋の再描画で、色を外した後は変数が残らない(描き直しの冪等)', () => {
    const { host } = rig(COLORED);
    // 本文を色なしに書き換えて描き直す(画面は塊ごと差し替わる)
    host.innerHTML = renderMarkdown(bodyBelowFrontmatter(BOARD), { sourceLineAnchors: true });
    applyPlaceLayout(host, () => null, 0);
    for (const el of host.querySelectorAll<HTMLElement>('.pkc-place')) {
      expect(el.getAttribute('style') ?? '').not.toMatch(COLOR_VARS);
    }
  });
});

describe('付箋の右クリック ── 色…', () => {
  it('🔴 「色…」「枠の色…」が出る。色が無いときは「色を外す」は出ない(押しても何も起きない口を作らない)', () => {
    const { root, host } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    expect(labels(root)).toContain('色…');
    expect(labels(root)).toContain('枠の色…');
    expect(acts(root)).not.toContain('place-color-clear');
    // 「消す」は色の項目より後ろ(確認を挟む物を真ん中に置かない)
    expect(acts(root).indexOf('remove-place')).toBeGreaterThan(acts(root).lastIndexOf('place-color'));
  });

  it('🔴 色が付いていれば「色を外す」が出る(片道にしない)。読めない値が書かれているときも出る', () => {
    for (const open of [
      ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a}',
      ':::format{#a .pkc-place x=0 y=0 w=100 h=60 stroke=#112233}',
      ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=red}',
    ]) {
      const { root, host } = rig(`${open}\n左\n:::\n`);
      rightClick(host.querySelector('.pkc-place')!);
      expect(acts(root), open).toContain('place-color-clear');
    }
  });

  it('🔴 「色…」を押すと既存の色の窓が開き、選ぶと本文の `fill=` が書き換わる', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    items(root).find((b) => b.textContent === '色…')!.click();
    const p = pick();
    expect(p, '押しても色の窓が開かない(dead click)').not.toBeNull();
    expect(p!.type).toBe('color');
    // ⚠ input のたびには書かない(色を探して動かす間は何も書かない)
    p!.value = '#ff0000';
    fire(p!, 'input');
    expect(asks, '探している最中に書いた').toHaveLength(0);
    fire(p!, 'change');
    expect(asks).toHaveLength(1);
    expect(rewriteOf(asks, 0)).toMatchObject({
      kind: 'place-style',
      line: 0,
      style: { fill: '#ff0000' },
    });
    const next = applyBodyRewrite(BOARD, rewriteOf(asks, 0))!;
    expect(next.split('\n')[0]).toBe(
      ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ff0000}',
    );
    expect(pick(), '使い終わった窓が残っている').toBeNull();
  });

  it('🔴 「枠の色…」は stroke= を書く(塗りとは別の札)', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    items(root).find((b) => b.textContent === '枠の色…')!.click();
    const p = pick()!;
    p.value = '#00aa00';
    fire(p, 'change');
    expect(rewriteOf(asks, 0)).toMatchObject({ style: { stroke: '#00aa00' } });
    expect(applyBodyRewrite(BOARD, rewriteOf(asks, 0))!.split('\n')[0]).toContain('stroke=#00aa00');
  });

  it('🔴 窓の初めの色は、いま付いている色(同じ色を選んだときは書かない)', () => {
    const open = ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a}';
    const body = `${open}\n左\n:::\n`;
    const { root, host, asks } = rig(body);
    rightClick(host.querySelector('.pkc-place')!);
    items(root).find((b) => b.textContent === '色…')!.click();
    const p = pick()!;
    expect(p.value).toBe('#ffe08a');
    fire(p, 'change'); // 値は元のまま
    expect(asks, '同じ色なのに書いた').toHaveLength(0);
  });

  /**
   * 🔴 **白い付箋・灰色の枠が付けられた**(着地後レビュー)。`<input type="color">` は値が**開いたときから
   * 変わらなければ `change` を撃たない**(仕様)── 初めの色が本物の白 / 灰色だと、その色を選んでも何も起きない。
   * ⚠ happy-dom は窓を開かないので「選んだら change が来ない」は**再現できない**。守れるのは
   *   「初めの色が、user が選びうる白 / 灰色と**値で違う**」(= 選べば値が変わる)ことと、
   *   その白 / 灰色が**本文へ書かれる**こと。
   */
  it('🔴 色が無い付箋の窓の初めの色は、白(#ffffff)ではない ── 白を選んでも値が変わり、本文へ入る', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    items(root).find((b) => b.textContent === '色…')!.click();
    const p = pick()!;
    expect(p.value, '初めの色が本物の白だと、白を選んでも change が来ない').not.toBe('#ffffff');
    expect(p.value, '見た目が白から離れた').toBe('#fffffe');
    p.value = '#ffffff';
    fire(p, 'change');
    expect(rewriteOf(asks, 0)).toMatchObject({ style: { fill: '#ffffff' } });
    expect(applyBodyRewrite(BOARD, rewriteOf(asks, 0))!.split('\n')[0]).toContain('fill=#ffffff');
  });

  it('🔴 色が無い付箋の「枠の色…」も、灰色(#808080)を選べば値が変わり、本文へ入る', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    items(root).find((b) => b.textContent === '枠の色…')!.click();
    const p = pick()!;
    expect(p.value, '初めの色が本物の灰色だと、灰色を選んでも change が来ない').not.toBe('#808080');
    expect(p.value).toBe('#7f7f7f');
    p.value = '#808080';
    fire(p, 'change');
    expect(applyBodyRewrite(BOARD, rewriteOf(asks, 0))!.split('\n')[0]).toContain('stroke=#808080');
  });

  it('🔴 色が無い線の窓の初めの色も、灰色(#808080)ではない', () => {
    const { root, host } = rig(BOARD);
    rightClick(host.querySelector('[data-pkc-field="place-line-hits"] path')!);
    items(root).find((b) => b.textContent === '色…')!.click();
    expect(pick()!.value).not.toBe('#808080');
  });

  it('🔴 「色を外す」を押すと fill= / stroke= が消え、元の行へ戻る(片道にしない)', () => {
    const colored = ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a stroke=#112233}';
    const body = `${colored}\n左\n:::\n`;
    const { root, host, asks } = rig(body);
    rightClick(host.querySelector('.pkc-place')!);
    items(root).find((b) => b.textContent === '色を外す')!.click();
    expect(asks).toHaveLength(1);
    expect(rewriteOf(asks, 0)).toMatchObject({ style: { fill: null, stroke: null } });
    expect(applyBodyRewrite(body, rewriteOf(asks, 0))!.split('\n')[0]).toBe(
      ':::format{#a .pkc-place x=0 y=0 w=100 h=60}',
    );
  });

  it('🔴 編集中は窓を開かず、理由を言って書かない(出した後に編集へ入った形)', () => {
    const { root, host, d, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    d.dispatch({ type: 'START_EDIT' });
    items(root).find((b) => b.textContent === '色…')!.click();
    expect(pick(), '書けないのに窓が開いた').toBeNull();
    expect(asks).toHaveLength(0);
    expect(d.getState().error ?? '', '理由が出ていない').toContain('色');
  });
});

describe('線の右クリック ── 色と太さ', () => {
  const lineHit = (host: Element): Element =>
    host.querySelector('[data-pkc-field="place-line-hits"] path')!;

  it('🔴 色なし・太さなしの線は「色…」「細く」「太く」+「消す」(最後)。外す口は出ない', () => {
    const { root, host } = rig(BOARD);
    rightClick(lineHit(host));
    expect(labels(root)).toEqual(['色…', '線を細くする', '線を太くする', 'この線を消す']);
  });

  it('🔴 いまの太さと同じ物は出ない。太さが書かれていれば「標準に戻す」が出る', () => {
    const thick = BOARD.replace('to=b:left}', 'to=b:left width=4}');
    const { root, host } = rig(thick);
    rightClick(lineHit(host));
    expect(labels(root)).toEqual(['色…', '線を細くする', '線の太さを標準に戻す', 'この線を消す']);
  });

  it('🔴 線の色が書かれていれば「色を外す」が出る', () => {
    const colored = BOARD.replace('to=b:left}', 'to=b:left stroke=#2563eb}');
    const { root, host } = rig(colored);
    rightClick(lineHit(host));
    expect(labels(root)).toContain('色を外す');
  });

  it('🔴 「色…」は線の stroke= を書く(付箋の行には触れない)', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(lineHit(host));
    items(root).find((b) => b.textContent === '色…')!.click();
    const p = pick()!;
    p.value = '#2563eb';
    fire(p, 'change');
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-style', line: 8, style: { stroke: '#2563eb' } });
    const next = applyBodyRewrite(BOARD, rewriteOf(asks, 0))!;
    expect(next.split('\n')[8]).toBe(':::format{.pkc-line from=a:right to=b:left stroke=#2563eb}');
    expect(next.split('\n').slice(0, 8)).toEqual(BOARD.split('\n').slice(0, 8));
  });

  it('🔴 太さ: 太く(4)→ width=4 / 標準に戻す → width= が消える', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(lineHit(host));
    items(root).find((b) => b.textContent === '線を太くする')!.click();
    expect(rewriteOf(asks, 0)).toMatchObject({ style: { width: 4 } });
    const thick = applyBodyRewrite(BOARD, rewriteOf(asks, 0))!;
    expect(thick.split('\n')[8]).toBe(':::format{.pkc-line from=a:right to=b:left width=4}');

    const again = rig(thick);
    rightClick(lineHit(again.host));
    items(again.root).find((b) => b.textContent === '線の太さを標準に戻す')!.click();
    expect(rewriteOf(again.asks, 0)).toMatchObject({ style: { width: null } });
    expect(applyBodyRewrite(thick, rewriteOf(again.asks, 0))).toBe(BOARD);
  });

  it('🔴 編集中は書かず、理由を言う', () => {
    const { root, host, d, asks } = rig(BOARD);
    rightClick(lineHit(host));
    d.dispatch({ type: 'START_EDIT' });
    items(root).find((b) => b.textContent === '線を太くする')!.click();
    expect(asks).toHaveLength(0);
    expect(d.getState().error ?? '').toContain('太さ');
  });

  it('⚠ 属性を書き換えられて読めない太さになっても書かない', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(lineHit(host));
    const btn = items(root).find((b) => b.textContent === '線を太くする')!;
    btn.setAttribute('data-pkc-style-width', '99');
    btn.click();
    expect(asks).toHaveLength(0);
  });
});

describe('reducer(SET_PLACE_STYLE)', () => {
  it('🔴 付箋の行・線の行は受け、段落の行・読めない値は依頼を作らない', () => {
    const { d, asks } = rig(BOARD);
    d.dispatch({ type: 'SET_PLACE_STYLE', lid: 'n1', line: 0, style: { fill: '#ff0000' } });
    expect(asks).toHaveLength(1);
    d.dispatch({ type: 'SET_PLACE_STYLE', lid: 'n1', line: 8, style: { width: 4 } });
    expect(asks).toHaveLength(2);
    // 板でも線でもない行
    d.dispatch({ type: 'SET_PLACE_STYLE', lid: 'n1', line: 1, style: { fill: '#ff0000' } });
    // 読めない値
    d.dispatch({ type: 'SET_PLACE_STYLE', lid: 'n1', line: 0, style: { fill: 'red' } as never });
    expect(asks, '受けてはいけない依頼を作った').toHaveLength(2);
  });

  it('🔴 編集中は断る(声に出す)', () => {
    const { d, asks } = rig(BOARD);
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'SET_PLACE_STYLE', lid: 'n1', line: 0, style: { fill: '#ff0000' } });
    expect(asks).toHaveLength(0);
    expect(d.getState().error ?? '').toContain('色');
  });
});

/**
 * 🔴 **変数を置いても、受け皿の規則が無ければ画面は変わらない**(`place-board.ts` が置く変数の読み手)。
 * ⚠ 全部**既定つき**で読む ── 変数が無ければ今までの色(第 2 引数)で出る。実ブラウザの計算後の色は smoke が見る。
 * 🔑 CSS は構文で読む(`css-blocks.ts`)。注釈は落としてから(解説に書いた綴りに満たされない)。
 */
describe('色の受け皿(app.css)', () => {
  const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
  const one = (sel: string): string => {
    const b = blocksFor(APP, sel);
    expect(b, `${sel} の規則が 1 つに決まらない`).toHaveLength(1);
    return b[0]!;
  };

  it('🔴 四角の付箋: 地・枠・字が変数から(既定は今までの色)', () => {
    const b = one('.pkc-md-rendered .pkc-format-block.pkc-place');
    expect(b).toMatch(decl('background', 'var\\(--pkc-place-fill, var\\(--surface\\)\\)'));
    expect(b).toMatch(decl('border', '1px solid var\\(--pkc-place-stroke, var\\(--border\\)\\)'));
    expect(b).toMatch(decl('color', 'var\\(--pkc-place-ink, inherit\\)'));
  });

  /**
   * 🔴 **塗りを付けた付箋では、題名の帯・注記の字も塗りの上の字(`-ink`)に追従する**(着地後レビュー)。
   * ⚠ 直す前は `color: var(--fg)` / `var(--muted)` 固定で、暗いテーマ × 明るい塗りで題名が明るい字のまま読めなかった。
   * 🔑 第 2 引数(既定)は今までの色のまま ── 色の無い付箋の計算後の色は 1 ドットも変わらない(対照群は smoke)。
   */
  it('🔴 題名の帯(place-card)の字は `-ink` に追従し、既定は `--fg`', () => {
    const b = one(".pkc-place > [data-pkc-field='place-card']");
    expect(b).toMatch(decl('color', 'var\\(--pkc-place-ink, var\\(--fg\\)\\)'));
  });

  it.each(['place-limit-note', 'place-body-skip', 'place-body-link', 'place-body-more'])(
    '🔴 %s の字は `-ink` に追従し、既定は `--muted`(素の `--muted` の宣言が残っていない)',
    (field) => {
      const sel = `[data-pkc-field='${field}']`;
      const withColor = blocksFor(APP, sel).filter((b) => /(^|[;\s])color\s*:/.test(b));
      expect(withColor.length, `${sel} の字の色の宣言が見つからない`).toBeGreaterThan(0);
      for (const b of withColor) {
        expect(b).toMatch(decl('color', 'var\\(--pkc-place-ink, var\\(--muted\\)\\)'));
      }
    },
  );

  /**
   * 🔴 **印刷でも塗りを刷る**(着地後レビュー)。ブラウザの既定は印刷で背景を**刷らない** ──
   * 暗い塗りの付箋は、塗りの上の白い字だけが白紙に残って読めない。塗りを落として字を既定へ戻す案は採らない
   * (色で仲間分けした図面の意味が、紙で消える)。
   * ⚠ 実ブラウザの印刷は見られない ── 守れるのは**規則が `@media print` の中に在る**ことだけ(紙の見え方は未確認)。
   * ⚠ 画面の規則(`withoutMedia` 済み)には**入れない**(画面の付箋に効かせる理由が無い)。
   */
  it('🔴 `@media print` の中に、付箋の `print-color-adjust: exact`(接頭辞つきも)が在る', () => {
    const print = mediaBlock(stripComments(readFileSync('src/styles/app.css', 'utf-8')), 'print').body;
    const hit = blocksFor(print, '.pkc-md-rendered .pkc-format-block.pkc-place');
    expect(hit.length, '印刷の節に付箋の規則が無い').toBe(1);
    expect(hit[0]).toMatch(decl('print-color-adjust', 'exact'));
    expect(hit[0]).toMatch(decl('-webkit-print-color-adjust', 'exact'));
    expect(
      blocksFor(APP, '.pkc-md-rendered .pkc-format-block.pkc-place').some((b) => /print-color-adjust/.test(b)),
      '画面の規則へ入っている',
    ).toBe(false);
  });

  it('🔴 角丸・丸は層(::before)が、ひし形・矢印は 2 層(外 = 枠 / 内 = 塗り)が変数から', () => {
    // ⚠ 同じ選択子が共通の規則(`content` など)にも載るので、**宣言を持つ規則が在るか**で見る
    const has = (sel: string, prop: string, value: string): void => {
      const hit = blocksFor(APP, sel).some((b) => decl(prop, value).test(b));
      expect(hit, `${sel} に ${prop}: ${value} が無い`).toBe(true);
    };
    const STROKE_B = '1px solid var\\(--pkc-place-stroke, var\\(--border\\)\\)';
    const FILL = 'var\\(--pkc-place-fill, var\\(--surface\\)\\)';
    const STROKE = 'var\\(--pkc-place-stroke, var\\(--border\\)\\)';
    for (const sh of ['round', 'ellipse']) {
      has(`.pkc-place[data-pkc-shape='${sh}']::before`, 'border', STROKE_B);
      has(`.pkc-place[data-pkc-shape='${sh}']::before`, 'background', FILL);
    }
    for (const sh of ['diamond', 'arrow']) {
      has(`.pkc-place[data-pkc-shape='${sh}']::before`, 'background', STROKE);
      has(`.pkc-place[data-pkc-shape='${sh}']::after`, 'background', FILL);
    }
  });

  it('🔴 線: 色と太さが変数から(既定は今までの色と 2px)。塗り潰さない(fill: none は変数にしない)', () => {
    const b = one("[data-pkc-field='place-lines'] path");
    expect(b).toMatch(decl('stroke', 'var\\(--pkc-line-stroke, var\\(--muted\\)\\)'));
    expect(b).toMatch(decl('stroke-width', 'var\\(--pkc-line-width, 2\\)'));
    expect(b).toMatch(decl('fill', 'none'));
  });
});
