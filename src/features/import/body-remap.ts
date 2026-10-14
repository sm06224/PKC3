/**
 * 取り込みで**本文の中の ID を付け替える**口(添付の key / ノートの lid)。
 *
 * ## なぜ 1 か所か
 *
 * 取り込みは本文(tip)を書き換えるが、**履歴の鎖はその tip を起点に逆向きのパッチで戻す**。
 * tip だけ書き換えると、戻した古い版は「書き換えた行」と「書き出したときの hash」が噛み合わず、
 * worker の噛み合わせ検査(`restoreOneChain`)で**鎖ごと捨てられていた**(#1087、バックアップ往復の見直し)。
 * 直しは「書き出したときの本文で戻し、戻した各版に**同じ**書き換えを当てる」── そのためには
 * tip と履歴で書き換えが 1 文字も違ってはならないので、規則をここ 1 つに置く。
 *
 * ⚠ 純関数(worker からも呼ぶ)。
 */

/**
 * `<prefix><token>` を 1 パスで写す。
 *
 * ⚠ token は `[A-Za-z0-9_-]+` を**最長一致**で取る ── これが境界の実体である。
 * 貪欲でないと `asset:k10` の `k1` 部分だけが `k1` の写し先に化ける
 * (PKC2 の旧 key 3 系統は prefix 関係になりうるので実際に起きる)。
 * map に無い token はそのまま(missing key は壊れシグナルとして保存する)。
 */
export function replacePrefixed(
  body: string,
  prefix: string,
  map: ReadonlyMap<string, string>,
): string {
  if (map.size === 0) return body;
  return body.replace(
    new RegExp(`${prefix}[A-Za-z0-9_-]+`, 'g'),
    (m) => prefix + (map.get(m.slice(prefix.length)) ?? m.slice(prefix.length)),
  );
}

/**
 * 暫定 asset key を最終 key(= 中身のハッシュ)へ写す。
 *
 * convert は純関数なので bytes を持たず、content key を決められない ──
 * adapter が復号後にこれを呼ぶ。body 中の出現箇所は 2 通りある:
 * ① markdown の `asset:<key>` ② frontmatter の `attachment.asset_key: <key>` /
 * `attachment.app_icon_asset_key: <key>`。②は素の値なので prefix 無しで消す。
 *
 * 暫定 key は**この取込で生成した token**であり、body 中では必ず `:` か空白の
 * 直後に現れる ── 前方境界を見なくても他の語の一部に当たらない。
 */
export function remapAssetKeys(body: string, map: ReadonlyMap<string, string>): string {
  if (map.size === 0) return body;
  // 素の token を最長一致で拾って引く(map 全件ループをやめる ── review M-7)。
  // 暫定 key は `ast-<ts36>-<rand6>` なので、`-` を含む 1 token として取れる
  return body.replace(/[A-Za-z0-9_-]+/g, (t) => map.get(t) ?? t);
}

/**
 * 取り込みで本文に当てる書き換えの全部。⚠ **変わる組だけ**を持つ(写し先が同じ組は入れない)
 * ── 空なら本文も履歴も 1 バイトも触らない。worker へ渡すので配列で持つ。
 */
export interface ImportRemap {
  /** 添付の key(旧 → 新)。 */
  assetKeys: ReadonlyArray<readonly [string, string]>;
  /** ノートの lid(旧 → 新)。本文の `entry:<lid>`(リンク・カード)を写す。 */
  lids: ReadonlyArray<readonly [string, string]>;
}

/** 写す組が 1 つも無いか(無いなら本文も履歴も触らない)。 */
export function isEmptyRemap(r: ImportRemap): boolean {
  return r.assetKeys.length === 0 && r.lids.length === 0;
}

/** 写し先が元と同じ組を落とす(恒等の組を持ち回らない)。 */
export function changedPairs(map: ReadonlyMap<string, string>): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const [from, to] of map) if (from !== to) out.push([from, to]);
  return out;
}

/**
 * 🔑 本文を写す**唯一の口**。tip(取り込む本文)と、履歴から戻した各版の両方がここを通る。
 * ⚠ lid は `entry:` の直後だけを狭く当てる。添付の key は token を全部見る(取り込み前からの規則)ので、
 *   lid と添付の旧 key が偶然同じ字なら、どちらの順でも化けうる ── 起きる確率は採番の形から極小。
 * ⚠ コードの塊の中の `entry:<lid>`(リンクの書き方の説明など)も写す。区別しないのは添付の key と同じ。
 */
export function remapImportedBody(body: string, remap: ImportRemap): string {
  let out = body;
  if (remap.lids.length > 0) out = replacePrefixed(out, 'entry:', new Map(remap.lids));
  if (remap.assetKeys.length > 0) out = remapAssetKeys(out, new Map(remap.assetKeys));
  return out;
}
