/**
 * 🔴 **拾った中身で、その場に建て直す**(#1006。user 裁定 2026-09-18)。
 *
 * ## user が求めたこと(こちらの解釈)
 *
 * **壊れているのは DB だけなのに、なぜ全部を捨てさせるのか。**
 *
 * ⚠ 直す前の案内は 3 手だった ── 「拾って書き出す」→「中身を捨てる」→「ファイルを取り込む」。
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
import { archiveSuffix } from '../export/archive-kind';
import { humanBytes } from '../human-bytes';
import {
  assetArchivePorts,
  collectRescuedExtras,
  drainPages,
  extrasArchivePorts,
  extrasTally,
  type RescueAssets,
  type RescuedExtras,
  type RescuedRelation,
  type RescuedRevision,
  type RescuePick,
  type RescueRelationsPick,
  type RescueRevisionsPick,
  type RescueStats,
} from './rescue-archive';

// ⚠ つながり・履歴の拾い方は拾い出しの zip と**同じ口**(`rescue-archive.ts`)── 既存の import 先を変えない
export { collectRescuedExtras, type RescuedExtras };

/**
 * 🔴 **保険の zip の呼び名**(#1017 段④b)。⚠ 以前はボタン名
 * (`RESCUE_ARCHIVE_LABEL` = 「拾って、戻せる形で書き出す」)を指していたが、
 * その専用ボタンは無くなった ── いまは**落ちた file の末尾**で言う
 * (`main.ts` の `saveArchive` が `archiveFileName(base, 'part')` で焼く)。
 */
const RESCUE_ARCHIVE_SUFFIX = archiveSuffix('part');

