/**
 * PKC-Message ── PKC3 を **iframe に入れた親**と話すための約束(#189 / C-4)。
 *
 * 🔴 **これは PKC3 が「受ける」側の口である。** これまでの `postMessage` は全部
 * **PKC3 が親で、子(worker / sandbox / 組み込みアプリ)に話しかける**向きだった
 * (`markdown-worker` / `html-sandbox` / `app-shell` …)。⚠ **逆向きの口は 1 つも無い**
 * ── だから #194(Bookmarklet 取込)も #195(PKC-Extension)も載る土台が無かった。
 *
 * ## PKC2 から流用したもの / 変えたもの(user 指示「流用 + 総合的見直し。丸写し禁止」)
 *
 * | | PKC2 | PKC3 |
 * |---|---|---|
 * | 封筒 | v1 独自形式と **JSON-RPC 2.0 の並列稼働** | 🔑 **JSON-RPC 2.0 だけ** |
 * | origin | fail-closed(空 = 全部拒否) | **同じ**(良い規律なのでそのまま) |
 * | 洪水よけ | 粗サイズ上限 + origin 別 rate limit | **同じ** |
 * | 規模 | 10 file / 2,117 行 | 2 file |
 *
 * 🔴 **v1 を持ち込まない**のが「総合的見直し」の中身である。PKC2 は
 * 「同じ問いに 2 つの形式が答える」状態を抱え、`isV2Envelope()` で毎回選び分けていた
 * ── ⚠ CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ壊しても届かない」。
 * PKC3 は**外から来る封筒を 1 形式に固定**する。
 *
 * ## ⚠ この module は pure(browser API を触らない)
 *
 * 受信・送信・時計は `message-bridge.ts` の仕事。ここは**判定だけ**なので、
 * unit がそのまま届く。
 */

/** JSON-RPC 2.0 の誤り符号(必要なものだけ)。 */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** 実装で決めてよい帯(-32000..-32099)。 */
  FORBIDDEN_ORIGIN: -32001,
  TOO_MANY: -32002,
  TOO_BIG: -32003,
} as const;

/** 受け付ける method。⚠ **ここに無いものは全部撥ねる**(素通りさせない)。 */
export const METHODS = ['pkc.hello', 'pkc.ping', 'pkc.createEntry'] as const;
export type Method = (typeof METHODS)[number];

/**
 * 受理する封筒の粗さの上限。
 *
 * ⚠ **`JSON.stringify` を通さない** ── 巨大な物を渡されたとき、測るために
 * まず巨大な文字列を作ることになる(それ自体が攻撃面である)。
 * 🔑 だから**浅く歩いて文字列の長さだけ足す**。
 */
export const MAX_ROUGH_SIZE = 256 * 1024;

/** 1 origin あたり 1 分間に受理する数。 */
export const MAX_PER_MINUTE = 120;

export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: Method;
  params?: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
}

/** 判定の結果。⚠ 「なぜ撥ねたか」を必ず持たせる(無言で捨てない)。 */
export type Parsed =
  | { ok: true; request: RpcRequest }
  | { ok: false; id: string | number | null; error: RpcError };

/**
 * 粗い大きさ。⚠ 深さを 3 で打ち切る ── 深い入れ子で計算を吹かせないため。
 */
export function roughSize(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (!value || typeof value !== 'object' || depth >= 3) return 0;
  let total = 0;
  for (const v of Object.values(value as Record<string, unknown>)) {
    total += roughSize(v, depth + 1);
    // ⚠ 上限を超えた時点で歩くのをやめる(測るために全部歩かない)
    if (total > MAX_ROUGH_SIZE) return total;
  }
  return total;
}

/**
 * 外から来た `data` を 1 つの request に narrow する。
 *
 * ⚠ **通知(id 無し)は受けない。** 返事の要らない書込を許すと、
 * 「送った側は成功したと思っているのに何も起きていない」を作れてしまう
 * (PKC3 が繰り返し戒めている**無言の失敗**)。
 */
export function parseRequest(data: unknown): Parsed {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, id: null, error: { code: RPC.INVALID_REQUEST, message: '封筒が object ではありません' } };
  }
  const obj = data as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') {
    return { ok: false, id: null, error: { code: RPC.INVALID_REQUEST, message: 'jsonrpc は "2.0" である必要があります' } };
  }
  const id = typeof obj.id === 'string' || typeof obj.id === 'number' ? obj.id : null;
  if (id === null) {
    return { ok: false, id: null, error: { code: RPC.INVALID_REQUEST, message: 'id が要ります(返事のいらない依頼は受けません)' } };
  }
  if (typeof obj.method !== 'string') {
    return { ok: false, id, error: { code: RPC.INVALID_REQUEST, message: 'method が要ります' } };
  }
  if (!(METHODS as readonly string[]).includes(obj.method)) {
    return { ok: false, id, error: { code: RPC.METHOD_NOT_FOUND, message: `知らない method です: ${obj.method}` } };
  }
  const params = obj.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return { ok: false, id, error: { code: RPC.INVALID_PARAMS, message: 'params は object である必要があります' } };
  }
  return {
    ok: true,
    request: {
      jsonrpc: '2.0',
      id,
      method: obj.method as Method,
      ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
    },
  };
}

/**
 * origin を許すか。
 *
 * 🔴 **fail-closed** ── 一覧が空なら**全部拒否**する(PKC2 から引き継ぐ良い規律)。
 * ⚠ `'*'` は**明示のときだけ**通す。⚠ `"null"`(sandbox / file:)は `'*'` に含めない
 * ── 素性が無い相手なので、**名指しで許したときだけ**通す。
 */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  if (origin === 'null') return allowed.includes('null');
  return allowed.includes('*') || allowed.includes(origin);
}

/** 成功の返事。 */
export function okResponse(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** 失敗の返事。⚠ id が採れなかったときは `null`(JSON-RPC の決まり)。 */
export function errResponse(id: string | number | null, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}
