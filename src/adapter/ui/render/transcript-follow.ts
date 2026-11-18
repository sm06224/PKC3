/**
 * 🔴 **再生に合わせて文字起こしを送るか**(#1966 4-3 ①。user 裁定 2026-11-17「文字起こしの追従スクロール(入/切付き)」)。
 *
 * - `pkc3.transcript-follow` … `'1'` = 送る(既定)/ `'0'` = 送らない
 *
 * ⚠ **既定は入**(頼まれた機能そのもの ── 鳴っている行が画面の外へ流れていくのを追わなくて済む)。
 *   ⚠ 行が見えている間は動かさない(`block: 'nearest'`)ので、読んでいる所を勝手に動かすのは
 *   「鳴っている行が画面の外に出たとき」だけである。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の聞き方の好み(`phone-links.ts` と同じ扱い)。
 * ⚠ 読むたびに保存を見る(別のウィンドウでも同じ好みを読む)。
 */

export const TRANSCRIPT_FOLLOW_KEY = 'pkc3.transcript-follow';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class TranscriptFollowStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = true;
  /** 🔴 直近の書き込みが失敗したか。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage()) {}

  enabled(): boolean {
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(TRANSCRIPT_FOLLOW_KEY) !== '0';
    } catch {
      return this.fallback;
    }
  }

  set(on: boolean): void {
    this.fallback = on;
    this.saveFailed = false;
    try {
      this.storage?.setItem(TRANSCRIPT_FOLLOW_KEY, on ? '1' : '0');
    } catch {
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appTranscriptFollow = new TranscriptFollowStore();
