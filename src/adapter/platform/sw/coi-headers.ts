/**
 * cross-origin isolation のヘッダ ── **綴りを 1 か所に持つ**(#88 / #111)。
 *
 * ## なぜ定数を切り出すのか
 *
 * この 2 行は **3 か所**で要る:
 *
 * | どこ | 誰が配るか |
 * |---|---|
 * | dev server | `vite.config.ts` の `server.headers` |
 * | preview(smoke が使う) | 同 `preview.headers` |
 * | **本番(GitHub Pages)** | 🔴 **service worker が被せる**(ここが無かった) |
 *
 * 🔴 **2 か所に書くと片方だけ直る。** この repo は同じ形で 1 度壊している
 * (配布物の必要 file 一覧が builder と取得側に分かれていて、片方だけ直った)。
 * ⚠ したがって `vite.config.ts` も **この定数を import する**。
 *
 * ## なぜ `credentialless` か(2026-08-10 実測)
 *
 * | COEP | isolated | SharedArrayBuffer | 外部画像(CORP 無し) |
 * |---|---|---|---|
 * | (なし) | false | ✕ | OK |
 * | `require-corp` | true | ✓ | **BLOCKED** |
 * | `credentialless` | **true** | **✓** | **OK** |
 *
 * `require-corp` にすると CORP を返さない外部画像が全部消え、「外部画像の同意」
 * 機能がそのまま死ぬ。`credentialless` は資格情報を落として no-cors 取得を許すので
 * 両立する。⚠ 代償は**資格情報つきの外部リソースが読めなくなる**こと ──
 * いまの外部画像は同意制の公開画像だけなので該当しない。
 *
 * ⚠ **値を変えるのは仕様変更である。** `tests/adapter/coi-headers.test.ts` が
 * 値そのものを pin してある(黙って `require-corp` へ寄せると外部画像が死ぬ)。
 */

/**
 * 最上位文書に必要な 2 つ。**この 2 つが揃って初めて `crossOriginIsolated`**。
 *
 * ⚠ 片方だけでは成立しない ── だから 1 つのまとまりで持つ。
 */
export const COI_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

/** 生成コードへ埋めるための `[名前, 値]` の並び。 */
export const COI_HEADER_ENTRIES: readonly (readonly [string, string])[] =
  Object.entries(COI_HEADERS);
