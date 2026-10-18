/**
 * 🔴 **2 ペインファイラの「留めた場所」**(#273 残件。user 指示 2026-08-19
 * 「往年の FD などを見習ってください / OS のファイラと同じことができないといけません」)。
 *
 * ## 何のために在るか
 *
 * 深い所に置いた作業用のフォルダへ、**毎回パンくずを辿らずに**行けるようにする。
 * 古典の 2 ペインファイラ(Total Commander / Double Commander / FAR / Krusader)は
 * 例外なく持っており、**帯 1 本 + 1 打鍵**というのが共通の形である。
 *
 * ## ⚠ 決めごと
 *
 * - 🔑 **留めるのは「場所」(フォルダの lid)と「ノート」の 2 種類**(#1377)。
 *   ノートは `note:<コレクションの id>/<lid>` の綴り({@link noteBookmarkKey})で同じ一覧に入る ──
 *   一覧の形(文字列の配列)も保存の鍵も変えない(旧い保存はそのまま場所として読める)。
 *   ⚠ **コレクションの id を綴りに入れる**のは、この一覧が**端末の保存**(コレクションをまたいで
 *   1 つ)だから ── 入れないと、別のコレクションのノートが帯にも上限の数にも混ざる。
 *   ⚠ 種類を綴りで持つのは、**消えた物の扱いが種類で違う**ため ── 消えた場所は
 *   外せるよう帯に残し、消えたノートは帯から落とす(下の {@link liveBookmarks})。
 * - 🔴 **ノートの綴りを保存から落とす操作は無い**(足す / 外すの相手以外)。帯に出さないだけ ──
 *   消えたノートも別のコレクションのノートも、保存には残る(ゴミ箱から戻せば、また並ぶ)。
 *   ⚠ 保存の総数だけは {@link MAX_BOOKMARKS_STORED} で止める(足すのを断る)。
 * - ⚠ **旧いビルドの見え方**:旧いビルドは `note:` の綴りを**場所の lid** として読む ──
 *   帯に「(消えた場所 note:…)」の押せないボタンとして出て、「×」で外せる(旧いビルドの
 *   「消えた場所も外せる」の作りのまま)。新しいビルドで入れたノートが、旧いビルドの帯に
 *   出るのは、この 1 点だけ。
 * - ⚠ 開発中に一度だけ `note:<lid>`(コレクションの id 無し)の綴りを作ったが、配っていないので
 *   読み方を持たない(`noteRefOf` は `null`、`liveBookmarks` は帯にも上限にも出さない)。
 * - ⚠ **ルート(`null`)は留めない** ── パンくずの左端が常にルートなので、
 *   1 押しで行ける所を帯に並べても枠を食うだけである
 * - 🔴 **置けるなら外せる**(user 指示 2026-08-23「なんで双方向にする発想が
 *   でねぇんだよ!」)── 留める口と外す口は**必ず対で**置く
 * - ⚠ **消えたフォルダの分も落とさない**(この module では)── 落とすのは
 *   描く側の仕事である。ここで黙って消すと、**取り違えて消した直後に
 *   ゴミ箱から戻した**ときに留めが復活しない
 *
 * ⚠ **pure module**。browser API も dispatch も触らない。
 */

/**
 * 留められる上限。
 * ⚠ 上限は**手違いの検出**である ── 押し続けて 500 件になると帯が版面を食い尽くす
 * (`MAX_TABS` と同じ理由)。⚠ 超えたら**古いほうから捨てる**のではなく
 * **足すのを断る** ── 黙って消えると「留めたのに無い」になる。
 */
export const MAX_BOOKMARKS = 20;

/**
 * 保存に持てる総数(他のコレクションのノート・消えたノートを含む)。
 * ⚠ 帯と {@link MAX_BOOKMARKS} は**いまのコレクションの生きている分**しか数えない ──
 *   保存を掃除しない代わりに、保存そのものが膨らみ続けないよう、足すのを断る。
 */
