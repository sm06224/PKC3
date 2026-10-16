/** @vitest-environment happy-dom */
/**
 * コードの囲みの中の `> ` 行は引用ではない ── Enter で `> ` を足さず、`>` だけの行から `>` を消さない(E1)。
 * 対照群(囲みの外では今までどおり続ける / 抜ける)を各項に置く。
 */
import { describe, expect, it } from 'vitest';
import { quoteOnEnter } from '../../src/features/markdown/quote-assist';

describe('コードの囲みの中では引用を続けない(E1)', () => {
  it('対照群: 囲みの外の `> echo` は続く', () => {
    const v = '> echo';
    expect(quoteOnEnter(v, v.length)).toEqual({ kind: 'continue', insert: '\n> ' });
  });

  it('囲みの中の `> echo` に `> ` を足さない', () => {
    const v = '```sh\n> echo';
    expect(quoteOnEnter(v, v.length)).toEqual({ kind: 'none' });
  });

  it('対照群: 囲みの外の `>` だけの行は抜ける(記号を消す)', () => {
    const v = '> あ\n>';
    expect(quoteOnEnter(v, v.length).kind).toBe('exit');
  });

  it('囲みの中の `>` だけの行から `>` を消さない', () => {
    const v = '```\n>';
    expect(quoteOnEnter(v, v.length)).toEqual({ kind: 'none' });
  });

  it('囲みを閉じた後は、また引用として続く', () => {
    const v = '```\nx\n```\n> echo';
    expect(quoteOnEnter(v, v.length)).toEqual({ kind: 'continue', insert: '\n> ' });
  });
});
