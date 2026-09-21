/**
 * 🔴 **起動のたびに、軽く検める**(#1007 段①)。
 *
 * ## いままでどうだったか
 *
 * `quick_check` は設定の「壊れていないか調べる」を**押したときだけ**走っていた
 * (`binder.ts` の `db-check` の 1 か所)。⚠ つまり壊れた日には気づけず、
 * **書けなくなって初めて**分かる(= 手遅れ)。
 *
 * ## ここで決めること(⚠ pure module ── 時計もブラウザも読まない)
 *
 * 1. **いま検めるべきか**(`shouldStartupCheck`)── 前回から `INTEGRITY_CHECK_INTERVAL_DAYS`
 *    以上経っていれば検める。**1 度も検めていないなら必ず検める**
 *    (`lastCheckedAt === null`)。⚠ 起動直後の 1 回目を飛ばすと、いちばん危ない瞬間
 *    (壊れた DB を開いた直後)を見逃す ── `write-quota.ts` の `shouldRecheck` と同じ向き。
 * 2. **表ごとの結果を 1 つに畳む**(`mergeQuickCheckRows`)── 検めは**表ごとに 1 request**
 *    で回す(下の「なぜ表ごとか」)ので、`ok` が表の数だけ返る。
 *    `parseQuickCheck` は「**`ok` の 1 行だけ**」を健全と読むので、ここで畳んでから渡す。
 * 3. **見つけたときの字**(`startupIntegrityNotice`)── 押していない人にも出るので、
 *    **何が起きたか**を先に言う。次の一手は `integritySummary` が持っている
 *    (⚠ 字を 2 か所に書かない ── ボタン名の門は `db-rescue.test.ts` に在る)。
 *
 * ## なぜ表ごとか(= 「途中で止められる」の実体)
 *
 * worker は**単一 queue** で、`PRAGMA quick_check` は同期に走る ── 丸ごと 1 回で
 * 回すと、数 GB では**分の単位**で保存が待たされる(`storage-worker.ts` の
 * `checkIntegrity` の註記)。🔑 `quick_check(<表>)` は**その表と索引だけ**を見るので
 * (sqlite 3.53 で実測。壊した索引を `quick_check("entries")` が名指しした)、
 * 表ごとに 1 request にすれば **表と表の間に保存が割り込める**。
 * 止めるのも同じ所 ── 次の request を出さなければ止まる。
 *
 * ⚠ 表ごとの検めは、丸ごとの `quick_check` が最後に見る **freelist / page count の
 *   整合**を見ない。それは「壊れが広がる」向きの壊れではなく、書き込みが失敗する
 *   向きでもないので、ここでは**軽さを取る**(押した検めは丸ごとのまま)。
 *
 * ## ⚠ 見つけても書き込みは止めない
 *
 * 押した検め(`db-check`)も止めていない。止める門は**書き込みが実際に壊れに当たった
 * とき**(`storage-worker.ts` の `dbCorrupt`)の 1 か所である ── ここで 2 か所目を
 * 作ると「同じ問いに答える口が 2 つ」になる(CLAUDE.md §7)。
 * 🔑 ここがやるのは**早く知らせる**ことだけ。
 */
import { type IntegrityReport, integritySummary } from './db-rescue';

/**
 * 検める間隔(日)。
 *
 * ⚠ 値の根拠:表ごとの `quick_check` は数百 MB で秒の単位(実測は node で
 *   20 万行 23ms)。毎回でも軽いが、**起動のたびに全部読む**のは端末の電池と
 *   OPFS の読み出しを食うので、週に 1 度で「壊れてから気づくまで」を
 *   **最長 7 日**に抑える(いままでは**無期限**だった)。
 * 🔑 数で持つ ── 散文の規律にしない(test が pin する)。
 */
export const INTEGRITY_CHECK_INTERVAL_DAYS = 7;
export const INTEGRITY_CHECK_INTERVAL_MS = INTEGRITY_CHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

/**
 * boot の刻印から検め始めるまでの間。
 *
 * ⚠ **起動を遅くしない**のがこの段の条件 ── 刻印の直後は worker がまだ一覧や
 *   本文を読んでいるので、そこへ `quick_check` を割り込ませると**画面が出るのが遅れる**。
 */
export const INTEGRITY_START_DELAY_MS = 5_000;

/** `settings` 表に置く印の置き場。⚠ scope は cid ではない ── 検めるのは DB 全体である。 */
export const INTEGRITY_STAMP_SCOPE = '__integrity__';
export const INTEGRITY_STAMP_KEY = 'checked_at';

/**
 * 起動の検めが、どう終わったか。
 *
 * - `skipped`   前回から間隔が空いていない(検めていない)
 * - `ok`        検めて、壊れは見つからなかった(印を更新した)
 * - `broken`    検めて、壊れが見つかった(⚠ 印は更新しない ── 次の起動でも言う)
 * - `cancelled` 途中で止めた(タブが隠れた / 閉じた)
 * - `failed`    検めそのものが通らなかった(worker が交代した など)
 * - `follower`  本体タブではないので検めない(検めは本体が 1 度やれば足りる)
 */
export type StartupIntegrityOutcome =
  | 'skipped'
  | 'ok'
  | 'broken'
  | 'cancelled'
  | 'failed'
  | 'follower';

/**
 * いま検めるべきか。
 *
 * ⚠ 印が読めない形(壊れた字 / 未来の時刻)なら**検める側へ倒す** ──
 *   門の目的は「壊れに気づくこと」であって、印を守ることではない。
 */
export function shouldStartupCheck(input: {
  readonly lastCheckedAt: string | null;
  readonly now: number;
}): boolean {
  if (input.lastCheckedAt === null) return true;
  const at = Date.parse(input.lastCheckedAt);
  if (Number.isNaN(at)) return true;
  if (at > input.now) return true;
  return input.now - at >= INTEGRITY_CHECK_INTERVAL_MS;
}

/**
 * 表ごとの `quick_check` の行を、`parseQuickCheck` へ渡せる 1 つの列に畳む。
 *
 * ⚠ 健全な表は **`ok` の 1 行**を返す(実測)。それを表の数だけ並べたまま渡すと
 *   `parseQuickCheck` は「`ok` の 1 行だけではない」= 壊れと読む。
 * 🔑 `ok` だけの行を落とし、**何も残らなければ `['ok']`**。
 * ⚠ 説明文の中の `ok` は落とさない(等値で見る ── `includes` にしない)。
 */
export function mergeQuickCheckRows(perTable: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const rows of perTable) for (const r of rows) if (r.trim() !== 'ok') out.push(r);
  return out.length === 0 ? ['ok'] : out;
}

/**
 * 見つけたときに、赤い帯へ出す字。
 *
 * ⚠ 押していない人に出るので、**まず何が起きたか**を言う ── 「壊れていたのは目次だけ
 *   です」だけが突然出ると、何を調べたのか分からない。
 * 🔑 次の一手は `integritySummary` から**そのまま**引く(ボタン名を 2 か所に書かない)。
 * ⚠ 健全なときは呼ばない(出す字が無い)── 呼んだら**それは呼び側の誤り**なので落とす。
 */
export function startupIntegrityNotice(report: IntegrityReport): string {
  if (report.ok) throw new Error('問題が無いのに、問題ありの字を組もうとした');
  return `起動のときに保存されている中身を自動で調べたところ、読めない所が見つかりました。${integritySummary(report)}`;
}
