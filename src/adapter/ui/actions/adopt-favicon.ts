/**
 * 🔴 **リンク先の印(favicon)を取りに行く**(#856 段②)。
 *
 * user 裁定 2026-09-12 / 09-13(こちらの解釈)── 通信が始まるのは
 * **user がボタンを押した瞬間だけ**。そのうえで取れる率を上げたいので **2 段構え**にする:
 *
 * 1. サイトの**決まった場所**を 1 回見る(ここで済むサイトが多い)
 * 2. 🔴 **そこに無かったときだけ**、そのページを読んで、サイトが指している印を探す
 *
 * ## ここが持つ判断は 4 つ
 *
 * 1. 🔴 **押していないのに通信しない** ── この関数は「押した」以外から呼ばれない
 *    (設定の門は呼び側 = `binder.ts` が見る ── 層の役割が違う)
 * 2. 🔴 **取れなかった理由を、user の言葉で 1 行返す** ── 黙って終わらない
 *    (この repo がいちばん嫌う無言の dead click を作らない)
 * 3. ⚠ **絵でなければ受けない** ── 404 のページは `fetch` では例外にならないので、
 *    そのまま置くと**エラーページの HTML が「印」になる**(`adopt-urls.ts` の教訓)
 * 4. ⚠ **通信の回数に上限を置く** ── 段 2 で候補を端から叩くと、押した 1 回のつもりが
 *    何往復にもなる。上限は下の `MAX_TRIES`(理由つき)
 *
 * ⚠ **`main.ts` へ書かない** ── あそこは原文を読む test しか持てないので、
 *   判断を置くと「全 test 緑のまま取り違える」形になる(CLAUDE.md §2)。
 */
import { isImageAssetMime } from '@features/asset/asset-ref-format';
import type { ExternalImageMode } from '@features/markdown/external-images';
import { iconPicksFromDocument, wellKnownIconUrl } from '@features/launcher/favicon';
import { HttpStatusError } from './adopt-urls';
import type { AssetGate } from './asset-gate';
import { storeAsset, type AttachDeps } from './attach';

/**
 * 段 2 で叩く候補の数。
 *
 * ⚠ **1 では足りない** ── いちばん大きい絵を置いていない(404 の)サイトが在る。
 * ⚠ **多すぎてもいけない** ── 押した 1 回のつもりが何往復にもなる。
 * 🔑 だから **2**:最悪でも「決まった場所 1 + ページ 1 + 候補 2 = 4 回」で止まる。
 */
const MAX_TRIES = 2;

export interface FaviconDeps {
  /** URL を bytes にする(既定は `adopt-urls.ts` の `fetchImageBlob`)。 */
  readonly fetchBlob: (url: string) => Promise<Blob>;
  /** ⚠ ページの原文を読む ── **段 2 に入ったときだけ**呼ばれる。 */
  readonly fetchText: (url: string) => Promise<string>;
  /** 原文を `Document` にする。⚠ worker / node に `DOMParser` は無いので注入する。 */
  readonly parse: (html: string) => Document;
}

export interface FaviconFound {
  readonly ok: true;
  readonly blob: Blob;
  /** どこから取れたか(後から読めるように残す)。 */
  readonly from: string;
  /** 🔑 **どちらの段で取れたか** ── 「決まった場所で済んだか」を呼び側が言える。 */
  readonly step: 1 | 2;
}

export interface FaviconMissing {
  readonly ok: false;
  /** user が読む 1 行。⚠ **観測したことだけ**書く(推測を書かない)。 */
  readonly why: string;
}

export type FaviconOutcome = FaviconFound | FaviconMissing;

/** ⚠ 例外を user の言葉へ。**状態番号は落とさない**(`adopt-urls.ts` と同じ理由)。 */
function whyOf(e: unknown): string {
  if (e instanceof HttpStatusError) return `置き場所が ${String(e.status)} を返しました`;
  return '取りに行けませんでした(先方が許していない可能性があります)';
}

/** 1 件叩いて、絵だったら返す。⚠ **絵でなければ `null`**(理由は呼び側が組む)。 */
async function tryOne(url: string, deps: FaviconDeps): Promise<Blob | null> {
  const blob = await deps.fetchBlob(url);
  // ⚠ 空も落とす ── 0 バイトの「印」を置くと、出す側で**黙って何も出ない**
  if (blob.size === 0) return null;
  if (!isImageAssetMime(blob.type)) return null;
  return blob;
}

/**
 * 🔴 **押されたときに 1 度だけ呼ぶ。**
 *
 * ⚠ 呼び側の責務が 2 つある:
 * ① 設定で止めている user には**呼ばない**(「常にオフ」の裁定)
 * ② 取れた `blob` を**置く**(`storeAsset`)── ここは bytes を返すだけで、保存しない
 *   (層を分けておくと、置き場の作法が変わってもここは動かない)。
 */
