/**
 * **同じ面に戻ったら、同じ場所に戻る**(P8 段⑫)。
 *
 * > user 指示 2026-08-03「**サイドバーも同じ、スクロールが発生するすべての画面が
 * > 対象だよ**」
 *
 * 🔴 実測(直す前に測った)で飛んでいたのはここ:
 * ```
 * 一覧: 追記で再描画      ✓ 保つ      ← 行を再利用しているので元から平気
 * 一覧: 別の行を選ぶ      ✓ 保つ
 * 一覧: 題名を変える      ✓ 保つ
 * 一覧: 絞り込み → 戻す   ✗ 飛ぶ (250 → 0)
 * フォルダ: 絞り込み      ✗ 飛ぶ (250 → 0)
 * ```
 * 絞り込むと中身が縮んで `scrollTop` が **0 に丸められ**、戻しても 0 のまま。
 * 「同じ器を別の面(一覧 / フォルダ / アプリ)で使い回している」ぶんも同じで、
 * タブを行き来すると前の面の位置が残る。
 *
 * 🔑 だから **「面」ごとに位置を覚える**。面 = `mode` × 「絞り込み中かどうか」。
 * ⚠ 絞り込んだ結果は**先頭から**が正しい(探しているのだから)。戻したときに
 * 元の位置へ帰る、が欲しい振る舞い。
 *
 * 🔴 **順番が本体**。使い方は必ずこの 2 手:
 * ```
 * park();          // ① 中身を書き換える**前**に退避する
 * …描画…
 * use(newKey);     // ② 中身を入れ**終わってから**戻す
 * ```
 * ⚠ ① を描画の後にすると、**縮んで 0 に丸められた値**を保存してしまう
 * (実際にそれで 1 回外した)。⚠ ② を描画の前にすると、まだ `scrollHeight` が
 * 足りないので指した位置がやはり丸められる(段⑪ でも同じ罠を踏んだ)。
 */

/** 覚えておく面の数。⚠ 無制限に持つと、面が増えるたびに伸びる辞書になる。 */
const CAP = 8;

export class ScrollMemory {
  private readonly el: HTMLElement;
  private readonly seen = new Map<string, number>();
  private key: string | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** ① 中身を書き換える**前**に、いまの位置を退避する。 */
  park(): void {
    if (this.key === null) return;
    this.seen.set(this.key, this.el.scrollTop);
    if (this.seen.size > CAP) {
      const oldest = this.seen.keys().next().value; // Map は挿入順
      if (oldest !== undefined && oldest !== this.key) this.seen.delete(oldest);
    }
  }

  /**
   * ② 中身を入れ**終わってから**、その面の位置へ戻す。
   * ⚠ **鍵が同じでも戻す** ── 同じ面を描き直しただけのときこそ位置が飛ぶ
   * (ログのように 400ms ごとに作り直す面がある)。鍵が同じなら `park()` が
   * 直前に保存した値なので、戻しても何も動かない。
   */
  use(key: string): void {
    this.key = key;
    this.el.scrollTop = this.seen.get(key) ?? 0;
  }

  /** いま覚えている位置(test の観測点)。 */
  peek(key: string): number | undefined {
    return this.seen.get(key);
  }
}
