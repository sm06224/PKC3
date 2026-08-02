/**
 * P6c 段⑤: `folders[]` + `parent_folder_lid` → **folder entry + structural relation**。
 *
 * PKC3 の木の規約(`features/relation/tree.ts`):
 * folder = archetype 'folder' の entry / 辺 = kind 'structural'、**fromLid = 親**。
 *
 * 🔴 **循環を作ってはいけない**。`resolveCanonicalParents` は「親を持たない entry」を
 * root 直下として出すので、A→B→A があると **A も B も root に出ず、配下ごと
 * filer から消える**(無言のデータ不可視)。tree.ts は
 * 「木の不変量は relation を**書く側**で守る ── 読み手は防御のみ」と宣言している
 * ので、その責務はここにある。
 *
 * ## PKC2 の実地確認(2026-08-01、read-only 調査)
 * - 🔴 **writer は循環・自己親・重複 lid・dangling parent を一切防いでいない**
 *   (`folder-export.ts:114-137` に検査が無い)。PKC2 自身が循環の実在を認めている
 *   (`tree.ts` の "F-cycle hotfix": 循環すると sidebar から component ごと消えた)
 * - **`folders[]` に親が先に来る保証は無い**(トポロジカルソートしていない。
 *   テストが親→子順に見えるのは fixture の並びのせい)── 順序に依存しない実装にする
 * - **export root 自身が `folders[]` に入る**(`folders[0]`、`parent_lid: null`)。
 *   循環で root が自分の子孫になっていると **同じ lid が 2 回**出る
 * - `entries[].parent_folder_lid` は **`folders[]` に無い lid を指しうる**
 *   (親が folder でない / 多重親の last-write-wins が部分木の外を指す)
 * - **空フォルダも `folders[]` に入る**(件数フィルタが無い)
 *
 * ## PKC2 から変えた点
 * PKC2 の reader は上のどれか 1 つでも見つけると **階層を丸ごと捨てて平坦取込**に
 * 落ち、しかも warning は 1 件で打ち切る(`import-planner.ts:74-131`)。さらに
 * 「選択 entry の祖先チェーン」しか folder を作らないので**空フォルダが無言で消える**。
 * PKC3 は **壊れた辺だけを直して残りの木は保つ** ── 1 本の悪い辺で全部の階層を
 * 失う方が損失が大きい。直した箇所は 1 件ずつ全部見せる(§4-K)。空フォルダも作る(§4-M)。
 */

/** 入力(PKC2 の manifest から取る形。呼び出し側が型を狭めて渡す)。 */
export interface FolderNode {
  lid: string;
  title: string;
  parentLid: string | null;
}

export interface FolderGraphResult {
  /** 合成 container に足す folder entry。 */
  entries: Array<{ lid: string; title: string; archetype: 'folder'; body: string }>;
  /** structural relation(fromLid = 親)。id は convert が採番するので持たない。 */
  edges: Array<{ fromLid: string; toLid: string }>;
  warnings: string[];
}

/**
 * 循環を切る。**決定的**(`order` の順に走査し、循環を閉じる辺を切る)。
 *
 * 「どれか 1 本を切れば木になる」ので、切る辺は**循環を閉じた辺**を選ぶ ──
 * 走査順が同じなら結果も同じで、取込のたびに違う形になることはない。
 */
function breakCycles(
  parentOf: Map<string, string>,
  order: readonly string[],
  onBreak: (child: string, parent: string) => void,
): void {
  // 0 = 未訪問 / 1 = 現在の経路上 / 2 = 確定
  const state = new Map<string, 1 | 2>();
  for (const start of order) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !state.has(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    // 経路上のものへ戻った = 循環。閉じた辺(path 末尾 → cur)を切る
    if (cur !== undefined && state.get(cur) === 1) {
      const child = path[path.length - 1]!;
      parentOf.delete(child);
      onBreak(child, cur);
    }
    for (const n of path) state.set(n, 2);
  }
}

/**
 * folder 木を組む。
 *
 * @param folders manifest の `folders[]`(**配列順を保つ** ── 親が先に来る保証は
 *   無いので順序に依存しない実装にするが、循環を切る位置は配列順で決める)
 * @param childOf 本体 entry lid → 親 folder lid(`entries[].parent_folder_lid`)
 */
export function buildFolderGraph(
  folders: readonly FolderNode[],
  childOf: ReadonlyMap<string, string>,
  /** 本体 entry の lid(**folder ではない**もの)。文面を正しくするために要る。 */
  nonFolderLids: ReadonlySet<string> = new Set(),
): FolderGraphResult {
  const warnings: string[] = [];
  const byLid = new Map<string, FolderNode>();
  for (const f of folders) {
    if (f.lid === '') {
      warnings.push('lid の無いフォルダを無視しました');
      continue;
    }
    if (byLid.has(f.lid)) {
      // どちらが正か決められない ── 片方を静かに捨てない
      warnings.push(`同じ lid のフォルダが 2 つあります: ${f.lid}(先の方を採ります)`);
      continue;
    }
    byLid.set(f.lid, f);
  }

  // folder → 親 folder。**実在しない親 / 自己参照は落として言う**
  const parentOf = new Map<string, string>();
  for (const f of byLid.values()) {
    const p = f.parentLid;
    if (p === null || p === '') continue; // export root
    if (p === f.lid) {
      warnings.push(`自分自身を親にしているフォルダの親子関係を外しました: ${f.title}`);
      continue;
    }
    if (!byLid.has(p)) {
      // PKC2 は「選択 entry の祖先」しか folders[] に入れないことがある ──
      // 親が居ないなら root 直下に置く。**黙って平坦にしない**(§4-K)
      warnings.push(`親フォルダが書出しに含まれていません: ${f.title}(最上位に置きます)`);
      continue;
    }
    parentOf.set(f.lid, p);
  }

  breakCycles(parentOf, [...byLid.keys()], (child, parent) => {
    warnings.push(
      `フォルダの親子関係が循環していたので 1 か所外しました: ` +
        `${byLid.get(child)?.title ?? child} → ${byLid.get(parent)?.title ?? parent}`,
    );
  });

  const entries = [...byLid.values()].map((f) => ({
    lid: f.lid,
    title: f.title || '(無題のフォルダ)',
    archetype: 'folder' as const,
    body: '',
  }));

  const edges: FolderGraphResult['edges'] = [];
  for (const [child, parent] of parentOf) edges.push({ fromLid: parent, toLid: child });
  // 本体 entry → 親 folder(循環しえない ── 本体は親になれない)
  for (const [child, parent] of childOf) {
    if (!byLid.has(parent)) {
      // ⚠ **2 つの原因を混ぜない**(review M-3)。PKC2 の structural は UI から
      // 任意の entry 間に張れるので、「親が居ない」と「親は居るが folder ではない」
      // は別の話 ── 前者を後者の文面で言うと user が原因を誤解する
      warnings.push(
        nonFolderLids.has(parent)
          ? `ノートの親がフォルダではありません(${parent})── ${child} を最上位に置きます`
          : `ノートの親フォルダが書出しに含まれていません(${parent})── ${child} を最上位に置きます`,
      );
      continue;
    }
    edges.push({ fromLid: parent, toLid: child });
  }

  return { entries, edges, warnings };
}
