/**
 * ノートの色ラベルの手元(#1982 段 4)。**開いているコレクションの分だけ**をメモリに持つ(`note-pin-store.ts` と同じ作法)。
 *
 * 🔴 正本は storage(`settings` 表 ── `listNoteLabels` / `putNoteLabel`)。ここは描画が毎回 storage を読まないための**写し**と書込の配線。
 * - 付け外しはまず写しを動かして描き直し、書込は `attach` された書き手へ頼む。書込に失敗したら正本を読み直す(`onFail`)。
 * - 🔴 書込は**直列**(速く 2 回押しても追い越さない)。
 */
import { isNoteLabelColor, setLabel, type NoteLabelEntry } from '@features/note-label';

export type NoteLabelWriter = (lid: string, color: number | null) => Promise<void>;

export class NoteLabelStore {
  private map: ReadonlyMap<string, number> = new Map();
  private readonly listeners = new Set<() => void>();
  private writer: NoteLabelWriter | null = null;
  private onFail: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly writtenListeners = new Set<() => void>();

  /** lid → 色の番号。 */
  all(): ReadonlyMap<string, number> {
    return this.map;
  }

  get(lid: string): number | null {
    return this.map.get(lid) ?? null;
  }

  attach(writer: NoteLabelWriter, onFail: () => void): void {
    this.writer = writer;
    this.onFail = onFail;
  }

  /** 正本から読んだ内容を写す(起動 / 他タブの書込)。変わったときだけ知らせる。 */
  setAll(entries: readonly NoteLabelEntry[]): void {
    const next = new Map<string, number>();
    for (const e of entries) if (isNoteLabelColor(e.color)) next.set(e.lid, e.color);
    if (next.size === this.map.size && [...next].every(([k, v]) => this.map.get(k) === v)) return;
    this.map = next;
    this.emit();
    // 🔴 正本を読み直して変わった(取り込み・取り消し・他タブの書込)も「書込が済んだ」として知らせる
    this.notifyWritten();
  }

  private notifyWritten(): void {
    for (const cb of [...this.writtenListeners]) cb();
  }

  /**
   * 🔴 **正本への書込が終わった**ときに呼ぶ(`onChange` は写しを動かした時点)。
   * ⚠ storage を読み直す側(色で絞るスマートフォルダの集め直し)は、書込を追い越さないようこちらを使う。
   */
  onWritten(cb: () => void): () => void {
    this.writtenListeners.add(cb);
    return () => void this.writtenListeners.delete(cb);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** 付ける / 外す(`color: null`)。複数ノートへ同じ色もこれで(呼び側が回す)。 */
  set(lid: string, color: number | null): void {
    if (color !== null && !isNoteLabelColor(color)) return;
    const next = setLabel(this.map, lid, color);
    const changed = next.get(lid) !== this.map.get(lid);
    this.map = next;
    if (changed) this.emit();
    const writer = this.writer;
    if (writer !== null && changed) {
      this.chain = this.chain
        .then(() => writer(lid, color))
        .catch(() => {
          this.onFail?.();
        })
        .then(() => this.notifyWritten());
    }
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

/** アプリ全体で 1 個。 */
export const appNoteLabels = new NoteLabelStore();
