/**
 * 🔴 **可搬単一 HTML の保存**(#400 段③)── 束ねて遅らせ、閉じる前に必ず流す。
 *
 * `file://` では OPFS が取れないので、DB は `:memory:` にしか置けない。
 * 永続は「**DB 画像を丸ごと器へ書く**」── 実測(設計 doc §3)で
 * **33MB の DB は 1 保存あたり約 1 秒**、しかも画像の割当は
 * **wasm heap に残って縮まない**。だから 1 編集ごとには書かない。
 *
 * ## 🔑 この層が守る 3 つ
 *
 * 1. **落とさない** ── 保存中に来た編集は、その保存の直後にもう 1 回走る
 *    (`dirty` を while で汲み直す)。⚠ 「保存中だから今回は飛ばす」は
 *    **最後の編集だけが永久に消える**形になる
 * 2. **重ねない** ── 画像を出す処理を 2 本同時に走らせない(heap のピークが 2 倍)
 * 3. **閉じる前に流す** ── `visibilitychange`(hidden)と `pagehide` の両方。
 *    ⚠ `beforeunload` だけに頼らない(モバイルでは飛ばないことがある)
 *
 * ## ⚠ 器へ書くのは `Uint8Array` である
 *
 * `Blob` は発行した realm が生きている間しか換金できない借用証書で、
 * **閉じる直前に書くとまさにそこで落ちる**(`asset-blob-store.ts` の実測)。
 * ここは可搬バンドルの「閉じる直前の保存」そのものなので、`Blob` にしてはならない。
 */
import { errorText } from '@features/error-text';

/** 保存の見え方。⚠ **失敗だけは必ず user に出す**(黙ると編集が消える)。 */
export type PersistState =
  | { kind: 'idle' }
  /** 溜まっているが、まだ書いていない。 */
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'error'; why: string };

