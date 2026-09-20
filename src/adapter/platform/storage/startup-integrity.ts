/**
 * 🔴 **起動のたびに、軽く検める ── 駆動部**(#1007 段①)。
 *
 * 判断(間隔 / 畳み方 / 字)は `features/storage/integrity-schedule.ts` に在る。
 * ここは **worker へ 1 表ずつ頼んで、間に保存を通し、止められる**ようにするだけ。
 *
 * ## 順番
 *
 * 1. boot の刻印から `INTEGRITY_START_DELAY_MS` 待つ(起動を遅くしない)
 * 2. `integrityPlan` ── 前回の印と、検める表の一覧
 * 3. 間隔が空いていなければ `skipped`
 * 4. 表ごとに `checkIntegrity({ table })` ── ⚠ **1 表 1 request**。worker は単一 queue
 *    なので、request の間に保存が割り込める。`cancelled()` が真なら次を出さない
 * 5. 畳んで読む ── 壊れが無ければ **印を残して `ok`**。在れば **印を残さず**
 *    `onBroken(字)` で `broken`(次の起動でも言う ── 直すまで黙らない)
 *
 * ## ⚠ 検めそのものが通らなかったとき
 *
 * worker が交代した(作り直し #1006)/ タブが閉じた、で request が落ちることがある。
 * 🔑 **壊れの綴り**(`looksCorrupt`)なら `onBroken` へ ── schema すら読めないほど
 *   壊れているのは、いちばん言うべき壊れである。それ以外は `failed` で**黙る**
 *   (押していない人に「調べられませんでした」を出しても、できることが無い)。
 *
 * ## ⚠ 本体タブだけ
 *
 * follower(別タブ)は本体経由で worker を叩くので、両方が回すと**同じ DB を 2 回
 * 読む**。本体が 1 度やれば足りる ── `isHost()` が偽なら `follower`。
 */
import type { ResultMap, StorageRequest } from './protocol';
import { looksCorrupt } from '@features/storage/db-corruption';
import { parseQuickCheck } from '@features/storage/db-rescue';
import {
  INTEGRITY_START_DELAY_MS,
  mergeQuickCheckRows,
  shouldStartupCheck,
  startupIntegrityNotice,
  type StartupIntegrityOutcome,
} from '@features/storage/integrity-schedule';

type RequestFn = <Op extends StorageRequest['op']>(
  req: Extract<StorageRequest, { op: Op }>,
) => Promise<ResultMap[Op]>;

export interface StartupIntegrityDeps {
  /** worker への口(本体タブは `StoreClient`)。 */
  readonly request: RequestFn;
  /** このタブが本体か。⚠ **呼ぶたびに読む**(昇格で変わる)。 */
  readonly isHost: () => boolean;
  readonly now: () => number;
  /** 待つ(⚠ test は 0 で差す)。 */
  readonly wait: (ms: number) => Promise<void>;
  /** 途中で止めるか ── 表と表の間で読む。 */
  readonly cancelled: () => boolean;
  /** 壊れが見つかったときに出す(赤い帯)。 */
  readonly onBroken: (text: string) => void;
}

export async function runStartupIntegrity(
  deps: StartupIntegrityDeps,
): Promise<StartupIntegrityOutcome> {
  if (!deps.isHost()) return 'follower';
  await deps.wait(INTEGRITY_START_DELAY_MS);
  if (deps.cancelled()) return 'cancelled';
  try {
    const plan = await deps.request({ op: 'integrityPlan' });
    if (!shouldStartupCheck({ lastCheckedAt: plan.lastCheckedAt, now: deps.now() })) {
      return 'skipped';
    }
    const perTable: string[][] = [];
    let schema: ResultMap['checkIntegrity']['schema'] = [];
    for (const table of plan.tables) {
      // 🔑 止めるのはここ ── 出した request は最後まで走るが、次を出さない
      if (deps.cancelled()) return 'cancelled';
      const res = await deps.request({ op: 'checkIntegrity', table });
      perTable.push(res.rows);
      schema = res.schema;
    }
    const report = parseQuickCheck(mergeQuickCheckRows(perTable), schema);
    if (report.ok) {
      // ⚠ 印は**全部の表を見終えてから**(途中で止めた回に印を残すと、次も飛ばす)
      await deps.request({ op: 'integrityStamp', at: new Date(deps.now()).toISOString() });
      return 'ok';
    }
    deps.onBroken(startupIntegrityNotice(report));
    return 'broken';
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    if (looksCorrupt(raw)) {
      // 🔑 worker が既に `corruptReport` の字(次の一手つき)にしている ── そのまま出す
      deps.onBroken(raw);
      return 'broken';
    }
    return 'failed';
  }
}
