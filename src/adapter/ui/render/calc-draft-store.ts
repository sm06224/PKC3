/**
 * 計算スクラッチパッドの打ちかけを覚える(#1230。「入力中のテキストは自動一時保存され、ウィンドウを閉じても
 * 前回の計算状態から再開できる」)。
 *
 * ⚠ **container に入れない** ── 打ちかけの計算は作業の都合であって、ノートのデータではない
 * (ノートにするのは user が「ノートにする」を押したとき)。`pkc3.query-key` と同じ分け方。
 * ⚠ **設定ファイルに載せない**(`settings-file.ts` の「運ばない鍵」)── 金額など、端末の外へ出したくない字が入りうる。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 「覚えていない」に落ちる。
 */

export const CALC_DRAFT_STORAGE_KEY = 'pkc3.calc-draft';
const KEY = CALC_DRAFT_STORAGE_KEY;

/** 覚える字数の上限。⚠ 手違い(壊れた保存・巨大な貼り付け)の検出で、超えた分は覚えない。 */
export const CALC_DRAFT_MAX_CHARS = 100_000;

function readStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class CalcDraftStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: string | null = null;
  /** 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = readStorage(),
  ) {}

  /** 前回の字。無ければ空文字。 */
  get(): string {
    try {
      if (this.storage === null || this.saveFailed) return this.fallback ?? '';
      const raw = this.storage.getItem(KEY);
      return raw === null || raw.length > CALC_DRAFT_MAX_CHARS ? '' : raw;
    } catch {
      return this.fallback ?? '';
    }
  }

  /**
   * ⚠ 空文字は**消す**(空という選択を書き残さない)。上限を超える字は覚えない(控えも作らない)。
   * @returns `saved` = 覚えた(空は消した) / `too-long` = 上限を超えたので覚えていない(前に覚えた内容のまま) /
   *   `failed` = 書けなかった(容量不足など。この session の間だけ控えで効く)
   */
  set(text: string): 'saved' | 'too-long' | 'failed' {
    if (text.length > CALC_DRAFT_MAX_CHARS) return 'too-long';
    this.fallback = text === '' ? null : text;
    this.saveFailed = false;
    try {
      if (this.fallback === null) this.storage?.removeItem(KEY);
      else this.storage?.setItem(KEY, this.fallback);
      return 'saved';
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
      return 'failed';
    }
  }
}

export const appCalcDraft = new CalcDraftStore();
