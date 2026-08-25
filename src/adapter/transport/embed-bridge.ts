/**
 * 受け口を「張るかどうか」を決める(#189 / C-4 段①)。
 *
 * 🔑 **判断をここに置く理由**: `src/main.ts` は **原文を読む test しか無い**ので、
 * そこに条件を直書きすると「flag を無視して常に張る」型の取り違えが
 * **全 test 緑のまま**通る(CLAUDE.md §2)。取り出せば unit が届く。
 *
 * 段① で答える method は **読み取りだけ** ── `pkc.hello`(何ができるか)と
 * `pkc.ping`。⚠ **書き込み(`pkc.createEntry`)は段②**。外から書かせる口は、
 * 許可の管理(設定の面)が揃ってから開ける。
 */

import { METHODS, RPC } from './protocol';
import { attachMessageBridge, type BridgeOptions } from './message-bridge';
import { parseCreateEntryParams, type CreateEntryInput } from './create-entry-params';

export interface EmbedDeps {
  /** flag が立っているか。 */
  enabled: boolean;
  /**
   * ノートを 1 件作る。⚠ **渡されないときは `pkc.createEntry` を申告しない**
   * ── 「あります」と言って何もしないのが、いちばん困る形である。
   * 🔑 呼び手(boot)は**帯に出す**ところまでやる ── 外から増えたことが
   * **黙って起きない**ようにするのは、この口の動線そのものである。
   */
  createEntry?: (input: CreateEntryInput, origin: string) => Promise<string> | string;
  /** 許す origin(呼ぶたびに読む ── 設定を変えたら張り直さずに効く)。 */
  origins: () => readonly string[];
  onReject?: BridgeOptions['onReject'];
  target?: Window;
}

/** 捌き手が無くても必ず答えられる method。 */
export const ALWAYS_SERVED: readonly string[] = ['pkc.hello', 'pkc.ping'];

/**
 * この版が答えられる method(`pkc.hello` が申告する)。
 *
 * 🔑 **申告は「いま本当に答えられるもの」** ── 約束の全部(`METHODS`)ではない。
 * ⚠ `createEntry` を渡されていない器で `pkc.createEntry` を申告すると、
 * 相手は送ってきて `METHOD_NOT_FOUND` を食う(**嘘の申告**)。
 */
export function served(deps: Pick<EmbedDeps, 'createEntry'>): string[] {
  return [...ALWAYS_SERVED, ...(deps.createEntry ? ['pkc.createEntry'] : [])];
}

/** ⚠ 後方互換のために残す名前(段① の test が読む)。 */
export const SERVED: readonly string[] = ALWAYS_SERVED;

/**
 * 張る。⚠ **flag が false のときは `null` を返し、listener を 1 つも足さない。**
 */
export function startEmbedBridge(deps: EmbedDeps): (() => void) | null {
  if (!deps.enabled) return null;
  return attachMessageBridge({
    allowedOrigins: deps.origins,
    handlers: {
      'pkc.hello': () => ({
        methods: served(deps),
        protocol: 'jsonrpc-2.0',
      }),
      'pkc.ping': () => ({ pong: true }),
      ...(deps.createEntry === undefined
        ? {}
        : {
            'pkc.createEntry': async (request: { params?: Record<string, unknown> }, origin: string) => {
              const parsed = parseCreateEntryParams(request.params);
              if (!parsed.ok) {
                // ⚠ 引数の誤りは**内部の失敗ではない** ── 相手が直せるように
                //    `INVALID_PARAMS` で返す(`message-bridge` は投げた誤りを
                //    `INTERNAL_ERROR` に畳むので、符号を持たせて投げる)
                throw Object.assign(new Error(parsed.message), { rpcCode: RPC.INVALID_PARAMS });
              }
              const lid = await deps.createEntry!(parsed.input, origin);
              return { lid, title: parsed.input.title };
            },
          }),
    },
    ...(deps.onReject === undefined ? {} : { onReject: deps.onReject }),
    ...(deps.target === undefined ? {} : { target: deps.target }),
  });
}

/** ⚠ 申告が約束の外へはみ出していないこと(test が使う)。 */
export function servedAreKnown(): boolean {
  const all = served({ createEntry: () => '' });
  return all.every((m) => (METHODS as readonly string[]).includes(m));
}
