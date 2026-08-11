/**
 * 添付参照の**書き換え**規則(#88 / O4)── 保存で版が変わったとき、
 * 本文が指す先を新しい key へ移す。
 *
 * 🔴 user 裁定 2026-08-11:「**保存したら旧版と差し替えるべきです / そうでなくては
 * PKC のマークダウンからの参照が崩れます**」。
 *
 * ## 🔴 走査(`asset-ref-scan.ts`)と**役割が逆**である
 *
 * | | 走査 | ここ(書き換え) |
 * |---|---|---|
 * | 何を守る | 「まだ使われている」を見落とさない | 関係ない場所を書き換えない |
 * | 誤差の向き | **keep 側**(広く拾う) | **触らない側**(狭く当てる) |
 * | 規則 | key を **substring** で探す | `asset:<key>` という**構文**で拾う |
 *
 * ⚠ **走査の規則をここへ流用してはならない。** substring で置換すると、散文の中に
 * key が偶然現れただけの場所まで書き換わる ── CLAUDE.md「片方の規則をもう片方に
 * 流用すると、誤差がデータ欠損の向きへ反転する」の、まさにその形である。
 *
 * ## 取りこぼしても壊れない(そして黙らない)
 *
 * 狭いので、escape 済みの綴り(`asset:ast\-key`)は**当たらない**。そこは旧 key を
 * 指したまま残るが、旧 bytes は生きている(台帳が持つ)ので**壊れるのではなく
 * 「そこだけ古い版が出る」**。⚠ 呼び側は書き換えのあと**広い走査で数え直し**、
 * 残っていたら件数を user に出す ── 黙って「差し替えました」と言わない。
 *
 * ## 🔑 fence の中も書き換える(意図した選択)
 *
 * ⚠ 規則を 2 本にしないため。fence の中の `asset:<key>` は参照として描かれないが、
 * **書き換えても意味は変わらない**(key は内部の識別子で、指す中身は同じ文書の
 * 最新版になるだけ)。逆に「fence だけ避ける」を入れると、数え直しの側も同じ
 * 例外を持たねばならず、**2 本の規則がずれる**余地を作る。
 *
 * ⚠ **pure module**。
 */

/** key に使われうる字。**境界の判定**に使う(前方一致の巻き込みを防ぐ)。 */
const KEY_CHAR = /[A-Za-z0-9_-]/;

/** 正規表現の特殊文字を逃がす。⚠ key は `-` を含むので必須。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RewriteResult {
  readonly text: string;
  /**
   * 実際に書き換えた箇所の数。
   *
   * ⚠ かつてここに「0 なら同一参照を返す」と書き、`count === 0` を早期 return で
   * 分けていた ── **JS では観測できない主張**だった(文字列は値で比べるので、
   * 作り直しても等値)。変異試験で「枝を消しても緑」= 誰も守っていないと分かったので、
   * **枝ごと落とした**(CLAUDE.md「検査の主張そのものが間違っていることがある」)。
   */
  readonly count: number;
}

/**
 * 本文の `asset:<oldKey>` / `pkc://<cid>/asset/<oldKey>` を新しい key へ移す。
 *
 * ⚠ **後ろの境界を見る** ── `oldKey` が別の key の前半分だったとき、
 * `asset:ast-abcdef` の `ast-abc` に当ててしまうと**別の添付を壊す**。
 * ⚠ `cid` は問わない(自分のコンテナの携帯参照も他所からの写しも、指す先は同じ物)。
 * ⚠ **同じ key への書き換えは何もしない**(無駄な保存で版を積まない)。
 */
export function rewriteAssetRefs(text: string, oldKey: string, newKey: string): RewriteResult {
  if (oldKey === '' || newKey === '' || oldKey === newKey) return { text, count: 0 };
  // `asset:<key>` と `…/asset/<key>` の 2 綴りだけを構文として拾う
  const re = new RegExp(`(asset:|/asset/)(${escapeRe(oldKey)})`, 'g');
  let count = 0;
  const out = text.replace(re, (whole: string, prefix: string, _key: string, at: number) => {
    const after = text[at + whole.length] ?? '';
    // ⚠ 後ろが key の字なら、これは**別の(もっと長い)key** ── 触らない
    if (after !== '' && KEY_CHAR.test(after)) return whole;
    count += 1;
    return `${prefix}${newKey}`;
  });
  return { text: out, count };
}
