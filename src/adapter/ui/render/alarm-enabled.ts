/**
 * 🔴 **予定の時刻に知らせるか**(#280)。
 *
 * ## ⚠ なぜ既定を「切」にするか
 *
 * ① **音は割り込みである。** 頼んでいない音が鳴るのは、それだけで迷惑になりうる
 * ② 🔴 **入にすると、起動のたびに全ノートの走査が要る。** 予定の札は
 *    `taskScan` に在るが、それは **「予定」の面を 1 度でも開いた user にしか
 *    集まらない**(`app-state.ts` が「予定を使わない user に全走査を負わせない」と
 *    書いている)。⚠ その方針を、知らせのためだけに全 user へ広げない ──
 *    **入にした人だけが払う**形にする
 *
 * 🔑 だから設定画面の字は「**入れると、起動したときに予定を数えます**」まで書く
 *   ── 何を引き換えにしているかを隠さない。
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い
 * (`open-in-edit` と同じ扱い。flag の 15 枠は使わない)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の鳴らし方である。
 */

const KEY = 'pkc3.alarm';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class AlarmEnabledStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(`OpenInEditStore` と同じ理由 ── 書き手が複数)。 */
  enabled(): boolean {
    try {
      return this.storage?.getItem(KEY) === '1';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 保存できないだけ ── この session では効いている(控えが持つ)
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appAlarmEnabled = new AlarmEnabledStore();