export const MAX_BOOKMARKS_STORED = 100;

/** 保存の形を読む。⚠ **どんな壊れ方でも空へ落ちる**(留めが読めないだけで面が死なない)。 */
export function decodeBookmarks(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== 'string' || x === '') continue;
      if (out.includes(x)) continue;
      out.push(x);
      if (out.length >= MAX_BOOKMARKS_STORED) break;
    }
    return out;
  } catch {
    return [];
  }
}

export const encodeBookmarks = (list: readonly string[]): string => JSON.stringify([...list]);

/**
 * 留める / 外すを 1 本で決める(押し口は 1 つ ── 同じボタンが二役)。
 * @returns 変わらないときは**同じ配列**を返す(描き直しの判定に使える)
 */
export function toggleBookmark(
  list: readonly string[],
  lid: string,
  cap: number = MAX_BOOKMARKS,
): string[] {
  if (lid === '') return [...list];
  if (list.includes(lid)) return list.filter((x) => x !== lid);
  // ⚠ 上限で断る(黙って古いものを捨てない)
  if (list.length >= cap) return [...list];
  return [...list, lid];
}

/** ノートの印(綴りの前置き)。⚠ 場所(フォルダの lid)と取り違えない。 */
const NOTE_PREFIX = 'note:';

/**
 * 🔴 **場所(フォルダ)の綴り**(台帳 #1852 N1 / 依頼 328 A。Gemini 回答 = 推薦どおり)。`place:<コレクションの id>/<lid>`。
 * ⚠ 直す前は場所の綴りが**素の lid**で、コレクションの印が無かった ── コレクション A でフォルダを 20 件ブックマークしてから B を開くと、
 *   A の 20 件が「(消えた場所 …)」の押せないボタンとして並び、B で足そうとすると「20 件までです」と断られた。
 * 🔑 **古い綴り(素の lid)はそのまま読める** ── 開いているコレクションに**その lid のノートがあるときだけ**そのコレクションの物として出す
 *   (lid は作るたびに別の値なので、別のコレクションの物と取り違えない)。新しく足す物は `place:` で入る。
 * ⚠ 古い綴りのまま、**開いているコレクションのフォルダが消えた**分は帯から落ちる(保存には残る ── ゴミ箱から戻せば帯へ復活する。ノートと同じ)。
 */
const PLACE_PREFIX = 'place:';

/** 場所を一覧に入れるときの綴り(`place:<コレクションの id>/<lid>`)。 */
export const placeBookmarkKey = (cid: string, lid: string): string =>
  `${PLACE_PREFIX}${cid}/${lid}`;

/** 綴りが新しい場所の綴りなら、そのコレクションの id と lid。⚠ ノート・古い綴り・読めない綴りは `null`。 */
export function placeRefOf(key: string): { cid: string; lid: string } | null {
  if (!key.startsWith(PLACE_PREFIX)) return null;
  const rest = key.slice(PLACE_PREFIX.length);
  const at = rest.indexOf('/');
  if (at <= 0 || at === rest.length - 1) return null;
  return { cid: rest.slice(0, at), lid: rest.slice(at + 1) };
}

/** 綴りが指す先の lid(ノート・新しい場所の綴りは中の lid、古い綴りはそのもの)。 */
export const bookmarkTargetLid = (key: string): string =>
  noteRefOf(key)?.lid ?? placeRefOf(key)?.lid ?? key;

/** ノートを一覧に入れるときの綴り(`note:<コレクションの id>/<lid>`)。 */
export const noteBookmarkKey = (cid: string, lid: string): string =>
  `${NOTE_PREFIX}${cid}/${lid}`;

/**
 * 綴りがノートなら、そのコレクションの id と lid。⚠ 場所・読めない綴りは `null`。
 * ⚠ 区切りは**最初の `/`**(コレクションの id に `/` は無い前提 ── lid 側は何でもよい)。
 */
