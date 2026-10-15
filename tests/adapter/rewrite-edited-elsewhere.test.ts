/** @vitest-environment happy-dom */
/**
 * 🔴 **別のタブ・窓が編集中のノートへは、書き換える口の残り 4 つも断る**(#1087。`toggle-task` と同じ門)。
 *
 * 対象: ① 追記を元に戻す(`undo-append`)② スタックの行の上へ / 下へ(`stack-link-up` / `stack-link-down`)
 *   ③ ノートの日付を付ける(`set-entry-date`)④ ノートの日付を外す(`clear-entry-date`)。
 * ⚠ 通すと、編集中のタブの保存で上書きされ、書き換えた結果は履歴にだけ残る。**断って理由を出し、何も撃たない**。
 * 観測点は「撃った書換の event」と「出た断りの字」。各口に、錠が取れたとき(対照群)は撃つことを置く。
 * ⚠ 型は `append-edited-elsewhere.test.ts` の台と同じ(実物の binder に錠の口を渡す)。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';
import { stackBody } from '../../src/features/flavor/stack-flavor';

vi.mock('../../src/adapter/ui/render/app-dialog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapter/ui/render/app-dialog')>();
  return {
    ...real,
    // 日付の選び窓は、選び終えた体で即座に返す(窓の手順は app-dialog.test.ts が持つ)
    pickDateInApp: vi.fn(async () => ({ date: '2026-10-20', time: null })),
  };
});

const meta = (lid: string, archetype = 'text', date: string | null = null): never =>
  ({
    lid,
    title: lid,
    archetype,
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date,
    archived: 0,
  }) as never;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const STACK = stackBody([
  { title: 'A', lid: 'a' },
  { title: 'B', lid: 'b' },
]);

/** 実物の binder に錠の口を繋いだ台。押し所は `button[data-pkc-action]` を 1 つ生やして押す。 */
function rig(services: Partial<BinderServices>, opts: { date?: string | null } = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  bindActions(root, d, { showStatus: () => {}, ...services });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', 'text', opts.date ?? null), meta('n2'), meta('s1', 'stack')],
    relations: [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
  events.length = 0;
  const press = (action: string, attrs: Record<string, string> = {}): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', action);
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    root.append(b);
    b.click();
  };
  const rewrites = (kind: string) =>
    events.filter((e) => e.type === 'REQUEST_BODY_REWRITE' && (e as { rewrite: { kind: string } }).rewrite.kind === kind);
  return { d, events, press, rewrites, root };
}

const denied = () => ({ acquireEditLock: vi.fn(async () => 'denied' as const), releaseEditLock: vi.fn() });
const granted = () => ({ acquireEditLock: vi.fn(async () => 'granted' as const), releaseEditLock: vi.fn() });

describe('① 追記を元に戻す(undo-append)', () => {
  const armed = (t: ReturnType<typeof rig>) => {
    t.d.dispatch({
      type: 'ENTRY_APPENDED',
      gen: 0,
      lid: 'n1',
      body: '本文\n\n足した\n',
      status: null,
      date: null,
      archived: false,
      inserted: ['足した'],
    } as never);
    // ⚠ 台の前提: 外す材料が入っている(無いと reducer が黙って何もしない = 空振り)
    expect(t.d.getState().lastAppend?.lid, '台の前提: 追記の材料が無い').toBe('n1');
    t.events.length = 0;
  };

  it('🔴 別のタブが握っていたら何も撃たず、理由を出し、材料は残る', async () => {
    const lock = denied();
    const t = rig(lock);
    armed(t);
    t.press('undo-append');
    await flush();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('n1');
    expect(t.rewrites('undo-append'), '断られたのに外す書換を撃った').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
    expect(t.d.getState().lastAppend, '断った回に材料を捨てた(押し直せない)').not.toBeNull();
  });

  it('対照群: 取れたら撃つ(錠は握り続けず返す)', async () => {
    const lock = granted();
    const t = rig(lock);
    armed(t);
    t.press('undo-append');
    await flush();
    expect(t.rewrites('undo-append')).toHaveLength(1);
    expect(lock.releaseEditLock).toHaveBeenCalledWith('n1');
  });

  it('🔴 問い合わせの間に別のノートへ追記が替わったら、押していない追記を外さない', async () => {
    let grant!: (v: 'granted') => void;
    const t = rig({
      acquireEditLock: () => new Promise<'granted'>((r) => (grant = r)),
      releaseEditLock: vi.fn(),
    });
    armed(t);
    t.press('undo-append');
    // 待っている間に、別のノート(n2)への追記が「直前の追記」になった
    t.d.dispatch({
      type: 'ENTRY_APPENDED',
      gen: 0,
      lid: 'n2',
      body: '別\n\n足した\n',
      status: null,
      date: null,
      archived: false,
      inserted: ['足した'],
    } as never);
    expect(t.d.getState().lastAppend?.lid, '台の前提: 直前の追記が替わっていない').toBe('n2');
    t.events.length = 0;
    grant('granted');
    await flush();
    expect(t.rewrites('undo-append'), '押していない追記(n2)を外した').toHaveLength(0);
    expect(t.d.getState().lastAppend?.lid, 'n2 の材料を捨てた').toBe('n2');
  });

  it('問い合わせが落ちたら、次にすることを言って撃たない', async () => {
    const t = rig({
      acquireEditLock: async () => {
        throw new Error('x');
      },
      releaseEditLock: vi.fn(),
    });
    armed(t);
    t.press('undo-append');
    await flush();
    expect(t.rewrites('undo-append')).toHaveLength(0);
    expect(t.d.getState().error ?? '').toContain('追記を元に戻せませんでした');
  });
});

