/**
 * 🔴 **アプリの一覧で、グループを畳む**(#857 段④)。
 *
 * ## どこに憶えるか ── **端末ごと**である
 *
 * ⚠ 段②(見出しの目印)は **user 裁定 2026-09-12 で「グループ用のノートに憶える」**
 *   と決まっている。⚠ **こちらは同じではない** ── 目印は**ノートの中身**
 *   (端末をまたいで同じであってほしい)だが、**畳んでいるかは「この端末の見え方」**
 *   である(小さい画面では全部畳みたく、広い画面では開けておきたい)。
 * 🔑 だから `pane-size.ts` と同じ側に置く ── あちらの docstring が
 *   「**container に入れない ── ノートのデータではなく、この端末の見え方である**」
 *   と、まさにこの判定を書いている。
 *
 * ## ⚠ 名前で憶える(id ではない)
 *
 * グループは**名前で束ねる**(user 裁定 2026-08-19)ので、畳みも名前で憶える。
 * ⚠ 名前を打ち替えたら畳みは外れる ── タグやスマートフォルダと同じ性質である。
 *
 * 🔑 **pure module**。DOM も保存も知らない(保存は `adapter/ui/render/group-fold.ts`)。
 */

/** 畳んでいるグループの名前。⚠ 並びに意味は無い(集合である)。 */
export type FoldedGroups = readonly string[];

/**
 * 保存の字から読む。⚠ **読めない字は空**にする ── 壊れた保存で起動を止めない。
 * ⚠ 文字列でない物・空文字は捨てる(空文字は「名前の無いグループ」= 見出しを
 * 持たないので、畳む口がそもそも無い)。
 */
export function decodeFolded(raw: string | null): FoldedGroups {
  if (raw === null || raw === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    // ⚠ **重複は落とす**(保存が壊れていても、畳みの判定は 1 名 1 回で足りる)
    return [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))];
  } catch {
    return [];
  }
}

/** 保存の字にする。 */
export function encodeFolded(groups: FoldedGroups): string {
  return JSON.stringify([...groups]);
}

/**
 * 畳む / 開く。⚠ **名前の無いグループは畳めない**(見出しが無いので、開く口が
 * 画面に 1 つも無くなる ── 片道の操作を作らない)。
 */
export function toggleFolded(groups: FoldedGroups, name: string): FoldedGroups {
  if (name === '') return groups;
  return groups.includes(name) ? groups.filter((g) => g !== name) : [...groups, name];
}

/**
 * 🔴 **画面に出ている群が、1 つ残らず畳んであるか**(#857 段④ の「すべて開く」)。
 *
 * ⚠ **0 件のときは false** ── 押し所そのものを出さないため(畳む物が 1 つも
 *   無いのに「すべて畳む」が在ると、押しても何も起きない)。
 */
export function allFolded(groups: FoldedGroups, names: readonly string[]): boolean {
  const named = names.filter((n) => n !== '');
  return named.length > 0 && named.every((n) => groups.includes(n));
}

/**
 * 🔴 **すべて畳む / すべて開く**(#857 段④)。押し所は 1 つで、いまの状態で裏返る ──
 * ⚠ 2 つ並べると**いつも片方が空振り**する(全部開いている画面に「すべて開く」が在る)。
 *
 * 🔑 **一覧に居ない名前は触らない** ── 畳みは設定として別の端末へ運べるので、
 *   ここで全部消すと**別の container で畳んでおいた群まで開いてしまう**
 *   (画面に出ていない物を、画面の操作で変えない)。
 */
export function toggleAllFolded(groups: FoldedGroups, names: readonly string[]): FoldedGroups {
  const named = names.filter((n) => n !== '');
  if (named.length === 0) return groups;
  if (allFolded(groups, named)) return groups.filter((g) => !named.includes(g));
  return [...new Set([...groups, ...named])];
}

/**
 * その群を畳んでいるか。
 *
 * ⚠ **絞り込み中は畳みを無視する**(呼び側が `filtering` を渡す)── 絞った結果が
 *   畳んだ群の中に在ると、**打ったのに何も出ない**ように見える(探している人には
 *   「無い」と「畳んである」の区別が付かない)。
 */
export function isFolded(groups: FoldedGroups, name: string, filtering: boolean): boolean {
  return !filtering && name !== '' && groups.includes(name);
}
