/** @vitest-environment happy-dom */
/**
 * アプリとして開いているか(PWA)の印(A1)── 判定は `isInstalledApp` の 1 本(standalone / minimal-ui / window-controls-overlay /
 * iOS のホーム画面)。表示の形が変わったら付け直し、外したら聞かない。
 */
import { describe, expect, it } from 'vitest';
import { installStandalone, STANDALONE_ATTR } from '../../src/adapter/ui/render/standalone';
import { INSTALLED_MODES } from '../../src/adapter/platform/installed-app';

function fakeWin() {
  const listeners = new Map<string, Set<() => void>>();
  const asked: string[] = [];
  const win = {
    matchMedia: (q: string) => {
      asked.push(q);
      const set = listeners.get(q) ?? new Set<() => void>();
      listeners.set(q, set);
      return { matches: false, addEventListener: (_t: string, f: () => void) => set.add(f), removeEventListener: (_t: string, f: () => void) => set.delete(f) } as unknown as MediaQueryList;
    },
  };
  const fire = (q: string) => listeners.get(q)?.forEach((f) => f());
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { win, fire, asked, count };
}

describe('installStandalone', () => {
  it('印は isInstalledApp の答え / どの表示の形が変わっても付け直す / 外すと聞かない', () => {
    const { win, fire, asked, count } = fakeWin();
    let installed = true;
    const off = installStandalone(document, win, () => installed);
    expect(document.documentElement.hasAttribute(STANDALONE_ATTR)).toBe(true);
    expect(asked).toEqual(INSTALLED_MODES.map((m) => `(display-mode: ${m})`));
    installed = false;
    fire('(display-mode: minimal-ui)');
    expect(document.documentElement.hasAttribute(STANDALONE_ATTR)).toBe(false);
    expect(count()).toBe(3);
    off();
    expect(count(), '外しても聞いている').toBe(0);
  });
});
