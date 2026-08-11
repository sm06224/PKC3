/** @vitest-environment node */
/**
 * #115: 起動に失敗したら、待機中の新しい版へ自分で乗り換える。
 *
 * 🔴 **これは自己永続化する障害を塞ぐ機構である**(2026-08-11 に実際に作った)。
 * 起動を壊す SW が active になると、直した版を配っても waiting のままで、
 * 交代を促す案内は起動しないと出ない ── 誰も回復できなくなる。
 *
 * ⚠ だからこそ **輪を作らない**方が優先度が高い。「乗り換える」より先に
 * 「**乗り換えない**」の経路を全部当てる。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyBootRecovery,
  autoApplyOnBootFailure,
  BOOT_RECOVERY_KEY,
} from '../../src/adapter/platform/sw/boot-recovery';

describe('乗り換えるかどうか', () => {
  const deps = (over: Partial<Parameters<typeof autoApplyOnBootFailure>[0]> = {}): {
    d: Parameters<typeof autoApplyOnBootFailure>[0];
    apply: ReturnType<typeof vi.fn>;
  } => {
    const apply = vi.fn();
    return {
      apply,
      d: { bootFailed: true, triedBefore: false, markTried: () => true, apply, ...over },
    };
  };

  it('🔴 起動できているなら何もしない(押していない交代を起こさない)', () => {
    // ⚠ ここが抜けると、**正常なタブが勝手に読み直される** ── 段⑤ が
    //    わざと避けた「開いたままの作業を巻き込む」形そのものになる
    const { d, apply } = deps({ bootFailed: false });
    expect(autoApplyOnBootFailure(d)).toBe('no-failure');
    expect(apply).not.toHaveBeenCalled();
  });

  it('🔴 1 度乗り換えていたら繰り返さない(輪を作らない)', () => {
    const { d, apply } = deps({ triedBefore: true });
    expect(autoApplyOnBootFailure(d)).toBe('gave-up');
    expect(apply).not.toHaveBeenCalled();
  });

  it('🔴 印を残せないなら乗り換えない(記録できない = 輪になる)', () => {
    const { d, apply } = deps({ markTried: () => false });
    expect(autoApplyOnBootFailure(d)).toBe('gave-up');
    expect(apply).not.toHaveBeenCalled();
  });

  it('起動に失敗していて、まだ試していないなら乗り換える', () => {
    const { d, apply } = deps();
    expect(autoApplyOnBootFailure(d)).toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('🔴 印を置いてから押す(順序が逆だと輪になる)', () => {
    const order: string[] = [];
    const { d } = deps({
      markTried: () => {
        order.push('mark');
        return true;
      },
      apply: () => order.push('apply'),
    });
    autoApplyOnBootFailure(d);
    expect(order).toEqual(['mark', 'apply']);
  });
});

describe('環境からの採取', () => {
  const session = (initial?: string): Storage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set(BOOT_RECOVERY_KEY, initial);
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as unknown as Storage & { data: Map<string, string> };
  };

  it('印を残して乗り換える', () => {
    const apply = vi.fn();
    const s = session();
    expect(applyBootRecovery({ bootFailed: true, session: s, apply })).toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(s.data.get(BOOT_RECOVERY_KEY)).toBe('1');
  });

  it('印が在れば乗り換えない', () => {
    const apply = vi.fn();
    expect(applyBootRecovery({ bootFailed: true, session: session('1'), apply })).toBe('gave-up');
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    [
      '読めない',
      {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {},
      },
    ],
    [
      '読めるが書けない',
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
    ],
    ['そもそも無い', null],
  ])('🔴 storage が %s 環境では乗り換えない(覚えられない = 輪になる)', (_name, s) => {
    const apply = vi.fn();
    expect(
      applyBootRecovery({
        bootFailed: true,
        session: s as Pick<Storage, 'getItem' | 'setItem'> | null,
        apply,
      }),
    ).toBe('gave-up');
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('配線(#115 は main.ts の失敗側に居る)', () => {
  /**
   * ⚠ **弱い検査だと自覚して使う**(CLAUDE.md 2026-08-08)。`main.ts` は原文を
   * 読む test しか無い。判断そのものは上の unit が見ているので、ここが守るのは
   * **「失敗側から呼ばれていること」**だけ。
   *
   * ⚠ 実測(変異試験 2026-08-11): `(apply) =>` を `() =>` に変える配線切りは
   * **この検査を生き延びる**(名前は残るので)。殺したのは
   * `tests/smoke/coi.smoke.spec.ts` の「起動を壊す SW から自動回復する」だった ──
   * **配線の正しさを見ているのは smoke である**。ここは名前が消える変異だけを止める。
   */
  it('🔴 起動失敗の経路から watchForUpdate と applyBootRecovery を呼んでいる', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main.ts', 'utf-8');
    const failure = src.slice(src.indexOf('起動に失敗しました'));
    expect(failure, '失敗側で待機中の版を見ていない').toContain('watchForUpdate');
    expect(failure, '失敗側で乗り換えの判断をしていない').toContain('applyBootRecovery');
    expect(failure).toContain('bootFailed: true');
  });
});
