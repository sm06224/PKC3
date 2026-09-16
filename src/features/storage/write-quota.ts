/**
 * 🔴 **ノート本体を書く前に、空きを見る**(#971 段②の残り)。
 *
 * ## ⚠ ここまでの門は、添付にしか掛かっていなかった
 *
 * `storeAsset`(`attach.ts`)の門は **IDB へ bytes を置く直前**にだけ在り、
 * **sqlite が育つ経路は素通り**だった ── 2026-09-16 に user の DB が 4GB を
 * 超えて壊れたのは、こちら側である。
 *
 * ## 🔴 いちばん大事な設計:**減らす操作まで止めない**
 *
 * ⚠ 素直に「書き込みを全部止める」と、**空きが無い user は消すこともできなくなる** ──
 *   詰みである。だから止めるのは**増える側だけ**にする。
 *
 * | | op |
 * |---|---|
 * | 🔴 **止める(増える)** | ノートを書く / まとめて入れる / 履歴を取り込む / 添付の登記 / 関係をまとめて書く / 居場所を張る / 参照の張り替え |
 * | 🟢 **通す(減る・変わらない)** | 消す / ごみ箱を空にする / 添付の登記を消す / 関係を消す / 改名 / 並べ替え |
 *
 * 🔑 **改名と並べ替えを通す理由**は「1 列しか書かないので実質増えない」ことと、
 *   **止めても user が空きを作れない**ことの 2 つである。
 *
 * ## ⚠ 毎回は測らない
 *
 * `estimate()` は安くない ── 打鍵のたびに呼ぶと保存が遅くなる。
 * 🔑 **時間と回数の両方**で間隔を決める(片方だけだと、待っている間に
 *   大量に書く経路 / ほとんど書かない経路のどちらかで外す)。
 *
 * ⚠ **pure module**。ブラウザも時計も読まない ── 測った値を受け取って決めるだけ。
 */

/** ⚠ 読めなければ `undefined`(0 と決めつけない)。 */
export interface QuotaSample {
  readonly usage?: number;
  readonly quota?: number;
}

/**
 * 🔴 **これ以上空きが無いなら、増える書き込みを止める**。
 *
 * ⚠ 値の根拠:sqlite は本体に加えて**巻き戻し記録**を書くので、
 *   1 回の取引で「変える頁ぶん」の余白が要る。64MB は
 *   **普通のノート数千件ぶんの取引より十分大きく**、かつ
 *   **ここで止めれば user がまだ消せる**大きさである。
 * ⚠ 添付の門(`storeAsset`)は**置く物の大きさ × 1.2** で見る ── あちらは
 *   大きさが分かっているので比で見られる。こちらは分からないので**床**で見る。
 */
export const WRITE_FLOOR_BYTES = 64 * 1024 * 1024;

/** 測り直す間隔(⚠ 時間と回数の両方 ── 片方だけだとどちらかの経路で外す)。 */
export const QUOTA_RECHECK_MS = 30_000;
export const QUOTA_RECHECK_WRITES = 50;

/**
 * 🔴 **測る側が遅いとき、保存を待たせない**ための打ち切り。
 *
 * ⚠ `estimate()` は**書き込みの直前**に待つので、これが戻らないと
 *   その書き込みごと止まる ── 別のタブからの依頼は **10 秒**で打ち切られるので、
 *   測っている間にその期限を使い切ると「**保存できなかった**」になる。
 * 🔑 **測れなかった回は、断らない側へ倒す** ── 門の目的は
 *   「一杯のときに壊さない」であって、測ることそのものではない。
 */
export const QUOTA_ESTIMATE_TIMEOUT_MS = 2_000;

/**
 * 🔴 **増やす側の op**(= 止める対象)。
 *
 * ⚠ **`CORRUPT_BLOCKED_OPS` を使い回さない** ── あちらは「壊れているときに
 *   止める書き込み」で、**消す op も入っている**(壊れた DB へは消す書き込みも
 *   したくないので、あれで正しい)。こちらで同じ一覧を使うと
 *   🔴 **空きが無い user が消せなくなる = 詰む**。
 * 🔑 目的が違えば一覧も違う ── 同じ名前の集合に見えても、寄せてはいけない。
 */
export const QUOTA_BLOCKED_OPS: readonly string[] = [
  'upsertEntry',
  'bulkUpsertEntries',
  'bulkUpsertRelations',
  'setEntryParent',
  'putAssetMeta',
  'replaceAssetRefs',
  'importRevisionChains',
  'restoreRevisionChains',
];

/**
 * 🟢 **空きが無くても通す書き込み**(減らす / 実質増えない)。
 *
 * 🔑 一覧にしてあるのは、**`QUOTA_BLOCKED_OPS` との和が
 *   `CORRUPT_BLOCKED_OPS` と一致すること**を test で見るためである
 *   (op を足した人が、どちらかへ入れるまで落ちる)。
 */
export const QUOTA_ALLOWED_WRITES: readonly string[] = [
  'deleteEntry',
  'deleteRelation',
  'purgeTrash',
  'deleteAssetMeta',
  'renameEntry',
  'reorderEntry',
];

/**
 * 測り直すべきか。
 *
 * ⚠ **まだ 1 度も測っていないなら必ず測る**(`lastAt === null`)── 起動直後の
 *   1 回目を飛ばすと、**いちばん危ない瞬間**(既に一杯の DB を開いた直後)を見逃す。
 */
export function shouldRecheck(input: {
  readonly lastAt: number | null;
  readonly now: number;
  readonly writesSince: number;
}): boolean {
  if (input.lastAt === null) return true;
  if (input.now - input.lastAt >= QUOTA_RECHECK_MS) return true;
  return input.writesSince >= QUOTA_RECHECK_WRITES;
}

/**
 * 🔴 **増やす書き込みを断るか**。
 *
 * ⚠ **読めないときは断らない**(`unknown` → 通す)── 測れない端末で
 *   **保存できないアプリ**にしてしまうほうが、はるかに害が大きい。
 * 🔑 つまりこの門は**安全側が「通す」**である ── 壊れの門(`db-corruption`)とは
 *   倒し方が逆で、理由も逆である(あちらは書くほど壊れが広がるので止める側が安全)。
 */
export function refuseWrite(sample: QuotaSample): boolean {
  const { usage, quota } = sample;
  if (usage === undefined || quota === undefined) return false;
  if (!Number.isFinite(usage) || !Number.isFinite(quota)) return false;
  if (quota <= 0) return false;
  return quota - usage < WRITE_FLOOR_BYTES;
}

/**
 * 断るときに画面へ出す字。
 *
 * ⚠ **記法を書かない**(素のテキストとして出る面がある)。
 * 🔑 **できることを 2 つ書く** ── 「空きがありません」だけでは詰みに見える。
 *   実際には**消す操作は通る**ので、そう言い切る。
 */
export const WRITE_QUOTA_REFUSAL =
  '保存できる空き容量が足りません。これ以上書き込むと保存に失敗して、' +
  '中身が壊れることがあるので止めました。消す操作は止めていません ── ' +
  '設定の「何が容量を使っているか」で重いノートを探すか、' +
  '「使っていない添付を消す」で空きを作ってから、もう一度お試しください。';
