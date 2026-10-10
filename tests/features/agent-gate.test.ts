/**
 * ブラウザの AI に何を許すか ── 門の規則(#1407 段①。裁定「許可すれば渡す」)。
 *
 * 守る主張:
 * 1. 既定は許可なし(聞く)
 * 2. 「この 1 回だけ」は 2 回目でまた聞く / 「常に許す」は 2 回目から聞かない / 「許さない」は通さない
 * 3. 聞けない(ask が無い・落ちた)は許さないと同じ
 * 4. 範囲ごとに別(read を許しても write は聞く)
 * 5. 同時に 2 本来ても、1 枚目で「常に許す」を選べば 2 枚目は聞かない(列に並ぶ)
 * 6. 通したときだけ最終の使われた時刻を控える
 * 7. 🔴 取り消された依頼(signal)は、列に並んでいる間は聞かず、聞いている間に取り消されたら台帳を触らず断る
 * 8. ダイアログの 1 行目は「何を」を言う(探す語 / 題名)── AI の字は 40 字で切り、制御文字を落とす
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_DENIED_TEXT,
  AGENT_LABEL_MAX,
  agentAskNote,
  agentLabel,
  createAgentGate,
  scopeOf,
  type AgentAnswer,
  type AgentGrantsLike,
  type AgentScope,
  type AgentTarget,
} from '@features/agent/agent-gate';

const READ: AgentTarget = { action: 'search', query: '買い物' };
const WRITE: AgentTarget = { action: 'create', title: 'メモ' };

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

describe('scopeOf', () => {
  it('作るだけが write、探す・読む・タグは read', () => {
    expect(scopeOf({ action: 'create', title: 'x' })).toBe('write');
    expect(scopeOf({ action: 'search', query: 'x' })).toBe('read');
    expect(scopeOf({ action: 'read', title: 'x' })).toBe('read');
    expect(scopeOf({ action: 'tags' })).toBe('read');
    // 🔴 書き足すも write(read だけ許した AI に、既存のノートを書き換えさせない)(#1407 段④)
    expect(scopeOf({ action: 'append', title: 'x' })).toBe('write');
  });
});

describe('createAgentGate', () => {
  it('既定は許可なし ── 聞く。許さないなら通さず、時刻も控えない', async () => {
    const g = fakeGrants();
    const asked: AgentTarget[] = [];
    const gate = createAgentGate({
      grants: g.grants,
      ask: async (t) => {
        asked.push(t);
        return 'deny';
      },
      now: () => 1,
    });
    expect(await gate(READ)).toBe(false);
    expect(asked).toEqual([READ]);
    expect(g.touched).toEqual([]);
    expect(g.always.size).toBe(0);
  });

  it('🔴 この 1 回だけ: 通すが憶えない。2 回目はまた聞く', async () => {
    const g = fakeGrants();
    let n = 0;
    const gate = createAgentGate({
      grants: g.grants,
      ask: async () => {
        n++;
        return 'once' as AgentAnswer;
      },
      now: () => 5,
    });
    expect(await gate(READ)).toBe(true);
    expect(await gate(READ)).toBe(true);
    expect(n, '「この 1 回だけ」なのに 2 回目を聞いていない').toBe(2);
    expect(g.always.size).toBe(0);
  });

  it('🔴 常に許す: 憶える。2 回目から聞かない', async () => {
    const g = fakeGrants();
    let n = 0;
    const gate = createAgentGate({
      grants: g.grants,
      ask: async () => {
        n++;
        return 'always' as AgentAnswer;
      },
      now: () => 5,
    });
    expect(await gate(WRITE)).toBe(true);
    expect(await gate(WRITE)).toBe(true);
    expect(await gate(WRITE)).toBe(true);
    expect(n).toBe(1);
    expect(g.always.has('write')).toBe(true);
  });

  it('範囲ごとに別: read を許しても write は聞く', async () => {
    const g = fakeGrants();
    g.always.add('read');
    const asked: AgentTarget[] = [];
    const gate = createAgentGate({
      grants: g.grants,
      ask: async (t) => {
        asked.push(t);
        return 'deny';
      },
      now: () => 1,
    });
    expect(await gate(READ)).toBe(true);
    expect(await gate(WRITE)).toBe(false);
    expect(asked).toEqual([WRITE]);
  });

  it('🔴 聞けない(ask が無い / 出す途中で落ちた)は許さないと同じ', async () => {
    const g1 = fakeGrants();
    const none = createAgentGate({ grants: g1.grants, ask: null, now: () => 1 });
    expect(await none(READ)).toBe(false);
    const g2 = fakeGrants();
    const broken = createAgentGate({
      grants: g2.grants,
      ask: () => Promise.reject(new Error('dialog failed')),
      now: () => 1,
    });
    expect(await broken(READ)).toBe(false);
    expect(g1.touched).toEqual([]);
    expect(g2.touched).toEqual([]);
  });

  it('通したときだけ最終の時刻を控える(この 1 回だけ / 常に許す / 許可済み)', async () => {
    const g = fakeGrants();
    let t = 100;
    const answers: AgentAnswer[] = ['once', 'always', 'deny'];
    const gate = createAgentGate({
      grants: g.grants,
      ask: async () => answers.shift() ?? 'deny',
      now: () => t++,
    });
    await gate(READ); // once → 100
    g.always.delete('read');
    await gate(READ); // always → 101
    await gate(READ); // 許可済み → 102(聞かない)
    g.always.clear();
    await gate(READ); // deny → 控えない
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
    const a = gate(READ);
    const b = gate(READ);
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
    expect(await gate(READ)).toBe(false);
    expect(await gate(READ)).toBe(true);
  });

  describe('🔴 取り消された依頼(signal)', () => {
    it('取り消し済みの依頼は聞かない・台帳も触らない(許可済みの範囲でも通さない)', async () => {
      const g = fakeGrants();
      g.always.add('read');
      let asked = 0;
      const gate = createAgentGate({
        grants: g.grants,
        ask: async () => {
          asked++;
          return 'always';
        },
        now: () => 1,
      });
      const ac = new AbortController();
      ac.abort();
      expect(await gate(READ, ac.signal)).toBe(false);
      expect(asked).toBe(0);
      expect(g.touched).toEqual([]);
      // 対照群: 取り消していなければ通る
      expect(await gate(READ, new AbortController().signal)).toBe(true);
    });

    it('列に並んでいる間に取り消されたら、順番が来ても聞かない', async () => {
      const g = fakeGrants();
      let asked = 0;
      let release: (a: AgentAnswer) => void = () => undefined;
      const gate = createAgentGate({
        grants: g.grants,
        ask: () => {
          asked++;
          return new Promise<AgentAnswer>((r) => {
            release = r;
          });
        },
        now: () => 1,
      });
      const first = gate(WRITE);
      const ac = new AbortController();
      const second = gate(READ, ac.signal);
      await Promise.resolve();
      await Promise.resolve();
      ac.abort(); // 2 本目は順番待ちのうちに取り消された
      release('once');
      expect(await first).toBe(true);
      expect(await second).toBe(false);
      expect(asked, '取り消した依頼の分まで聞いた').toBe(1);
    });

    it('聞いている最中に取り消されたら、答えが「常に許す」でも台帳を触らず断る', async () => {
      const g = fakeGrants();
      const ac = new AbortController();
      const gate = createAgentGate({
        grants: g.grants,
        ask: async () => {
          ac.abort(); // ダイアログが閉じられた(答えは競り合いで「常に許す」が返った)
          return 'always';
        },
        now: () => 1,
      });
      expect(await gate(READ, ac.signal)).toBe(false);
      expect(g.always.size, '取り消した依頼で台帳が書き換わった').toBe(0);
      expect(g.touched).toEqual([]);
    });

    it('ask へ signal を渡す(ダイアログを閉じられるように)', async () => {
      const g = fakeGrants();
      const seen: Array<AbortSignal | undefined> = [];
      const gate = createAgentGate({
        grants: g.grants,
        ask: async (_t, s) => {
          seen.push(s);
          return 'once';
        },
        now: () => 1,
      });
      const ac = new AbortController();
      await gate(READ, ac.signal);
      expect(seen).toEqual([ac.signal]);
    });
  });
});

describe('ダイアログの 1 行目 ── 何を', () => {
  it('🔴 探す: 探す語を出し、本文が AI の提供元へ送られると言う', () => {
    expect(agentAskNote({ action: 'search', query: '買い物' })).toBe(
      'ブラウザの AI が、『買い物』でノートを探して読もうとしています。許すと、当たったノートの本文が AI の提供元へ送られます。',
    );
  });

  it('読む: 題名を出す', () => {
    expect(agentAskNote({ action: 'read', title: '会議メモ' })).toBe(
      'ブラウザの AI が、『会議メモ』を読もうとしています。許すと、そのノートの本文が AI の提供元へ送られます。',
    );
  });

  it('作る: 題名を出す。本文が送られるとは言わない(嘘を言わない)', () => {
    const note = agentAskNote({ action: 'create', title: 'AI のメモ' });
    expect(note).toBe('ブラウザの AI が、『AI のメモ』というノートを作ろうとしています。');
    expect(note).not.toContain('送られ');
  });

  it('書き足す: 題名を出す。本文が送られるとは言わない(#1407 段④)', () => {
    const note = agentAskNote({ action: 'append', title: '会議メモ' });
    expect(note).toBe('ブラウザの AI が、『会議メモ』の末尾に書き足そうとしています。');
    expect(note).not.toContain('送られ');
  });

  it('タグの一覧は read の範囲なので、探す・読むと同じく本文が送られると言う(常に許すは範囲ぜんたいに効く)', () => {
    expect(agentAskNote({ action: 'tags' })).toContain('本文が AI の提供元へ送られます');
  });

  it('AI の字は制御文字を落として 1 行にし、40 字で切る(切ったら「…」)', () => {
    expect(agentLabel('a\nb\tc\u0007d  e')).toBe('a b c d e');
    const long = 'あ'.repeat(AGENT_LABEL_MAX + 10);
    const out = agentLabel(long);
    expect([...out]).toHaveLength(AGENT_LABEL_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
    // 対照群: 40 字ちょうどは切らない
    expect(agentLabel('い'.repeat(AGENT_LABEL_MAX))).toBe('い'.repeat(AGENT_LABEL_MAX));
    // 本文の字を長く渡されても、本来の文(許すと何が起きるか)が残る
    expect(agentAskNote({ action: 'search', query: long })).toContain('本文が AI の提供元へ送られます');
    expect(agentAskNote({ action: 'search', query: 'x\n\ny' })).toContain('『x y』');
  });
});

describe('断りの字', () => {
  it('AI が繰り返さず、ユーザーに伝えるところまで書く', () => {
    expect(AGENT_DENIED_TEXT).toBe(
      'ユーザーが許可しませんでした。同じ依頼を繰り返さず、そのことをユーザーに伝えてください。',
    );
  });
});