/** 壊れた DB から 1 周で拾えた 1 行。 */
export interface RescuedRow {
  readonly lid: string;
  readonly title: string;
  readonly archetype: string;
  readonly body: string;
  /** 🔑 読めた並び・時刻(#1087)。`null` = 読めなかった(でっち上げず、代わりは書き戻し側で決める)。 */
  readonly entryOrder: number | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
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
  /** 読めた時刻(#1087)。`null` = 取り込んだ今(DB が刻む)。 */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** 🔴 `'system'` = システムのメッセージ(台帳 #1852 束 F2 / 依頼 119-1 A。同じ領域へ書き戻す)。省略 = user のノート。 */
  readonly realm?: 'system';
}

/** 🔴 書き戻すゴミ箱のノート 1 件(台帳 #1852 束 F2 / 依頼 119-1 A)。⚠ 形は storage の `TrashNoteInput` に揃える(層をまたいで型を引かない)。 */
export interface RebuiltTrashNote {
  readonly lid: string;
  readonly title: string;
  readonly archetype: string;
  /** ゴミ箱へ移した時点の本文(頭の行の全文)。 */
  readonly body: string;
  readonly trashedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly entryOrder: number | null;
  /** 頭より古い版(保存形の鎖。新しい → 古い)。 */
  readonly rows: ReadonlyArray<{
    readonly revOrder: number;
    readonly createdAt: string | null;
    readonly title: string | null;
    readonly archetype: string | null;
    readonly kind: string;
    readonly snapshot: string;
    readonly contentHash: string | null;
  }>;
}

/** 拾ったゴミ箱の履歴 → 書き戻す形(頭 = 先頭の行が本文)。 */
export function rebuiltTrash(trash: RescuedExtras['trash']): RebuiltTrashNote[] {
  return [...trash].map(([lid, rows]) => {
    const head = rows[0]!;
    return {
      lid,
      title: head.title ?? '(無題)',
      archetype: head.archetype ?? 'text',
      body: head.snapshot,
      trashedAt: head.createdAt,
      createdAt: head.entryCreatedAt ?? null,
      updatedAt: head.entryUpdatedAt ?? null,
      entryOrder: head.entryOrder ?? null,
      rows: rows.slice(1).map((r) => ({
        revOrder: r.revOrder,
        createdAt: r.createdAt,
        title: r.title,
        archetype: r.archetype,
        kind: r.kind,
        snapshot: r.snapshot,
        contentHash: r.contentHash,
      })),
    };
  });
}

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
): Promise<{ rows: RescuedRow[]; skipped: number; empty: number; truncated: boolean }> {
  const rows: RescuedRow[] = [];
  const seen = new Set<string>();
  const got = await drainPages(
    pick,
    (page) => {
      for (const r of page.rows) {
        // ⚠ 同じ lid が 2 度来たら後を捨てる(壊れた DB では起こりうる)
        if (seen.has(r.lid)) continue;
        seen.add(r.lid);
        rows.push({
          lid: r.lid,
          title: r.title,
          archetype: r.archetype,
          body: r.body,
          entryOrder: r.entryOrder ?? null,
          createdAt: r.createdAt ?? null,
          updatedAt: r.updatedAt ?? null,
        });
      }
    },
    onProgress,
  );
  return { rows, ...got };
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
  /** 🔑 拾えたつながりと履歴(#1087)。⚠ 省略 = 入れない(今までどおり)。 */
  readonly extras?: RescuedExtras;
  /** 🔴 ノートの拾い出しを途中で打ち切った(#1087)。 */
  readonly truncated?: boolean;
  /**
   * 🔴 **捨てる前に読んだタグの色**(#1087)。⚠ 安全のための zip にも入れる ── 入れないと、
   * 建て直しが「メモリ上のみ / 書き戻し失敗 / 保存先を失った」で終わった日に、色が zip にも画面にも残らない。
   */
  readonly tagColors?: ReadonlyArray<{ tag: string; color: string }>;
}): { readonly source: ArchiveSource; readonly stats: () => RescueStats } {
  const assetPorts = assetArchivePorts(opts.cid, opts.assets);
  const source: ArchiveSource = {
    // 🔴 拾えた分だけの zip だと、ファイルの中に書く(依頼 119-4)
    partial: true,
    cid: opts.cid,
    title: opts.title,
    listEntryMetas: async () =>
      opts.rows.map((r, i) => ({
        lid: r.lid,
        title: r.title,
        archetype: r.archetype,
        // 🔑 読めた時刻・並びを運ぶ(#1087)。⚠ 読めなかった分は**でっち上げない**(時刻は null、並びは拾った順)
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        entry_order: r.entryOrder ?? i + 1,
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
    // 🔑 つながりと履歴(#1087)。⚠ 拾い出しの zip と**同じ口**(`extrasArchivePorts`)
    ...extrasArchivePorts(opts.extras),
    ...(opts.tagColors === undefined
      ? {}
      : { listTagColors: async () => opts.tagColors!.map((c) => ({ tag: c.tag, color: c.color })) }),
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
      ...(opts.extras === undefined ? {} : { extras: extrasTally(opts.extras) }),
      ...(opts.truncated === true || opts.extras?.truncated === true ? { truncated: true } : {}),
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
      // 🔑 読めた並びを使う。読めなければ拾った順(#1087)
      entryOrder: r.entryOrder ?? i + 1,
      status: ext.status,
      date: ext.date,
      archived: ext.archived,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

/**
 * 担当でないタブで押されたときの断り文(縮める操作の断り文と同じ言い方)。
 * ⚠ 呼び側の `catch` が「作り直せませんでした(何も消えていません): 」を前置きする ── ここは 1 文だけ。
 */
export const REBUILD_NOT_WRITER =
  'このタブは保存を担当していないので作り直せません(保存を担当しているタブで押してください)';

/** 建て直しに要る口。⚠ **順番はこの file が持つ**(呼び側に判断を置かない)。 */
export interface RebuildPorts {
  /**
   * 🔴 **このタブが保存を担当しているか**(#1087)。⚠ 必須 ── 渡し忘れたら tsc が落とす。
   * 担当でないタブは DB の手を握っていない: 捨てる命令だけが担当のタブへ届いて**そちらの DB が空になり**、
   * 開き直しは手を取れずメモリ上へ落ちる。だから**何も拾わない前に**断る。
   */
  holdsWriterLease(): boolean;
  /** 壊れた DB から拾う(1 周)。 */
  readonly pick: RescuePick;
  /**
   * 🔴 **システムのメッセージを拾う**(台帳 #1852 束 F2 / 依頼 119-1 A)。⚠ 必須 ── 渡し忘れると、静かに戻らなくなる。
   * 読めなくても建て直しは止めない(メッセージが読めないだけで、ノートを捨てる理由は無い)。zip には入れない(メッセージは書き出さない領域)。
   */
  readonly pickSystem: RescuePick;
  /**
   * 🔴 **一覧に出ているノートの数**(台帳 #1852 束 F2 / 依頼 119-2 A)。⚠ 省略可 ── 渡したとき、読めた数がこれより少なければ
   * **捨てる前に** `confirmFewer` で聞く。
   */
  readonly expectedNotes?: number;
  /**
   * 🔴 読めた数が一覧より少ないとき、**何も書き出さず・捨てず**に聞く(依頼 119-2 A)。`false` なら何もせずやめる(`'declined'`)。
   * ⚠ 省略 = 聞かない(従来どおり、終わった後に件数を言う)。
   */
  confirmFewer?(read: number, expected: number): Promise<boolean>;
  /** 🔑 つながりと履歴を拾う(#1087)。⚠ 必須 ── 渡し忘れると、静かに戻らなくなる。 */
  readonly pickRelations: RescueRelationsPick;
  readonly pickRevisions: RescueRevisionsPick;
  /**
   * 🔴 **捨てる前に**タグの色を読む(#1087)。色は sqlite の `settings` 表にあり、捨てると消える。
   * ⚠ 読めなければ空で返してよい(呼び側が握る)── 色が読めないだけで建て直しは止めない。
   */
  readTagColors(): Promise<Array<{ tag: string; color: string }>>;
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
  /** ⑤ つながりを書き戻す(#1087)。⚠ ノートの後(両端が居てから)。 */
  writeRelations(cid: string, relations: readonly RescuedRelation[]): Promise<void>;
  /**
   * ⑤ 履歴の鎖を書き戻す(#1087)。⚠ ノートの後(鎖は tip = ノートの本文から遡る)。
   * 返す `broken` = 噛み合わなくて捨てた鎖の数(黙って減らさない)。
   */
  writeRevisions(
    cid: string,
    chains: ReadonlyMap<string, readonly RescuedRevision[]>,
  ): Promise<{ added: number; broken: number }>;
  /**
   * ⑤ 🔴 **添付の登録行を組み直す**(#1087)。
   *
   * ⚠ 作り直しは sqlite を丸ごと捨てるので `assets` 表も消える ── bytes は IndexedDB に
   *   残っているのに、書き出し・容量の内訳は**登録行から**一覧を取るため、バックアップに
   *   添付が 0 件で出ていた。呼び側は `metas`(`assetArchivePorts` と同じ組み方)を書くだけ。
   */
  writeAssetMetas(
    cid: string,
    metas: ReadonlyArray<{
      key: string;
      mime: string | null;
      size: number | null;
      hash: string | null;
    }>,
  ): Promise<void>;
  /**
   * ⑤ 🔴 ゴミ箱のノートを、ゴミ箱の中へ戻す(台帳 #1852 束 F2 / 依頼 119-1 A)。⚠ 必須 ── ノートの後(頭の行は全文なので順は問わないが、
   * つながりと同じ段で戻す)。返す `restored` = 戻せた件数(同じ lid が既にある / 壊れた鎖は戻らない)。
   */
  writeTrash(cid: string, notes: readonly RebuiltTrashNote[]): Promise<{ restored: number }>;
  /** ⑤ 🔴 捨てる前に読んだタグの色を戻す(#1087)。 */
  writeTagColors(cid: string, colors: ReadonlyArray<{ tag: string; color: string }>): Promise<void>;
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
  /**
   * 🔴 **読めた数が一覧より少なく、user がやめた**(台帳 #1852 束 F2 / 依頼 119-2 A)。⚠ 何も書き出さず・消していない ──
   * 呼び側は**読み込み直さない**(この画面の保存は生きている)。
   */
  | 'declined'
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
  /** 🔑 戻したつながり・履歴の版の数(#1087)。 */
  readonly relationsRestored: number;
  readonly revisionsRestored: number;
  /**
   * 🔴 つながり・履歴を**読み切れなかった**印(#1087)。読めない区画 / 噛み合わず捨てた鎖 /
   * 途中で打ち切った、のどれかが在れば `true`。⚠ `true` のとき「戻りました」だけで終えない。
   */
  readonly extrasPartial: boolean;
  /** 戻したタグの色の数(#1087)。 */
  readonly tagColorsRestored: number;
  /** 🔴 戻したゴミ箱のノートの数(台帳 #1852 束 F2)。 */
  readonly trashRestored: number;
  /** 🔴 戻したシステムのメッセージの数(台帳 #1852 束 F2)。 */
  readonly systemRestored: number;
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
  // 🔴 ① より前に断る(まだ何も読んでも消してもいない)
  if (!ports.holdsWriterLease()) throw new Error(REBUILD_NOT_WRITER);
  // ① 拾う → zip を落とす。⚠ ここで落ちたら例外で抜ける(**まだ何も消していない**)
  const got = await collectRescued(ports.pick, ports.onProgress);
  // 🔑 つながりと履歴も、ノートと同じ ① の段で拾う(捨てた後の DB からはもう読めない)
  const extras = await collectRescuedExtras(cid, new Set(got.rows.map((r) => r.lid)), {
    relations: ports.pickRelations,
    revisions: ports.pickRevisions,
  });
  // 🔴 システムのメッセージも捨てる前に読む(台帳 #1852 束 F2 / 依頼 119-1 A)。読めなくても止めない。zip には入れない
  const sys = await collectRescued(ports.pickSystem).catch(() => ({ rows: [] as RescuedRow[] }));
  // 🔴 色は sqlite の `settings` 表 ── 捨てる前でないと読めない。読めなければ空(建て直しは止めない)
  const tagColors = await ports.readTagColors().catch(() => []);
  const { source, stats } = rebuildArchiveSource({
    cid,
    title,
    rows: got.rows,
    skipped: got.skipped,
    empty: got.empty,
    extras,
    truncated: got.truncated,
    tagColors,
    ...(ports.assets === undefined ? {} : { assets: ports.assets }),
  });
  /**
   * ⚠ 添付の成果(`assets` / `assetBytes`)は zip を組んで初めて分かる ── 「やめた」報告(zip を組まない)は 0 のままでよい。
   * 組んだ後(下の `saveArchive` の後)で取り直す。
   */
  let rescued = stats();
  /** 戻していない間の値(① の後に返す 3 つの結末が使う)。 */
  const none = {
    relationsRestored: 0,
    revisionsRestored: 0,
    extrasPartial: extras.skipped > 0 || extras.truncated,
    tagColorsRestored: 0,
    trashRestored: 0,
    systemRestored: 0,
  };
  /**
   * 🔴 **読めた数が一覧より少ないなら、書き出す前・捨てる前に聞く**(台帳 #1852 束 F2 / 依頼 119-2 A)。
   * > 100 件のうち 3 件しか読めなくても、止まらずに捨てていた。件数が分かるのは終わった後だった。
   * ⚠ 何も書き出さず・消していないので、やめても失う物は無い。呼び側は読み込み直さない(`'declined'`)。
   */
  if (
    ports.expectedNotes !== undefined &&
    ports.confirmFewer !== undefined &&
    got.rows.length < ports.expectedNotes &&
    !(await ports.confirmFewer(got.rows.length, ports.expectedNotes))
  ) {
    return {
      outcome: 'declined',
      rescued,
      restored: 0,
      ...none,
      wiped: false,
      note: null,
      fallbackReason: null,
      error: null,
    };
  }
  await ports.saveArchive(source);
  rescued = stats();

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
        ...none,
        wiped: wipe.wiped,
        note: wipe.note,
        fallbackReason: re.fallbackReason ?? '',
        error: null,
      };
    }

    // ⑤ 同じ id で作り直して、書き戻す
    const entries = rebuiltEntries(got.rows);
    // 🔴 メッセージは同じ領域(system)へ書き戻す。件数 `restored` には数えない(ノートの件数と混ぜない)
    const systemEntries: RebuiltEntry[] = sys.rows.map((r, i) => ({
      ...rebuiltEntries([r])[0]!,
      entryOrder: r.entryOrder ?? i,
      realm: 'system' as const,
    }));
    /**
     * ⚠ **書き戻す「前」に言う** ── ここは 1 回の bulk なので、終わってから言うと
     *   いちばん長い間ずっと「**拾っています…**」のままになる(user は
     *   **止まった**と読んで窓を閉じる ── 閉じられると書き戻しが途中で終わる)。
     */
    ports.onProgress?.('write', entries.length, entries.length);
    let relationsRestored = 0;
    let revisionsRestored = 0;
    let brokenChains = 0;
    let tagColorsRestored = 0;
    let trashRestored = 0;
    try {
      await ports.openContainer(cid, title);
      await ports.writeEntries(cid, [...entries, ...systemEntries]);
      // 🔴 つながりと履歴は**ノートの後**(履歴の鎖は、書き戻したノートの本文から遡る)
      // 🔴 ゴミ箱のノートに触るつながりも(台帳 #1852 束 F2)── 戻したゴミ箱から「戻す」と居場所も戻る
      const allRelations = [...extras.relations, ...extras.trashRelations];
      await ports.writeRelations(cid, allRelations);
      relationsRestored = allRelations.length;
      const rev = await ports.writeRevisions(cid, extras.chains);
      revisionsRestored = rev.added;
      brokenChains = rev.broken;
      // 🔴 ゴミ箱のノート(台帳 #1852 束 F2 / 依頼 119-1 A)── ゴミ箱の中へ戻す。⚠ 一覧には出ない
      const trashNotes = rebuiltTrash(extras.trash);
      if (trashNotes.length > 0) trashRestored = (await ports.writeTrash(cid, trashNotes)).restored;
      /**
       * 🔴 **添付の登録行を組み直す**(#1087)。bytes は IndexedDB に残っているが、
       * 書き出し・容量の内訳は登録行から一覧を取る ── 戻さないと添付が 0 件に見える。
       * 🔑 組み方は拾い出しの zip と**同じ口**(`assetArchivePorts`)。hash は分からないので null。
       */
      await ports.writeAssetMetas(cid, await assetArchivePorts(cid, ports.assets).listAssetMetas());
      // 🔴 捨てる前に読んだタグの色(#1087)
      await ports.writeTagColors(cid, tagColors);
      tagColorsRestored = tagColors.length;
    } catch (e) {
      ports.forgetLocal();
      ports.announceWiped();
      return {
        outcome: 'write-failed',
        rescued,
        restored: 0,
        ...none,
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
      trashRestored,
      systemRestored: systemEntries.length,
      relationsRestored,
      revisionsRestored,
      extrasPartial: none.extrasPartial || brokenChains > 0,
      tagColorsRestored,
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
      ...none,
      wiped: wipe.wiped,
      note: wipe.note,
      fallbackReason: null,
      error: String(e),
    };
  }
}

/**
 * 🔴 **読めても戻らない物の呼び名を 1 か所で持つ**(#1006 → #1087 で空にした)。
 *
 * ⚠ 押す前の窓(`rebuildExplainMessage`)と、終わった後の字
 *   (`rebuildDoneMessage`)の**両方**に出る ── ⚠ 2 か所に手で書くと、
 *   片方だけ直した日に user は「**別の物も消えた**」と読む(§7)。
 *
 * ## 🔑 いまは空である ── 「戻らない」と書いていたのは実測で誤りだった
 *
 * 直す前は「どのフォルダに入っていたか / ノート同士のつながり / 履歴」を戻らない物としていた
 * (「索引を使う形でしか引けない」)。🔴 2026-10-14 に、索引を潰した DB で `NOT INDEXED` の
 * 表走査が `relations` / `revisions` を **500 件中 500 件**読めることを実測した
 * (索引を使う形は rc 11)── 読めた分は拾って戻す。
 * ⚠ **読めなかった分**は戻らない ── それは固定の一覧ではなく**件数で出る**
 * (`RebuildReport.extrasPartial`)ので、ここには置かない。
 * ⚠ 戻らない物がまた出たら、ここへ足す(マニュアルの表と**等値**で pin してある)。
 */
/**
 * 🔴 **作り直しで戻らない物**(#1087 → 台帳 #1852 束 F2 / 依頼 119-1 A で空にした)。
 *
 * ゴミ箱のノートとシステムのメッセージは、拾い出しの対象に入れて**戻す**ようにした(直す前は「戻らないもの」として窓に出していた)。
 * ⚠ 戻らない物がまた出たら、ここへ足す(マニュアルの表と**等値**で pin してある)。
 */
export const REBUILD_LOST: readonly string[] = [] as const;

/**
 * 🔴 **読めた数が一覧より少ないときに聞く字**(台帳 #1852 束 F2 / 依頼 119-2 A)。押す前の窓(`rebuildExplainMessage`)とは別の、
 * 「拾ってみたら少なかった」ときの 2 枚目。⚠ 何も書き出さず・消していない段で出す ── やめても失う物は無い。
 */
export function rebuildFewerMessage(read: number, expected: number): string {
  return [
    `${expected} 件のうち ${read} 件しか読めませんでした。`,
    '',
    `続けると、読めた ${read} 件だけで保存データを作り直します。読めなかった ${expected - read} 件は戻りません。`,
    `読めた分は、${RESCUE_ARCHIVE_SUFFIX} のファイルとして手元にダウンロードされます。`,
    '',
    '続けますか。',
  ].join('\n');
}

/**
 * 終わった後に画面へ出す字。
 *
 * ⚠ **「戻りました」だけで終えない** ── 戻らなかった物(つながり・履歴)と、
 *   拾えなかった区画は**必ず字にする**(「拾えた件数」を「全部」と読ませない)。
 */
export function rebuildDoneMessage(r: RebuildReport): string {
  if (r.outcome === 'declined') {
    return '作り直しをやめました(何も書き出さず、何も消していません)。';
  }
  if (r.outcome === 'memory-only') {
    return (
      'ノートの保存データを作り直せませんでした(このタブでは中身がメモリ上にしか置けません)。' +
      `書き戻していないので、いまダウンロードした ${RESCUE_ARCHIVE_SUFFIX} のファイルを、` +
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
      `⚠ ノートの保存データを消した後に止まりました(${r.error ?? '理由は分かりません'})。` +
      `いまダウンロードした ${RESCUE_ARCHIVE_SUFFIX} のファイルは手元にあります。` +
      '⚠ このタブはもう保存できないので、読み込み直してから「取り込む」で戻してください。' +
      '読み込み直します。'
    );
  }
  if (r.outcome === 'write-failed') {
    return (
      `⚠ 書き戻せませんでした(${r.error ?? '理由は分かりません'})。` +
      `いまダウンロードした ${RESCUE_ARCHIVE_SUFFIX} のファイルを、` +
      '読み込み直したあとに「取り込む」から読み込んでください。'
    );
  }
  const miss: string[] = [];
  if (r.rescued.skipped > 0) miss.push(`読み込めなかった箇所 ${r.rescued.skipped}`);
  if (r.rescued.empty > 0) miss.push(`空だった箇所 ${r.rescued.empty}`);
  // 🔴 打ち切ったときは、拾えた件数を「全部」と読ませない(#1087)
  if (r.rescued.truncated === true) miss.push('読み進められなくなり、途中で打ち切りました');
  const head = `${r.restored} 件を戻しました${miss.length === 0 ? '' : `(${miss.join(' / ')})`}`;
  // 🔑 添付は「触っていない」と言う ── 数ではなく**事実**が知りたい所である
  const kept =
    r.rescued.assets > 0
      ? `。添付 ${r.rescued.assets} 件(${humanBytes(r.rescued.assetBytes)})はそのまま残っています`
      : '';
  // 🔑 つながり・履歴は**戻した件数**で言う。読み切れなかったときは、そう言う(黙って 0 件にしない)
  const back: string[] = [];
  if (r.relationsRestored > 0) back.push(`つながり ${r.relationsRestored} 件`);
  if (r.revisionsRestored > 0) back.push(`履歴 ${r.revisionsRestored} 版`);
  if (r.tagColorsRestored > 0) back.push(`タグの色 ${r.tagColorsRestored} 件`);
  // 🔴 ゴミ箱のノートとメッセージも戻す(台帳 #1852 束 F2 / 依頼 119-1 A)
  if (r.trashRestored > 0) back.push(`ゴミ箱のノート ${r.trashRestored} 件`);
  if (r.systemRestored > 0) back.push('システムのメッセージ');
  const backed = back.length === 0 ? '' : `。${back.join('・')}も戻しました`;
  const lost = r.extrasPartial
    ? '⚠ 読み込めなかったつながり・履歴があり、その分は戻っていません。'
    : '';
  // 🔴 戻らない物は呼び名を `REBUILD_LOST` から引く(押す前の窓と同じ語。§7)
  const never = REBUILD_LOST.length === 0 ? '' : `${REBUILD_LOST.join('・')}は戻りません。`;
  return `${head}${kept}${backed}。${lost}${never}読み込み直します。`;
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
    'いま読めるノートを集めて、ノートの保存データを作り直し、そのまま戻します。',
    '',
    'この順で進みます',
    '・読めるノートを集めて、ファイル(.pkc3-part.zip)にして手元へダウンロードします',
    '・ノートの保存データを作り直します',
    '・集めたノートを、そのまま戻します',
    // 🔑 いちばん怖い所を先に潰す ── 「押したら消える」ではない
    'ファイルをダウンロードできなかったときは、何も消さずに止まります。',
    /**
     * 🔴 **始めたら止められないことを、始める前に言う**(動線レビューが出した)。
     * ⚠ 走り出すと押せる物が 1 つも無いので、**言っていないと「固まった」と読まれる**。
     */
    '⚠ 始めると、途中で止めることはできません。',
    '',
    '残るもの',
    `・いま一覧に出ている ${notes} 件のノート(題名・本文・タグ・チェック)`,
    attach,
    '・設定・見た目・ショートカットキーの割り当て・読んだお知らせの記録',
    // 🔑 読めた分は戻す(#1087。2026-10-14 の実測で、索引だけ壊れた DB はこれらも読めた)
    '・どのフォルダに入っていたか・ノート同士のつながり・履歴(前の版)・タグの色・ゴミ箱のノート・システムのメッセージ(読めた分)',
    '',
    // ⚠ 呼び名は `REBUILD_LOST` から引く ── 終わった後の字と食い違わせない(空なら節ごと出さない)
    ...(REBUILD_LOST.length === 0
      ? []
      : ['戻らないもの', ...REBUILD_LOST.map((x) => `・${x}`), '']),
    /**
     * 🔴 **読めない分は戻らないことを、先に言う**(#1087)。
     *
     * ⚠ 以前は「戻した後は、ノートがフォルダの外の一覧にまとめて並びます」と言っていた
     *   (#1006 の動線レビュー)。つながりを拾って戻すようになったので、並ぶのは
     *   **読めなかった分だけ**になった ── 字を残すと、戻った画面と食い違う。
     */
    '⚠ つながりや履歴の読めない所があるときは、その分は戻りません(戻した後の字に出ます)。',
    // ⚠ 見えている数 ≠ 在る数(壊れているときは一覧そのものが引けていないことがある)
    '⚠ 読めない所があるときは、一覧に出ていない分を集められないことがあります。',
    '',
    // ⚠ 黙って他のタブを読み込み直さない ── 先に言う
    '同じ PKC3 を開いている他のタブも、読み込み直されます。',
  ].join('\n');
}
