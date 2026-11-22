/**
 * 🔴 **S3 互換の保管先の CORS の設定の例**(#2000 段 4a-4。user 必須ガード)── 設定の画面に、いまの画面の場所(`location.origin`)を
 * 埋めて出す。利用者はこれを保管先(AWS S3 / Cloudflare R2 / MinIO など)の CORS の設定に貼る。
 *
 * - `AllowedHeaders` は `S3Box` が送る見出しの全部(⚠ 増やしたらここも増やす ── `tests/adapter/s3-box.test.ts` が送った見出しと突き合わせる)。
 * - `ExposeHeaders` に `ETag`(見えないと条件付き書き込みの版が分からない ── `S3Box.write` が理由を言って止まる)。
 * ⚠ pure module。
 */

/** `S3Box` が送る見出し(小文字)。⚠ `host` はブラウザが付ける(許す見出しに入れない)。 */
export const S3_CORS_ALLOWED_HEADERS = ['authorization', 'content-type', 'if-match', 'if-none-match', 'x-amz-content-sha256', 'x-amz-date'] as const;
export const S3_CORS_ALLOWED_METHODS = ['GET', 'PUT', 'DELETE', 'HEAD'] as const;

/** CORS の設定の例(AWS S3 の JSON の形。R2 の画面も同じ形を受ける)。 */
export function s3CorsTemplate(origin: string): string {
  return JSON.stringify(
    [
      {
        AllowedOrigins: [origin],
        AllowedMethods: [...S3_CORS_ALLOWED_METHODS],
        AllowedHeaders: [...S3_CORS_ALLOWED_HEADERS],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3000,
      },
    ],
    null,
    2,
  );
}

/**
 * 🔴 **`<user>.github.io` の注意**(user 裁定)── GitHub Pages の `<user>.github.io` は、同じ持ち主の別のリポジトリのページと
 * 場所(origin)を共有する。同じ場所のページは、この画面が保存した物(暗号化した認証情報を含む)を使えてしまう。
 */
export function sharedOriginHost(hostname: string): boolean {
  return /\.github\.io$/i.test(hostname);
}
