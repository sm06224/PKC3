/** @vitest-environment node */
/**
 * P7 段⑧: boot 前の交代からタブを救う。
 *
 * 🔴 段⑤ のレビュー(round-1 M-4)が「塞いでいない窓」として実証した経路 ──
 * lease 待ちのタブが、別タブの更新に巻き込まれて**起動不能**になる。
 * ⚠ この test が守るのは「**いつ読み直すか**」の判断だけで、
 * 実際に読み直すかは `tests/adapter/bootstrap-wiring.test.ts` が配線を見る。
 */
import { describe, expect, it } from 'vitest';
import { reloadOnPrebootSwap, type PrebootTarget } from '../../src/adapter/platform/sw/preboot-swap';

class FakeContainer implements PrebootTarget {
  controller: unknown;
  private readonly listeners: Array<() => void> = [];
  constructor(controlled: boolean) {
    this.controller = controlled ? {} : null;
  }
  addEventListener(_type: 'controllerchange', fn: () => void): void {
    this.listeners.push(fn);
  }
  /** `clients.claim()` が起きた ── **全タブに**飛ぶ。 */
  swap(): void {
    this.controller = {};
    for (const fn of [...this.listeners]) fn();
  }
}

function start(controlled: boolean): {
  container: FakeContainer;
  guard: ReturnType<typeof reloadOnPrebootSwap>;
  reloads: () => number;
} {
  const container = new FakeContainer(controlled);
  let reloads = 0;
  const guard = reloadOnPrebootSwap(container, () => {
    reloads += 1;
  });
  return { container, guard, reloads: () => reloads };
}

describe('boot 前の交代', () => {
  it('🔴 boot が終わる前に交代されたら読み直す(起動不能を避ける)', () => {
    // lease 待ちのタブは storage worker をまだ作っていない ── そのまま進むと
    // **旧 build の hash 付き URL** を取りに行き、cache にも Pages にも無くて 404
    const h = start(true);
    h.container.swap();
    expect(h.reloads()).toBe(1);
  });

  it('🔴 boot 済みのタブは巻き込まない(下書きを捨てない)', () => {
    // 段⑤ の設計「押したタブだけを再読込する」を壊さない
    const h = start(true);
    h.guard.booted();
    h.container.swap();
    expect(h.reloads()).toBe(0);
  });

  it('🔴 初回インストールの claim では読み直さない(交代ではない)', () => {
    // ⚠ 初回の SW も `claim()` するので `controllerchange` は来る ──
    // 区別しないと、**初めて開いた人のページが必ず 1 回リロードする**
    const h = start(false);
    h.container.swap();
    expect(h.reloads()).toBe(0);
  });

  it('読み直しは 1 回だけ(controllerchange は複数回来うる)', () => {
    const h = start(true);
    h.container.swap();
    h.container.swap();
    expect(h.reloads()).toBe(1);
  });

  it('何も起きなければ何もしない', () => {
    expect(start(true).reloads()).toBe(0);
  });

  it('🔴 制御の有無は**登録時点**で読む(交代後に読むともう新しい方)', () => {
    // ⚠ `controllerchange` の中で `container.controller` を読むと、初回でも
    // 真になっている ── 初回と交代を区別できなくなる
    const container = new FakeContainer(false);
    let reloads = 0;
    reloadOnPrebootSwap(container, () => {
      reloads += 1;
    });
    container.swap(); // ここで controller は非 null になる
    expect(container.controller).not.toBeNull(); // ⚠ 前提が成立していることを見る
    expect(reloads).toBe(0);
  });
});
