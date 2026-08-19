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
  /** IDB blob store の key 一覧(**いま開いている器の分だけ**)。 */
  listBlobKeys(): Promise<string[]>;
  /**
   * 🔴 **どの器にも属さない bytes**(#260)。IDB の key をそのまま返す。
   *
   * ⚠ **本文の走査に掛けない** ── 器が無い以上、その bytes を参照しうる body が
   *   存在しない。走査に掛けると、たまたま同じ asset key を使う**別の器の本文**に
   *   救われて永久に残る(器ごとに key 空間が分かれている意味が消える)。
   * ⚠ optional にしない ── 配線を落としても tsc が黙ると、戻ってくる症状は
   *   「整理を何度押しても 0 件なのに容量だけ減らない」という気づけない形である。
   */
  listStrayBlobs(): Promise<string[]>;
  /** 候補のうち、いずれかの body に参照される key(worker で走査)。 */
  scanReferenced(candidates: string[]): Promise<string[]>;
  deleteBlob(key: string): Promise<void>;
  /** `listStrayBlobs` が返した key をそのまま消す(組み立て直さない)。 */
  deleteStrayBlob(storeKey: string): Promise<void>;
  deleteMeta(key: string): Promise<void>;
}

/**
 * 🔴 **どの器にも属さない bytes を選ぶ**(#260)。
 *
 * ⚠ **判定をここ 1 か所に置く。** 呼び側(`main.ts`)へ直書きすると、あの file は
 * **どの test からも実行されない**ので、取り違えが全 test 緑のまま通る
 * (CLAUDE.md §2)。
 *
 * 🔑 **器の一覧が空なら 1 件も返さない。** 一覧を取り損ねた回に
 * 「全部が残骸」と読むと、**user の添付を全部消す**。誤差はこの向きにだけ倒す
 * (§7「誤差の向きを決めて、両側に使い回さない」)。
 */
export function strayBlobKeys(
  all: readonly { storeKey: string; cid: string }[],
  knownCids: readonly string[],
): string[] {
  if (knownCids.length === 0) return [];
  const known = new Set(knownCids);
  return all.filter((b) => !known.has(b.cid)).map((b) => b.storeKey);
}

export interface OrphanScan {
  keys: string[];
  /**
   * どの器にも属さない bytes(#260)。⚠ `keys` と**混ぜない** ── あちらは
   * asset key、こちらは IDB の key であり、消し方が違う。
   */
  strays: string[];
  /** meta に size がある分だけの合計(bytes だけの dangling は数えない)。 */
  knownBytes: number;
}

/** 走査のみ(削除しない)。UI はこの結果を見せて確認を取ってから purge する。 */
export async function findOrphanAssets(ports: AssetGcPorts): Promise<OrphanScan> {
  const metas = await ports.listMetas();
  const blobKeys = await ports.listBlobKeys();
  // ⚠ 器の無い bytes は**走査に掛けない**(掛ける相手の body が存在しない)
  const strays = await ports.listStrayBlobs();
  const candidates = [...new Set([...metas.map((m) => m.key), ...blobKeys])];
  if (candidates.length === 0) return { keys: [], strays, knownBytes: 0 };
  const referenced = new Set(await ports.scanReferenced(candidates));
  const sizeByKey = new Map(metas.map((m) => [m.key, m.size ?? 0]));
  const keys = candidates.filter((k) => !referenced.has(k));
  const knownBytes = keys.reduce((sum, k) => sum + (sizeByKey.get(k) ?? 0), 0);
  return { keys, strays, knownBytes };
}

/**
 * 指定 key を削除する。**bytes(blob)→ meta の順**: どちらで失敗しても
 * 残骸は候補の和集合に再登場するので、次回の purge が回収できる(自己修復)。
 * 1 key の失敗は他を止めない。
 */
export async function purgeAssets(
  ports: AssetGcPorts,
  keys: readonly string[],
  strays: readonly string[] = [],
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
  // ⚠ 残骸は meta を持たない(器ごと消えているので sqlite 側に行が無い)
  for (const storeKey of strays) {
    try {
      await ports.deleteStrayBlob(storeKey);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}

/**
 * 🔴 **他のタブの編集を見て、整理を断るかどうか**(#253)。
 *
 * ⚠ 判定を `main.ts` に直書きしない ── あの file は**どの test からも実行されない**
 * (原文を読む test しか無い)ので、文言と判定の取り違えが緑のまま通る。
 * ⚠ 3 値をそのまま文言へ落とす:**「返事が無い」を「編集中」と言わない**
 * (言うと user は**存在しないタブ**を探しに行く ── `EditGrant` の M-7 と同じ理由)。
 *
 * @returns 断る理由。`null` なら進めてよい
 */
export function purgeBlockReason(editing: 'editing' | 'idle' | 'unknown'): string | null {
  if (editing === 'editing')
    return '他のタブで編集中です。そちらを保存してからもう一度お試しください';
  if (editing === 'unknown')
    return '本体タブと通信できないため、他のタブが編集中か確かめられません';
  return null;
}

export interface PurgeFlowDeps {
  ports: AssetGcPorts;
  /**
   * 削除してよい状態か。⚠ **自タブの `phase` だけでは足りない**(#253)──
   * 別のタブが編集中に貼った画像は、bytes は在るのに参照が**未保存の欄の中**に
   * しか無く、走査からは「使っていない」に見える。呼び側はタブ間の編集ロックも
   * ここで見る(だから `Promise` にしてある)。
   *
   * ⚠ confirm 待ちの間に編集が始まりうるので、**削除の直前にもう一度**呼ぶ。
   */
  isReady(): Promise<{ ok: boolean; reason: string }>;
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
  if (first.keys.length === 0 && first.strays.length === 0) {
    deps.alert('未参照の添付データはありません');
    return;
  }
  const ok = deps.confirm(
    `どの entry からも参照されていない添付データ ${first.keys.length + first.strays.length} 件` +
      `(${deps.formatSize(first.knownBytes)})を削除します。よろしいですか?`,
  );
  if (!ok) return;
  const ready = await deps.isReady();
  if (!ready.ok) {
    deps.alert(`${ready.reason}(整理は行っていません)`);
    return;
  }
  const second = await findOrphanAssets(deps.ports);
  const firstSet = new Set(first.keys);
  const keys = second.keys.filter((k) => firstSet.has(k));
  // ⚠ 残骸も**交差だけ**を消す(confirm の間に器が生き返る経路は無いが、
  //    規則を 2 つ作らない ── keys と同じ扱いにする)
  const firstStrays = new Set(first.strays);
  const strays = second.strays.filter((k) => firstStrays.has(k));
  const r = await purgeAssets(deps.ports, keys, strays);
  deps.alert(
    `${r.deleted} 件を削除しました` +
      (r.failed > 0 ? `(${r.failed} 件は失敗 ── 再実行で回収されます)` : ''),
  );
}
