/**
 * 🔴 **「この添付は何の file か」を決める、たった 1 か所**(#854 段① / 段③)。
 *
 * ⚠ 見分けは**題名の拡張子だけ**(中身で見分けるには全部読むしかなく、選ぶ前に
 *   何十 MB も heap へ載せることになる ── 不可侵指示 2026-07-27 の逆)。
 *
 * ## なぜ features 層に置くのか
 *
 * 🔑 読む側(`storage-worker.ts`)と、選ぶ側(`store-effects.ts`)と、
 *   選び所を描く側(`ui/render/sql.ts`)が**同じ答え**を使う必要がある ──
 *   §7「同じ問いに答える口を 2 つ作らない」。⚠ 判定が 2 か所に分かれると、
 *   **選び所には並ぶのに開くと断られる**(あるいはその逆)という、
 *   user から見て理由の分からない形になる。
 */
import { looksLikeCsvAttachmentName } from './csv-attachment';
import { SQLITE_EXTS } from './sqlite-attachment';
import { looksLikeXlsxAttachmentName } from './xlsx-attachment';

/**
 * 🔴 **`openSqlGuest` に渡す「これは何の file か」**。
 *
 * ⚠ `lid` / `name` は**どの種類でも要る**(表の `_note` / `_lid` 列に入る)ので
 *   `kind` の外に置く ── 中に入れると、種類を足す人が写し忘れる。
 */
export type SqlGuestSource = {
  /** 元のノートの lid(表の `_lid` 列に入る)。 */
  readonly lid: string;
  /** 元のノートの題名(表の `_note` 列に入る)。 */
  readonly name: string;
} & (
  | { readonly kind: 'csv'; readonly lang: 'csv' | 'tsv' }
  /** 🔴 枚(シート)ごとに 1 つの表になる ── 表の名前は `sheet1` / `sheet2` …。 */
  | { readonly kind: 'xlsx' }
);

/**
 * 題名から、開き方を決める。
 *
 * @returns `null` = **`.sqlite` の image としてそのまま開く**(今までどおり)。
 *   ⚠ `.sqlite` を名指しで判定しない ── 判定するのは「ほかの読み方が要る物」だけで、
 *   それ以外は既定の道へ落ちる(拡張子の一覧を 2 か所で持たずに済む)。
 */
export function sqlGuestSourceOf(lid: string, name: string): SqlGuestSource | null {
  const lang = looksLikeCsvAttachmentName(name);
  if (lang !== null) return { kind: 'csv', lang, lid, name };
  if (looksLikeXlsxAttachmentName(name)) return { kind: 'xlsx', lid, name };
  return null;
}

/**
 * 🔴 **「手持ちのファイルを開く…」で選ばせてよい拡張子**(`accept` に出す字)。
 *
 * ⚠ ここと `sqlGuestSourceOf` が食い違うと、user から見て 2 通りの事故になる ──
 *   ①**選べるのに必ず断られる**(accept に在って、判定が知らない)
 *   ②**開けるのに file 選択画面に出てこない**(判定は知っているが、accept に無い)。
 * 🔑 食い違っていないことは `tests/adapter/sql-source-parity.test.ts` が見る。
 */
export const SQL_GUEST_EXTS: readonly string[] = [...SQLITE_EXTS, '.csv', '.tsv', '.xlsx'];
