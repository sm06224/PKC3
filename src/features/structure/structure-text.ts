/**
 * 🔴 **構成をテキストで書き出す**(#429 段①)── AI に整理を頼むための材料。
 *
 * ## なぜ要るか
 *
 * ノートが増えたとき、いま PKC3 で分け直すには **2 ペインで 1 件ずつ**運ぶしかない
 * (`dual-mkdir` / `dual-rename` / `dual-move-to-other` は全部 1 件単位)。
 * ⚠ **やり直す道も無い** ── 50 件動かしてから「やっぱり違う」と思っても 50 回戻す。
 *
 * PKC2 は同じ用事を「**構成をコピー → AI に渡す → 返ってきた案を一括適用**」で
 * 終わらせていた(マニュアル 3 章に載っており、コマンドパレットから届いていた)。
 * ここはその **1 手目**である ── 書き出してコピーするところまで。
 *
 * ## 🔴 コマンドの書き方を**同じ紙に**載せる
 *
 * ⚠ 木だけ渡しても、AI は**どう答えればいいか**を知らない。PKC2 は
 * 「コマンドの書き方の説明つきテキスト」を渡していた ── その形を継ぐ。
 * 🔑 説明が本文の中に在れば、user は**何も覚えなくていい**(貼るだけ)。
 *
 * ## ⚠ lid をそのまま出す
 *
 * `mv <lid> …` は lid が無いと書けない。⚠ **#427 段① で「参照をコピー」が
 * 入るまで、lid は画面のどこにも出ていなかった** ── だからこの機能は
 * それまで前提を欠いていた。
 *
 * 🔑 **pure module**。DOM も時計も持たない。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { getRootEntries, getStructuralChildren } from '@features/relation/tree';

/** 木が深すぎるときに打ち切る段数。⚠ 循環は `tree.ts` が既に断つが、念のため。 */
export const MAX_STRUCTURE_DEPTH = 32;

/**
 * 書き出す本数の上限。⚠ **超えたぶんは出さないが、何件あったかは書く**
 * (「N 件中 M 件を出しています」── `QUERY_LIMITS` / `SMART_LIMIT` と同じ規律)。
 * 🔑 貼り先(AI)には入る量の限りがあるので、黙って全部出すほうが害になる。
 */
export const STRUCTURE_LIMIT = 2000;

/** 説明の書き出し。⚠ **1 か所**に持つ(画面とマニュアルで書き直さない)。 */
export const STRUCTURE_HELP: readonly string[] = [
  '# これは PKC3 のノートの構成です。整理する案を、下の書き方で返してください。',
  '#',
  '#   mv <lid> <フォルダのlid|@名前|root>     フォルダの直下(または root)へ移す',
  '#   mkdir "<題名>" [<親>] [as @名前]        フォルダを作る(親を省くと root)',
  '#   rename <lid> "<新しい題名>"             題名を変える',
  '#',
  '# ・"as @名前" を付けると、同じ案の後の行から @名前 を親として指せます',
  '#   (「新しいフォルダを作って、そこへまとめて移す」が 1 つの案で書けます)',
  '# ・# で始まる行と空行は読み飛ばします',
];

/** 1 行ぶんの材料。⚠ 画面に出す側が字を組み直さないよう、ここで完成させる。 */
export interface StructureLine {
  readonly lid: string;
  readonly depth: number;
  readonly title: string;
  readonly isFolder: boolean;
}

export interface StructureExport {
  /** 貼れる 1 枚。 */
  readonly text: string;
  /** 出した本数。 */
  readonly shown: number;
  /** ぜんぶで何本あったか(上限で切っても数える)。 */
  readonly total: number;
}

/**
 * 木を上から順に平らにする。
 *
 * ⚠ **並び順は `tree.ts` に従う**(`entryOrder` → lid)── ここで並べ直すと、
 *   ファイラの見た目と食い違う(§7「同じ判定を 2 か所に持たない」)。
 */
export function structureLines(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): StructureLine[] {
  const out: StructureLine[] = [];
  const seen = new Set<string>();
  const walk = (m: EntryMeta, depth: number): void => {
    /**
     * ⚠ **`seen` の門は「いま」到達しない**(2026-08-26 の変異試験 S3 が
     *   SURVIVED で教えた)── `tree.ts` が **正準親 1 つ**へ寄せるので、
     *   木は森になり、同じ節点を 2 度通る経路が構造として存在しない
     *   (`resolveCanonicalParents` の docstring:「児は正準親の下に**だけ**現れる」)。
     * 🔑 それでも残すのは、**その不変量が崩れた日に無限再帰にしない**ため。
     * ⚠ だからここを消す変異が生き延びても **test の穴ではない** ──
     *   「これが無いと壊れる」とは書かない(CLAUDE.md)。
     * 🔑 段数の門(`MAX_STRUCTURE_DEPTH`)のほうは**深い木で実際に効く**。
     */
    if (seen.has(m.lid) || depth > MAX_STRUCTURE_DEPTH) return;
    seen.add(m.lid);
    out.push({
      lid: m.lid,
      depth,
      title: m.title,
      isFolder: m.archetype === 'folder',
    });
    for (const c of getStructuralChildren(m.lid, metas, relations)) walk(c, depth + 1);
  };
  for (const r of getRootEntries(metas, relations)) walk(r, 0);
  return out;
}

/**
 * 貼れる 1 枚に組む。
 *
 * @param metas lid → meta
 * @param relations 構造の辺
 */
export function structureText(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): StructureExport {
  const all = structureLines(metas, relations);
  const shown = all.slice(0, STRUCTURE_LIMIT);
  const body = shown.map(
    (l) => `${'  '.repeat(l.depth)}${l.lid}  ${l.isFolder ? '[フォルダ] ' : ''}${l.title}`,
  );
  const head = [...STRUCTURE_HELP];
  if (all.length > shown.length) {
    // ⚠ 切ったことを**本文に**書く ── 黙って切ると、AI は「これで全部」と読む
    head.push('#', `# ⚠ ${all.length} 件のうち上から ${shown.length} 件だけを出しています。`);
  }
  head.push('', 'root');
  return {
    text: [...head, ...body, ''].join('\n'),
    shown: shown.length,
    total: all.length,
  };
}
