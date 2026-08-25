/**
 * PKC-Message の受け口(#189 / C-4 段①)。
 *
 * 🔴 **PKC3 が iframe に入れられたとき、親からの依頼を受ける唯一の口**である。
 * 判定は `protocol.ts`(pure)に置き、ここは **窓・時計・配線**だけを持つ。
 *
 * ## 断り方の規律
 *
 * ⚠ **無言で捨てない。** 撥ねるときも JSON-RPC の誤り応答を返す ── 相手が
 * 「送ったのに何も起きない」で詰まるのが、PKC3 がいちばん嫌う形である。
 * 🔑 ただし **`event.source` が無い / 封筒が JSON-RPC でない**ときは返しようがないので、
 * `onReject` へ回して**こちら側の log に残す**(数えられる形にする)。
 *
 * ## ⚠ 既定では動かない
 *
 * 呼び手(boot)が **flag が立っているときだけ** `attachMessageBridge()` を呼ぶ。
 * 外向きの口なので、**既定で開けない**。
 */

import { accepts, type CaptureGrant } from './capture-grant';
import {
  MAX_PER_MINUTE,
  MAX_ROUGH_SIZE,
  RPC,
  errResponse,
  okResponse,
  originAllowed,
  parseRequest,
  roughSize,
  type Method,
  type RpcError,
  type RpcRequest,
} from './protocol';

/**
 * どの門を通ってきたか。
 *
 * 🔴 **捌き手はこれで返す中身を変える**(#194)── `'capture'` は
 * **許可リストの外**から、その起動 1 回だけ通した相手である。⚠ 身元が確かめられて
 * いないので、**返事に中身を載せない**(`lid` を返すと読み出しの口になる)。
 */
export type Via = 'origin' | 'capture';

/** 依頼 1 件を捌く。⚠ 例外を投げてよい(こちらが `internal error` に畳む)。 */
export type Handler = (
  request: RpcRequest,
  origin: string,
  via: Via,
) => Promise<unknown> | unknown;

export interface BridgeOptions {
  /**
   * 許す origin。🔴 **空 = 全部拒否**(fail-closed)。
   * ⚠ 関数で渡せる ── 設定を後から変えても、張り直さずに効く。
   */
  allowedOrigins: readonly string[] | (() => readonly string[]);
  /** method ごとの捌き手。⚠ 無い method は `protocol.ts` が先に撥ねる。 */
  handlers: Partial<Record<Method, Handler>>;
  /** 撥ねたことを数えるため(返事を返せない場合も含めて必ず呼ぶ)。 */
  onReject?: (why: string, origin: string) => void;
  /** 差し替え可能な時計(test 用。⚠ 既定は `Date.now`)。 */
  now?: () => number;
  /**
   * 🔴 **許可リストの外から、その起動 1 回だけ受ける口**(#194 / C-3)。
   *
   * ⚠ Bookmarklet は**読んでいる頁の上**で走るので、相手の origin は事前に
   * 列挙できない ── だから「**この窓を開いた相手**から、**いま出した合図**を
   * 添えた **1 通だけ**」を通す(理由は `capture-grant.ts`)。
   * ⚠ 渡さなければ、この門は**存在しない**(既定は許可リストだけ)。
   */
  capture?: {
    /** 送り主がこの窓を開いた相手か(既定の呼び側は `window.opener` を見る)。 */
    isOpener: (source: Window) => boolean;
    /** いま効いている合図(出していなければ `null`)。 */
    grant: () => CaptureGrant | null;
    /** 1 通受けたら焼き捨てる。 */
    burn: () => void;
  };
  /** 張り先(既定は `globalThis` の window)。 */
  target?: Window;
}

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * 受け口を張る。返り値を呼ぶと外す(器と同じ寿命で畳めるように)。
 */
