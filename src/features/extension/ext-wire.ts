/**
 * 🔴 **拡張と話す封筒**(#195 / C-5 段①)。
 *
 * 設計は `docs/development/pkc-extension-host-design-2026-08.md`。
 *
 * ## 段②までで通るのは 3 語だけ
 *
 * | 種別 | 向き | 中身 |
 * |---|---|---|
 * | `hello` | 拡張 → ホスト | 挨拶。ホストは見取り図を返す |
 * | `projection` | ホスト → 拡張 | 見取り図(`ext-projection.ts`)。中身が変わったら押し直す |
 * | `entry` | ホスト → 拡張 | 🔴 **実体 1 件**(`ext-delivery.ts`)。**user が押したときだけ**流れる |
 *
 * 🔴 **拡張 → ホストは、段② を足した後も `hello` 1 語のままである。**
 * ⚠ ここが段② の要点である ── 実体が流れるようになっても、**始めるのは user** で
 * あって拡張ではない。`get` のような取りに行く口を 1 つ足した瞬間、user のジェスチャは
 * 「この 1 件を見せる」から「**以後ぜんぶ読んでよい**」に変わってしまう。
 *
 * 🚫 **書き戻しは段③。** 語彙を先に広げない ── PKC2 は write op が 9 種まで育ち、
 * さらに DSL まで生えた(`docs/spec/pkc-message-api-v2.md`)。
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
import type { ExtDeliveredEntry } from './ext-delivery';

/** 港をやり取りするときの合図。⚠ 外殻の inline script と**同じ綴り**でなければ死ぬ。 */
export const EXT_PORT_TAG = 'pkc3.ext.port';

/** 外殻が「聴いている」と立てる印。⚠ 本体タブはこれを読んでから港を渡す(測定で決定)。 */
export const EXT_READY_FLAG = '__pkcExtReady';

/** 拡張 → ホスト。 */
export type ExtRequest =
  | { readonly t: 'hello' }
  /**
   * 🔴 **書き戻し**(段③)。⚠ 中身の検めは `ext-write.ts` が持つ ──
   *   ここは**種別を見分ける**だけである(渡した覚えの照合には集合が要り、
   *   それは封筒の知らない情報である)。
   */
  | { readonly t: 'write'; readonly raw: unknown };

/** ホスト → 拡張。 */
export type ExtResponse =
  | { readonly t: 'projection'; readonly projection: ExtProjection }
  /** 🔴 段②: user が情報ペインで押した 1 件。⚠ 押されない限り 1 通も流れない。 */
  | { readonly t: 'entry'; readonly entry: ExtDeliveredEntry }
  /**
   * 🔴 段③: 書き戻しの返事。⚠ **必ず返す** ── 返さないと、拡張の作者は
   *   「書けたのか / 断られたのか」を**永久に知れない**(いちばん困る形)。
   */
  | {
      readonly t: 'write-result';
      readonly ok: boolean;
      /** 断ったときの理由。⚠ 通ったときは `undefined`。 */
      readonly why?: string;
      /** 通ったときに書いた件数。⚠ 断ったときは `0`。 */
      readonly wrote: number;
    };

/** 受け取った物の判定。⚠ **なぜ捨てたか**を必ず持たせる(無言で捨てない)。 */
export type ExtParsed =
  | { readonly ok: true; readonly request: ExtRequest }
  | { readonly ok: false; readonly why: string };

/**
 * 拡張から来た `data` を 1 つの依頼に narrow する。
 *
 * ⚠ 段②を足した後も `hello` しか受けない ── 知らない種別は**名前を添えて**断る
 *   (拡張の作者が「送ったのに何も起きない」で詰まるのが、いちばん困る形である)。
 *
 * 🔴 **取りに行こうとした相手には、無いのが意図であることまで言う。**
 * ⚠ ただ「知らない種別です」と返すと、拡張の作者は**綴りを間違えた**と読んで
 *   探し続ける ── 「無い」ことと「**わざと無い**」ことは別の情報である。
 */
export function parseExtRequest(data: unknown): ExtParsed {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { ok: false, why: '封筒が object ではありません' };
  const t = (data as { t?: unknown }).t;
  if (typeof t !== 'string') return { ok: false, why: 't がありません' };
  if (t === 'hello') return { ok: true, request: { t: 'hello' } };
  // 🔴 段③: 書き戻し。⚠ 中身は `ext-write.ts` が検める(上の注記)
  if (t === 'write') return { ok: true, request: { t: 'write', raw: data } };
  if (PULL_ATTEMPTS.has(t))
    return {
      ok: false,
      why:
        `「${t}」は在りません(意図的です)。` +
        '実体は user が情報ペインの「このアプリへ送る」で 1 件ずつ渡します ── ' +
        '拡張から取りに行く口はありません。',
    };
  return { ok: false, why: `知らない種別です: ${t}` };
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

/**
 * 🔴 **「取りに行く」つもりで投げられそうな綴り**(段②)。
 *
 * ⚠ 網羅ではない ── 網羅しようとすると、次に流行った綴りが漏れて
 *   **漏れた側だけ不親切**になる。ここに在るのは「よく試される綴り」で、
 *   外れても普通の「知らない種別です」に落ちるだけである(害が無い側)。
 */
/**
 * ⚠ **`write` はここに入れない**(段③ で受けるようになった)── 入れると
 *   「在りません(意図的です)」と断り続ける。⚠ 上の `parseExtRequest` は
 *   `write` を**先に**見るので順序でも守られているが、両方で守る
 *   (片方だけ直る形を残さない)。
 */
const PULL_ATTEMPTS: ReadonlySet<string> = new Set([
  'get',
  'getEntry',
  'fetch',
  'read',
  'readEntry',
  'body',
  'getBody',
  'entry',
  'deliver',
  'request',
]);

/** 見取り図の返事を組む。⚠ 組み立ての口はここ 1 つ(§7)。 */
export function projectionMessage(projection: ExtProjection): ExtResponse {
  return { t: 'projection', projection };
}

/**
 * 🔴 **実体 1 件の封筒**(段②)。⚠ 組み立ての口はここ 1 つ(§7)。
 *
 * ⚠ 段① で踏んだ穴(封筒を 2 か所で組んで綴りがずれ、受け側が**黙って捨てた**)を
 *   繰り返さないため、段② の封筒も**必ずここを通す**。
 */
export function deliveredMessage(entry: ExtDeliveredEntry): ExtResponse {
  return { t: 'entry', entry };
}

/**
 * 🔴 **書き戻しの返事**(段③)。⚠ 組み立ての口はここ 1 つ(§7)。
 *
 * ⚠ **断ったときも `wrote` を載せる**(必ず `0`)── 形を揃えておかないと、
 *   受け側が `ok` を見ずに `wrote` を読んで「1 件書けた」と誤解する道が残る。
 */
export function writeResultMessage(
  result: { ok: true; wrote: number } | { ok: false; why: string },
): ExtResponse {
  return result.ok
    ? { t: 'write-result', ok: true, wrote: result.wrote }
    : { t: 'write-result', ok: false, why: result.why, wrote: 0 };
}
