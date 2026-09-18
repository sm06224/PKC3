/**
 * 🔴 **拾った中身で、その場に建て直す**(#1006。user 裁定 2026-09-18)。
 *
 * ## user が求めたこと(こちらの解釈)
 *
 * **壊れているのは DB だけなのに、なぜ全部を捨てさせるのか。**
 *
 * ⚠ 直す前の案内は 3 手だった ── 「拾って書き出す」→「中身を捨てる」→「取り込む」。
 * 🔴 途中の「捨てる」が**添付の bytes まで消す**ので、案内どおりに進んだ人は
 *   **一度も壊れていない添付を失う**(#1005 で「拾える」ようにはしたが、
 *   **消すこと自体は直っていなかった**)。
 *
 * 🔑 だから 1 押しにする ── 押したら**拾った中身でその場に建て直し、添付には触らない**。
 *
 * ## 🔑 肝は「器の id を持ち越す」こと
 *
 * 添付の鍵は `${cid}:${assetKey}` なので、**同じ id で作り直せば本文の `asset:<key>` が
 * そのまま解決する** ── bytes を 1 バイトも書き写さない。
 *
 * ⚠ これは速さの話ではない。**持ち越さないと壊れる**:
 *
 * | 持ち越さないと | 何が起きるか |
 * |---|---|
 * | 🔴 孤児の掃除 | `strayBlobKeys` は**器の一覧に無い bytes を「どこにも属さない」**と判定する ── 新しい id を採ると**既存の添付が丸ごと対象**になり、「使っていない添付を消す」を押した日に失う |
 * | 🔴 栞と外部リンク | `pkc://<cid>/entry/<lid>` の「自分の入れ物か」は**文字列の等値** ── id が変わると**壊れる前に作ったリンクが全部「他人の PKC」**になる |
 *
 * ## 🔴 実測して分かった、いちばん危ない所(2026-09-18、実ブラウザ)
 *
 * **`wipeStorage` の後にそのまま開き直すと、黙って `memory` に落ちる。**
 *
 * | 試したこと | 結果 |
 * |---|---|
 * | 対照群(普通に開く) | 🟢 `vfs: opfs-sahpool` |
 * | **同じ worker に `init` をもう一度** | 🔴 **例外は出ない**が `vfs: memory` |
 * | **旧 worker を閉じて、新しい worker で `init`** | 🟢 `opfs-sahpool` |
 * | `wipeStorage` の後の IndexedDB の添付 | 🟢 **鍵も中身も残った** |
 *
 * 落ちる理由はブラウザがそのまま言う ──
 * `NoModificationAllowedError: … Access Handles cannot be created if there is
 * another open Access Handle …`。🔑 **`wipeStorage` は file の中身を消すだけで、
 * 掴んでいる手を離していない**ので、2 度目は**自分自身の古い手とぶつかる**。
 *
 * 🔴 **だから④の門が要る。** 無いと「建て直した」と言いながら**メモリ上**で、
 * user は普通に書き続け、**タブを閉じた瞬間に全部消える** ──
 * ⚠ 直した当人以外、誰も気づけない形である。
 * 🔑 見分けるのは **`fallbackReason`**(`vfs === 'memory'` ではない ──
 * 持ち歩ける 1 枚の HTML は memory を**選んで**いる。`storage-notice.ts` の規律)。
 *
 * ## ⚠ 順番に理由がある(1 つでも入れ替えると壊れる)
 *
 * 1. **拾って zip を落とす** ── 🔑 **ここまでで 1 バイトも消していない**。
 *    落ちたらそこで止まるので、user は何も失わない
 * 2. **sqlite だけ捨てる** ── IDB は触らない(実測で無傷)
 * 3. 🔴 **旧 worker を閉じて、新しい worker で開く**(上の実測)
 * 4. 🔴 **`fallbackReason` を見る。立っていたら書き戻さない**
 * 5. **同じ id で作り直して、書き戻す**
 * 6. 🔴 **ここで初めて**他のタブへ知らせる ── ⚠ これを前へ出すと、
 *    他のタブが**器が空のうちに**読み込み直して**別の id を採番**し、
 *    器が 2 つ並んで**復元した本体が以後見えなくなる**
 *
 * ## ⚠ 本文は heap に載せる(添付と違って text だから)
 *
 * 拾った行は②の前に集め、⑤まで持ち続ける ── ⚠ 捨てた後の DB からはもう読めない。
 * 🔑 本文は text なので添付のようには大きくならない(⚠ ただし**測っていない**)。
 * 🔑 万一ここで落ちても、①の zip が**既に手元に在る**ので user は戻せる ──
 *   これは上限を決めて断るより強い(門ではなく、**順番で守っている**)。
 */