export function attachMessageBridge(options: BridgeOptions): () => void {
  const target = options.target ?? (globalThis as unknown as Window);
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  const allowList = (): readonly string[] =>
    typeof options.allowedOrigins === 'function' ? options.allowedOrigins() : options.allowedOrigins;

  const reject = (why: string, origin: string): void => {
    options.onReject?.(why, origin);
  };

  /** 1 分の窓で数える。⚠ 窓は origin ごと(1 つの相手が全体を止められない)。 */
  const withinRate = (origin: string): boolean => {
    const t = now();
    const b = buckets.get(origin);
    if (!b || t - b.windowStart >= 60_000) {
      buckets.set(origin, { windowStart: t, count: 1 });
      return true;
    }
    b.count += 1;
    return b.count <= MAX_PER_MINUTE;
  };

  const handler = (event: MessageEvent): void => {
    const origin = typeof event.origin === 'string' ? event.origin : '';
    const source = event.source as Window | null;

    // ⚠ 返事の宛先が無いものは、返しようがない ── 数えて捨てる
    if (!source || typeof source.postMessage !== 'function') {
      reject('返事の宛先が無い', origin);
      return;
    }
    const reply = (payload: Record<string, unknown>): void => {
      // ⚠ **`targetOrigin` に `'*'` を使わない** ── 返事に中身が載るので、
      //    来た origin へ名指しで返す(`"null"` は指定できないので捨てる)
      if (origin === 'null' || origin === '') {
        reject('origin が指定できないので返せない', origin);
        return;
      }
      try {
        source.postMessage(payload, origin);
      } catch {
        reject('返事を送れなかった', origin);
      }
    };

    /**
     * 🔴 **門は 2 つ。** ①許可リスト(C-4)②取り込みの合図(#194 / C-3)。
     * ⚠ ②は**この窓を開いた相手**に限る ── そうでなければ「合図が生きている間、
     * 誰でも 1 通送れる」になり、合図が窓を守っていないことになる。
     * 🔑 ②で入った封筒は**中身まで見てから**改めて断る(下の `accepts`)──
     * 合図そのものが本文に載っているので、ここでは判定しきれない。
     */
    const byOrigin = originAllowed(origin, allowList());
    const viaCapture =
      !byOrigin && options.capture !== undefined && options.capture.isOpener(source);
    if (!byOrigin && !viaCapture) {
      reject('許していない origin', origin);
      // 🔑 **中身を見る前に断る。** 許していない相手の封筒を解釈しない
      reply(errResponse(null, { code: RPC.FORBIDDEN_ORIGIN, message: '許可されていない origin です' }));
      return;
    }
    if (roughSize(event.data) > MAX_ROUGH_SIZE) {
      reject('封筒が大きすぎる', origin);
      reply(errResponse(null, { code: RPC.TOO_BIG, message: '封筒が大きすぎます' }));
      return;
    }
    if (!withinRate(origin)) {
      reject('多すぎる', origin);
      reply(errResponse(null, { code: RPC.TOO_MANY, message: '1 分あたりの上限を超えました' }));
      return;
    }

    const parsed = parseRequest(event.data);
    if (!parsed.ok) {
      reject(parsed.error.message, origin);
      reply(errResponse(parsed.id, parsed.error));
      return;
    }
    if (viaCapture) {
      // ⚠ **3 つすべて**を見る(生きている / method が 1 つだけ / 合図が一致)
      if (!accepts(options.capture!.grant(), now(), parsed.request.method, parsed.request.params)) {
        reject('取り込みの合図が合わない', origin);
        reply(
          errResponse(parsed.request.id, {
            code: RPC.FORBIDDEN_ORIGIN,
            message: '取り込みの合図がありません',
          }),
        );
        return;
      }
      // 🔴 **受けると決めた時点で焼き捨てる**(捌き手が落ちても再利用させない)
      options.capture!.burn();
    }
    const fn = options.handlers[parsed.request.method];
    if (!fn) {
      reject(`捌き手が居ない: ${parsed.request.method}`, origin);
      reply(
        errResponse(parsed.request.id, {
          code: RPC.METHOD_NOT_FOUND,
          message: `この版では扱えません: ${parsed.request.method}`,
        }),
      );
      return;
    }
    // ⚠ 同期でも非同期でも同じ扱いにする(`await` を落とすと静かに空が返る)
    void Promise.resolve()
      .then(() => fn(parsed.request, origin, viaCapture ? 'capture' : 'origin'))
      .then(
        (result) => reply(okResponse(parsed.request.id, result ?? null)),
        (e: unknown) => {
          /**
           * 🔑 **捌き手が符号を持たせて投げたら、それを使う。**
           * ⚠ 引数の誤り(`INVALID_PARAMS`)を `INTERNAL_ERROR` に畳むと、
           * 相手は「こちらのせい」と読んで**直しようが無くなる** ──
           * 「送り手が直せる誤り」と「こちらが壊れた」は別の事情である。
           */
          const given = (e as { rpcCode?: unknown } | null)?.rpcCode;
          const err: RpcError = {
            code: typeof given === 'number' ? given : RPC.INTERNAL_ERROR,
            message: e instanceof Error ? e.message : '内部で失敗しました',
          };
          reject(err.message, origin);
          reply(errResponse(parsed.request.id, err));
        },
      );
  };

  target.addEventListener('message', handler as EventListener);
  return () => target.removeEventListener('message', handler as EventListener);
}