export function noteRefOf(key: string): { cid: string; lid: string } | null {
  if (!key.startsWith(NOTE_PREFIX)) return null;
  const rest = key.slice(NOTE_PREFIX.length);
  const at = rest.indexOf('/');
  if (at <= 0 || at === rest.length - 1) return null;
  return { cid: rest.slice(0, at), lid: rest.slice(at + 1) };
}

/**
 * 🔴 **いまのコレクションで生きている一覧**(#1377)── 帯に出す物と、上限の数える物。
 *
 * - 場所(フォルダ)は**このコレクションの物**(`place:` の綴り)なら消えていても残す(帯に出して外せるようにしてある)。
 *   古い綴り(素の lid)は、いまのコレクションに在るときだけ(依頼 328 A)
 * - ノートは**このコレクションの、いま在るもの**だけ(別のコレクションのノートは数えない)
 * 🔑 **保存は書き換えない**(これは見せる側の読み方) ── 消えたノートも別のコレクションの
 *   ノートも保存に残るので、ゴミ箱から戻したノートは、いつでも帯へ復活する。
 */
export function liveBookmarks(
  list: readonly string[],
  cid: string | null,
  exists: (lid: string) => boolean,
): string[] {
  return list.filter((k) => {
    if (k.startsWith(PLACE_PREFIX)) {
      // 場所は消えていても残す(帯に出して外せるように)。別のコレクションの物は出さず、数えない
      const place = placeRefOf(k);
      return place !== null && cid !== null && place.cid === cid;
    }
    if (!k.startsWith(NOTE_PREFIX)) return exists(k); // 古い綴り(素の lid)── このコレクションに在るときだけ
    const ref = noteRefOf(k);
    return ref !== null && cid !== null && ref.cid === cid && exists(ref.lid);
  });
}

/**
 * 🔴 **足すのを断る理由**(#1377)。⚠ 外すときは `null`(置けなくても外せる)。
 * - 生きている分が {@link MAX_BOOKMARKS} → 「20 件まで」
 * - 保存の総数が {@link MAX_BOOKMARKS_STORED} → 「保存の上限」
 * 🔑 ☆ とメニューの両方がここを引く(断り文を 2 か所に書かない)。
 */
export function bookmarkRefusal(
  stored: readonly string[],
  live: readonly string[],
  key: string,
): string | null {
  if (stored.includes(key)) return null;
  if (live.length >= MAX_BOOKMARKS)
    return `ブックマークは ${String(MAX_BOOKMARKS)} 件までです(どれか外してください)`;
  // 🔴 バーに出ていない分(ほかのコレクションの物・消したノートの物)も数えていることを言う(依頼 97-4 A)
  if (stored.length >= MAX_BOOKMARKS_STORED)
    return `この端末に残っているブックマークが ${String(MAX_BOOKMARKS_STORED)} 件に達したため、足せません。バーに出ていない分(ほかのコレクションの物や、消したノートの物)も数えています。不要なブックマークを外してください`;
  return null;
}

/**
 * その場所が留めてあるときの、一覧の中の綴り(新しい綴りか、古い綴りのどちらか。無ければ `null`)。
 * ⚠ 外す口が**入っている綴りのほう**を撃つための問い ── 新しい綴りだけを引くと、古い綴りで入っている物が外せない。
 */
export function placeBookmarkIn(
  list: readonly string[],
  cid: string | null,
  lid: string | null,
): string | null {
  if (lid === null) return null;
  if (cid !== null) {
    const key = placeBookmarkKey(cid, lid);
    if (list.includes(key)) return key;
  }
  return list.includes(lid) ? lid : null;
}

/** 留めてあるか。⚠ 判定はここ 1 か所(押し口の字と帯の並びが食い違わないように)。 */
export const isBookmarked = (
  list: readonly string[],
  lid: string | null,
  cid: string | null,
): boolean => placeBookmarkIn(list, cid, lid) !== null;