import { extractMeta } from '../flavor';
import type { ArchiveSource } from '../export/pkc3-archive';
import { humanBytes } from '../human-bytes';
import {
  assetArchivePorts,
  type RescueAssets,
  type RescuePick,
  type RescueStats,
} from './rescue-archive';
import { RESCUE_ARCHIVE_LABEL } from './rescue-labels';

/** 壊れた DB から 1 周で拾えた 1 行。 */
export interface RescuedRow {
  readonly lid: string;
  readonly title: string;
  readonly archetype: string;
  readonly body: string;
}

/** 書き戻す 1 件。⚠ 形は storage の `EntryUpsert` に揃える(層をまたいで型を引かない)。 */
export interface RebuiltEntry {
  readonly lid: string;
  readonly title: string;
  readonly archetype: string;
  readonly body: string;
  readonly entryOrder: number;
  readonly status: string | null;
  readonly date: string | null;
  readonly archived: boolean;
}

/** ⚠ 1 回に頼む区画の数(拾い出しと同じ ── 2 通りの規則を作らない)。 */
const CHUNKS = 20;

/** 進み具合を外へ出す(画面が「止まった」と読まれないように)。 */
export interface RebuildProgress {
  (phase: 'pick' | 'write', seen: number, max: number | null): void;
}

/**
 * 🔑 **壊れた DB を 1 周だけ舐めて、拾える行を全部集める**。
 *
 * ⚠ 拾い出し(`rescueArchiveSource`)が 2 周するのは**全本文を heap に抱えない**
 *   ためだが、建て直しは**どのみち抱える**(捨てた後には読めないので)。
 * 🔑 だから 1 周にする ── **zip と建て直しが、1 バイトも違わない同じ行**になる。
 *   ⚠ 2 周すると、壊れ方によって**回ごとに読める区画が変わる**ので、
 *   「書き出した件数」と「戻した件数」が食い違って読み手を混乱させる。
 */
export async function collectRescued(
  pick: RescuePick,
  onProgress?: RebuildProgress,
): Promise<{ rows: RescuedRow[]; skipped: number; empty: number }> {
  const rows: RescuedRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let empty = 0;
  let after = 0;
  for (;;) {
    const before = after;
    const page = await pick(after, CHUNKS);
    skipped += page.skipped;
    empty += page.empty;
    for (const r of page.rows) {
      // ⚠ 同じ lid が 2 度来たら後を捨てる(壊れた DB では起こりうる)
      if (seen.has(r.lid)) continue;
      seen.add(r.lid);
      rows.push({ lid: r.lid, title: r.title, archetype: r.archetype, body: r.body });
    }
    after = page.lastRowid;
    onProgress?.('pick', after, page.maxRowid);
    if (page.done || page.lastRowid <= 0) break;
    // 🔴 前へ進まない相手で回り続けない(拾い出しと同じ守り方)
    if (after <= before) break;
  }
  return { rows, skipped, empty };
}

/**
 * 集めた行から zip を組む口。
 *
 * ⚠ **拾い出しの `rescueArchiveSource` とは別物**である ── あちらは
 *   「DB を 2 周舐めながら出す」形、こちらは「**もう手に持っている行を出す**」形。
 * 🔑 **添付の口は同じ実体を使う**(`assetArchivePorts`)── 2 か所に書くと、
 *   片方だけ直した日に静かにずれる(CLAUDE.md §7)。
 */
