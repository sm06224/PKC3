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
 * - 場所(フォルダ)は**消えていても残す**(帯に出して外せるようにしてある)
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
    if (!k.startsWith(NOTE_PREFIX)) return true;
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
  if (stored.length >= MAX_BOOKMARKS_STORED)
    return `この端末に残っているブックマークが ${String(MAX_BOOKMARKS_STORED)} 件に達したため、足せません(不要なブックマークを外してください)`;
  return null;
}

/** 留めてあるか。⚠ 判定はここ 1 か所(押し口の字と帯の並びが食い違わないように)。 */
export const isBookmarked = (list: readonly string[], lid: string | null): boolean =>
  lid !== null && list.includes(lid);
