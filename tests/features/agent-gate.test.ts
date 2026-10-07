/**
 * ブラウザの AI に何を許すか ── 門の規則(#1407 段①。裁定「許可すれば渡す」)。
 *
 * 守る主張:
 * 1. 既定は許可なし(聞く)
 * 2. 「今回だけ」は 2 回目でまた聞く / 「常に許す」は 2 回目から聞かない / 「許さない」は通さない
 * 3. 聞けない(ask が無い・落ちた)は許さないと同じ
 * 4. 範囲ごとに別(read を許しても write は聞く)
 * 5. 同時に 2 本来ても、1 枚目で「常に許す」を選べば 2 枚目は聞かない(列に並ぶ)
 * 6. 通したときだけ最終の呼び出し時刻を控える
 */
import { describe, expect, it } from 'vitest';
import {
  createAgentGate,
  type AgentAnswer,
  type AgentGrantsLike,
  type AgentScope,
} from '@features/agent/agent-gate';

function fakeGrants() {
  const always = new Set<AgentScope>();
  const touched: Array<[AgentScope, number]> = [];
  const grants: AgentGrantsLike = {
    isAlways: (s) => always.has(s),
    setAlways: (s) => void always.add(s),
    touch: (s, at) => void touched.push([s, at]),
  };
  return { grants, always, touched };
}

describe('createAgentGate', () => {
  it('既定は許可なし ── 聞く。許さないなら通さず、時刻も控えない', async () => {
    const g = fakeGrants();
    const asked: AgentScope[] = [];
    const gate = createAgentGate({
      grants: g.grants,
      ask: async (s) => (asked.push(s), 'deny'),
      now: () => 1,
    });
    expect(await gate('read')).toBe(false);
    expect(asked).toEqual(['read']);
    expect(g.touched).toEqual([]);
    expect(g.always.size).toBe(0);
  });

  it('🔴 今回だけ: 通すが憶えない。2 回目はまた聞く', async () => {
    const g = fakeGrants();
    let n = 0;
    const gate = createAgentGate({
      grants: g.grants,
      ask: async () => (n++, 'once' as AgentAnswer),
      now: () => 5,
    });
    expect(await gate('read')).toBe(true);
    expect(await gate('read')).toBe(true);
    expect(n, '「今回だけ」なのに 2 回目を聞いていない').toBe(2);
    expect(g.always.size).toBe(0);
  });

  it('🔴 常に許す: 憶える。2 回目から聞かない', async () => {
    const g = fakeGrants();
    let n = 0;
    const gate = createAgentGate({
      grants: g.grants,
      ask: async () => (n++, 'always' as AgentAnswer),
      now: () => 5,
    });
    expect(await gate('write')).toBe(true);
    expect(await gate('write')).toBe(true);
    expect(await gate('write')).toBe(true);
    expect(n).toBe(1);
    expect(g.always.has('write')).toBe(true);
  });

  it('範囲ごとに別: read を許しても write は聞く', async () => {
    const g = fakeGrants();
    g.always.add('read');
    const asked: AgentScope[] = [];
    const gate = createAgentGate({
      grants: g.grants,
      ask: async (s) => (asked.push(s), 'deny'),
      now: () => 1,
    });
    expect(await gate('read')).toBe(true);
    expect(await gate('write')).toBe(false);
    expect(asked).toEqual(['write']);
  });

  it('🔴 聞けない(ask が無い / 出す途中で落ちた)は許さないと同じ', async () => {
    const g1 = fakeGrants();
    const none = createAgentGate({ grants: g1.grants, ask: null, now: () => 1 });
    expect(await none('read')).toBe(false);
    const g2 = fakeGrants();
    const broken = createAgentGate({
      grants: g2.grants,
      ask: () => Promise.reject(new Error('dialog failed')),
      now: () => 1,
    });
    expect(await broken('read')).toBe(false);
    expect(g1.touched).toEqual([]);
    expect(g2.touched).toEqual([]);
  });

  it('通したときだけ最終の呼び出し時刻を控える(今回だけ / 常に許す / 許可済み)', async () => {
    const g = fakeGrants();
    let t = 100;
    const answers: AgentAnswer[] = ['once', 'always', 'deny'];
    const gate = createAgentGate({
      grants: g.grants,
      ask: async () => answers.shift() ?? 'deny',
      now: () => t++,
    });
    await gate('read'); // once → 100
    g.always.delete('read');
    await gate('read'); // always → 101
    await gate('read'); // 許可済み → 102(聞かない)
    g.always.clear();
    await gate('read'); // deny → 控えない
    expect(g.touched).toEqual([
      ['read', 100],
      ['read', 101],
      ['read', 102],
    ]);
  });

  it('🔴 同時に 2 本来ても、1 枚目で「常に許す」を選べば 2 枚目は聞かない(列に並ぶ)', async () => {
    const g = fakeGrants();
    let n = 0;
    let release: (a: AgentAnswer) => void = () => undefined;
    const gate = createAgentGate({
      grants: g.grants,
      ask: () => {
        n++;
        return new Promise<AgentAnswer>((r) => {
          release = r;
        });
      },
      now: () => 1,
    });
    const a = gate('read');
    const b = gate('read');
    // 1 枚目の答えを待つ間、2 枚目はまだ聞いていない
    await Promise.resolve();
    await Promise.resolve();
    expect(n).toBe(1);
    release('always');
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(n, '2 枚目も聞いてしまった(許可を読み直していない)').toBe(1);
  });

  it('前の 1 本が転んでも、列は進む', async () => {
    const g = fakeGrants();
    let first = true;
    const gate = createAgentGate({
      grants: g.grants,
      ask: async () => {
        if (first) {
          first = false;
          throw new Error('x');
        }
        return 'once';
      },
      now: () => 1,
    });
    expect(await gate('read')).toBe(false);
    expect(await gate('read')).toBe(true);
  });
});
