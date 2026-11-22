/** @vitest-environment happy-dom */
/** アプリとして開いているか(PWA)の印(A1)── `display-mode` が standalone / window-controls-overlay のときだけ `<html>` に付く。 */
import { describe, expect, it } from 'vitest';
import { installStandalone, STANDALONE_ATTR, STANDALONE_QUERY } from '../../src/adapter/ui/render/standalone';

function fakeMq(matches: boolean) {
  const listeners: (() => void)[] = [];
  const mq = {
    matches,
    addEventListener: (_t: string, fn: () => void) => void listeners.push(fn),
    removeEventListener: () => undefined,
  };
  return { mq, fire: (m: boolean) => ((mq.matches = m), listeners.forEach((f) => f())) };
}

describe('installStandalone', () => {
  it('PWA なら印を付け、表示の形が変われば付け外す / 問い合わせは standalone と window-controls-overlay', () => {
    const { mq, fire } = fakeMq(true);
    let asked = '';
    installStandalone(document, { matchMedia: (q: string) => ((asked = q), mq as unknown as MediaQueryList) });
    expect(asked).toBe(STANDALONE_QUERY);
    expect(asked).toContain('standalone');
    expect(asked).toContain('window-controls-overlay');
    expect(document.documentElement.hasAttribute(STANDALONE_ATTR)).toBe(true);
    fire(false);
    expect(document.documentElement.hasAttribute(STANDALONE_ATTR)).toBe(false);
  });
});
