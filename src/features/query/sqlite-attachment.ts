/**
 * 🔴 **取り込んだ `.sqlite` を、SQL の相手として選べるようにする**(#681 段③ の 2 つ目)。
 *
 * user の言葉(2026-09-03)の「**csv や sqliteDB のクエリアプリ**」の sqliteDB の側。
 *
 * ## どこから選ぶか
 *
 * 🔑 **添付として取り込んだノート**から選ぶ(issue の指示「添付として取り込み」)。
 * ⚠ 添付の key は**中身のハッシュ**なので、key からは名前が読めない ── だから
 *   一覧は**添付のノートの題名**(= file の名前)で作る。
 *
 * ## ⚠ 何を「それらしい」と見るか
 *
 * 🔴 **拡張子だけで見る。中身は見ない** ── 中身で見分けるには**全部読む**しかなく、
 *   選ぶ前に何十 MB も heap へ載せることになる(不可侵指示 2026-07-27 の逆)。
 * ⚠ 外したものは**開いたときに断られる**(`openSqlGuest` が読んで言う)ので、
 *   ここで取りこぼしても「開けない」が正しく出る ── **広めに拾ってよい**側である。
 */

/** それらしい拡張子。⚠ 大文字で書く人も居るので、比べる前に小文字へ落とす。 */
const SQLITE_EXTS = ['.sqlite', '.sqlite3', '.db', '.db3'] as const;

/** その題名は `.sqlite` の添付か。 */
export function looksLikeSqliteName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return SQLITE_EXTS.some((ext) => lower.endsWith(ext));
}

/** 選べる相手 1 つ(画面の `<select>` に並ぶ形)。 */
export interface SqlSource {
  readonly lid: string;
  readonly name: string;
}

/**
 * 添付のノートから、選べる相手を拾う。
 *
 * ⚠ **並びは題名順**(作った順だと、同じ file を入れ直すたびに場所が変わる)。
 */
export function sqlSourcesOf(
  metas: Iterable<{ readonly lid: string; readonly title: string; readonly archetype: string }>,
): SqlSource[] {
  const out: SqlSource[] = [];
  for (const m of metas) {
    if (m.archetype !== 'attachment') continue;
    if (!looksLikeSqliteName(m.title)) continue;
    out.push({ lid: m.lid, name: m.title });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
