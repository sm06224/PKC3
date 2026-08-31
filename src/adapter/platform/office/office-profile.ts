/**
 * 🔴 **Office 側の設定を初期状態に戻す口**(#634)。
 *
 * LO が持つ設定(ツールバーの形・UI 言語・最近使った文書…)は
 * `registrymodifications.xcu` 1 file にまとまり、`public/office/host.html` が
 * localStorage の `pkc3-office-profile` へ退避して次の起動で書き戻す(#159)。
 *
 * ⚠ **戻す口が 1 つも無かった。** 2026-08-30 の user 報告
 * 「リボン UI がオンで開くとクラッシュしました」で分かった形はこうである ──
 * ① LO の中で設定を変える ② その設定で LO が落ちる ③ 落ちる前に退避されている
 * ④ 次に開くと書き戻されて**また落ちる**。⚠ `remove()`(一式の削除)は
 * IndexedDB しか消さない(`office-pack-store.ts:211`)ので、
 * **入れ直しても直らない** ── 出られない。
 *
 * 🔑 だから消す口を作る。⚠ 消すのは**この 1 鍵だけ**(ノートも一式も触らない)。
 */

/** ⚠ 綴りの正本。`public/office/host.html` の `PROFILE_KEY` と**同じ**でなければ
 *  ならず、`tests/adapter/office-profile.test.ts` が両者を突き合わせて pin する
 *  ── 片方だけ変えると「消したのに戻ってくる」形で静かに壊れる。 */
import { OFFICE_CHANNEL } from './office-window';

export const OFFICE_PROFILE_KEY = 'pkc3-office-profile';

/** ⚠ `Storage` そのものを取らない(test から差せる最小の面だけ受ける)。 */
export interface ProfileStore {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** 退避されている設定の大きさ(バイト数の目安)。0 なら**まだ何も無い**。 */
export function officeProfileBytes(store: ProfileStore): number {
  try {
    return (store.getItem(OFFICE_PROFILE_KEY) ?? '').length;
  } catch {
    // ⚠ private mode などで読めないことがある ── 「無い」と同じ扱いにする
    return 0;
  }
}

export interface ResetResult {
  /** 実際に消したか(元から空なら `false`)。 */
  readonly removed: boolean;
  /** user に出す 1 行。⚠ **押して無反応を作らない**ので、消せなくても必ず言う。 */
  readonly message: string;
}

/**
 * 設定を消す。
 *
 * ⚠ **開いている Office の窓にも伝える**(`announce`)── 伝えないと、その窓は
 * 閉じるとき(`pagehide`)に手元の設定を**書き戻す**ので、消したそばから復活する。
 * 🔑 これは「消す」と「消えたままにする」が別物だという話で、
 *    片方だけ実装すると **user から見て何も起きない**。
 * ⚠ ただし**その窓を開き直させはしない** ── 生きている窓は書きかけを抱えている
 *    かもしれない。窓側は退避を止めて「開き直す」を出すだけにする(host.html)。
 */
export function resetOfficeProfile(store: ProfileStore, announce?: () => void): ResetResult {
  const had = officeProfileBytes(store) > 0;
  try {
    store.removeItem(OFFICE_PROFILE_KEY);
  } catch {
    return { removed: false, message: 'Office の設定を消せませんでした(この端末では保存領域を触れません)。' };
  }
  if (announce) {
    try {
      announce();
    } catch {
      // ⚠ 伝えられなくても消えてはいる ── 消したことは言う
    }
  }
  return had
    ? {
        removed: true,
        message: 'Office の設定を初期状態に戻しました。次に Office を開いたときから素の状態で始まります。',
      }
    : { removed: false, message: 'Office の設定はまだ保存されていません(すでに初期状態です)。' };
}

/**
 * 開いている Office の窓へ「その設定はもう捨てた」と伝える。
 *
 * ⚠ 放送の名前は **`office-window.ts` の 1 つ**を使う(綴りを 2 か所に持たない ──
 * 2026-08-25 に、両端が別々の綴りを持って**両方緑のまま届かない**形を踏んでいる)。
 * ⚠ 窓を**閉じさせはしない** ── 受け側は退避を止めて帯を出すだけ(host.html)。
 */
export function announceOfficeProfileReset(): void {
  const ch = new BroadcastChannel(OFFICE_CHANNEL);
  try {
    ch.postMessage({ pkc3Office: 'reset-profile', payload: {} });
  } finally {
    // ⚠ 使い終わったら閉じる(2026-07-27 の「生成物はライフサイクル終端で破棄」)
    ch.close();
  }
}
