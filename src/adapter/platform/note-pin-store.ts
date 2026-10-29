/**
 * ノートのピン留めの手元(#1377)。**開いているコレクションの分だけ**をメモリに持つ。
 *
 * 🔴 **正本は storage(コレクションの `settings` 表 ── `listNotePins` / `putNotePin`)**。端末の記憶(localStorage)ではない
 * ので、バックアップに入り、別の端末にも運ばれる(タグの色と同じ ── `main.ts` が起動と他タブの書込で `setAll` する)。
 * ここが持つのは、状態が動くたびに描く帯が毎回 storage を読まないための**写し**と、書込の配線だけ。
 *
 * - 付け外しはまず写しを動かして描き直し(押した手応え)、書込は `attach` された書き手へ頼む。
 *   ⚠ 書込に失敗したら、写しを**書き手が返した正本へ戻す**(`onFail`)── 画面だけ留まって保存されていない、を残さない。
 * - 🔴 書込は**直列**(前の書込が終わってから次)── 速く 2 回押しても追い越さない(§7 の世代管理)。
 */
import { togglePin } from '@features/relation/note-pins';

/** 書き手。`prune` = 同じ tx で掃除する、消えたノートの lid。 */
export type NotePinWriter = (lid: string, on: boolean, prune: string[]) => Promise<void>;

export class NotePinStore {
  private items: string[] = [];
  private readonly listeners = new Set<() => void>();
  private writer: NotePinWriter | null = null;
  private onFail: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  /** 留めた順(消えたノートの分を、掃除されるまで含む)。 */
  list(): readonly string[] {
    return this.items;
  }

  has(lid: string): boolean {
    return this.items.includes(lid);
  }

  /** 書込の配線(`main.ts` が storage へつなぐ)。`onFail` = 書けなかったとき正本を読み直す口。 */
  attach(writer: NotePinWriter, onFail: () => void): void {
    this.writer = writer;
    this.onFail = onFail;
  }

  /** 正本から読んだ並びを写す(起動 / 他タブの書込)。変わったときだけ知らせる。 */
  setAll(lids: readonly string[]): void {
    if (JSON.stringify(lids) === JSON.stringify(this.items)) return;
    this.items = [...lids];
    this.emit();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /**
   * ピン留めする / 外す(掃除つき)。
   * @returns 満杯で断ったら `false`
   */
  toggle(lid: string, exists: (lid: string) => boolean): boolean {
    const was = this.items.includes(lid);
    const r = togglePin(this.items, lid, exists);
    if (r.refused) return false;
    const changed = JSON.stringify(r.list) !== JSON.stringify(this.items);
    this.items = r.list;
    if (changed) this.emit();
    const writer = this.writer;
    if (writer !== null) {
      const on = !was;
      this.chain = this.chain
        .then(() => writer(lid, on, r.prune))
        .catch(() => {
          this.onFail?.();
        });
    }
    return true;
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

/** アプリ全体で 1 個。 */
export const appNotePins = new NotePinStore();