export function rebuildArchiveSource(opts: {
  readonly cid: string;
  readonly title: string;
  readonly rows: readonly RescuedRow[];
  readonly skipped: number;
  readonly empty: number;
  readonly assets?: RescueAssets;
}): { readonly source: ArchiveSource; readonly stats: () => RescueStats } {
  const assetPorts = assetArchivePorts(opts.cid, opts.assets);
  const source: ArchiveSource = {
    cid: opts.cid,
    title: opts.title,
    listEntryMetas: async () =>
      opts.rows.map((r, i) => ({
        lid: r.lid,
        title: r.title,
        archetype: r.archetype,
        // ⚠ 拾い出しは時刻を持っていない ── **でっち上げない**(null で出す)
        created_at: null,
        updated_at: null,
        // 🔑 並びは拾った順(壊れた DB で元の順番は読めない)
        entry_order: i + 1,
        status: null,
        date: null,
        archived: 0,
      })),
    // ⚠ もう手に持っているので刻まない(1 回で全部返して `done`)
    listBodies: async () => ({
      rows: opts.rows.map((r) => ({ lid: r.lid, body: r.body })),
      done: true,
    }),
    listAssetMetas: assetPorts.listAssetMetas,
    getAssetBlob: assetPorts.getAssetBlob,
    // 🚫 つながりと履歴は **sqlite にしか無く、索引を使う形でしか引けない**
    listRelations: async () => [],
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
  return {
    source,
    stats: () => ({
      entries: opts.rows.length,
      skipped: opts.skipped,
      empty: opts.empty,
      // 🔑 1 周なので「2 周目で本文が来なかった」が原理的に起きない
      bodyMissing: 0,
      ...assetPorts.stats(),
    }),
  };
}

/**
 * 拾った行を、書き戻せる形へ直す。
 *
 * 🔑 **`extractMeta` を通す** ── 予定の日付やチェックの状態は**本文から導かれる**ので、
 *   取り込み(`import-pkc2.ts`)とまったく同じ関数を通せば、
 *   **建て直しは取り込みと同じだけ戻る**(⚠ こちらだけ弱くしない)。
 */
export function rebuiltEntries(rows: readonly RescuedRow[]): RebuiltEntry[] {
  return rows.map((r, i) => {
    const ext = extractMeta(r.archetype, r.body);
    return {
      lid: r.lid,
      title: r.title,
      archetype: r.archetype,
      body: r.body,
      entryOrder: i + 1,
      status: ext.status,
      date: ext.date,
      archived: ext.archived,
    };
  });
}

/** 建て直しに要る口。⚠ **順番はこの file が持つ**(呼び側に判断を置かない)。 */
export interface RebuildPorts {
  /** 壊れた DB から拾う(1 周)。 */
  readonly pick: RescuePick;
  /** 🔑 添付の実体(IndexedDB)。⚠ 渡さなければ zip に添付が入らない。 */
  readonly assets?: RescueAssets;
  /** ① zip を手元へ落とす。⚠ **落ちたら例外**(何も消さずに止まる)。 */
  saveArchive(source: ArchiveSource): Promise<void>;
  /** ② sqlite だけ捨てる。⚠ IDB には触らない。 */
  wipeStorage(): Promise<{ wiped: boolean; note: string | null }>;
  /** ③ 🔴 **旧 worker を閉じてから**、新しい worker で開き直す。 */
  reopenStorage(): Promise<{ fallbackReason: string | undefined }>;
  /** ⑤ 同じ器の id で作り直す。 */
  openContainer(cid: string, title: string): Promise<void>;
  /** ⑤ 拾ったノートを書き戻す。 */
  writeEntries(cid: string, entries: readonly RebuiltEntry[]): Promise<void>;
  /** 消えたノート由来の物をこの端末から落とす(コピー履歴など)。 */
  forgetLocal(): void;
  /** ⑥ 🔴 **最後に**他のタブへ知らせる。 */
  announceWiped(): void;
  readonly onProgress?: RebuildProgress;
}

/**
 * 建て直しの結末。⚠ **真偽で持たない** ── 「作り直せたが memory だった」は
 * 成功でも失敗でもなく、**user が次にやることが違う**からである。
 */
export type RebuildOutcome =
  /** 🟢 建て直して、書き戻せた。 */
  | 'rebuilt'
  /** 🔴 開き直せたが**メモリ上**だった ── 書き戻していない(書いても消えるので)。 */
  | 'memory-only'
  /** 🔴 書き戻しに失敗した。 */
  | 'write-failed'
  /**
   * 🔴 **捨てた後の段で落ちた**(#1006 の着地前レビューが出した)。
   *
   * ⚠ `write-failed` と分ける理由:あちらは**開き直せている**ので、この画面は
   *   まだ生きている。こちらは **DB を捨てた後に開き直しそのものが落ちた**ので、
   *   🔴 **この画面の保存機構ごと死んでいる**(古い worker は `terminate()` 済みで、
   *   共有している client は戻らない ── 以後の保存は全部
   *   `store client terminated` で落ちる)。
   * 🔑 だから user に言うことが違う:**必ず読み込み直させる**。
   */
  | 'storage-lost';

export interface RebuildReport {
  readonly outcome: RebuildOutcome;
  /** 拾えた成果(zip に入れた分と同じ)。 */
  readonly rescued: RescueStats;
  /** 実際に書き戻した件数。⚠ `rescued.entries` と**分けて持つ**。 */
  readonly restored: number;
  /** DB を file ごと捨てたか(`false` = もともとメモリ上だった)。 */
  readonly wiped: boolean;
  /** 捨てられなかったときの理由。 */
  readonly note: string | null;
  /** 🔴 開き直しが退避した理由(立っていたら**書き戻していない**)。 */
  readonly fallbackReason: string | null;
  /** 書き戻しが落ちたときの理由。 */
  readonly error: string | null;
}

/**
 * 拾って、その場に建て直す。
 *
 * ⚠ **読み込み直しはここでやらない** ── 呼び側(画面)がやる。
 *   ここでやると、**test がこの関数を 1 度も最後まで走らせられない**。
 *
 * @param cid いまの器の id。🔑 **これを持ち越す**のが、この機能の肝である
 */
export async function rebuildContainer(
  cid: string,
  title: string,
  ports: RebuildPorts,
): Promise<RebuildReport> {
  // ① 拾う → zip を落とす。⚠ ここで落ちたら例外で抜ける(**まだ何も消していない**)
  const got = await collectRescued(ports.pick, ports.onProgress);
  const { source, stats } = rebuildArchiveSource({
    cid,
    title,
    rows: got.rows,
    skipped: got.skipped,
    empty: got.empty,
    ...(ports.assets === undefined ? {} : { assets: ports.assets }),
  });
  await ports.saveArchive(source);
  const rescued = stats();

  /**
   * 🔴 **ここから先では投げない**(#1006 の着地前レビューが出した)。
   *
   * ⚠ 直す前は②③が裸で、落ちると呼び側の 1 つの `catch` へ飛んでいた ──
   *   そこは「**何も消えていません**」と言う所である。🔴 ②が通った後なら
   *   **DB はもう無い**ので、いちばん安心させる字が**いちばん嘘**になっていた。
   * ⚠ しかも呼び側は例外のとき**読み込み直さない**ので、
   *   `terminate()` 済みの client を握ったまま画面が残る
   *   (以後の保存が全部 `store client terminated` で落ちる)。
   * 🔑 だから**結末として返す** ── 呼び側は返ってきた報告なら必ず読み込み直す。
   * 🔑 これで呼び側の `catch` が意味するのは「**①で落ちた**」だけになり、
   *   「何も消えていません」が**作りとして真**になる。
   */
  let wipe: { wiped: boolean; note: string | null } = { wiped: false, note: null };
  try {
    // ② sqlite だけ捨てる
    wipe = await ports.wipeStorage();

    // ③ 旧 worker を閉じて、新しい worker で開き直す
    const re = await ports.reopenStorage();

    /**
     * ④ 🔴 **門** ── 退避していたら**書き戻さない**。
     *
     * ⚠ ここで書くと、user は「戻った」と思って書き続け、
     *   **タブを閉じた瞬間に全部消える**。🔑 書かずに言うほうが、はるかに良い。
     * ⚠ 見分けるのは `fallbackReason` である(`vfs === 'memory'` ではない ──
     *   持ち歩ける 1 枚の HTML は memory を**選んで**いる)。
     */
    const fell = re.fallbackReason !== undefined && re.fallbackReason !== '';
    if (fell) {
      // ⚠ 器は空になった ── この端末に残る断片(コピー履歴)を落とす
      ports.forgetLocal();
      ports.announceWiped();
      return {
        outcome: 'memory-only',
        rescued,
        restored: 0,
        wiped: wipe.wiped,
        note: wipe.note,
        fallbackReason: re.fallbackReason ?? '',
        error: null,
      };
    }

    // ⑤ 同じ id で作り直して、書き戻す
    const entries = rebuiltEntries(got.rows);
    /**
     * ⚠ **書き戻す「前」に言う** ── ここは 1 回の bulk なので、終わってから言うと
     *   いちばん長い間ずっと「**拾っています…**」のままになる(user は
     *   **止まった**と読んで窓を閉じる ── 閉じられると書き戻しが途中で終わる)。
     */
    ports.onProgress?.('write', entries.length, entries.length);
    try {
      await ports.openContainer(cid, title);
      await ports.writeEntries(cid, entries);
    } catch (e) {
      ports.forgetLocal();
      ports.announceWiped();
      return {
        outcome: 'write-failed',
        rescued,
        restored: 0,
        wiped: wipe.wiped,
        note: wipe.note,
        fallbackReason: null,
        error: String(e),
      };
    }

    /**
     * ⑥ 🔴 **ここで初めて知らせる。**
     *
     * ⚠ これを②や③の側へ出すと、他のタブが**器が空のうちに**読み込み直し、
     *   **別の id を採番**する ── 器が 2 つ並び、片方だけが以後ずっと返るので、
     *   **復元した本体が誰からも見えなくなる**。
     * 🔑 ⚠ **`forgetLocal` はここでは呼ばない** ── 建て直しは lid を持ち越すので、
     *   コピー履歴の指す先は**生きている**(消すと、戻ったのに履歴だけ失う)。
     */
    ports.announceWiped();
    return {
      outcome: 'rebuilt',
      rescued,
      restored: entries.length,
      wiped: wipe.wiped,
      note: wipe.note,
      fallbackReason: null,
      error: null,
    };

  } catch (e) {
    /**
     * 🔴 **捨てた後に落ちた** ── いちばん危ない結末である。
     *
     * 🔑 zip は**手元に在る**(①は通っている)ので、user は失っていない。
     * ⚠ ただし**この画面の保存はもう働かない**ので、必ず読み込み直させる。
     * ⚠ `forgetLocal` は呼ぶ ── 器は空(か、開けない)ので、コピー履歴の
     *   指す先が無い。
     */
    ports.forgetLocal();
    /**
     * ⚠ **知らせる所も落ちうる**ので、ここだけは失敗を飲む ──
     *   知らせに失敗したせいで、**報告そのものを返せなくなる**のがいちばん悪い
     *   (返せないと呼び側は例外の枝へ行き、また「何も消えていません」と言う)。
     */
    try {
      ports.announceWiped();
    } catch {
      /* 知らせられなくても、下の報告は必ず返す */
    }
    return {
      outcome: 'storage-lost',
      rescued,
      restored: 0,
      wiped: wipe.wiped,
      note: wipe.note,
      fallbackReason: null,
      error: String(e),
    };
  }
}

/**
 * 🔴 **戻らない物の呼び名を 1 か所で持つ**(#1006)。
 *
 * ⚠ 押す前の窓(`rebuildExplainMessage`)と、終わった後の字
 *   (`rebuildDoneMessage`)の**両方**に出る ── ⚠ 2 か所に手で書くと、
 *   片方だけ直した日に user は「**別の物も消えた**」と読む(§7)。
 *
 * ## ⚠ 「つながり」と丸めない
 *
 * 拾えるのは `entries` の行だけなので、戻らないのは**別の表に在る物**である ──
 * 居場所(`relations` の `structural`)/ 手で付けた関係 / `revisions`。
 * 🔑 フォルダそのものは archetype `folder` の**ノート**、タグは**本文の
 *   frontmatter** に在るので**残る** ── 消えるのは「どこに入っていたか」だけである。
 */
export const REBUILD_LOST: readonly string[] = [
  'どのフォルダに入っていたか',
  'ノート同士に付けた関係',
  '履歴(前の版)',
] as const;

/**
 * 終わった後に画面へ出す字。
 *
 * ⚠ **「戻りました」だけで終えない** ── 戻らなかった物(つながり・履歴)と、
 *   拾えなかった区画は**必ず字にする**(「拾えた件数」を「全部」と読ませない)。
 */
export function rebuildDoneMessage(r: RebuildReport): string {
  if (r.outcome === 'memory-only') {
    return (
      '🔴 入れ物を作り直せませんでした(この画面では中身がメモリ上にしか置けません)。' +
      `書き戻していないので、いま落とした「${RESCUE_ARCHIVE_LABEL}」のファイルを、` +
      '読み込み直したあとに「取り込む」から読み込んでください。'
    );
  }
  if (r.outcome === 'storage-lost') {
    /**
     * 🔴 **いちばん危ない結末** ── 捨てた後に、開き直しそのものが落ちた。
     *
     * 🔑 言うことは 3 つ:①**ファイルは手元に在る**(怖がらせない)
     *   ②**この画面の保存はもう働かない**(黙っていると、打った字が
     *   消え続けるのに気づけない)③**読み込み直してから取り込む**(次の一手)。
     * ⚠ 「何も消えていません」とは**書かない** ── 捨てた後だからである。
     */
    return (
      `🔴 入れ物を捨てた後に止まりました(${r.error ?? '理由は分かりません'})。` +
      `いま落とした「${RESCUE_ARCHIVE_LABEL}」のファイルは手元に在ります。` +
      '⚠ この画面はもう保存できないので、読み込み直してから「取り込む」で戻してください。' +
      '読み込み直します。'
    );
  }
  if (r.outcome === 'write-failed') {
    return (
      `🔴 書き戻せませんでした(${r.error ?? '理由は分かりません'})。` +
      `いま落とした「${RESCUE_ARCHIVE_LABEL}」のファイルを、` +
      '読み込み直したあとに「取り込む」から読み込んでください。'
    );
  }
  const miss: string[] = [];
  if (r.rescued.skipped > 0) miss.push(`読めなかった区画 ${r.rescued.skipped}`);
  if (r.rescued.empty > 0) miss.push(`空だった区画 ${r.rescued.empty}`);
  const head = `${r.restored} 件を戻しました${miss.length === 0 ? '' : `(${miss.join(' / ')})`}`;
  // 🔑 添付は「触っていない」と言う ── 数ではなく**事実**が知りたい所である
  const kept =
    r.rescued.assets > 0
      ? `。添付 ${r.rescued.assets} 件(${humanBytes(r.rescued.assetBytes)})はそのまま残っています`
      : '';
  // 🔴 戻らなかった物は**黙って 0 件にしない**。⚠ 呼び名は `REBUILD_LOST` から引く
  // ⚠ **押す前の窓と同じことを言う** ── 戻った画面の見え方は、ここでも 1 行要る
  const lost =
    `⚠ ${REBUILD_LOST.join('・')}は戻りません` +
    '(ノートはフォルダの外の一覧にまとめて並びます)。';
  return `${head}${kept}。${lost}読み込み直します。`;
}

/**
 * 🔴 **押す前に出す字**(#1006)。⚠ **捨てる側の窓と同じ作法**
 * (`container-reset.ts` の `resetExplainMessage`)── 判断を `binder.ts` に置かない。
 *
 * ## なぜ「残るもの」より先に「やること」を書くか
 *
 * ⚠ この口を押す人は**壊れたと言われた直後**で、いちばん怖いのは
 *   「押したら消えるのではないか」である。🔑 だから**順番そのものを見せる**
 *   ── 先にファイルが手元へ落ち、**落とせなければ何も消さずに止まる**。
 *
 * ## ⚠ 戻らない物の呼び名は `REBUILD_LOST` から引く
 *
 * 手で書くと、終わった後の字(`rebuildDoneMessage`)と**片方だけ**直る(§7)。
 */
export function rebuildExplainMessage(opts: {
  readonly notes: number;
  /** 🔑 いまこの端末に在る添付の件数(数えられなければ `null`)。 */
  readonly assetsOnDisk: number | null;
}): string {
  const { notes, assetsOnDisk } = opts;
  /**
   * 🔴 **「触りません」を、数えたときだけ数で言う**(#1005 と同じ向き)。
   * ⚠ 数えられなかったのに「N 件は残ります」と書くと、**0 件の人が安心する**。
   */
  const attach =
    assetsOnDisk === null
      ? '・添付したファイルの中身(別の場所にあるので触りません。件数はこの端末では数えられませんでした)'
      : assetsOnDisk > 0
        ? `・添付したファイル ${assetsOnDisk} 件の中身(別の場所にあるので触りません)`
        : '・添付したファイルの中身(別の場所にあるので触りません)';
  return [
    'いま読めるノートを集めて、入れ物を作り直し、そのまま戻します。',
    '',
    'この順で進みます',
    '・読めるノートを集めて、ファイル(.pkc3.zip)にして手元へ落とします',
    '・入れ物を作り直します',
    '・集めたノートを、そのまま戻します',
    // 🔑 いちばん怖い所を先に潰す ── 「押したら消える」ではない
    '⚠ ファイルを落とせなかったときは、何も消さずに止まります。',
    /**
     * 🔴 **始めたら止められないことを、始める前に言う**(動線レビューが出した)。
     * ⚠ 走り出すと押せる物が 1 つも無いので、**言っていないと「固まった」と読まれる**。
     */
    '⚠ 始めると、途中で止めることはできません。',
    '',
    '残るもの',
    `・いま一覧に出ている ${notes} 件のノート(題名・本文・タグ・チェックの印)`,
    attach,
    '・設定・見た目・ショートカットキーの割り当て・読んだお知らせの印',
    '',
    '🔴 戻らないもの',
    // ⚠ 呼び名は `REBUILD_LOST` から引く ── 終わった後の字と食い違わせない
    ...REBUILD_LOST.map((x) => `・${x}`),
    '⚠ フォルダそのものとタグは、ノートの中に在るので残ります。',
    /**
     * 🔴 **戻ってきた画面がどう見えるかを、先に言う**(#1006 の動線レビューが出した)。
     *
     * ⚠ 「どのフォルダに入っていたか は戻りません」だけだと、user は
     *   **戻った画面を見て初めて**それが何を意味するか分かる ── そして
     *   **全部が根元に平らに並んだ画面**は「直った」ではなく「**壊れた**」と読める。
     * 🔑 マニュアルには書いてあったが、**この窓だけを見て押す人**には届かない。
     */
    '⚠ 戻した後は、ノートがフォルダの外の一覧にまとめて並びます(フォルダそのものは空で残ります)。',
    // ⚠ 見えている数 ≠ 在る数(壊れているときは一覧そのものが引けていないことがある)
    '⚠ 壊れているときは、一覧に出ていない分を集められないことがあります。',
    '',
    // ⚠ 黙って他のタブを読み込み直さない ── 先に言う
    '⚠ 同じ PKC を開いている他のタブも、読み込み直されます。',
  ].join('\n');
}
