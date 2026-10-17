/**
 * 🔴 **他のページに組み込まれた AI に、この範囲を許した**を憶える(#1407 段⑥)。
 *
 * `agent-grants.ts`(このブラウザの AI)と**同じ 3 つの範囲**(探す・読む / 作る / 書き足す)を、
 * **origin ごと**に憶える。既定はどれも許可なし。憶えるのは「常に許す」だけ(「この 1 回だけ」は憶えない)。
 *
 * ## 台帳を分ける理由
 *
 * ブラウザの AI に「探す・読む」を常に許した人が、`https://x.test` に組み込まれた AI にまで
 * 黙って許したことになってはいけない(相手が違う ── 本文の行き先が違う)。鍵も別(`KEY`)。
 * container には入れない(許可は書き出して配る物ではない ── `agent-grants.ts` と同じ)。
 *
 * ⚠ 憶えるのは origin と時刻だけ(何を探したか・何を読んだかは 1 バイトも残さない)。
 * ⚠ 読むときに検める(壊れた値・知らない範囲は捨てる)。保存が使えない端末では session の中でだけ効く。
 */

import { AGENT_SCOPES, type AgentGrantsLike, type AgentScope } from '@features/agent/agent-gate';
import type { AgentGrantRow } from './agent-grants';

const KEY = 'pkc3.agent-origin-grants';

/** test / 設定の画面が場所を名指しできるように出す。 */
export const AGENT_ORIGIN_GRANTS_KEY = KEY;

interface ScopeState {
  always: boolean;
  last: number | null;
}
type OriginState = Partial<Record<AgentScope, ScopeState>>;
type State = Map<string, OriginState>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readStorage(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 一覧の 1 行(origin つき)。 */
export interface AgentOriginGrantRow extends AgentGrantRow {
  origin: string;
}

export class AgentOriginGrants {
  private fallback: State = new Map();
  private readonly listeners = new Set<() => void>();
  private storage: Store | null;

  constructor(storage: Store | null = readStorage()) {
    this.storage = storage;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private read(): State {
    if (this.storage === null) return this.fallback;
    let raw: string | null;
    try {
      raw = this.storage.getItem(KEY);
    } catch {
      return this.fallback;
    }
    const out: State = new Map();
    if (raw === null) return out;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
      for (const [origin, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'object' || v === null) continue;
        const st: OriginState = {};
        for (const scope of AGENT_SCOPES) {
          const r = (v as Record<string, unknown>)[scope];
          if (typeof r !== 'object' || r === null) continue;
          const { always, last } = r as { always?: unknown; last?: unknown };
          st[scope] = {
            always: always === true,
            last: typeof last === 'number' && Number.isFinite(last) ? last : null,
          };
        }
        if (AGENT_SCOPES.some((s) => st[s] !== undefined)) out.set(origin, st);
      }
    } catch {
      return new Map();
    }
    return out;
  }

  private write(state: State): void {
    this.fallback = state;
    if (this.storage !== null) {
      try {
        if (state.size === 0) this.storage.removeItem(KEY);
        else this.storage.setItem(KEY, JSON.stringify(Object.fromEntries(state)));
      } catch {
        // 書けないなら以後は控えだけで動く(`agent-grants.ts` と同じ)
        this.storage = null;
      }
    }
    for (const fn of this.listeners) fn();
  }

  isAlways(origin: string, scope: AgentScope): boolean {
    return this.read().get(origin)?.[scope]?.always === true;
  }

  setAlways(origin: string, scope: AgentScope): void {
    const state = this.read();
    const cur = state.get(origin) ?? {};
    cur[scope] = { always: true, last: cur[scope]?.last ?? null };
    state.set(origin, cur);
    this.write(state);
  }

  touch(origin: string, scope: AgentScope, at: number): void {
    const state = this.read();
    const cur = state.get(origin) ?? {};
    cur[scope] = { always: cur[scope]?.always === true, last: at };
    state.set(origin, cur);
    this.write(state);
  }

  /** 1 つの範囲を外す。その origin の範囲が 0 になったら origin ごと消える。 */
  revoke(origin: string, scope: AgentScope): void {
    const state = this.read();
    const cur = state.get(origin);
    if (cur === undefined) return;
    delete cur[scope];
    if (AGENT_SCOPES.every((s) => cur[s] === undefined)) state.delete(origin);
    this.write(state);
  }

  /** origin の許可を全部消す(許すページの一覧から外れたとき ── 入れ直しても聞き直す)。 */
  revokeOrigin(origin: string): void {
    const state = this.read();
    if (!state.delete(origin)) return;
    this.write(state);
  }

  /** 「常に許す」を 1 つでも選んである origin。 */
  origins(): string[] {
    const out: string[] = [];
    for (const [origin, st] of this.read()) {
      if (AGENT_SCOPES.some((s) => st[s]?.always === true)) out.push(origin);
    }
    return out;
  }

  list(): readonly AgentOriginGrantRow[] {
    const rows: AgentOriginGrantRow[] = [];
    for (const [origin, st] of this.read()) {
      for (const scope of AGENT_SCOPES) {
        if (st[scope]?.always === true) rows.push({ origin, scope, last: st[scope]?.last ?? null });
      }
    }
    return rows;
  }
}

/**
 * 門(`createAgentGate`)が引く台帳 ── `from` が無ければこのブラウザの AI の台帳、有れば origin ごとの台帳。
 * 🔑 振り分けはここ 1 か所(門は台帳が 2 つ在ることを知らない)。
 */
export class AgentGrantsRouter implements AgentGrantsLike {
  constructor(
    private readonly local: AgentGrantsLike,
    private readonly byOrigin: AgentOriginGrants,
  ) {}

  isAlways(scope: AgentScope, from?: string): boolean {
    return from === undefined ? this.local.isAlways(scope) : this.byOrigin.isAlways(from, scope);
  }

  setAlways(scope: AgentScope, from?: string): void {
    if (from === undefined) this.local.setAlways(scope);
    else this.byOrigin.setAlways(from, scope);
  }

  touch(scope: AgentScope, at: number, from?: string): void {
    if (from === undefined) this.local.touch(scope, at);
    else this.byOrigin.touch(from, scope, at);
  }
}

/** アプリ共有の 1 個。⚠ test は自分で `new AgentOriginGrants(fake)` を渡す。 */
export const appAgentOriginGrants = new AgentOriginGrants();
