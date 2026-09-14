/**
 * 🔴 **聞くときだけ音を整えるか**(#772 段① B)。
 *
 * ## ⚠ なぜ「録るとき」ではなく「聞くとき」なのか
 *
 * user 要望 #772 は「音声明瞭化」だが、**掛け方が 2 通り**ある:
 *
 * | | 何が起きるか |
 * |---|---|
 * | 録るときに掛ける | 整えた音**だけ**が残る ── 🔴 **元の音は二度と戻らない(不可逆)** |
 * | **聞くときに掛ける**(ここ) | 残るのは元の音のまま。**再生のときだけ**整う ── いつでも切れる |
 *
 * 🔑 **不可逆なほうは user の裁定が要る**(CLAUDE.md「委任の外:不可逆・外向き」)ので、
 *   この store が受け持つのは**戻せるほう**だけである。
 *
 * ## ⚠ 既定は「切」
 *
 * ① 整えると**音が変わる** ── 頼んでいないのに変わるのは、それ自体が驚きである
 * ② 🔴 **入にすると `AudioContext` が 1 つ常駐する**(音を通すので、途中で捨てられない)。
 *    ⚠ 入にした人だけが払う形にする(`alarm-enabled.ts` と同じ考え方)
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の聞き方である。
 */

import { VoiceBoostRouter, webAudioHost } from '@adapter/platform/audio/voice-boost';

const KEY = 'pkc3.voice-boost';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class VoiceBoostStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(`AlarmEnabledStore` と同じ理由 ── 書き手が複数)。 */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(#278 段② の test が教えた)
    if (this.storage === null) return this.fallback;
    try {
      return this.storage.getItem(KEY) === '1';
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
export const appVoiceBoost = new VoiceBoostStore();

/**
 * アプリ共有の繋ぎ替え役。⚠ **器(`AudioContext`)はここでは作らない** ──
 * 入にした user が初めて再生機に出会ったときに、はじめて 1 つ作られる。
 */
export const appVoiceBoostRouter = new VoiceBoostRouter(webAudioHost, () =>
  appVoiceBoost.enabled(),
);
