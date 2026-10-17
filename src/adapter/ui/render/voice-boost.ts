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

import {
  MODE_ANY,
  VoiceBoostRouter,
  webAudioHost,
  type BoostMode,
} from '@adapter/platform/audio/voice-boost';

const KEY = 'pkc3.voice-boost';
/** 🔴 「音量をそろえる」(#952 B2)。⚠ 「音を聞きやすくする」とは**独立**に切り替える。 */
export const LEVEL_KEY = 'pkc3.voice-level';
/** 🔴 「頭の中で鳴る感じを和らげる」(#952 B3)。⚠ 同じく独立。 */
export const CROSSFEED_KEY = 'pkc3.voice-crossfeed';

type Backing = Pick<Storage, 'getItem' | 'setItem'>;

function readStorage(): Backing | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 入 / 切を 1 つ持つ。⚠ 保存が読めない環境の控え・書込失敗の扱いは 3 つとも同じ。 */
class OnOffCell {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = false;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Backing | null,
    private readonly key: string,
  ) {}

  /** ⚠ **読むたびに保存を見る**(`AlarmEnabledStore` と同じ理由 ── 書き手が複数)。 */
  get(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(#278 段② の test が教えた)
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(this.key) === '1';
    } catch {
      return this.fallback;
    }
  }

  set(on: boolean): void {
    this.fallback = on;
    this.saveFailed = false;
    try {
      this.storage?.setItem(this.key, on ? '1' : '0');
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

export class VoiceBoostStore {
  private readonly voice: OnOffCell;
  private readonly level: OnOffCell;
  private readonly cross: OnOffCell;

  constructor(storage: Backing | null = readStorage()) {
    this.voice = new OnOffCell(storage, KEY);
    this.level = new OnOffCell(storage, LEVEL_KEY);
    this.cross = new OnOffCell(storage, CROSSFEED_KEY);
  }

  /** 「音を聞きやすくする」。 */
  enabled(): boolean {
    return this.voice.get();
  }

  setEnabled(on: boolean): void {
    this.voice.set(on);
  }

  /** 「音量をそろえる」(#952 B2)。 */
  levelEnabled(): boolean {
    return this.level.get();
  }

  setLevelEnabled(on: boolean): void {
    this.level.set(on);
  }

  /** 「頭の中で鳴る感じを和らげる」(#952 B3)。 */
  crossfeedEnabled(): boolean {
    return this.cross.get();
  }

  setCrossfeedEnabled(on: boolean): void {
    this.cross.set(on);
  }

  /** 🔑 鎖の組み方(3 つの切り替えをそのまま映す)。 */
  mode(): BoostMode {
    return {
      voice: this.voice.get(),
      level: this.level.get(),
      crossfeed: this.cross.get(),
    };
  }

  /** どれか 1 つでも入っていれば、鎖を通す。 */
  anyEnabled(): boolean {
    return MODE_ANY(this.mode());
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appVoiceBoost = new VoiceBoostStore();

/**
 * アプリ共有の繋ぎ替え役。⚠ **器(`AudioContext`)はここでは作らない** ──
 * 入にした user が初めて再生機に出会ったときに、はじめて 1 つ作られる。
 */
export const appVoiceBoostRouter = new VoiceBoostRouter(
  webAudioHost,
  () => appVoiceBoost.anyEnabled(),
  () => appVoiceBoost.mode(),
);
