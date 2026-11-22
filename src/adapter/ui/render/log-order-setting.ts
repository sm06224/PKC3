/**
 * 🔴 **ログを新しい順に並べるか**の保存(#2018 1。user 裁定 2026-11-22「降順の記憶は端末の設定 1 つ」)。
 *
 * ⚠ **既定は古い順**(いまの見え方)── 何も選んでいない人の画面は変えない。
 * ⚠ **flag ではない**(正規設定)。**container に入れない**(ノートのデータではなく、この端末の読み方の好み)。
 * ⚠ 並べ替えるのは**読む面の見た目だけ**で、本文の原文は 1 バイトも変えない(`render/log-days.ts` の `applyLogOrder`)。
 * 🔴 `?.` で読まない ── `storage` が `null` のとき `?.` は例外を投げず `undefined` を返すので、
 *   `catch` の控えへ 1 度も入らない(CLAUDE.md §7。`tests/adapter/store-fallback.test.ts` が見張る)。
 */

/** 並び。`asc` = 古い順(既定)/ `desc` = 新しい順。 */
export type LogOrder = 'asc' | 'desc';

const KEY = 'pkc3.log-order';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

export class LogOrderStore {
  /** 保存が読めない環境の控え(この session では効いている)。既定は古い順。 */
  private fallback: LogOrder = 'asc';

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(別のタブの変更に追随する。他の設定と同じ理由)。 */
  order(): LogOrder {
    // 🔴 保存が無い環境では控えを読む(`?.` では `catch` に入らない)
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(KEY) === 'desc' ? 'desc' : 'asc';
    } catch {
      return this.fallback;
    }
  }

  setOrder(order: LogOrder): void {
    this.fallback = order;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, order);
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(ログの並べ替えボタンと設定画面が同じ 1 つを読み書きする)。 */
export const appLogOrder = new LogOrderStore();
