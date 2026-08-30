/**
 * 🔴 **拡張からの書き戻しを、実際に当てる**(#195 / C-5 段③)。
 *
 * 語彙と「渡した覚え」の検めは既に済んでいる(`features/extension/ext-write.ts` /
 * `adapter/platform/extension-host.ts`)。ここが持つのは**当て方**だけである。
 *
 * ## 守ること 4 つ
 *
 * 1. ⚠ **編集中は 1 バイトも書かない** ── 画面の draft を裏から潰さない
 * 2. 🔴 **書く前に全部読んで、古くないかを検める** ── 1 件でも読めなければ
 *    **全体を断る**(部分適用を作らない)
 * 3. 🔴 **履歴へ積む**(`checkpoint`)── **別のアプリが書いた本文**なので、
 *    戻せない形にしてはいけない
 * 4. ⚠ 書き終えたら**画面を取り直す** ── 外から本文が変わったのに一覧も本文も
 *    古いまま、を作らない
 *
 * ## ⚠ 「不正なら全体拒否」と「先を越された」は**別の話**である
 *
 * - **不正**(語彙 / 渡した覚え / 形)は**書く前に**全部分かるので、
 *   1 バイトも書かずに断る ── ここに来る前に済んでいる
 * - **先を越された**(別のタブが書き替えた)は**書いてみないと分からない** ──
 *   だから `expectHash` が 1 件ずつ止め、**そこまでの件数を添えて**断る
 *
 * 🔑 だから返す言葉を分ける ── 「書けません」ではなく「**N 件まで書いて止めました**」。
 *   ⚠ 件数を言わないと、拡張の作者も user も**どこまで進んだか**を知る手段が無い。
 *
 * ## 🔑 なぜ `main.ts` から取り出したか
 *
 * `main.ts` は**どの test からも実行されない**(原文を読む test しか無い)。
 * ⚠ そこに判断を書くと、取り違えが**全 test 緑のまま**通る
 * (CLAUDE.md §2「取り出せば test できる」── `update-card.ts` と同じ前例)。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import type { ExtWriteOp } from '@features/extension/ext-write';
import { extractMeta } from '@features/flavor';
import { contentHash64Hex } from '@adapter/platform/storage/content-hash';

/** 書き込む 1 行(store の `upsertEntry` に渡す形)。 */
export interface ExtWriteEntry {
  lid: string;
  title: string;
  archetype: string;
  body: string;
  entryOrder: number;
  status: string | null;
  date: string | null;
  archived: boolean;
}

export interface ExtWriteApplyDeps {
  /**
   * 🔴 **書込の chain に載せる**。⚠ `settled()` で待ってから外で走らせない ──
   *   待ち終わった直後にアプリ自身の書込が積まれれば基底が変わる。
   */
  run<T>(job: () => Promise<T>): Promise<T>;
  phase(): string;
  metaOf(lid: string): EntryMeta | null;
  getBody(lid: string): Promise<string | null>;
  /** @returns `conflict: true` = 先を越された(1 バイトも書いていない)。 */
  write(
    entry: ExtWriteEntry,
    expectHash: string,
  ): Promise<{ conflict?: boolean } | null | undefined>;
  /** 画面の取り直し。⚠ **1 件も書いていなければ呼ばない**(呼び側が守る)。 */
  refresh(): Promise<void>;
}

export type ExtWriteApplied = { ok: true; wrote: number } | { ok: false; why: string };

export async function applyExtWriteOps(
  ops: readonly ExtWriteOp[],
  deps: ExtWriteApplyDeps,
): Promise<ExtWriteApplied> {
  return deps.run(async () => {
    if (deps.phase() !== 'ready')
      return {
        ok: false as const,
        why: 'PKC3 が編集中です(保存するか取り消してから送ってください)',
      };
    /**
     * ── ① 全部読む。⚠ **1 件でも読めなければ全体を断る**
     *    (半分だけ書いて「読めませんでした」は、いちばん分からない負け方)。
     */
    const bases = new Map<string, string>();
    for (const op of ops) {
      if (deps.metaOf(op.lid) === null)
        return { ok: false as const, why: `ノートが見つかりません: ${op.lid}` };
      const body = await deps.getBody(op.lid);
      if (body === null) return { ok: false as const, why: `本文を読めませんでした: ${op.lid}` };
      bases.set(op.lid, body);
    }
    // ── ② 当てる。⚠ 先を越されたらそこで止めて、件数つきで断る
    let wrote = 0;
    for (const op of ops) {
      const meta = deps.metaOf(op.lid);
      // ⚠ 読んだ後に消えていることがある ── 黙って作らない
      if (meta === null) {
        if (wrote > 0) await deps.refresh();
        return {
          ok: false as const,
          why: `ノートが消えました: ${op.lid}(${wrote} 件まで書いて止めました)`,
        };
      }
      const ext = extractMeta(meta.archetype, op.body);
      const stamps = await deps.write(
        {
          lid: op.lid,
          // ⚠ **題名は触らない** ── 語彙は `setBody` だけである
          title: meta.title,
          archetype: meta.archetype,
          body: op.body,
          entryOrder: meta.entryOrder,
          status: ext.status,
          date: ext.date,
          archived: ext.archived,
        },
        contentHash64Hex(bases.get(op.lid)!),
      );
      if (stamps?.conflict === true) {
        if (wrote > 0) await deps.refresh();
        return {
          ok: false as const,
          why: `別のウィンドウがこのノートを書き替えたため、${wrote} 件まで書いて止めました(もう一度送ってください)`,
        };
      }
      wrote += 1;
    }
    if (wrote > 0) await deps.refresh();
    return { ok: true as const, wrote };
  });
}
