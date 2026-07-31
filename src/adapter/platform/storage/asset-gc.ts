/**
 * 未参照 asset の掃除(P4b)。**明示 purge のみ** ── 自動 GC は走らせない
 * (裏で走る削除は S3 型のデータ消失経路になる。PKC2 の reconcile 走査が
 * boot OOM を誘発した教訓もあり、走査はユーザーの明示操作時に限る)。
 *
 * keep-set の判定は storage worker の `scanAssetRefs`(候補 key の raw
 * substring 一致)── frontmatter(attachment.asset_key / app_icon_asset_key /
 * extra 内 JSON)と本文の `asset:` 参照はどれも key 文字列そのものを含むので、
 * この 1 規則が全参照源を包摂する。誤差は **false-keep 側にしか出ない**
 * (無関係な散文が key を偶然含む)── GC で許されるのはその向きだけ。
 *
 * 候補 = sqlite assets 表 ∪ IDB blob keys の**和集合**。どちらか片側にしか
 * 無い dangling(meta だけ / bytes だけ)も同じ purge で回収される。
 */
export interface AssetGcPorts {
  /** sqlite assets 表(meta)。 */
  listMetas(): Promise<Array<{ key: string; size: number | null }>>;
  /** IDB blob store の key 一覧。 */
  listBlobKeys(): Promise<string[]>;
  /** 候補のうち、いずれかの body に参照される key(worker で走査)。 */
  scanReferenced(candidates: string[]): Promise<string[]>;
  deleteBlob(key: string): Promise<void>;
  deleteMeta(key: string): Promise<void>;
}

export interface OrphanScan {
  keys: string[];
  /** meta に size がある分だけの合計(bytes だけの dangling は数えない)。 */
  knownBytes: number;
}

/** 走査のみ(削除しない)。UI はこの結果を見せて確認を取ってから purge する。 */
export async function findOrphanAssets(ports: AssetGcPorts): Promise<OrphanScan> {
  const metas = await ports.listMetas();
  const blobKeys = await ports.listBlobKeys();
  const candidates = [...new Set([...metas.map((m) => m.key), ...blobKeys])];
  if (candidates.length === 0) return { keys: [], knownBytes: 0 };
  const referenced = new Set(await ports.scanReferenced(candidates));
  const sizeByKey = new Map(metas.map((m) => [m.key, m.size ?? 0]));
  const keys = candidates.filter((k) => !referenced.has(k));
  const knownBytes = keys.reduce((sum, k) => sum + (sizeByKey.get(k) ?? 0), 0);
  return { keys, knownBytes };
}

/**
 * 指定 key を削除する。**bytes(blob)→ meta の順**: どちらで失敗しても
 * 残骸は候補の和集合に再登場するので、次回の purge が回収できる(自己修復)。
 * 1 key の失敗は他を止めない。
 */
export async function purgeAssets(
  ports: AssetGcPorts,
  keys: readonly string[],
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await ports.deleteBlob(key);
      await ports.deleteMeta(key);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}

export interface PurgeFlowDeps {
  ports: AssetGcPorts;
  /** confirm 待ちの間に編集が始まりうる ── 削除直前の再確認に使う。 */
  isReady(): boolean;
  confirm(message: string): boolean;
  alert(message: string): void;
  formatSize(bytes: number): string;
}

/**
 * 「添付の整理」の明示フロー(走査 → confirm → **再確認 → 再走査交差** → 削除)。
 *
 * confirm は modal だが、それに寄りかからない(review F1 ── TOCTOU):
 * confirm が返った後に (a) ready を再確認し (b) もう一度走査して**初回結果との
 * 交差だけ**を消す。confirm 中に取込が進んで現れた「まだ entry の無い key」は
 * 交差に入らず(初回に無い)、confirm 中に参照され直した key も交差に入らない
 * (再走査で referenced)。将来 confirm を独自 async UI に替えても保険が残る。
 * 呼び出し側は attach と排他の in-flight gate を張ること(main.ts)。
 */
export async function runExplicitPurge(deps: PurgeFlowDeps): Promise<void> {
  const first = await findOrphanAssets(deps.ports);
  if (first.keys.length === 0) {
    deps.alert('未参照の添付データはありません');
    return;
  }
  const ok = deps.confirm(
    `どの entry からも参照されていない添付データ ${first.keys.length} 件` +
      `(${deps.formatSize(first.knownBytes)})を削除します。よろしいですか?`,
  );
  if (!ok) return;
  if (!deps.isReady()) {
    deps.alert('編集が始まったため中止しました(整理は行っていません)');
    return;
  }
  const second = await findOrphanAssets(deps.ports);
  const firstSet = new Set(first.keys);
  const keys = second.keys.filter((k) => firstSet.has(k));
  const r = await purgeAssets(deps.ports, keys);
  deps.alert(
    `${r.deleted} 件を削除しました` +
      (r.failed > 0 ? `(${r.failed} 件は失敗 ── 再実行で回収されます)` : ''),
  );
}