export interface PortablePersistDeps {
  /** いまの DB を画像にする(worker の `exportImage`)。 */
  exportImage: () => Promise<Uint8Array>;
  /** 器へ書く。⚠ commit まで待つこと。 */
  write: (rec: { savedAt: number; image: Uint8Array }) => Promise<void>;
  onState: (s: PersistState) => void;
  /**
   * 🔴 **「まだ器に着いていない分が在る」かどうかが変わった**(`unsaved()` の変化)。
   * ⚠ `pending` / `saving` の表示とは別物 ── 表示は遅らせてよいが、**離れる確認はこちらで出す**
   *   (1.2 秒の待ちも、画像を書き出している最中も、器には着いていない)。
   */
  onUnsaved?: (unsaved: boolean) => void;
  /**
   * 🔴 **画像の保存の外で「まだ着いていない」もの**(日誌に控え中の書込 op など)が在るか。
   * 真の間は `unsaved()` も真。⚠ 変わったら `recheck()` を呼ぶ。
   */
  busy?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface PortablePersist {
  /** 書込があった。⚠ **op ごとに 1 回**呼ぶ(まとめて 1 回に潰さない)。 */
  touch(): void;
  /** 溜まっているものを全部書き切る。⚠ 飛んでいる保存も待つ。 */
  flush(): Promise<void>;
  /**
   * 🔴 **器に着いていない分が在るか**(溜まっている / 書いている最中 / 失敗して溜めたまま)。
   * ⚠ 「溜まっている」だけを見ると、画像を書き出している最中に閉じたとき確認が消える。
   */
  unsaved(): boolean;
  /** `busy` が変わったとき、離れる確認の判定を取り直す。 */
  recheck(): void;
  /** いまの見え方(test の観測点 ── `onState` を数えるだけだと順番が見えない)。 */
  state(): PersistState;
  dispose(): void;
}

/** 打鍵が止まってから書くまで。 */
export const IDLE_MS = 1_200;
/**
 * 🔴 **打ち続けている間も、これを超えたら書く。**
 * ⚠ 遅延だけだと「1 時間書き続けたら 1 度も保存されていない」が成立する。
 */
export const MAX_WAIT_MS = 15_000;
/**
 * 「⏳ 保存待ち」を出し始めるまで。
 * 🔴 **0 = 溜まった瞬間から出す。** 以前は 3 秒だったが、器に着かない窓は
 *   `IDLE_MS`(1.2 秒)+ 画像の書き出し・書込(DB が大きいほど長い)で、**3 秒より短い窓の間は
 *   一度も出なかった**(#1589: 追加直後に読み直すとノートが消えるのに、何も出ていなかった)。
 * ⚠ ちらつき対策の遅延は、窓の間に何も出ない代償に見合わない。同じ状態では塗り直さない
 *   (`setState`)ので、打鍵のたびに DOM は書き換えない。
 */
export const PENDING_NOTICE_MS = 0;

/**
 * 状態行に出す字(`main.ts` はこれを繋ぐだけ ── どの test からも実行されないため、判断はここに置く)。
 * ⚠ 画像を書き出している最中(`saving`)も、器にはまだ着いていない ── 出し続ける(#1589)。
 */
export function persistStatusText(st: PersistState): string {
  if (st.kind === 'error') return `⚠ この端末に保存できませんでした(${st.why})`;
  if (st.kind === 'pending' || st.kind === 'saving') return '⏳ 保存待ち';
  return '';
}

export function connectPortablePersist(deps: PortablePersistDeps): PortablePersist {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let dirty = false;
  /** いちばん古い未保存の編集の時刻(`MAX_WAIT_MS` の基準)。 */
  let dirtySince = 0;
  let running: Promise<void> | null = null;
  let timer: unknown = null;
  let disposed = false;
  let state: PersistState = { kind: 'idle' };
  let lastUnsaved = false;

  const isUnsaved = (): boolean => dirty || running !== null || (deps.busy?.() ?? false);
  /** ⚠ 変わったときだけ知らせる(打鍵ごとに離れる確認の登録・解除を叩かない)。 */
  const notifyUnsaved = (): void => {
    const now_ = isUnsaved();
    if (now_ === lastUnsaved) return;
    lastUnsaved = now_;
    deps.onUnsaved?.(now_);
  };

  const setState = (s: PersistState): void => {
    // ⚠ 同じ状態で塗り直さない(状態行の DOM を打鍵ごとに書き換えない)
    if (s.kind === state.kind && (s.kind !== 'error' || s.why === (state as { why?: string }).why))
      return;
    state = s;
    deps.onState(s);
  };

  const disarm = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const arm = (): void => {
    disarm();
    /**
     * ⚠ **ここで `disposed` を見ない**(変異試験 M16 / M16b が 2 度 SURVIVED で
     *   教えた)── 「畳んだ後は書かない」の門を `touch` / `arm` / `flush` /
     *   `drain` の **4 か所**に置いていたので、**どれを外しても他が救う** =
     *   1 つも効いていることを確かめられなかった(CLAUDE.md §1 の論理式版)。
     * 🔑 門は `touch` の 1 つに寄せ、`dispose` が溜まっているぶんを捨てる。
     */
    if (!dirty) return;
    const waited = now() - dirtySince;
    const delay = Math.max(0, Math.min(IDLE_MS, MAX_WAIT_MS - waited));
    /**
     * 🔴 **失敗の知らせは、器へ書けるまで消さない。** `PENDING_NOTICE_MS = 0` だと、失敗した後の
     *   次の打鍵ごとに「保存待ち」へ上書きされ、**警告が点いたり消えたりする**(失敗は続いている)。
     */
    if (waited >= PENDING_NOTICE_MS && state.kind !== 'error') setState({ kind: 'pending' });
    timer = setTimer(() => {
      timer = null;
      void flush().catch(() => undefined);
    }, delay);
  };

  /**
   * 🔴 **`dirty` を汲み切るまで回す。**
   * ⚠ 「1 回書いて終わり」にすると、画像を出している最中に来た編集が落ちる
   *    ── しかも落ちるのは**最後の 1 編集**なので、いちばん惜しい所が消える。
   */
  async function drain(): Promise<void> {
    while (dirty) {
      dirty = false;
      // ⚠ 再試行の最中も、直前の失敗の知らせを「保存中」で塗りつぶさない(書けたときに idle へ戻す)
      if (state.kind !== 'error') setState({ kind: 'saving' });
      let image: Uint8Array;
      try {
        image = await deps.exportImage();
      } catch (e) {
        dirty = true; // ⚠ 出せなかったぶんは**溜めたまま**にする(捨てない)
        setState({ kind: 'error', why: errorText(e) });
        return;
      }
      /**
       * ⚠ **空は書かない。** 器に 0 バイトの記録が残ると、次の起動が
       *   「記録がある」と読んで**配られた中身ごと空で開く**。
       * 🔑 空なのは「まだ 1 行も無い DB」なので、**保存すべきものが無い**が正しい。
       */
      if (image.byteLength === 0) {
        setState({ kind: 'idle' });
        continue;
      }
      try {
        await deps.write({ savedAt: now(), image });
      } catch (e) {
        dirty = true;
        setState({ kind: 'error', why: errorText(e) });
        return;
      }
      if (!dirty) {
        dirtySince = 0;
        setState({ kind: 'idle' });
      }
    }
  }

  async function flush(): Promise<void> {
    disarm();
    /**
     * ⚠ **飛んでいる保存を待つだけでは足りない** ── その保存の最中に来た編集は
     *   まだ書かれていない。だから「溜まっているか / 走っているか」が両方
     *   落ち着くまで回す。
     */
    while (dirty || running !== null) {
      if (running === null) {
        const p = drain().finally(() => {
          if (running === p) running = null;
          notifyUnsaved();
        });
        running = p;
      }
      await running;
      if (state.kind === 'error') return; // ⚠ 失敗を無限に叩き直さない
    }
  }

  return {
    touch(): void {
      /** 🔴 **畳んだ後は書かない、の唯一の門**(下の `dispose` と対になる)。 */
      if (disposed) return;
      if (!dirty) {
        dirty = true;
        dirtySince = now();
      }
      arm();
      notifyUnsaved();
    },
    flush,
    unsaved: isUnsaved,
    recheck: notifyUnsaved,
    state: () => state,
    dispose(): void {
      disposed = true;
      /**
       * 🔴 **溜まっているぶんを捨てる。** ⚠ 残すと、畳んだ後に誰かが `flush` を
       *   呼んだとき(閉じる合図の listener は残っている)に**書きに行く**。
       * ⚠ **飛んでいる保存は止めない** ── そちらは user のデータなので、
       *   始まっているなら書き切らせるほうが正しい。
       */
      dirty = false;
      disarm();
      notifyUnsaved();
    },
  };
}
