/**
 * 初回訪問だけ 1 回読み直して、分離を成立させる(#88 / #111)。
 *
 * ## なぜ読み直しが要るのか
 *
 * 本番(GitHub Pages)の `crossOriginIsolated` は **service worker が被せる
 * COOP/COEP** からしか生まれない(`sw-source.ts` 冒頭)。ところが **SW は
 * 自分を登録した文書を制御していない** ── 初回訪問のその 1 回だけは、
 * ヘッダの付かない応答で開いている。
 *
 * 🔑 だから 1 回だけ読み直す。2 回目以降は SW が制御しているので、
 * 最初から分離した状態で開く(= ここは何もしない)。
 *
 * ## 🔴 「効かない環境で毎回読み直す」を作らない
 *
 * COEP `credentialless` に対応しないブラウザでは、何回読み直しても分離しない。
 * そこで **JSPI がある時だけ**試みる:
 *
 * - 分離が要るのは **Office 表示だけ**で、Office は JSPI 必須(Chromium 系のみ)
 * - JSPI を出す版の Chromium は `credentialless` を必ず持つ(前者のほうが後発)
 *
 * ⚠ したがって Safari / Firefox の user は**1 回も読み直さない**(読み直しても
 * 分離しないし、Office 以外は分離が要らない)。⚠ Chromium の user は
 * **生涯 1 回**だけ ── 読み直した後は分離が成立し、以後この関数は素通りする。
 *
 * ⚠ それでも `triedBefore` の門は要る ── 上の推論が外れたブラウザで
 * **無限に読み直す**のが最悪の壊れ方だからである(門があれば最大 1 回で止まる)。
 *
 * ⚠ **判断をここに置くのは、`main.ts` が原文 pin の test からしか実行されない
 * ため**(CLAUDE.md 2026-08-08)。`main.ts` は配線だけ持つ。
 */

export type CoiReloadOutcome =
  /** 既に分離している ── 何もしない(2 回目以降の通常経路)。 */
  | 'isolated'
  /** この環境では分離しても意味が無い(Office が動かない)。 */
  | 'not-needed'
  /** SW がまだ活きていない ── 読み直しても同じなので待つ。 */
  | 'no-worker'
  /** 1 度試して駄目だった ── 🔴 **これ以上は読み直さない**。 */
  | 'gave-up'
  /** 読み直しを指示した。 */
  | 'reloaded';

export interface CoiReloadDeps {
  /** `window.crossOriginIsolated`。 */
  readonly isolated: boolean;
  /** `WebAssembly.Suspending` が在るか(= Office が動きうる環境か)。 */
  readonly jspi: boolean;
  /**
   * 登録に **active な worker が居るか**を待って返す。
   *
   * ⚠ `navigator.serviceWorker.controller` ではない ── いま開いている文書が
   * 制御されているかは関係なく、**次の navigation が制御されるか**が要点である。
   * active な worker が 1 つ在れば、読み直した先は必ず制御される。
   *
   * 🔴 **待つ必要がある。** 初回訪問では `register()` が解決した時点ではまだ
   * install 中で `active` は null ── そこで諦めると、**分離が要るその 1 回**を
   * 取り逃がす(次の訪問まで Office が使えない)。
   * ⚠ だから thunk である ── 上の門で抜ける経路(通常の 2 回目以降 /
   * Office が動かないブラウザ)では **1 度も待たない**。
   */
  readonly hasActiveWorker: () => Promise<boolean>;
  /** 既にこのセッションで 1 度試したか。 */
  readonly triedBefore: boolean;
  /**
   * 「試した」を記録する。**記録できたら true**。
   *
   * 🔴 戻り値が要るのは、**記録できないのに読み直すと無限になる**からである
   * (読み直した先で `triedBefore` が false に戻り、また読み直す)。
   * ⚠ 「失敗しても進める」と書いていて、この輪を自分で作りかけた。
   */
  readonly markTried: () => boolean;
  readonly reload: () => void;
}

/**
 * 読み直すべきか決めて、必要なら読み直す。
 *
 * ⚠ **順序が意味を持つ。** `isolated` を最初に見る ── 通常経路(2 回目以降)は
 * ここで抜けるので、他の条件を 1 つも評価しない。
 */
export async function reloadForIsolation(deps: CoiReloadDeps): Promise<CoiReloadOutcome> {
  if (deps.isolated) return 'isolated';
  if (!deps.jspi) return 'not-needed';
  if (deps.triedBefore) return 'gave-up';
  if (!(await deps.hasActiveWorker())) return 'no-worker';
  // ⚠ **印を先に置き、置けたことを確かめてから**読み直す。逆順・確認なしだと
  //    読み直した先で印が無く、また試みて**無限に読み直す**
  if (!deps.markTried()) return 'gave-up';
  deps.reload();
  return 'reloaded';
}

/** `reloadForIsolation` に渡す値を実環境から集める(⚠ 判断は上の関数)。 */
export interface CoiEnvironment {
  /** `navigator.serviceWorker.register()` の結果(失敗なら null)。 */
  readonly registration: Promise<{ readonly active: unknown } | null>;
  /**
   * `navigator.serviceWorker.ready` ── **active になるまで待つ**ための口。
   *
   * ⚠ 登録が無い環境では解決しないので、**登録が在ると分かってから**しか待たない。
   */
  readonly ready: Promise<{ readonly active: unknown }> | null;
  readonly globals: typeof globalThis;
  /** ⚠ 触れないことがある(storage 遮断)。 */
  readonly session: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly reload: () => void;
}

/** セッション内で「1 度試した」を覚える印。 */
export const COI_TRIED_KEY = 'pkc3:coi-reload-tried';

export function applyIsolationReload(env: CoiEnvironment): Promise<CoiReloadOutcome> {
  const g = env.globals as {
    crossOriginIsolated?: boolean;
    WebAssembly?: { Suspending?: unknown };
  };
  // ⚠ storage は投げることがある(storage 遮断)。読めなければ「試した」と見なす
  //    ── 覚えられない環境で読み直すと、それこそ無限になる
  let tried: boolean;
  try {
    tried = env.session?.getItem(COI_TRIED_KEY) === '1';
  } catch {
    tried = true;
  }
  return reloadForIsolation({
    isolated: g.crossOriginIsolated === true,
    jspi: typeof g.WebAssembly?.Suspending === 'function',
    hasActiveWorker: async () => {
      const reg = await env.registration;
      if (reg === null) return false; // 登録できていない ── ready は解決しない
      if (reg.active != null) return true;
      // ⚠ ここで初めて待つ。install 中の初回訪問がこの経路に入る
      if (env.ready === null) return false;
      return (await env.ready).active != null;
    },
    triedBefore: tried,
    markTried: () => {
      try {
        if (!env.session) return false;
        env.session.setItem(COI_TRIED_KEY, '1');
        return true;
      } catch {
        // ⚠ 書けない = 覚えられない。**読み直さない**(輪を作らない)
        return false;
      }
    },
    reload: env.reload,
  });
}
