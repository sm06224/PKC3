/**
 * 🔴 **何が容量を食っているか**(#415)── 並べ方と文言。
 *
 * ## user の物語
 *
 * 保存領域が心細い。**何が重いのか見たい。** いまは 1 件ずつ開けば大きさは出るが、
 * ⚠ **300 件を 1 件ずつ開く**ことになる。片づけの口は在るが、それは
 * **どこからも参照されていない添付**を消すだけで、「**使っているが重い物**」には効かない。
 *
 * ## ⚠ 数えるのは worker の中(ここは並べるだけ)
 *
 * bytes も本文も worker の外へ出さない ── ここが受け取るのは**数字だけ**である
 * (`StorageProfileResult`)。
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import type { EntryMeta } from '@core/model/entry-meta';

/**
 * 🔴 **容量の内訳**(#415)。⚠ **数字だけ** ── 本文も bytes も worker の外へ出ない。
 *
 * ⚠ **型はここ(features)に置き、protocol が読む** ── 逆向きにすると
 *   `features` が `adapter` を import することになり、層の規約
 *   (core ← features ← adapter)が崩れる。
 */
export interface StorageProfileRow {
  readonly lid: string;
  /** そのノートが参照している添付の合計(バイト)。 */
  readonly assetBytes: number;
  /** 本文の文字数(`entries.body_chars` の列 ── 数え直さない)。 */
  readonly bodyChars: number;
  /**
   * ⚠ **他のノートとも共有している添付の数**。
   * 🔑 共有している添付は**参照している全部のノートに満額で数える**ので、
   *   行の合計は `totalAssetBytes` を超えうる ── そのことを画面が言えるように
   *   この数を返す(「合わない」と読まれないため)。
   */
  readonly sharedAssets: number;
}

export interface StorageProfileResult {
  readonly rows: readonly StorageProfileRow[];
  /** 🔑 **重複を数えない**添付の総量(器の実際の使用量に近いほう)。 */
  readonly totalAssetBytes: number;
  /** どのノートからも参照されていない添付の合計(= 片づけで消せる分)。 */
  readonly orphanBytes: number;
}

/** 一覧に出す本数。⚠ 全部出しても user は上から数件しか見ない。 */
export const PROFILE_TOP = 20;

export interface ProfileLine {
  readonly lid: string;
  readonly title: string;
  readonly assetBytes: number;
  readonly bodyChars: number;
  /** 他のノートとも共有している添付を持つか。 */
  readonly shared: boolean;
}

/** 人が読む大きさ。⚠ 1024 で割る(`formatSize` と同じ向き)。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * **重い順**に並べる。
 *
 * ⚠ **添付が 0 の行は落とす** ── 「何が容量を食っているか」を見に来た user に、
 *   0 B の行を 280 本見せない。⚠ ただし**本文が長い行は残す**(本文も容量である)。
 * ⚠ 題名が引けない lid は落とす(消された直後などに起こりうる)── 押しても
 *   飛べない行を出さない。
 */
export function profileLines(
  result: StorageProfileResult,
  metas: ReadonlyMap<string, EntryMeta>,
  top: number = PROFILE_TOP,
): ProfileLine[] {
  const out: ProfileLine[] = [];
  for (const r of result.rows) {
    const meta = metas.get(r.lid);
    if (meta === undefined) continue;
    if (r.assetBytes === 0 && r.bodyChars === 0) continue;
    out.push({
      lid: r.lid,
      title: meta.title,
      assetBytes: r.assetBytes,
      bodyChars: r.bodyChars,
      shared: r.sharedAssets > 0,
    });
  }
  /**
   * ⚠ 添付が同じ大きさなら**本文が長いほう**を上にする ── 添付を持たない
   *   ノートどうしが**毎回ばらばらの順**で出ると、押す場所を覚えられない。
   * ⚠ さらに同じなら lid で決める(**並びを毎回同じにする**)。
   */
  out.sort(
    (a, b) =>
      b.assetBytes - a.assetBytes ||
      b.bodyChars - a.bodyChars ||
      a.lid.localeCompare(b.lid),
  );
  return out.slice(0, top);
}

/**
 * 🔴 **合計の言い方**(#415 の ⚠)。
 *
 * ⚠ ブラウザが言う空き容量(`navigator.storage.estimate`)と**この合計は一致しない**
 *   ── ブラウザは索引や空き領域も数える。⚠ 並べて出すと「合わない」と読まれるので、
 *   **ここが何を数えているか**を 1 行で言う。
 */
export function profileSummary(result: StorageProfileResult): string {
  const head = `添付はぜんぶで ${formatBytes(result.totalAssetBytes)} です`;
  const orphan =
    result.orphanBytes > 0
      ? `。うち ${formatBytes(result.orphanBytes)} は、どのノートからも使われていません(「使っていない添付を消す」で片づけられます)`
      : '';
  return `${head}${orphan}。⚠ ブラウザが言う使用量とは数え方が違います(こちらは添付の合計だけです)。`;
}

/**
 * 共有している添付があるときの但し書き。
 * ⚠ 無いときは**空文字**(要らない注意書きを常に出さない)。
 */
export function sharedNote(lines: readonly ProfileLine[]): string {
  return lines.some((l) => l.shared)
    ? '⚠ 印の付いた行は、同じ添付を別のノートとも使っています。片方を消しても減りません。'
    : '';
}

/** 1 行の見せ方。⚠ 画面が字を組み直さないよう、ここで完成させる。 */
export const profileLineText = (l: ProfileLine): string =>
  `${formatBytes(l.assetBytes)}  ${l.title}${l.shared ? '(共有)' : ''}`;
