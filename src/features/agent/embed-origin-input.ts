/**
 * **「埋め込み先のページの AI」を許すページのアドレスを、入力欄から受ける**(#1407)。
 *
 * 入れたアドレスは **origin(`https://example.com`)に落として**一覧へ入れる ── 後ろ(`/a/b`・`?q`・`#h`)を
 * 貯めると、受けるときの突合(`agent-embed.ts` の `allowed().includes(origin)`)が永久に外れる。
 *
 * ## 受けるもの(現行の門 `nameable` ── http / https の名指しの origin ── より**狭い**)
 *
 * - `https://…` ── 受ける
 * - `http://localhost` / `http://127.0.0.1`(port つきも) ── 受ける(手元で組み込みを試す人のため)
 * - それ以外の `http://…` / 他の形式(`ftp:` など) ── 断る
 * - `*`(全部)・`null`(素性が無い) ── 断る(名指しではない。許可リストに有っても AI の道具には使われない)
 * - 空・アドレスの形でない字 ── 断る
 *
 * ⚠ 断る理由は**画面に出す 1 行**で返す(押しても何も起きない、を作らない)。
 * ⚠ **pure**(画面も保存も持たない)。
 */

export type EmbedOriginInput =
  | {
      ok: true;
      origin: string;
      /** 後ろの字を落としたか(「アドレスの後ろは使いません」を添える) */
      trimmed: boolean;
    }
  | { ok: false; reason: string };

export const EMBED_ORIGIN_REASON = {
  empty: 'アドレスを入れてください',
  malformed: 'アドレスの形が正しくありません(例: https://example.com)',
  userinfo: 'アドレスにユーザー名やパスワードは入れられません(例: https://example.com)',
  scheme: 'https:// で始まるアドレスだけ追加できます(http:// は localhost と 127.0.0.1 だけ)',
} as const;

const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export function parseEmbedOriginInput(raw: string): EmbedOriginInput {
  const s = raw.trim();
  if (s === '') return { ok: false, reason: EMBED_ORIGIN_REASON.empty };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: EMBED_ORIGIN_REASON.malformed };
  }
  if (u.username !== '' || u.password !== '') {
    return { ok: false, reason: EMBED_ORIGIN_REASON.userinfo };
  }
  const secure = u.protocol === 'https:';
  const local = u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname);
  if (!secure && !local) return { ok: false, reason: EMBED_ORIGIN_REASON.scheme };
  // 後ろに何か付いていたか(`https://a.test` と `https://a.test/` は同じ ── 末尾の `/` だけは「後ろ」に数えない)
  const trimmed = s.replace(/\/+$/, '') !== u.origin;
  return { ok: true, origin: u.origin, trimmed };
}

/**
 * 追加できたときに 1 行で言う字。
 * 🔴 入れた字と保存した origin が違うときは**必ず**「として」で言う(末尾の `/`・大文字・既定の port も含む)。
 */
export function embedOriginAddedText(origin: string, trimmed: boolean, input?: string): string {
  const same = input === undefined || input.trim() === origin;
  if (same) return `${origin} を追加しました`;
  return trimmed
    ? `${origin} として追加しました(アドレスの後ろは使いません)`
    : `${origin} として追加しました`;
}

export const EMBED_ORIGIN_SAVE_FAILED =
  '保存できませんでした(ブラウザの保存領域に書けません。一覧は変わっていません)';

export function embedOriginDuplicateText(origin: string): string {
  return `${origin} はすでに一覧に入っています`;
}
