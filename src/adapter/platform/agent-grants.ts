/**
 * 🔴 **「ブラウザの AI に、この範囲を許した」を憶える**(#1407 段①。裁定「許可すれば渡す」)。
 *
 * 範囲は 2 つ(`features/agent/agent-gate.ts`):`read`(探す・読む・タグ)と `write`(作る)。
 * **既定はどちらも許可なし。** ここに載るのは「常に許す」を選んだ範囲だけで、
 * 「今回だけ」は憶えない(2 回目はまた聞く)。
 *
 * ## container に入れない ── この端末の判断である
 *
 * `extension-grants.ts` / `same-origin-grants.ts` と同じ理由:入れると、書き出した
 * バックアップを配った相手の端末でまで「AI に読ませてよい」が立つ。許可は配ってはいけない。
 * 🔑 鍵は他の許可の台帳とは**別**にする(混ぜると、片方を取り消した人の許可がもう片方まで消える)。
 *
 * ## 最終の呼び出しも控える(設定の一覧に出す)
 *
 * 許可を取り消す判断の材料は「最近使われたか」である。⚠ 憶えるのは**時刻だけ**
 * (何を探したか・何を読んだかは 1 バイトも残さない ── 本文は私物である)。
 *
 * ⚠ **毎回読む**(別のタブでの取り消しがそのまま効く)。保存が使えない端末(私用ウィンドウ等)では
 * **この session の中でだけ**効く控えを持つ(`PhoneLinksStore` と同じ作法 ── 控えを読む枝が
 * 死んでいないこと)。
 */

import type { AgentGrantsLike, AgentScope } from '@features/agent/agent-gate';
import { AGENT_SCOPES } from '@features/agent/agent-gate';

const KEY = 'pkc3.agent-grants';

/** test / 設定の画面が場所を名指しできるように出す。 */
export const AGENT_GRANTS_KEY = KEY;

interface ScopeState {
  /** 「常に許す」を選んだか。 */
  always: boolean;
  /** 最後に呼ばれた時刻(ms)。`null` = まだ呼ばれていない。 */
  last: number | null;
}

type State = Partial<Record<AgentScope, ScopeState>>;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readStorage(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // 私用ウィンドウ等 ── 憶えられないだけで、起動そのものは動く
    return null;
  }
}

/** 一覧の 1 行。 */
export interface AgentGrantRow {
  scope: AgentScope;
  /** 最後に呼ばれた時刻(ms)。`null` = まだ呼ばれていない。 */
  last: number | null;
}

export class AgentGrants implements AgentGrantsLike {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: State = {};

  private readonly listeners = new Set<() => void>();

  /**
   * ⚠ `readonly` ではない ── 読めるのに書けない端末(容量 0 など)で、書いた後に `null`
   *   (= 控えだけで動く)へ倒すため(`write` を見よ)。
   */
  private storage: Store | null;

  constructor(storage: Store | null = readStorage()) {
    this.storage = storage;
  }

  /**
   * 許可が変わったとき(憶えた / 取り消した / 最後に使われた時刻が動いた)に呼ばれる。
   * ⚠ 設定の一覧が、ダイアログの答えで自分から更新されるために要る(取り消しだけ描き直していた)。
   */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** ⚠ **読むときに検める** ── 保存はアプリ自身も書ける場所なので、壊れた値・知らない範囲は捨てる。 */
  private read(): State {
    if (this.storage === null) return this.fallback;
    let raw: string | null;
    try {
      raw = this.storage.getItem(KEY);
    } catch {
      return this.fallback;
    }
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const out: State = {};
      for (const scope of AGENT_SCOPES) {
        const v = (parsed as Record<string, unknown>)[scope];
        if (typeof v !== 'object' || v === null) continue;
        const r = v as { always?: unknown; last?: unknown };
        out[scope] = {
          always: r.always === true,
          last: typeof r.last === 'number' && Number.isFinite(r.last) ? r.last : null,
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  private write(state: State): void {
    this.fallback = state;
    if (this.storage !== null) {
      try {
        // 空になったら鍵ごと消す(要らない行を残さない)
        if (AGENT_SCOPES.every((s) => state[s] === undefined)) this.storage.removeItem(KEY);
        else this.storage.setItem(KEY, JSON.stringify(state));
      } catch {
        /**
         * 🔴 容量超過等 ── **書けないなら、以後は控えだけで動く**(`storage` を捨てる)。
         * ⚠ 捨てないと、`getItem` は「何も無い」を返すので、書いたばかりの許可が
         *   次の `read` で消え、「常に許す」を選んだのに毎回聞かれる(一覧にも出ない)。
         * この session では効く(次の起動ではまた聞く ── 安全側)。
         */
        this.storage = null;
      }
    }
    for (const fn of this.listeners) fn();
  }

  isAlways(scope: AgentScope): boolean {
    return this.read()[scope]?.always === true;
  }

  setAlways(scope: AgentScope): void {
    const state = this.read();
    state[scope] = { always: true, last: state[scope]?.last ?? null };
    this.write(state);
  }

  touch(scope: AgentScope, at: number): void {
    const state = this.read();
    state[scope] = { always: state[scope]?.always === true, last: at };
    this.write(state);
  }

  /**
   * 許可を外す。⚠ 次に AI が呼んだときは、また聞く。
   * ⚠ 最終の呼び出しの時刻も消す(許していない範囲の行は一覧に出ない)。
   */
  revoke(scope: AgentScope): void {
    const state = this.read();
    delete state[scope];
    this.write(state);
  }

  /** 「常に許す」を選んである範囲(設定の一覧が描く)。 */
  list(): readonly AgentGrantRow[] {
    const state = this.read();
    return AGENT_SCOPES.filter((s) => state[s]?.always === true).map((scope) => ({
      scope,
      last: state[scope]?.last ?? null,
    }));
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(test は自分で `new AgentGrants(fake)` を渡す)。 */
export const appAgentGrants = new AgentGrants();
