/**
 * 🔴 **拡張と話す封筒**(#195 / C-5 段①)。
 *
 * 設計は `docs/development/pkc-extension-host-design-2026-08.md`。
 *
 * ## 段① で通るのは 2 語だけ
 *
 * | 種別 | 向き | 中身 |
 * |---|---|---|
 * | `hello` | 拡張 → ホスト | 挨拶。ホストは見取り図を返す |
 * | `projection` | ホスト → 拡張 | 見取り図(`ext-projection.ts`)。中身が変わったら押し直す |
 *
 * 🚫 **書き戻しも実体の受け渡しも段① には無い。** 語彙を先に広げない ── PKC2 は
 * write op が 9 種まで育ち、さらに DSL まで生えた(`docs/spec/pkc-message-api-v2.md`)。
 * ⚠ 知らない種別は**黙って捨てず**、捨てたことを呼び側に返す(無言の失敗を作らない)。
 *
 * ## ⚠ 封筒は「拡張が名乗るもの」ではない
 *
 * 港(`MessagePort`)を渡す相手はホストが選んでいるので、**誰から来たか**は
 * 港そのものが答える(`origin` も `source` も要らない)。ここが検めるのは
 * **形だけ**である ── 隔離した相手が壊れた値を投げても、こちらが落ちないように。
 *
 * 🔑 **pure module**。窓も DOM も知らない。
 */
import type { ExtProjection } from './ext-projection';

/** 港をやり取りするときの合図。⚠ 外殻の inline script と**同じ綴り**でなければ死ぬ。 */
export const EXT_PORT_TAG = 'pkc3.ext.port';

/** 外殻が「聴いている」と立てる印。⚠ 本体タブはこれを読んでから港を渡す(測定で決定)。 */
export const EXT_READY_FLAG = '__pkcExtReady';

/** 拡張 → ホスト。 */
export type ExtRequest = { readonly t: 'hello' };

/** ホスト → 拡張。 */
export type ExtResponse = { readonly t: 'projection'; readonly projection: ExtProjection };

/** 受け取った物の判定。⚠ **なぜ捨てたか**を必ず持たせる(無言で捨てない)。 */
export type ExtParsed =
  | { readonly ok: true; readonly request: ExtRequest }
  | { readonly ok: false; readonly why: string };

/**
 * 拡張から来た `data` を 1 つの依頼に narrow する。
 *
 * ⚠ 段① は `hello` しか受けない ── 知らない種別は**名前を添えて**断る
 *   (拡張の作者が「送ったのに何も起きない」で詰まるのが、いちばん困る形である)。
 */
export function parseExtRequest(data: unknown): ExtParsed {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { ok: false, why: '封筒が object ではありません' };
  const t = (data as { t?: unknown }).t;
  if (typeof t !== 'string') return { ok: false, why: 't がありません' };
  if (t !== 'hello') return { ok: false, why: `知らない種別です: ${t}` };
  return { ok: true, request: { t: 'hello' } };
}

/**
 * 🔴 **港を渡す封筒**(#195 / C-5 段①)。
 *
 * ⚠ **ここが 1 か所である理由**(2026-08-25 に踏んだ):外殻の inline script は
 *   `m.tag !== TAG || m.nonce !== NONCE` で港を検める。ホスト側がこれを
 *   別の綴りで組んでいると、**外殻は本物の港を黙って捨てる** ── そして
 *   どちらの unit も相手を模した stub と話しているので、**両方とも緑のまま**
 *   通る(CLAUDE.md §7「同じ問いに答える口が 2 つある」の実例)。
 * 🔑 組む口をここへ寄せ、**本物どうしを繋ぐ test**(`launcher-ext-relay`)で
 *   綴りの一致を見る。
 */
export function portHandoffMessage(nonce: string): {
  readonly tag: typeof EXT_PORT_TAG;
  readonly nonce: string;
} {
  return { tag: EXT_PORT_TAG, nonce };
}

/** 見取り図の返事を組む。⚠ 組み立ての口はここ 1 つ(§7)。 */
export function projectionMessage(projection: ExtProjection): ExtResponse {
  return { t: 'projection', projection };
}
