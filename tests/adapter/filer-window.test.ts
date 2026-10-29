/** @vitest-environment happy-dom */
/**
 * 🔴 **左の一覧(フォルダの表)は、行が多いとき画面に見えている塊だけ行を組む**(#1087 台帳④ の残り)。
 *
 * ## 何を直したか
 *
 * 3,000 件の一覧は、画面の外の行も全部 DOM に持っていた(`content-visibility` で配置は飛ばしても、
 * 行の node・スタイル・見張りは残る)。台帳④ は「一覧を画面に見えている行だけを組む作りに変える必要…費用に
 * 見合わないので見送る」で止まっていた。いまは **50 行の塊のうち見えている範囲の前後だけ**に行を置き、
 * ほかは**行と同じ高さの空の塊**にする(スクロールの長さを変えない)。
 *
 * ## 守るもの(落とした機能が無いこと)
 *
 * - ① 位置(スクロール)に追って塊が組み足され・外れる。組む行は数百行以内
 * - ② 組まれていない行も、`mountFilerRow` で組んでから引ける(↑↓・先頭/末尾・「見える所へ送る」の入口)
 * - ③ 焦点のある行の塊は外れない(外すと鍵が全部死ぬ)
 * - ④ 画面の外の印(複数選択)は「出ている物」に数える(帯の数が嘘をつかない)
 * - ⑤ ↓ / End が画面の外の行へ届く(焦点が移り、選択が動く)
 *
 * ⚠ happy-dom は配置を持たないので、スクロール器の高さと塊の位置は test が差し込む
 *   (`clientHeight` と `getBoundingClientRect` だけ ── 描画器が読む 2 つ)。
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { supportUntilFound } from '../helpers/until-found';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { OpenInEditStore } from '../../src/adapter/ui/render/open-in-edit';
import { mountFilerRow, ROW_CHUNK } from '../../src/adapter/ui/render/filer';

function memStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}
const meta = (i: number): EntryMeta =>
  ({
    lid: 'n' + i,
    title: 't' + i,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: i + 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  }) as EntryMeta;
const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

const N = 3000;
const VIEW = 600;

beforeEach(() => supportUntilFound(true));
afterEach(() => supportUntilFound(false));

function screen(n = N) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  bindActions(
    root,
    d,
    { setBrowse: () => {} } as never,
    new KeymapStore(memStorage() as never),
    new OpenInEditStore(memStorage() as never),
  );
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: Array.from({ length: n }, (_, i) => meta(i)), relations: [] });
  const host = regions.browseHost;
  const table = () => root.querySelector<HTMLElement>('[data-pkc-region="filer-table"]')!;
  // 描画器が読む 2 つだけ差し込む: スクロール器の高さと、先頭の塊の上端(= -スクロール量)
  let top = 0;
  Object.defineProperty(host, 'clientHeight', { get: () => VIEW, configurable: true });
  host.getBoundingClientRect = () => ({ top: 0, bottom: VIEW, left: 0, right: 300, width: 300, height: VIEW, x: 0, y: 0, toJSON: () => ({}) });
  const patchFirst = (): void => {
    const first = table().querySelector('tbody')!;
    first.getBoundingClientRect = () => {
      const t = -top;
      return { top: t, bottom: t + 1300, left: 0, right: 300, width: 300, height: 1300, x: 0, y: t, toJSON: () => ({}) };
    };
  };
  patchFirst();
  const scrollTo = async (px: number) => {
    top = px;
    host.dispatchEvent(new Event('scroll'));
    await tick(40);
  };
  const rowLids = () => [...table().querySelectorAll('tbody tr[data-pkc-entry]')].map((r) => r.getAttribute('data-pkc-entry')!);
  const mountedChunks = () =>
    [...table().querySelectorAll('tbody')].flatMap((b, i) => (b.children.length > 0 ? [i] : []));
  return { root, d, host, table, scrollTo, rowLids, mountedChunks, regions };
}

describe('① 位置に追って塊が組み足され・外れる', () => {
  it('🔴 3,000 件でも、組んでいる行は数百行以内 ── 先頭付近 → 中ほど → 先頭へ戻す', async () => {
    const s = screen();
    await tick();
    // 先頭: 見えている範囲 0..600px + 前後 650px → 塊 0(と 1)
    const first = s.rowLids();
    expect(first.length, '先頭付近で組む行が多すぎる').toBeLessThanOrEqual(250);
    expect(first[0]).toBe('n0');

    const at = 2000 * 26; // n2000 の行の上端
    await s.scrollTo(at);
    const mid = s.rowLids();
    expect(mid.length, '空振り防止: 何も組まれていない').toBeGreaterThan(0);
    expect(mid.length).toBeLessThanOrEqual(250);
    expect(mid, '見えている行 n2000 が組まれていない').toContain('n2000');
    expect(mid, '遠い先頭の行が残っている').not.toContain('n0');
    // 組んだ塊が順番どおり・重複なし
    const nums = mid.map((l) => Number(l.slice(1)));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(new Set(nums).size).toBe(nums.length);

    await s.scrollTo(0);
    expect(s.rowLids()).toContain('n0');
    expect(s.rowLids()).not.toContain('n2000');
  });

  it('🔴 スクロールの長さは全部組んだときと同じ ── 塊の高さの合計は行数 × 26 + 1px(最初と最後の 0.5px)', async () => {
    const s = screen();
    await s.scrollTo(40000);
    const bodies = [...s.table().querySelectorAll('tbody')];
    let total = 0;
    for (const b of bodies) {
      if (b.hasAttribute('data-pkc-chunk-empty')) total += Number.parseFloat(b.style.getPropertyValue('height'));
      else total += b.children.length * 26;
    }
    expect(bodies.length).toBe(N / ROW_CHUNK);
    // 組んだ塊の行(最初の行の 26.5px は CSS)を含め、空の塊の高さと合わせて全体が行数 × 26 + 1px になる
    expect(total).toBe(N * 26 + 1);
  });
});

describe('② 組まれていない行を、組んでから引ける', () => {
  it('🔴 mountFilerRow: 画面の外の行を組んで返す ── 在る行は同じ node、表に無い lid は null', async () => {
    const s = screen();
    await tick();
    expect(s.table().querySelector('[data-pkc-entry="n2900"]'), '前提: 組まれていない').toBeNull();
    const row = mountFilerRow(s.root, 'n2900');
    expect(row, '組んで返していない').not.toBeNull();
    expect(row!.getAttribute('data-pkc-entry')).toBe('n2900');
    expect(s.table().contains(row!)).toBe(true);
    // 在る行は同じ node
    const n0 = s.table().querySelector('[data-pkc-entry="n0"]')!;
    expect(mountFilerRow(s.root, 'n0')).toBe(n0);
    expect(mountFilerRow(s.root, 'no-such-lid')).toBeNull();
    // 組んだ行を含めても数百行以内(全件を組む実装に退行していない)
    expect(s.rowLids().length).toBeLessThanOrEqual(400);
  });
});

describe('③ 焦点のある行の塊は外れない', () => {
  it('🔴 行に焦点があるまま遠くへスクロールしても、その行は DOM に残り焦点も保つ', async () => {
    const s = screen();
    await tick();
    const row = s.table().querySelector<HTMLElement>('[data-pkc-entry="n3"]')!;
    row.focus();
    expect(document.activeElement).toBe(row);
    await s.scrollTo(2000 * 26);
    const again = s.table().querySelector<HTMLElement>('[data-pkc-entry="n3"]');
    expect(again, '焦点のある行の塊が外れた').toBe(row);
    expect(document.activeElement, '焦点が落ちた').toBe(row);
    // 焦点を外してもう一度動かすと、外れる(いつまでも溜めない)
    row.blur();
    await s.scrollTo(2000 * 26 + 10);
    await s.scrollTo(0);
    await s.scrollTo(2500 * 26);
    expect(s.table().querySelector('[data-pkc-entry="n3"]')).toBeNull();
  });
});

describe('④ 画面の外の印も「出ている物」に数える', () => {
  it('🔴 組まれていない行を選んでいても、選択の帯(data-pkc-bulk)が出る', async () => {
    const s = screen();
    await tick();
    s.d.dispatch({ type: 'SELECT_ONLY', lid: 'n2900' });
    await tick();
    expect(s.table().querySelector('[data-pkc-entry="n2900"]'), '前提: n2900 は組まれていない').toBeNull();
    const bar = s.root.querySelector('[data-pkc-region="filer-move"]')!;
    expect(bar.hasAttribute('data-pkc-bulk'), '画面の外の印が数えられていない').toBe(true);
    // 組んだら印と選択が付く
    const row = mountFilerRow(s.root, 'n2900')!;
    expect(row.hasAttribute('data-pkc-marked'), '組んだ行に印が付いていない').toBe(true);
  });
});

describe('⑤ キーで画面の外の行へ送る', () => {
  const press = (key: string, from: Element, over: KeyboardEventInit = {}) =>
    from.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...over }));

  it('🔴 End(最後の行)── 画面の外の行が組まれ、焦点と選択がそこへ移る', async () => {
    const s = screen();
    await tick();
    const row = s.table().querySelector<HTMLElement>('[data-pkc-entry="n0"]')!;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    row.focus();
    press('End', row);
    await tick();
    expect(s.d.getState().selection).toEqual(['n2999']);
    const last = s.table().querySelector<HTMLElement>('[data-pkc-entry="n2999"]');
    expect(last, '末尾の行が組まれていない').not.toBeNull();
    expect(document.activeElement).toBe(last);
  });

  it('🔴 ↓ を境の向こうへ ── 組まれた塊の末尾の次の行へ焦点が届く', async () => {
    const s = screen();
    await tick();
    // 組まれている最後の行まで進めてから ↓(次の行は組まれていないかもしれない)
    const lids = s.rowLids();
    const lastMounted = lids[lids.length - 1]!;
    const row = s.table().querySelector<HTMLElement>(`[data-pkc-entry="${lastMounted}"]`)!;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    row.focus();
    press('ArrowDown', row);
    await tick();
    const next = 'n' + (Number(lastMounted.slice(1)) + 1);
    expect(s.d.getState().selection).toEqual([next]);
    expect((document.activeElement as HTMLElement).getAttribute('data-pkc-entry')).toBe(next);
  });
});

describe('⑥ ブラウザ内検索(Ctrl+F)が、組んでいない行を見つけられる', () => {
  it('🔴 組まない塊に題名だけの軽い行(hidden=until-found)が 1 塊 1 つ置かれ、全題名が文字として入っている', async () => {
    const s = screen();
    await tick();
    const finds = [...s.table().querySelectorAll<HTMLElement>('tbody[data-pkc-chunk-empty] > tr[data-pkc-chunk-find]')];
    const bodies = [...s.table().querySelectorAll('tbody')];
    const empty = bodies.filter((b) => b.hasAttribute('data-pkc-chunk-empty'));
    expect(empty.length, '空の塊が無い(前提)').toBeGreaterThan(0);
    expect(finds.length, '空の塊ごとに 1 つ').toBe(empty.length);
    for (const f of finds) expect(f.getAttribute('hidden')).toBe('until-found');
    // 組んでいない行の題名が、検索に当たる文字として在る(対照群: 組んでいる塊の題名は行の中に在る)
    const all = finds.map((f) => f.textContent ?? '').join('\n');
    expect(all).toContain('t2999');
    expect(all).not.toContain('t0\n');
    // 軽い: 行の数だけ作らない(3,000 件でも 1 塊 1 行)
    expect(s.table().querySelectorAll('tbody tr').length - s.rowLids().length).toBe(finds.length);
  });

  it('🔴 beforematch が来たら、その塊を組む(軽い行は外れ、本物の行が出る)', async () => {
    const s = screen();
    await tick();
    expect(s.table().querySelector('[data-pkc-entry="n2900"]')).toBeNull();
    const find = [...s.table().querySelectorAll<HTMLElement>('tr[data-pkc-chunk-find]')].find((f) =>
      (f.textContent ?? '').includes('t2900'),
    )!;
    find.dispatchEvent(new Event('beforematch', { bubbles: true }));
    expect(s.table().querySelector('[data-pkc-entry="n2900"]'), '検索が当たっても塊が組まれない').not.toBeNull();
    expect(find.isConnected, '軽い行が残っている').toBe(false);
  });

  it('🔴 印刷の間は全部の塊を組む(紙には全行が出る)── 終われば窓に戻る', async () => {
    const s = screen();
    await tick();
    window.dispatchEvent(new Event('beforeprint'));
    expect(s.table().querySelectorAll('tbody tr[data-pkc-entry]').length).toBe(N);
    expect(s.table().querySelectorAll('[data-pkc-chunk-empty]').length).toBe(0);
    window.dispatchEvent(new Event('afterprint'));
    await tick(40);
    expect(s.table().querySelectorAll('tbody tr[data-pkc-entry]').length).toBeLessThanOrEqual(400);
  }, 60_000);
});

describe('⑦ 掴んでいる行は、自動スクロールで外れない', () => {
  it('🔴 dragstart した行の塊は遠くへ送っても残り、dragend の後で外れる', async () => {
    const s = screen();
    await tick();
    const row = s.table().querySelector<HTMLElement>('[data-pkc-entry="n3"]')!;
    row.dispatchEvent(new Event('dragstart', { bubbles: true }));
    await s.scrollTo(2000 * 26);
    expect(s.table().querySelector('[data-pkc-entry="n3"]'), '掴んだ行が外れた(dragend が届かなくなる)').toBe(row);
    row.dispatchEvent(new Event('dragend', { bubbles: true }));
    await tick(40);
    await s.scrollTo(2500 * 26);
    expect(s.table().querySelector('[data-pkc-entry="n3"]')).toBeNull();
  });
});
