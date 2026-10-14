/** @vitest-environment happy-dom */
/**
 * 🔴 **編集中の打鍵ごとに、情報ペインは本文を走査し直さない**(#1087)。
 *
 * 編集中は 1 打鍵ごとに `UPDATE_OPEN_BODY` が来て、本文の字が毎回変わる。直す前は記憶(字が鍵)が毎回外れ、
 * 400KB で 1 打鍵あたり約 70ms を同期で使っていた。編集中は前回の結果を出したまま、打鍵が止まってから
 * 最新の state で 1 回だけ走査し直す。
 *
 * ## 守る主張
 * 1. 編集中の連打では、同期の走査は増えない / 止まってから 1 回だけ走る
 * 2. 止まった後、添付の行が新しい本文のものになる
 * 3. 編集中でなければ今までどおり同期(対照群)
 * 4. 待っている間にノートを替えても、古いノートの結果は新しいノートへ描かれない
 * 5. 追記欄: 編集で足した見出しは、保存の後に追記先へ入る
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';

const useSpy = vi.fn();
vi.mock('../../src/features/asset/asset-refs-in-body', async (orig) => {
  const real = await orig<typeof import('../../src/features/asset/asset-refs-in-body')>();
  return {
    ...real,
    listAssetUses: (...a: Parameters<typeof real.listAssetUses>) => {
      useSpy(...a);
      return real.listAssetUses(...a);
    },
  };
});

function meta(lid: string): EntryMeta {
  return {
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
  };
}

beforeEach(() => {
  document.body.textContent = '';
  useSpy.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(body: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => {
    inspector.render(s);
    box.render(s);
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  return { root, d, inspector };
}

const assetRow = (root: HTMLElement): string =>
  root.querySelector('[data-pkc-field="inspector-assets"]')?.textContent ?? '';
const typeBody = (s: ReturnType<typeof setup>, body: string): void =>
  void s.d.dispatch({ type: 'UPDATE_OPEN_BODY', body });

describe('編集中の本文走査は打鍵が止まってから 1 回(#1087)', () => {
  it('🔴 連打しても同期の走査は増えず、止まってから 1 回だけ走る', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    s.d.dispatch({ type: 'START_EDIT' });
    expect(s.d.getState().phase, '前提: 編集に入れていない').toBe('editing');
    useSpy.mockClear();
    for (let i = 0; i < 20; i++) typeBody(s, `![設計図](asset:ast-a)\n${'あ'.repeat(i + 1)}\n`);
    expect(useSpy).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1000);
    expect(useSpy).toHaveBeenCalledTimes(1);
  });

  it('🔴 止まった後、添付の行は新しい本文のものになる(それまでは前回のまま)', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    s.d.dispatch({ type: 'START_EDIT' });
    typeBody(s, '[仕様書.pdf](asset:ast-b)\n');
    expect(assetRow(s.root)).toContain('設計図');
    vi.advanceTimersByTime(1000);
    expect(assetRow(s.root)).toContain('仕様書');
    expect(assetRow(s.root)).not.toContain('設計図');
  });

  it('対照群: 編集中でなければ本文が変わった回に同期で走査し直す', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    useSpy.mockClear();
    const st = s.d.getState();
    s.inspector.render({ ...st, openBody: { ...st.openBody!, body: '[仕様書.pdf](asset:ast-b)\n' } });
    expect(useSpy).toHaveBeenCalledTimes(1);
    expect(assetRow(s.root)).toContain('仕様書');
  });

  it('編集を保存して抜けた回は、待たずに同期で最新になる', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    s.d.dispatch({ type: 'START_EDIT' });
    typeBody(s, '[仕様書.pdf](asset:ast-b)\n');
    s.d.dispatch({ type: 'COMMIT_EDIT' });
    expect(s.d.getState().phase, '前提: 保存で ready へ戻っていない').toBe('ready');
    expect(assetRow(s.root)).toContain('仕様書');
  });

  it('🔴 待っている間にノートを替えても、古いノートの結果を新しいノートへ描かない', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    s.d.dispatch({ type: 'START_EDIT' });
    typeBody(s, '[仕様書.pdf](asset:ast-b)\n');
    s.d.dispatch({ type: 'CANCEL_EDIT' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    s.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '本文だけ\n' });
    vi.advanceTimersByTime(1000);
    expect(assetRow(s.root)).not.toContain('仕様書');
    expect(assetRow(s.root)).not.toContain('設計図');
    expect(s.root.querySelector<HTMLElement>('[data-pkc-field="inspector-assets"]')?.hidden).toBe(true);
  });

  it('別のノートの本文が届いた回は、前のノートの結果を出さず同期で走査する', () => {
    const s = setup('![設計図](asset:ast-a)\n');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    s.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '![図2](asset:ast-z)\n' });
    expect(assetRow(s.root)).toContain('図2');
    expect(assetRow(s.root)).not.toContain('設計図');
  });
});

describe('追記先の一覧は、編集で足した見出しが保存の後に出る(#1087)', () => {
  it('🔴 編集で見出しを足して保存すると、追記先に入る', () => {
    const s = setup('# 一章\n');
    const opts = (): string[] =>
      [...s.root.querySelectorAll<HTMLOptionElement>('[data-pkc-field="append-target"] option')].map(
        (o) => o.textContent ?? '',
      );
    expect(opts().some((t) => t.includes('一章')), '前提: 見出しが拾えていない').toBe(true);
    s.d.dispatch({ type: 'START_EDIT' });
    typeBody(s, '# 一章\n## 追加した節\n');
    expect(opts().some((t) => t.includes('追加した節'))).toBe(false);
    s.d.dispatch({ type: 'COMMIT_EDIT' });
    expect(opts().some((t) => t.includes('追加した節'))).toBe(true);
  });
});
