/** @vitest-environment happy-dom */
/**
 * 🔴 **板の付箋の中のチェックを、板の上で押せる**(#529 W5-c。Gemini 裁定 2026-10-11 依頼 18 Q4 = A)。
 *
 * 守る主張(画面で起きること):
 * 1. 付箋の中のチェックを押すと、**置いたノートの本文**のその行が反転する(`REQUEST_BODY_REWRITE` の
 *    `lid` は置いたノート。板のノートではない ── 板の同じ行番号を書き換えない)
 * 2. 置いたノートの先頭に設定行(frontmatter)があっても、**原文の行**で指す(抜粋は設定行を剥がすので足す)
 * 3. 別のタブが編集中なら断って理由を出し、何も書かない(押した印は動かない)
 * 4. 行を原文へ引けない印は押せないまま、理由(`title`)を言う
 * 5. 同じノートを 2 枚置いても、押した付箋のノートへ効く
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import {
  PLACE_TASK_LOCKED_HINT,
  PlaceEmbeds,
  sanitizeEmbedded,
  type PlaceEmbedDeps,
} from '../../src/adapter/ui/render/place-embed';
import { frontmatterLineCount, bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { excerptOf } from '../../src/features/markdown/place-embed';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';

const meta = (lid: string, archetype: string, title = lid): never =>
  ({ lid, title, archetype, created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 }) as never;
const METAS = [meta('n1', 'text', '板'), meta('n2', 'text', 'やること')];
const BOARD = [
  '- [ ] 板の自分の項目',
  '',
  ':::format{#a .pkc-place entry=n2 x=10 y=20 w=300 h=200}',
  ':::',
  '',
  ':::format{#b .pkc-place entry=n2 x=400 y=20 w=300 h=200}',
  ':::',
  '',
].join('\n');

beforeEach(() => {
  // 観測器が無い環境 = 全部の枠が「近い」(中身を描く)
  vi.stubGlobal('IntersectionObserver', undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

async function rig(placedBody: string, services: Partial<BinderServices> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = renderMarkdown(BOARD, { sourceLineAnchors: true, interactiveTasks: true });
  applyPlaceLayout(host, (l) => (l === 'n2' ? 'やること' : null), frontmatterLineCount(BOARD));
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'detail');
  region.append(host);
  root.append(region);
  document.body.append(root);
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  bindActions(root, d, { showStatus: () => {}, ...services });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
  const ex = excerptOf(placedBody, 'text');
  const deps: PlaceEmbedDeps = {
    selfLid: 'n1',
    excerptOf: () => ex,
    metaOf: (l) => {
      const m = METAS.find((x) => (x as { lid: string }).lid === l) as { title: string; archetype: string } | undefined;
      return m === undefined ? undefined : { title: m.title, archetype: m.archetype };
    },
    // 製品(detail.ts)と同じ旗: チェックだけ押せる・行は設定行のぶん足す
    render: (t, off) =>
      Promise.resolve(renderMarkdown(t, { sourceLineAnchors: false, interactiveTasks: true, taskLineOffset: off })),
    wanted: () => undefined,
    lender: null,
    figures: () => [],
    viewRoot: null,
  };
  new PlaceEmbeds().sync(host, deps);
  await flush();
  events.length = 0;
  const boxes = (id: string): HTMLInputElement[] => [
    ...host.querySelectorAll<HTMLInputElement>(`#${id} input.pkc-task-checkbox`),
  ];
  const ownBox = (): HTMLInputElement =>
    [...host.querySelectorAll<HTMLInputElement>('input.pkc-task-checkbox')].find((b) => b.closest('.pkc-place') === null)!;
  const rewrites = (): Extract<DomainEvent, { type: 'REQUEST_BODY_REWRITE' }>[] =>
    events.filter((e): e is Extract<DomainEvent, { type: 'REQUEST_BODY_REWRITE' }> => e.type === 'REQUEST_BODY_REWRITE');
  return { host, d, events, boxes, ownBox, rewrites, ex };
}

describe('付箋の中のチェックを押す', () => {
  it('🔴 書き換えは置いたノート(n2)の行で撃たれる。板(n1)の同じ行番号ではない', async () => {
    const t = await rig('- [ ] a\n- [x] b\n');
    const [a, b] = t.boxes('a');
    expect(a!.disabled, '押せない形で出ている').toBe(false);
    a!.click();
    await flush();
    expect(t.rewrites()).toHaveLength(1);
    expect(t.rewrites()[0]!.lid).toBe('n2');
    expect(t.rewrites()[0]!.rewrite).toEqual({ kind: 'task', line: 0 });
    b!.click();
    await flush();
    expect(t.rewrites()[1]!.rewrite).toEqual({ kind: 'task', line: 1 });
    // 対照群:板自身の項目は板(n1)へ撃たれる(付箋の分岐が本文の面を奪っていない)
    t.ownBox().click();
    await flush();
    expect(t.rewrites().at(-1)!.lid).toBe('n1');
  });

  it('🔴 置いたノートの先頭に設定行があっても、原文の行(設定行のぶんを足した行)で指す', async () => {
    const body = '---\ntags: x\n---\n- [ ] a\n';
    const t = await rig(body);
    expect(frontmatterLineCount(body)).toBe(3);
    expect(bodyBelowFrontmatter(body).startsWith('- [ ] a')).toBe(true);
    t.boxes('a')[0]!.click();
    await flush();
    expect(t.rewrites()[0]!.rewrite).toEqual({ kind: 'task', line: 3 });
  });

  it('🔴 同じノートを 2 枚置いても、押した付箋のノートへ効く(どちらも n2)', async () => {
    const t = await rig('- [ ] a\n');
    t.boxes('b')[0]!.click();
    await flush();
    expect(t.rewrites()[0]!.lid).toBe('n2');
  });

  it('🔴 別のタブが編集中なら何も書かず理由を出す。取れたら錠は返して書く(対照群)', async () => {
    const deny = vi.fn(async () => 'denied' as const);
    const t = await rig('- [ ] a\n', { acquireEditLock: deny, releaseEditLock: vi.fn() });
    t.boxes('a')[0]!.click();
    await flush();
    expect(deny).toHaveBeenCalledWith('n2');
    expect(t.rewrites(), '断られたのに書いた').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);

    const grant = vi.fn(async () => 'granted' as const);
    const release = vi.fn();
    const u = await rig('- [ ] a\n', { acquireEditLock: grant, releaseEditLock: release });
    u.boxes('a')[0]!.click();
    await flush();
    expect(release).toHaveBeenCalledWith('n2');
    expect(u.rewrites()).toHaveLength(1);
  });

  it('🔴 行を原文へ引けない印(押せない形)は押せないまま、理由を title で言う。付箋の外の掃除では付けない', () => {
    const html = '<input type="checkbox" class="pkc-task-checkbox" disabled>';
    const box = document.createElement('div');
    box.innerHTML = html;
    sanitizeEmbedded(box, () => null, 'p-', true);
    expect(box.querySelector('input')!.getAttribute('title')).toBe(PLACE_TASK_LOCKED_HINT);
    // 対照群:見出しの節の埋め込み(keepTaskToggle 無し)は従来どおり何も足さない
    const sec = document.createElement('div');
    sec.innerHTML = html;
    sanitizeEmbedded(sec, () => null, 'p-');
    expect(sec.querySelector('input')!.hasAttribute('title')).toBe(false);
  });

  it('🔴 付箋が押せる印だけを残す ── 押せる印(toggle-task)以外の action は従来どおり外れる', () => {
    const box = document.createElement('div');
    box.innerHTML =
      '<input type="checkbox" class="pkc-task-checkbox" data-pkc-action="toggle-task" data-pkc-task-line="2">' +
      '<button data-pkc-action="edit-code-block">x</button>';
    sanitizeEmbedded(box, () => null, 'p-', true);
    expect(box.querySelector('input')!.getAttribute('data-pkc-action')).toBe('toggle-task');
    expect(box.querySelector('button')!.hasAttribute('data-pkc-action')).toBe(false);
    const sec = document.createElement('div');
    sec.innerHTML = '<input type="checkbox" data-pkc-action="toggle-task" data-pkc-task-line="2">';
    sanitizeEmbedded(sec, () => null, 'p-');
    expect(sec.querySelector('input')!.hasAttribute('data-pkc-action'), '節の埋め込みで押せてしまう').toBe(false);
  });

  it('設定行の行数が抜粋に載る(鍵も変わる)。設定行が無ければ付かない', () => {
    expect(excerptOf('---\na: 1\n---\nx', 'text').lineOffset).toBe(3);
    expect(excerptOf('x', 'text').lineOffset).toBeUndefined();
  });
});