export async function fetchFavicon(pageUrl: string, deps: FaviconDeps): Promise<FaviconOutcome> {
  // ── 段 1:決まった場所 ──────────────────────────────
  const well = wellKnownIconUrl(pageUrl);
  if (well === null) return { ok: false, why: 'このアドレスからは印を探せません' };
  try {
    const blob = await tryOne(well, deps);
    if (blob !== null) return { ok: true, blob, from: well, step: 1 };
  } catch {
    // ⚠ ここで止めない ── 決まった場所に置いていないサイトのほうが多い(段 2 へ)
  }

  // ── 段 2:ページが指している印 ─────────────────────
  let doc: Document;
  try {
    doc = deps.parse(await deps.fetchText(pageUrl));
  } catch (e) {
    return { ok: false, why: whyOf(e) };
  }
  const picks = iconPicksFromDocument(doc, pageUrl);
  if (picks.length === 0) return { ok: false, why: 'そのサイトは印を置いていませんでした' };

  let last = '取れた印が画像ではありませんでした';
  for (const pick of picks.slice(0, MAX_TRIES)) {
    try {
      const blob = await tryOne(pick.url, deps);
      if (blob !== null) return { ok: true, blob, from: pick.url, step: 2 };
    } catch (e) {
      last = whyOf(e);
    }
  }
  return { ok: false, why: last };
}

/**
 * 🔴 **設定で止めている人には、取りに行かない**(#856 段②。user 裁定 2026-09-13)。
 *
 * ⚠ 求められていたのは「設定を favicon にも効かせる」ことである。押しても外へ通信しない。
 * ⚠ そのとき**黙って終わらない** ── 押して何も起きないのがいちばん悪い。
 *
 * 🔑 **判定をここに置く理由**:配線(`main.ts` / `binder.ts` の handler)へ書くと、
 *   `main.ts` は原文を読む test しか持てないので「全 test 緑のまま取り違える」形になる
 *   (CLAUDE.md §2)。
 *
 * ⚠ 既存の「外部の画像を取り込む」ボタン(`adopt-urls.ts`)は**この設定を見ていない**
 *   (押したことが同意、という設計)── 揃えるかどうかは別途伺う、と裁定に書いてある。
 *
 * @returns 止める理由(user が読む 1 行)。止めないなら `null`。
 */
export function externalImageBlockReason(mode: ExternalImageMode): string | null {
  // ⚠ `ask` は止めない ── **押したこと自体が、その 1 回の同意**である
  if (mode !== 'never') return null;
  return 'システムで「本文の外部画像」を常にオフにしているので、取りに行きませんでした(下の絵から選べます)';
}

/** 取り込んだ印の名乗り(#856 段②)。⚠ 添付の一覧に**何の絵か**が出る。 */
export const LINK_ICON_PREFIX = 'リンクの印';

export interface AdoptLinkIconDeps extends FaviconDeps {
  /**
   * ⚠ **整理(未参照 GC)と排他にする** ── 置いた直後はまだ誰も参照していないので、
   *   その窓で整理が走ると**置いたばかりの bytes を消される**(貼付と同じ理由)。
   */
  readonly gate: AssetGate;
  readonly attach: AttachDeps;
}

export type AdoptLinkIconOutcome =
  | { readonly ok: true; readonly assetKey: string }
  | { readonly ok: false; readonly why: string };

/**
 * 🔴 **取りに行って、置くところまで**(#856 段②)。
 *
 * ⚠ **ノートには書かない** ── 鍵を返すだけで、本文へ差すのは呼び側(reducer)の仕事。
 *   ここで書くと、書込の門(`SET_APP_TILE` の `writeLock` / 世代)を迂回することになる。
 * ⚠ **設定の門はここに無い** ── 押す前に見るものなので、押し所の側(binder)が持つ。
 */
export async function adoptLinkIcon(
  deps: AdoptLinkIconDeps,
  pageUrl: string,
): Promise<AdoptLinkIconOutcome> {
  const got = await fetchFavicon(pageUrl, deps);
  if (!got.ok) return got;

  /**
   * ⚠ **箱に入れて受ける** ── 素の変数に代入すると、tsc は
   *   「閉包が走った」ことを見ないので `never` に絞り、`as` で嘘をつく羽目になる。
   */
  const out: { assetKey: string | null; failed: string | null } = { assetKey: null, failed: null };
  await deps.gate(async () => {
    try {
      const stored = await storeAsset(deps.attach, {
        // ⚠ 名前は**どこから来たか**が読める形にする(添付の一覧に出る)
        name: `${LINK_ICON_PREFIX} ${hostOf(pageUrl)}`,
        type: got.blob.type,
        size: got.blob.size,
        blob: got.blob,
      });
      out.assetKey = stored.assetKey;
    } catch (e) {
      // ⚠ 空き容量が足りない等は**投げてくる** ── user が読める 1 行へ直す
      out.failed = e instanceof Error ? e.message : String(e);
    }
  });
  if (out.assetKey !== null) return { ok: true, assetKey: out.assetKey };
  // ⚠ `gate` が**走らせずに断った**ときも、ここへ来る(理由を落とさない)
  return {
    ok: false,
    why: out.failed ?? 'いま別の片付けが動いているので、少し待ってからもう一度押してください',
  };
}

/** 名前に出す宛先。⚠ 読めない綴りでも**落とさない**(名前が空になるだけ)。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
