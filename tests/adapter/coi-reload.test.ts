/** @vitest-environment node */
/**
 * #111: 初回訪問だけ 1 回読み直して分離を成立させる判断。
 *
 * 🔴 **いちばん怖いのは「読み直しの輪」である。** 分離しない環境で読み直し続けると、
 * アプリが永久に起動しない ── 機能が使えないより遥かに悪い。だから
 * 「読み直す」より先に「**読み直さない**」の 4 経路を全部当てる。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyIsolationReload,
  COI_TRIED_KEY,
  reloadForIsolation,
  type CoiReloadDeps,
} from '../../src/adapter/platform/sw/coi-reload';

function deps(over: Partial<CoiReloadDeps> = {}): CoiReloadDeps & {
  reload: ReturnType<typeof vi.fn>;
} {
  const reload = vi.fn();
  return {
    isolated: false,
    jspi: true,
    hasActiveWorker: () => Promise.resolve(true),
    triedBefore: false,
    markTried: () => true,
    reload,
    ...over,
    // ⚠ over が reload を差しても、数えられる方を返す
    ...(over.reload ? {} : { reload }),
  } as CoiReloadDeps & { reload: ReturnType<typeof vi.fn> };
}

describe('読み直すかどうか', () => {
  it('分離していれば何もしない(2 回目以降の通常経路)', async () => {
    const d = deps({ isolated: true });
    expect(await reloadForIsolation(d)).toBe('isolated');
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('🔴 JSPI が無ければ読み直さない(読み直しても分離しない環境)', async () => {
    // Safari / Firefox。⚠ ここが抜けると、Office を使えない人が
    // **セッションごとに 1 回**無駄な読み直しを食う
    const d = deps({ jspi: false });
    expect(await reloadForIsolation(d)).toBe('not-needed');
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('🔴 1 度試していたら読み直さない(輪を作らない)', async () => {
    const d = deps({ triedBefore: true });
    expect(await reloadForIsolation(d)).toBe('gave-up');
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('SW がまだ活きていなければ読み直さない(同じ結果になるだけ)', async () => {
    const d = deps({ hasActiveWorker: () => Promise.resolve(false) });
    expect(await reloadForIsolation(d)).toBe('no-worker');
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('条件が揃えば読み直す', async () => {
    const d = deps();
    expect(await reloadForIsolation(d)).toBe('reloaded');
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('🔴 印を残せないなら読み直さない(記録できない = 輪になる)', async () => {
    // ⚠ 実装は当初「失敗しても読み直しは進める」と書いていた ── それだと
    //    読み直した先で triedBefore が false に戻り、**無限に読み直す**
    const d = deps({ markTried: () => false });
    expect(await reloadForIsolation(d)).toBe('gave-up');
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('🔴 印を置いてから読み直す(順序が逆だと輪になる)', async () => {
    const order: string[] = [];
    const d = deps({
      markTried: () => {
        order.push('mark');
        return true;
      },
      reload: () => order.push('reload'),
    });
    await reloadForIsolation(d);
    expect(order).toEqual(['mark', 'reload']);
  });

  it('🔴 抜ける経路では SW を 1 度も待たない(通常経路に待ちを足さない)', async () => {
    const wait = vi.fn(() => Promise.resolve(true));
    for (const over of [{ isolated: true }, { jspi: false }, { triedBefore: true }]) {
      await reloadForIsolation(deps({ ...over, hasActiveWorker: wait }));
    }
    expect(wait).not.toHaveBeenCalled();
  });
});

/** 実環境から値を集める側。⚠ **判断ではなく採取**を見る。 */
describe('環境からの採取', () => {
  const session = (initial?: string): Storage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set(COI_TRIED_KEY, initial);
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as unknown as Storage & { data: Map<string, string> };
  };
  const globals = (over: Record<string, unknown> = {}): typeof globalThis =>
    ({ WebAssembly: { Suspending: function S() {} }, ...over }) as unknown as typeof globalThis;

  it('登録が失敗していれば読み直さない(ready を待たない)', async () => {
    // ⚠ 登録が無い scope の `ready` は**永久に解決しない** ── 待つと
    //    この Promise が一生残る
    const ready = new Promise<{ active: unknown }>(() => {});
    const reload = vi.fn();
    expect(
      await applyIsolationReload({
        registration: Promise.resolve(null),
        ready,
        globals: globals(),
        session: session(),
        reload,
      }),
    ).toBe('no-worker');
    expect(reload).not.toHaveBeenCalled();
  });

  it('🔴 初回訪問(まだ install 中)は active になるまで待ってから読み直す', async () => {
    // ⚠ `register()` が解決した時点では `active` は null。そこで諦めると
    //    **分離が要るその 1 回**を取り逃がし、次の訪問まで Office が使えない
    const reload = vi.fn();
    const s = session();
    expect(
      await applyIsolationReload({
        registration: Promise.resolve({ active: null }),
        ready: Promise.resolve({ active: {} }),
        globals: globals(),
        session: s,
        reload,
      }),
    ).toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(s.data.get(COI_TRIED_KEY)).toBe('1');
  });

  it('印が残っていれば読み直さない', async () => {
    const reload = vi.fn();
    expect(
      await applyIsolationReload({
        registration: Promise.resolve({ active: {} }),
        ready: null,
        globals: globals(),
        session: session('1'),
        reload,
      }),
    ).toBe('gave-up');
    expect(reload).not.toHaveBeenCalled();
  });

  it('🔴 storage が読めない環境では読み直さない(覚えられない = 輪になる)', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const reload = vi.fn();
    expect(
      await applyIsolationReload({
        registration: Promise.resolve({ active: {} }),
        ready: null,
        globals: globals(),
        session: throwing,
        reload,
      }),
    ).toBe('gave-up');
    expect(reload).not.toHaveBeenCalled();
  });

  it('🔴 storage に書けない環境でも読み直さない(読めるが書けない、を分けて見る)', async () => {
    // ⚠ 「読めた」だけで進むと、書けない環境で **毎回 reload** になる
    const halfBroken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const reload = vi.fn();
    expect(
      await applyIsolationReload({
        registration: Promise.resolve({ active: {} }),
        ready: null,
        globals: globals(),
        session: halfBroken,
        reload,
      }),
    ).toBe('gave-up');
    expect(reload).not.toHaveBeenCalled();
  });

  it('既に分離していれば、登録の解決も待たずに済ませる', async () => {
    expect(
      await applyIsolationReload({
        registration: new Promise(() => {}), // ⚠ 永久に解決しない
        ready: null,
        globals: globals({ crossOriginIsolated: true }),
        session: session(),
        reload: vi.fn(),
      }),
    ).toBe('isolated');
  });

  it('JSPI が無い環境は採取の段階で降りる', async () => {
    expect(
      await applyIsolationReload({
        registration: new Promise(() => {}),
        ready: null,
        globals: { WebAssembly: {} } as unknown as typeof globalThis,
        session: session(),
        reload: vi.fn(),
      }),
    ).toBe('not-needed');
  });
});
