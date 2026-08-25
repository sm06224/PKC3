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

import { METHODS } from './protocol';
import { attachMessageBridge, type BridgeOptions } from './message-bridge';

export interface EmbedDeps {
  /** flag が立っているか。 */
  enabled: boolean;
  /** 許す origin(呼ぶたびに読む ── 設定を変えたら張り直さずに効く)。 */
  origins: () => readonly string[];
  onReject?: BridgeOptions['onReject'];
  target?: Window;
}

/** この版が答えられる method(`pkc.hello` が申告する)。 */
export const SERVED: readonly string[] = ['pkc.hello', 'pkc.ping'];

/**
 * 張る。⚠ **flag が false のときは `null` を返し、listener を 1 つも足さない。**
 */
export function startEmbedBridge(deps: EmbedDeps): (() => void) | null {
  if (!deps.enabled) return null;
  return attachMessageBridge({
    allowedOrigins: deps.origins,
    handlers: {
      'pkc.hello': () => ({
        // 🔑 **申告は「この版が答えられるもの」** ── 約束の全部(`METHODS`)ではない。
        //    ⚠ ここで `METHODS` を返すと、まだ無い `pkc.createEntry` を
        //    「あります」と嘘をつくことになる。
        methods: [...SERVED],
        protocol: 'jsonrpc-2.0',
      }),
      'pkc.ping': () => ({ pong: true }),
    },
    ...(deps.onReject === undefined ? {} : { onReject: deps.onReject }),
    ...(deps.target === undefined ? {} : { target: deps.target }),
  });
}

/** ⚠ 申告が約束の外へはみ出していないこと(test が使う)。 */
export function servedAreKnown(): boolean {
  return SERVED.every((m) => (METHODS as readonly string[]).includes(m));
}
