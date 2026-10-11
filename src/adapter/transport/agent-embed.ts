/**
 * **他のページに組み込まれた PKC3 へ、そのページの AI が道具を使う**(#1407 段⑥)。
 *
 * PKC3 を iframe に入れた親ページの AI が、段①④の道具(`pkc_search_notes` …)を使えるようにする。
 * 道は 2 本あり、**どちらも同じ道具の組(`buildAgentTools`)を通る**(2 つ目の実行経路を作らない):
 *
 * | 道 | 条件 | 仕組み |
 * |---|---|---|
 * | WebMCP | 組み込み先が WebMCP の `getTools({ fromOrigins })` / `executeTool()` を話せる | `registerTool(tool, { exposedTo: [origin] })` |
 * | JSON-RPC | 話せない | 既存の C-4 の封筒に `tools/list` / `tools/call`(`embed-bridge.ts`) |
 *
 * ## 🔴 守っていること(fail-closed)
 *
 * 1. **見せてよい origin は許可リスト(`pkc3.embed-origins`)の中だけ** ── 空なら全部拒否。`*`(全部)と
 *    `null`(素性が無い)は**名指しではない**ので、AI の道具には使わない(許可リストに有っても見せない)。
 * 2. **WebMCP へ登録するのは、許可リストにあり、かつ「常に許す」を 1 つ以上選んだ origin だけ**
 *    (`exposedOrigins`)。まだ何も許していない相手に、道具の一覧(= 何ができる家か)を黙って見せない。
 *    初めての相手は JSON-RPC の道で最初の依頼を送り、ダイアログ(origin 名指し)で答えると、そのあと
 *    WebMCP にも見える。
 * 3. **中身が渡るのは許可の後** ── 道具の `execute` が必ず門(`gate`、`from` つき)を通る。段①と同じ。
 * 4. **取り消すと即座に消える** ── `revoke(origin)` は登録の `AbortController` を abort し、飛んでいる
 *    依頼とダイアログも畳む。
 * 5. 回数の上限は origin ごとの組(`buildAgentTools`)+ 窓口の上限(`message-bridge`)の**両方**。
 * 6. flag `agent.webmcp` がオフなら、登録も JSON-RPC の応答も**しない**。
 *
 * 🔑 判断はここに在る(`main.ts` はどの test からも実行されない)。
 * ⚠ 道具の説明・結果は**信用しない字**として扱われる側(組み込み先の AI)へ渡る物で、PKC3 の画面には
 * 入らない。画面に出る origin は許可リストから引いた値(`textContent` で出す)。
 */

import {
  resolveModelContext,
  type ModelContextTool,
  type ToolResult,
} from '@features/agent/webmcp-types';
import { RPC } from './protocol';

export interface AgentEmbedDeps {
  /** flag `agent.webmcp` がオンか(呼ぶたびに読む)。 */
  enabled: () => boolean;
  /** 許可リスト(`EmbedOriginsStore.list()` ── flag `transport.embed` がオフなら空)。 */
  allowed: () => readonly string[];
  /** 「常に許す」を 1 つ以上選んである origin(`AgentOriginGrants.origins()`)。 */
  granted: () => readonly string[];
  /** 入口の置き場(`{ document, navigator }`)。⚠ test は偽物を渡す。 */
  host: { document?: unknown; navigator?: unknown };
  /** origin ごとの道具の組。⚠ 回数の数え方を origin ごとに持つため、origin ごとに 1 度だけ呼ばれる。 */
  buildTools: (from: string) => ModelContextTool[];
}

/** AI へ見せる道具 1 本(`execute` は渡さない)。 */
export interface AgentToolInfo {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ModelContextTool['annotations'];
}

export interface AgentEmbed {
  /** WebMCP の `exposedTo` に載せる origin(許可リスト ∩ 常に許す済み。flag オフなら空)。 */
  exposedOrigins: () => string[];
  /** JSON-RPC `tools/list`。⚠ 許可リストに無い origin・flag オフは例外(`METHOD_NOT_FOUND` / `FORBIDDEN_ORIGIN`)。 */
  list: (origin: string) => AgentToolInfo[];
  /** JSON-RPC `tools/call`。許可は道具の中(`gate`)で見る。 */
  call: (origin: string, name: unknown, args: unknown) => Promise<ToolResult>;
  /** WebMCP の登録を、いまの許可に合わせる(許可が変わったとき・起動したとき)。 */
  sync: () => void;
  /** この origin の登録・飛んでいる依頼・ダイアログを今すぐ畳む(許可の取り消し)。 */
  revoke: (origin: string) => void;
  /** いま WebMCP へ登録している origin。 */
  registered: () => string[];
  /** 全部畳む(タブを閉じるとき)。 */
  stop: () => void;
}