describe('② スタックの行の上へ / 下へ(stack-link-up / stack-link-down)', () => {
  const withStack = (t: ReturnType<typeof rig>) => {
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 's1' });
    t.d.dispatch({ type: 'BODY_LOADED', lid: 's1', body: STACK });
    expect(t.d.getState().openBody?.lid, '台の前提: スタックを開いていない').toBe('s1');
    t.events.length = 0;
  };

  it.each(['stack-link-up', 'stack-link-down'])('🔴 %s: 別のタブが握っていたら何も撃たず、理由を出す', async (action) => {
    const lock = denied();
    const t = rig(lock);
    withStack(t);
    // 上へ = 2 行目(1)/ 下へ = 1 行目(0)を押す
    t.press(action, { 'data-pkc-line': action === 'stack-link-up' ? '1' : '0' });
    await flush();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('s1');
    expect(t.rewrites('link-move'), '断られたのに並べ替えを撃った').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it.each(['stack-link-up', 'stack-link-down'])('対照群: %s は取れたら撃つ', async (action) => {
    const lock = granted();
    const t = rig(lock);
    withStack(t);
    t.press(action, { 'data-pkc-line': action === 'stack-link-up' ? '1' : '0' });
    await flush();
    expect(t.rewrites('link-move')).toHaveLength(1);
    expect(lock.releaseEditLock).toHaveBeenCalledWith('s1');
  });
});

describe('③ ノートの日付を付ける(set-entry-date)', () => {
  it('🔴 別のタブが握っていたら何も撃たず、理由を出す(選び終えた時点で確かめる)', async () => {
    const lock = denied();
    const t = rig(lock);
    t.press('set-entry-date');
    await flush();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('n1');
    expect(t.rewrites('frontmatter'), '断られたのに日付を書いた').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it('対照群: 取れたら日付を書く', async () => {
    const lock = granted();
    const t = rig(lock);
    t.press('set-entry-date');
    await flush();
    const r = t.rewrites('frontmatter');
    expect(r).toHaveLength(1);
    expect((r[0] as { rewrite: { keys: Record<string, unknown> } }).rewrite.keys).toEqual({ date: '2026-10-20' });
  });
});

describe('④ ノートの日付を外す(clear-entry-date)', () => {
  it('🔴 別のタブが握っていたら何も撃たず、理由を出す', async () => {
    const lock = denied();
    const t = rig(lock, { date: '2026-10-01' });
    t.press('clear-entry-date');
    await flush();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('n1');
    expect(t.rewrites('frontmatter'), '断られたのに日付を外した').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it('対照群: 取れたら外す / 口の無い環境は同期のまま外す', async () => {
    const lock = granted();
    const t = rig(lock, { date: '2026-10-01' });
    t.press('clear-entry-date');
    await flush();
    expect(t.rewrites('frontmatter')).toHaveLength(1);
    const bare = rig({}, { date: '2026-10-01' });
    bare.press('clear-entry-date');
    expect(bare.rewrites('frontmatter'), '口の無い環境の操作を非同期に変えた').toHaveLength(1);
  });
});
