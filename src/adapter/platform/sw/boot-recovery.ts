/**
 * 起動に失敗したら、**待機中の新しい版へ自分で乗り換える**(#115)。
 *
 * ## 🔴 なぜ要るのか ── 自己永続化する障害を作ってしまった
 *
 * 2026-08-11 に実際に起きた形(実測で再現済み):
 *
 * | 段 | 状態 |
 * |---|---|
 * | ① | 起動を壊す SW が active になる(#112 の COEP の穴) |
 * | ② | 直した版を配る。新 SW は install されるが **waiting のまま** |
 * | ③ | 旧 SW が active なので**起動は失敗し続ける** |
 * | ④ | 交代を促す案内は**起動しないと出ない** ── 詰み |
 *
 * PKC3 は `install` で `skipWaiting()` を**わざと呼ばない**(P7 段⑤:
 * 開いたままの旧タブが旧 hash の chunk を取り零す)。その判断は正しいが、
 * **起動できないタブには当てはまらない** ── 守るべき「開いたままの作業」が
 * そもそも無いからである。
 *
 * 🔑 だから条件を 1 つだけ足す: **起動に失敗した時は、待っている版へ自分で移る。**
 *
 * ⚠ user は「タブを全部閉じて開き直す」で回復できる(waiting はそれで活性化する。
 * ⚠ **再読込では駄目** ── 制御しているタブが残っている限り交代しない)。
 * だが**それを知っていることを前提にしてはいけない**。
 *
 * ## ⚠ 交代そのものは書かない
 *
 * `SKIP_WAITING` を送って `controllerchange` を待って読み直す段取りは
 * `update-prompt.ts` に既に在る ── **2 つ目を書かない**(この repo の
 * 「規則の写しを 2 つ持たない」)。ここが決めるのは
 * **「その案内を、user に見せずに即押すか」**だけである。
 */

export type BootRecoveryOutcome =
  /** 起動できている ── 何もしない。 */
  | 'no-failure'
  /** 1 度試した ── 🔴 **これ以上は繰り返さない**。 */
  | 'gave-up'
  /** 新しい版へ移る(呼び側が `apply` を実行済み)。 */
  | 'applied';

export interface BootRecoveryDeps {
  /** 起動が失敗したか。 */
  readonly bootFailed: boolean;
  /** 既にこのセッションで 1 度乗り換えたか。 */
  readonly triedBefore: boolean;
  /**
   * 「試した」を記録する。**記録できたら true**。
   *
   * 🔴 記録できないのに乗り換えると、読み直した先でまた乗り換えを試みて
   * **無限に読み直す**。`coi-reload.ts` と同じ理由・同じ形。
   */
  readonly markTried: () => boolean;
  /** `update-prompt.ts` が渡してくる「押したことにする」関数。 */
  readonly apply: () => void;
}

/**
 * 待機中の版が在ると分かった時に呼ぶ。**押すかどうか**だけを決める。
 *
 * ⚠ 「待機中の版が在るか」はこの関数の外(`watchForUpdate`)が判定する ──
 * ここへ持ち込むと、同じ判定が 2 か所になる。
 */
export function autoApplyOnBootFailure(deps: BootRecoveryDeps): BootRecoveryOutcome {
  if (!deps.bootFailed) return 'no-failure';
  if (deps.triedBefore) return 'gave-up';
  // ⚠ **印を先に置き、置けたことを確かめてから**押す(輪を作らない)
  if (!deps.markTried()) return 'gave-up';
  deps.apply();
  return 'applied';
}

/** セッション内で「1 度乗り換えた」を覚える印。 */
export const BOOT_RECOVERY_KEY = 'pkc3:boot-recovery-tried';

export interface BootRecoveryEnvironment {
  readonly bootFailed: boolean;
  /** ⚠ 触れないことがある(storage 遮断)。 */
  readonly session: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly apply: () => void;
}

/** 環境から値を集めて上の判断へ渡す(⚠ 判断は上の関数)。 */
export function applyBootRecovery(env: BootRecoveryEnvironment): BootRecoveryOutcome {
  let tried: boolean;
  try {
    tried = env.session?.getItem(BOOT_RECOVERY_KEY) === '1';
  } catch {
    tried = true; // 覚えられない環境では乗り換えない(輪を作らない)
  }
  return autoApplyOnBootFailure({
    bootFailed: env.bootFailed,
    triedBefore: tried,
    markTried: () => {
      try {
        if (!env.session) return false;
        env.session.setItem(BOOT_RECOVERY_KEY, '1');
        return true;
      } catch {
        return false;
      }
    },
    apply: env.apply,
  });
}