interface Session {
  controller: AbortController;
  tools: ModelContextTool[];
}

/** 許可リストから外れた origin の道具が呼ばれたときの結果(例外ではなく、AI が理由を読める形で返す)。 */
const NOT_ALLOWED_RESULT: ToolResult = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'このページは、許可されたページの一覧から外れています。ユーザーに伝えてください。',
    },
  ],
};

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { rpcCode: code });
}

/** 名指しできる origin か(`*` / `null` / 形が違う物は AI の道具には使わない)。 */
function nameable(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === origin;
  } catch {
    return false;
  }
}

export function createAgentEmbed(deps: AgentEmbedDeps): AgentEmbed {
  const sessions = new Map<string, Session>();
  /** WebMCP へ登録済みの origin(登録の寿命 = その session の controller)。 */
  const registered = new Set<string>();

  const allowedNow = (origin: string): boolean =>
    deps.enabled() && nameable(origin) && deps.allowed().includes(origin);

  const exposedOrigins = (): string[] => {
    if (!deps.enabled()) return [];
    const granted = deps.granted();
    return deps.allowed().filter((o, i, all) => nameable(o) && all.indexOf(o) === i && granted.includes(o));
  };

  const sessionOf = (origin: string): Session => {
    let s = sessions.get(origin);
    if (s === undefined) {
      // 🔴 道具の `execute` の先頭で**許可リストを見直す**(WebMCP に登録済みの道具は窓口を通らない ──
      //    別のタブで一覧から外されても、登録が畳まれるまでの間に実行できてしまう)。門(`gate`)は「常に許す」の台帳しか見ない
      const tools = deps.buildTools(origin).map(
        (t): ModelContextTool => ({
          ...t,
          execute: (args, ctx) =>
            allowedNow(origin) ? t.execute(args, ctx) : Promise.resolve(NOT_ALLOWED_RESULT),
        }),
      );
      s = { controller: new AbortController(), tools };
      sessions.set(origin, s);
    }
    return s;
  };

  const revoke = (origin: string): void => {
    registered.delete(origin);
    const s = sessions.get(origin);
    if (s === undefined) return;
    sessions.delete(origin);
    s.controller.abort();
  };

  const sync = (): void => {
    const mc = resolveModelContext(deps.host);
    const want = mc === null ? [] : exposedOrigins();
    for (const origin of [...registered]) {
      if (!want.includes(origin)) revoke(origin);
    }
    if (mc === null) return;
    for (const origin of want) {
      if (registered.has(origin)) continue;
      const s = sessionOf(origin);
      registered.add(origin);
      for (const tool of s.tools) {
        try {
          // ⚠ 返り値は待たない・落ちても黙る(`webmcp.ts` と同じ ── 草案の入口はブラウザごとに挙動が違う)
          void Promise.resolve(
            mc.registerTool(tool, { signal: s.controller.signal, exposedTo: [origin] }),
          ).catch(() => undefined);
        } catch {
          // 同期で投げる実装もある ── 同じく黙る
        }
      }
    }
  };

  return {
    exposedOrigins,
    registered: () => [...registered],
    sync,
    revoke,
    list: (origin) => {
      if (!allowedNow(origin)) {
        throw rpcError(RPC.FORBIDDEN_ORIGIN, '許可されていない origin です');
      }
      return sessionOf(origin).tools.map((t) => ({
        name: t.name,
        ...(t.title === undefined ? {} : { title: t.title }),
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
      }));
    },
    call: async (origin, name, args) => {
      if (!allowedNow(origin)) {
        throw rpcError(RPC.FORBIDDEN_ORIGIN, '許可されていない origin です');
      }
      if (typeof name !== 'string' || name === '') {
        throw rpcError(RPC.INVALID_PARAMS, 'name が要ります');
      }
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        throw rpcError(RPC.INVALID_PARAMS, 'arguments は object である必要があります');
      }
      const s = sessionOf(origin);
      const tool = s.tools.find((t) => t.name === name);
      if (tool === undefined) throw rpcError(RPC.INVALID_PARAMS, `知らない道具です: ${name.slice(0, 60)}`);
      return tool.execute((args ?? {}) as Record<string, unknown>, { signal: s.controller.signal });
    },
    stop: () => {
      for (const origin of [...sessions.keys()]) revoke(origin);
      registered.clear();
    },
  };
}
