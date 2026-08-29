/**
 * effect 層(P3 設計メモ §1): DomainEvent を購読して store I/O を行い、
 * SystemCommand で reducer に還流する。reducer は純粋のまま。
 *
 * **直列化(storage review #5 の解消)**: store への op は 1 本の promise chain に
 * 直列化する。worker handler が将来 async 化しても、app 側から見た op 順序は
 * ここで保証される(「init 以外は同期」という暗黙 invariant に依存しない)。
 */
import type { EntryStamps, EntryUpsert } from '@adapter/platform/storage/schema';
import { extractMeta, type FlavorExtract } from '@features/flavor';
import { PersistOnce, type PersistState } from '@adapter/platform/storage-persist';
// 🔴 追記の楽観検査(#178)── 「読んだ本文」を worker と突き合わせるための指紋
import { contentHash64Hex } from '@adapter/platform/storage/content-hash';
import { appendBlock } from '@features/markdown/text-ops';
import {
  appendIntoSection,
  insertedLines,
  resolveAppendAt,
} from '@features/markdown/append-target';
import { applyBodyRewrite } from '@features/markdown/body-rewrite';
import { clipPreview } from '@features/relation/dual-pane';
import {
  EMPTY_SMART,
  isSmartEmpty,
  readSmartSpec,
  needsRescan,
  smartWriteError,
  smartCondError,
  smartQueryOf,
  withSmartField,
  withSmartTag,
  writeSmartSpec,
  type SmartCondResult,
  type SmartQuery,
  type SmartSpec,
} from '@features/smart/smart-spec';
import { spliceFrontmatterKeys } from '@features/markdown/frontmatter';
import { buildTiles, withBuiltinTiles, type TileSource } from '@features/launcher/tiles';
import type {
  GroupResult as QueryGroups,
  KeyResult as QueryKeys,
} from '@features/query/group-by';
// ⚠ 「未設定」の綴りは features 側の 1 か所(`''`)── ここで書き写さない(§7)
import { TAGS_KEY, UNSET as QUERY_UNSET } from '@features/query/group-by';
import { collectEntryTags } from '@features/flavor/entry-tags';
import { sameTag } from '@features/flavor/tags';
import type { TaskScan } from '@features/schedule/task-cards';
import type { ContactScan } from '@features/contact/contact-card';
import type { SnippetScan } from '@features/snippet/snippet-table';
import type { Relation } from '@core/model/entry-meta';
import type { Dispatcher } from './dispatcher';

/**
 * effect 層が必要とする store 面(test では fake を注入)。
 * persistEntry は**行全体(抽出列込み)**を受け取る ── 抽出は reducer の
 * COMMIT_EDIT が FlavorSpec.extract で行い、PERSIST_ENTRY イベントに載せて
 * 届く(review K の解消)。effect 層は実行時に state を参照しない
 * (時間差窓 C-1 の解消 ── 発火時に確定した行をそのまま書く)。
 */
export interface StorePort {
  getBody(lid: string): Promise<string | null>;
  /**
   * 本文の全文検索(#181)。⚠ **省略可** ── 検索を持たない環境(test の fake や
   * 旧い配線)では題名の絞り込みだけが効く(壊れるのではなく、機能が減るだけ)。
   */
  searchEntries?(query: string): Promise<string[]>;
  /**
   * 🔴 このノートを参照しているノート(#348)。⚠ **optional** ── 古い worker が
   * service worker のキャッシュに残っている端末では未知の op になる。
   */
  findBacklinks?(lid: string): Promise<{ lids: string[]; truncated: boolean }>;
  /**
   * 集計(#184)。⚠ **省略可** ── 持たない環境(test の fake / 旧い配線)では
   * 面が「この版では数えられません」と断るだけで、他は壊れない。
   * ⚠ 返るのは**束ねた結果**だけで、本文は 1 バイトも渡らない。
   * ⚠ 目録と表は **1 回の走査**で返る(`key` が `null` なら表は `null`)。
   */
  queryScan?(key: string | null): Promise<{ keys: QueryKeys; groups: QueryGroups | null }>;
  /**
   * 🔴 **スマートフォルダの中身**(#421 段①)。⚠ **省略可** ── 持たない環境
   * (test の fake / service worker に残った旧い worker)では、その入れ物が
   * 「この版では集められません」と断るだけで、他は壊れない。
   * ⚠ 返るのは **lid と件数**だけで、本文は 1 バイトも渡らない。
   */
  smartScan?(lid: string, query: SmartQuery): Promise<{ lids: string[]; total: number }>;
  /**
   * カンバンの札(#277 段②-b)。⚠ **省略可** ── 持たない環境(test の fake /
   * service worker に残った旧い worker)では面が「集められません」と断る。
   * ⚠ 返るのは**項目だけ**で、本文は 1 バイトも渡らない(worker の中で舐める)。
   */
  taskScan?(): Promise<TaskScan>;
  /**
   * 🔴 **連絡先**(#278 段①)。⚠ **省略可** ── 持たない配線では面が
   * 「集められません」と断る(予定と同じ規律)。
   * ⚠ 返るのは**連絡の手段だけ**で、本文は 1 バイトも渡らない。
   */
  contactScan?(): Promise<ContactScan>;
  /**
   * 🔴 **雛形を集める**(#196 / B-2)。⚠ **省略可** ── 持たない配線では
   * 雛形の機能が丸ごと畳まれる(壊れるのではなく、`/` にも `Tab` にも出ない)。
   */
  snippetScan?(): Promise<SnippetScan>;
  /**
   * 指定した lid の本文を **1 往復で** 取る(P7b review L-7)。
   * ⚠ 無い lid は結果に出ない ── 呼び側は「読めたものだけ」を受け取る。
   */
  getBodies(lids: string[]): Promise<Array<{ lid: string; body: string }>>;
  /**
   * 本文を **まとめて** 取る(P6d ── 書出し用)。
   * `getBody` を N 回呼ぶと 5000 entry の書出しが 5000 往復になる。
   * `maxBytes` は 1 メッセージの合計の目安(1 件目は必ず返る)。
   */
  listBodies(
    after: { entryOrder: number; lid: string } | undefined,
    maxBytes: number,
  ): Promise<{
    rows: Array<{ lid: string; body: string }>;
    done: boolean;
    next?: { entryOrder: number; lid: string };
  }>;
  /**
   * 本文の書込(P5c: 履歴の鎖の維持も worker が同 tx で行う)。
   * `checkpoint: true` = 変更前の body を履歴に 1 件積む。既定(amend)は
   * 履歴を伸ばさず鎖の頭を張り替えるだけ ── toggle / rename はこちら。
   */
  /**
   * ⚠ `parent` を渡すと **同じ tx で居場所も張る**(#258)── 渡さなければ辺に触らない。
   * 作成を 2 手に割ると、その隙にタブを閉じたとき**親だけ飛ぶ**(実測)。
   */
  /**
   * 🔴 **題名だけを書き換える**(#178、2026-08-22)。⚠ optional にしない ──
   * 配線を落としても tsc が黙ると、戻ってくる症状は「改名で別の窓の本文が消える」
   * という**いちばん気づけない形**である(CLAUDE.md §7 の待ちの口と同じ理由)。
   * @returns 行が消えていれば `null`
   */
  renameEntry(lid: string, title: string): Promise<EntryStamps | null>;
  /**
   * 🔴 **並びだけを書き換える**(#178 の残り、2026-08-24)。⚠ optional にしない ──
   * 理由は上と同じで、配線を落としても tsc が黙ると
   * 「並べ替えで別の窓の本文が消える」という**いちばん気づけない形**で戻ってくる。
   * @returns 行が消えていれば `null`
   */
  reorderEntry(lid: string, entryOrder: number): Promise<EntryStamps | null>;
  /**
   * 🔴 **添付の実体を差し替え、参照を書き換える**(#205 / #178 の残り / #212、2026-08-25)。
   *
   * ⚠ **optional にしない** ── 理由は上の 2 つと同じで、配線を落としても tsc が
   * 黙ると「Office で保存すると別の窓の本文が消える」という**いちばん気づけない形**で
   * 戻ってくる。
   * 🔑 **走査も書込も worker の同じ tx** ── 呼び側は本文を 1 バイトも運ばない。
   */
  replaceAssetRefs(input: {
    targetLid: string;
    newKey: string;
    newHash: string | null;
    newBytes: number;
    newName: string;
    newMime: string;
    savedAt: string;
  }): Promise<{
    problem: 'missing-entry' | 'missing-asset' | null;
    unchanged: boolean;
    wrote: Array<{ lid: string; body: string; stamps: EntryStamps }>;
    stale: string[];
    overBudget: boolean;
  }>;
  persistEntry(
    entry: EntryUpsert,
    opts?: {
      checkpoint?: boolean;
      parent?: { parentLid: string | null; relationId: string };
      /**
       * 🔴 **読んだ本文の hash**(#178)。渡すと、行の本文がそれと違っていたら
       * **1 バイトも書かず** `conflict: true` を返す。⚠ 省略時は last-write-wins。
       */
      expectHash?: string;
    },
  ): Promise<EntryStamps>;
  /**
   * trash snapshot を積んで entries から落とす(P5a)。冪等。
   * ⚠ **relations は消さない**(2026-08-05)── 消すとゴミ箱から戻しても
   * 居場所が戻らない。本当の処分は `purgeTrash`。
   */
  deleteEntry(lid: string): Promise<void>;
  /**
   * 居場所を張り替える(フォルダ整理)。`parentLid: null` = ルートへ。
   * ⚠ 1 op = 1 tx ── 「落として張る」を割らない。
   */
  setEntryParent(lid: string, parentLid: string | null, relationId: string): Promise<void>;
  /**
   * 🔴 **関係を作る・書き換える**(#185)。⚠ **省略可** ── 持たない配線
   * (古い test の fake)では関係の追加が効かないだけで、他は動く。
   */
  upsertRelation?(rel: {
    id: string;
    fromLid: string;
    toLid: string;
    kind: string;
  }): Promise<void>;
  /** 🔴 **関係を消す**(#185)。⚠ 冪等(2 回押しても壊れない)。 */
  deleteRelation?(id: string): Promise<void>;
  /**
   * 🔴 **関係を読む**(2026-08-06。ゴミ箱からの復元で居場所を戻すために要る)。
   *
   * `deleteEntry` は relations を消さない(戻せなくなるので)が、**常駐の
   * `state.relations` からは落ちている** ── 復元のときに disk から読み直さないと
   * 「戻したのにフォルダの外に出ている」になる(user 報告 2-9)。
   */
  listRelations(): Promise<Array<{ id: string; kind: string; from_lid: string; to_lid: string }>>;
  listRevisionMetas(entryLid: string): Promise<
    Array<{
      id: string;
      rev_order: number;
      created_at: string | null;
      title: string | null;
      archetype: string | null;
    }>
  >;
  /**
   * 🔴 **版ごとの増減行数**(#398 段①)。⚠ **本文は返らない**(数だけ)。
   * ⚠ `null` = 数えられない(全文で持っている版)。0 と潰さない。
   */
  revisionDiffStats(
    entryLid: string,
  ): Promise<Array<{ id: string; added: number | null; removed: number | null }>>;
  getRevision(revId: string): Promise<{
    body: string;
    title: string | null;
    archetype: string | null;
  } | null>;
  listTrash(): Promise<
    Array<{
      id: string;
      entry_lid: string;
      created_at: string | null;
      title: string | null;
      archetype: string | null;
    }>
  >;
  purgeTrash(): Promise<{ purged: number }>;
}

/**
 * 購読を解く関数。**`settled()` を生やしてある**(呼び側は今までどおり
 * `dispose()` として呼べる)。
 */
export interface StoreEffects {
  (): void;
  /**
   * 🔴 **飛んでいる書込が着地するまで待つ**(2026-08-17 に実測して判明)。
   *
   * 書込はこの層の 1 本の chain に**直列化**されるが、**読みはその外**にある ──
   * `getBody` を直に呼ぶ経路(書き出し)は、chain に並んでいる書込を**追い越す**。
   * 実測(`vite preview` + 実ブラウザ、保存の直後に Word を押す):
   * **11/12 で保存前の本文**が出た(800ms 待つ対照群は 0/12)。
   * 順番はこうだった ── `upsertEntry`(改名)→ **`getBody`(書き出し)** →
   * `upsertEntry`(本文)。改名の書込が 67ms かかる間に読みが割り込んでいる。
   *
   * ⚠ **待つのは「いま並んでいる分」まで**。待っている間に積まれた仕事も
   * 拾うが、上限を置く ── 書き続ける相手(自動保存)で永久に待たない。
   */
  settled(): Promise<void>;
  /**
   * 🔴 **同じ 1 本の chain に、外からの仕事を載せる**(#195 / C-5 段③)。
   *
   * ⚠ **2 本目の待ち口を作らないため**に在る ── 拡張からの書き戻しは
   *   「読んで、古くないか検めて、書く」で、その途中に**アプリ自身の書込が
   *   割り込むと基底が変わる**。`settled()` で待ってから外で走らせても、
   *   待ち終わった直後に新しい書込が積まれれば同じことである
   *   (CLAUDE.md §7「読みは書込を追い越す」の裏返し)。
   * 🔑 だから**載せる**。載せれば順序は chain が保証する。
   *
   * ⚠ **失敗は呼び側へ返す**(chain は止めない)── ここで throw を飲むと、
   *   拡張は「書けたのか断られたのか」を永久に知れない。
   */
  run<T>(job: () => Promise<T>): Promise<T>;
}

/** `settled()` が待つ最大の巡回数(積まれ続ける相手で永久に待たないための上限)。 */
const SETTLE_ROUNDS_MAX = 20;

export function connectStoreEffects(
  dispatcher: Dispatcher,
  store: StorePort,
  opts: {
    /**
     * Office 一式が入っているか(#148 の組み込みタイル)。
     * ⚠ 同期で答えられる控え(`appOfficePack.isInstalled` 相当)を渡す。
     * 既定 false = 組み込みタイルを出さない(test の既存呼び出しを変えない)。
     */
    officeInstalled?: () => boolean;
    /**
     * 🔴 保存を「消えない」側へ置いてもらう係(#347)。
     * ⚠ 既定は `navigator.storage` ── **test では持たない環境が普通**なので、
     *   その場合 `unsupported` になって何も起きない(既存の呼び出しを変えない)。
     */
    persist?: PersistOnce;
  } = {},
): StoreEffects {
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;
  const officeInstalled = opts.officeInstalled ?? ((): boolean => false);
  /**
   * 🔑 タイル一覧の**出口は 1 つ**(CLAUDE.md §7「同じ値を複数の経路へ渡すものは
   * 経路ごとに pin する」の予防形)── 組み込み分の合流を dispatch 側 2 か所へ
   * 書き写さず、ここで 1 度だけ決める。
   */
  const dispatchTiles = (sources: readonly TileSource[]): void => {
    if (disposed) return;
    dispatcher.dispatch({
      type: 'LAUNCHER_TILES_LOADED',
      tiles: withBuiltinTiles(buildTiles(sources), { office: officeInstalled() }),
    });
  };

  /** 全 store op を単一 chain に直列化(順序保証)。op の失敗は chain を殺さない。 */
  const enqueue = (op: () => Promise<void>): void => {
    queue = queue.then(op, op);
  };

  /**
   * 🔑 **書込が返した時刻を state へ流す**(P9 段①)。
   *
   * ⚠ `persistEntry` を呼ぶ**すべての経路**がこれを通ること ── 通し忘れた経路だけ
   * 情報列が「—」に戻る(それが元のバグだった)。`tests/adapter/entry-timestamps.test.ts`
   * が経路ごとに pin している。
   * ⚠ 呼ぶのは **meta を差し替える action の後** ── `ENTRY_RESTORED` のように
   * meta を丸ごと置き換える action が後に来ると、刻んだ時刻が消える
   */
  /**
   * 🔴 **最初の書込が通った所で、永続化を 1 度だけ頼む**(#347、2026-08-23)。
   *
   * ⚠ **boot では頼まない** ── 初回訪問はまだ何も持っていないので、
   *   ブラウザが尋ねる実装では**断る理由しかない瞬間**に聞くことになる。
   * 🔑 ここ(保存の ack)は**全部の書込経路が通る 1 か所**である ──
   *   経路ごとに書くと、必ずどれかが漏れる(#347 がまさにその形だった:
   *   Office 一式の経路にだけ入っていた)。
   * ⚠ 回数は `PersistOnce` が持つ ── ここは書込のたびに呼ぶ。
   */
  const persistOnce = opts.persist ?? new PersistOnce(globalThis.navigator?.storage);
  /**
   * 🔴 **分かったら画面へ伝える**(#347、user 裁定 2026-08-23「気になるから見るだけで」)。
   *
   * ⚠ **`unknown` を弾く門は置かない。** 1 稿目は置いたが、変異試験で
   *   **等価変異**(外しても何も壊れない)と分かった ── 同値を捨てるのは
   *   reducer の仕事で、そちらに既に在る。⚠ 「これが無いと壊れる」と書く前に
   *   外して壊れるのを見る(CLAUDE.md §1。`min-height: 0` と同じ型)。
   */
  const tellPersist = (st: PersistState): void => {
    if (disposed) return;
    dispatcher.dispatch({ type: 'PERSIST_STATE', state: st });
  };
  /**
   * ⚠ **起動時は「尋ねずに聞く」だけ**(`persisted()`)── ブラウザが user に
   * 尋ねることは無いので、ここで呼んでよい。頼む側(`persist()`)は
   * **最初の書込のとき**である(下の `stamp`)。
   */
  void persistOnce.probe().then(tellPersist);

  /**
   * 🔴 **列の条件を持つスマートフォルダは、行を書くたびに集め直す**(#421 段②)。
   *
   * ⚠ タグだけの入れ物は reducer が**その場で**当て直せる(新しい本文が在る)が、
   *   **「更新が N 日以内」は保存した瞬間に変わる**し、`archetype` / `created_at` /
   *   `date` は本文からは決まらない ── 手で継ぎ足すと嘘になる。
   * ⚠ **語の条件も同じ**(段③)── 当てるのは SQL 1 か所である(§7)。
   * 🔑 **ここは「行を書いた」唯一の口である**(`stamp`)── 書く経路の数と
   *   刻む数が一致することを `tests/adapter/entry-timestamps.test.ts` が機械で見ている。
   *   だから 1 か所で足りる(経路ごとに書かない ── §7)。
   * ⚠ 頼みは `REQUEST_SMART_SCAN` 側で**列の中で 1 つに畳む** ── まとめて 100 件に
   *   タグを付けた回に、全件走査が 100 回走らないように。
   */
  /** 走査を頼んだが、まだ走り出していない入れ物(`REQUEST_SMART_SCAN` の畳み込み)。 */
  const queuedScans = new Set<string>();

  const rescanColumnSmarts = (): void => {
    for (const [smartLid, hit] of dispatcher.getState().smartHits) {
      if (hit.failed || !needsRescan(hit.spec)) continue;
      dispatcher.dispatch({ type: 'SMART_RESCAN', lid: smartLid });
    }
  };

  /**
   * 🔴 **スマートフォルダの条件を本文へ書く、唯一の道**(#421 段①②)。
   *
   * 🔑 タグ(`REQUEST_SMART_COND`)も列の条件(`REQUEST_SMART_FIELD`)も**ここ**を通る
   *   ── 道を 2 本作ると、片方だけ `expectHash` を落とす / 片方だけ刻みを流さない、
   *   が静かに起きる(§7)。
   * ⚠ 書き換えは**原文 splice**(`writeSmartSpec`)── 説明文も他の key も無傷。
   * ⚠ 変わらないとき(既に在る / 元から無い)は**書かないが集め直す**
   *   ── user は押しているので、いまの当たりを出す。
   * ⚠ 受けられなかったときは**なぜ**を出す(黙って捨てない)。
   */
  const writeSmartCond = (
    t: { lid: string; title: string; archetype: string; entryOrder: number },
    apply: (spec: SmartSpec) => SmartCondResult,
  ): void => {
    enqueue(async () => {
      if (disposed) return;
      try {
        const body = await store.getBody(t.lid);
        if (disposed || body === null) return;
        const res = apply(readSmartSpec(body));
        if (!res.ok) {
          const why = smartCondError(res.reason);
          if (why !== null) dispatcher.dispatch({ type: 'OP_FAILED', error: why });
          else dispatcher.dispatch({ type: 'SMART_RESCAN', lid: t.lid });
          return;
        }
        const newBody = writeSmartSpec(body, res.spec);
        const ext = extractMeta(t.archetype, newBody);
        const stamps = await store.persistEntry(
          {
            lid: t.lid,
            title: t.title,
            archetype: t.archetype,
            body: newBody,
            entryOrder: t.entryOrder,
            status: ext.status,
            date: ext.date,
            archived: ext.archived,
          },
          { expectHash: contentHash64Hex(body) },
        );
        if (disposed) return;
        // ⚠ **刻みを流す** ── 流さないと、条件を直しても一覧の「更新」が古いまま
        //   (`tests/adapter/entry-timestamps.test.ts` が経路の数で機械的に見る)
        stamp(t.lid, stamps);
        dispatcher.dispatch({ type: 'SMART_RESCAN', lid: t.lid });
      } catch {
        if (!disposed)
          dispatcher.dispatch({ type: 'OP_FAILED', error: '条件を書き換えられませんでした' });
      }
    });
  };

  const stamp = (lid: string, s: EntryStamps): void => {
    if (disposed) return;
    void persistOnce.ensure().then(tellPersist);
    dispatcher.dispatch({
      type: 'ENTRY_STAMPED',
      lid,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    rescanColumnSmarts();
  };

  const unsubscribe = dispatcher.onEvent((ev) => {
    switch (ev.type) {
      /**
       * 🔴 **本文の全文検索**(#181)。⚠ **直列 queue に載せない** ── 打鍵ごとに
       * 走るので、載せると保存・本文読込がその後ろに詰まる(体感の主因になる)。
       * 遅れて返った結果は reducer が `query` で捨てるので、順序保証は要らない。
       */
      case 'REQUEST_SEARCH': {
        const search = store.searchEntries;
        if (!search || ev.query.trim() === '') break;
        const q = ev.query;
        void search(q).then(
          (lids) => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'SET_SEARCH_HITS', query: q, lids });
          },
          () => {
            /* ⚠ 検索の失敗で帯を出さない ── 題名の絞り込みは効いたままで、
               user の操作は止まっていない(黙って減るのは「増えない」方向) */
          },
        );
        break;
      }
      /**
       * 🔴 **このノートを参照しているのはどれか**(#348)。
       * ⚠ **直列 queue に載せない**(検索と同じ)── 選ぶたびに走るので、
       *   載せると保存・本文読込がその後ろに詰まる。
       * ⚠ 遅れて返った答えは reducer が `lid` で捨てるので、順序保証は要らない。
       */
      case 'REQUEST_BACKLINKS': {
        const ask = store.findBacklinks;
        // ⚠ 古い worker(未知の op)では**何も出さない** ── 帯は出さない。
        //    「参照しているノート」は付随情報で、操作は止まっていない
        if (!ask) break;
        const lid = ev.lid;
        void ask(lid).then(
          (r) => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'BACKLINKS_LOADED', lid, ...r });
          },
          () => {
            /* ⚠ 失敗しても黙る(付随情報なので、user の操作は止まっていない) */
          },
        );
        break;
      }
      /**
       * 🔴 **スマートフォルダの中身を集める**(#421 段①)。
       *
       * 🔑 **条件はここで読む** ── reducer は本文を持っていないので、
       *   `getBody` → `readSmartSpec` → `smartScan` の 3 手になる。
       *   ⚠ 読む口は `readSmartSpec` **1 本**(§7)。
       * 🔑 **同じ `enqueue` の列に並べる** ── 列の外で `getBody` を呼ぶと、
       *   並んでいる書込を追い越して**保存前の条件**で集める(2026-08-17 の形)。
       * ⚠ 集められない版では**黙らない** ── 面が「集めています…」のまま
       *   永久に止まって見えるのが最悪である(`REQUEST_QUERY_SCAN` と同じ規律)。
       */
      /**
       * 🔴 **スマートフォルダの条件のタグを、選んだノートへ足す / 外す**(#421 段①)。
       *
       * 🔑 **条件はその場で本文から読む** ── 憶えている値(`smartHits.tags`)で
       *   書くと、本文を直に書き換えた直後に**違うタグ**を付ける。
       * 🔑 **書くのは既にある口**(`BULK_TAG`)── タグを本文へ書く規則を
       *   2 つ作らない(§7)。条件が 2 つなら 2 回撃つ。
       * ⚠ 条件が 1 つも無いときは**断る** ── 黙って何もしないと、落とした user は
       *   「入ったはずなのに出てこない」を見る。
       */
      case 'REQUEST_SMART_TAGS': {
        const smartLid = ev.smartLid;
        const lids = [...ev.lids];
        const mode = ev.mode;
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(smartLid);
            if (disposed) return;
            const spec = body === null ? EMPTY_SMART : readSmartSpec(body);
            /**
             * 🔴 **書けない条件しか無いなら、理由を出して止まる**(#421 段②の穴)。
             * ⚠ 直す前は「条件が 1 つも無い」ときしか断っておらず、
             *   **タグを 1 つも持たない入れ物**(「更新が 30 日以内」だけ、など)へ
             *   落とすと**付けるタグが 0 個 = 無言で何も起きなかった**
             *   (2026-08-26 に対照群つきで実測)。
             * 🔑 判定と文言は `smartWriteError` が 1 か所で持つ ── 落とす口と
             *   「ここから外す」口の両方がここを通るので、書き分けない(§7)。
             */
            const refusal = smartWriteError(spec, mode);
            if (refusal !== null) {
              dispatcher.dispatch({ type: 'OP_FAILED', error: refusal });
              return;
            }
            for (const tag of spec.tags) dispatcher.dispatch({ type: 'BULK_TAG', lids, tag, mode });
            /**
             * 🔑 **書いた後に集め直す** ── 同じ `enqueue` の列に並ぶので、
             *   上の書込が終わってから走る(古い本文で集めることはない)。
             * ⚠ 集め直さないと、落とした user は「入れたのに出てこない」を見る。
             */
            dispatcher.dispatch({ type: 'SMART_RESCAN', lid: smartLid });
          } catch {
            if (!disposed)
              dispatcher.dispatch({ type: 'OP_FAILED', error: 'タグを書き換えられませんでした' });
          }
        });
        break;
      }
      /**
       * 🔴 **スマートフォルダの条件を本文へ書く**(#421 段①)。
       *
       * 🔑 書き終えたら**その場で集め直す** ── 条件だけ変わって並びが古いままだと、
       *   user は「効いていない」と読む。⚠ 順番が要るので、同じ `enqueue` の中で続ける。
       * ⚠ 書き換えは**原文 splice**(`writeSmartSpec`)── 説明文も他の key も無傷。
       * ⚠ 変わらないとき(既に在る / 元から無い)は**書かない**が、黙って終える
       *   (赤い帯にしない ── `REQUEST_BULK_TAG` と同じ扱い)。
       */
      case 'REQUEST_SMART_COND': {
        const t = ev.target;
        const tag = ev.tag;
        const mode = ev.mode;
        writeSmartCond(t, (spec) => withSmartTag(spec, tag, mode));
        break;
      }
      /**
       * 🔴 **列で引く条件を書く**(#421 段②)── タグと**同じ書込の道**を通す。
       * ⚠ 道を 2 本作ると、片方だけ `expectHash` を落とす / 片方だけ刻みを流さない、
       *   が静かに起きる(§7)。
       */
      case 'REQUEST_SMART_FIELD': {
        const t = ev.target;
        const field = ev.field;
        const value = ev.value;
        writeSmartCond(t, (spec) => withSmartField(spec, field, value));
        break;
      }
      case 'REQUEST_SMART_SCAN': {
        const ask = store.smartScan;
        if (!ask) {
          dispatcher.dispatch({ type: 'SMART_SCAN_FAILED', lid: ev.lid });
          break;
        }
        const lid = ev.lid;
        /**
         * 🔴 **同じ入れ物の走査が列に居るなら、積み増さない**(#421 段②)。
         * ⚠ まとめて 100 件にタグを付けると、書くたびに集め直しが飛ぶ ──
         *   畳まないと**全件走査が 100 回**走る。
         * 🔑 走り出したら外す(下)── 走っている最中に届いた書込は
         *   **その走査が読み逃している**ので、次の 1 本を積む必要がある。
         */
        if (queuedScans.has(lid)) break;
        queuedScans.add(lid);
        enqueue(async () => {
          queuedScans.delete(lid);
          if (disposed) return;
          try {
            const body = await store.getBody(lid);
            if (disposed) return;
            // ⚠ 入れ物ごと消えていた ── 集められないのではなく、頼む相手がいない
            if (body === null) {
              dispatcher.dispatch({ type: 'SMART_SCAN_FAILED', lid });
              return;
            }
            const spec = readSmartSpec(body);
            /**
             * 🔴 **条件が 0 件なら worker を呼ばない**(変異試験 S5 が教えた)。
             *
             * ⚠ 呼ぶと **entries を 500 件ずつ全部舐めて 0 件が返る** ──
             *   `matchesSmart` が空を false にするので当たりようがない走査である。
             * ⚠ そしてこれは**作った直後のスマートフォルダの姿**である
             *   (条件はまだ空)── つまり「作って開く」たびに全件走査が走る。
             * 🔑 画面は変わらない ── 空の当たりを置けば帯が
             *   「条件を選んでください」を出す(`renderSmartBar`)。
             */
            if (isSmartEmpty(spec)) {
              dispatcher.dispatch({
                type: 'SMART_SCANNED',
                lid,
                lids: [],
                total: 0,
                spec: EMPTY_SMART,
              });
              return;
            }
            /**
             * ⚠ **境目の時刻はここで作る**(#421 段②)── worker に時計を持ち込むと、
             *   走らせるたびに答えが変わって test が書けない。
             */
            const out = await ask(lid, smartQueryOf(spec, Date.now()));
            if (disposed) return;
            // 🔑 **効いていた条件も返す** ── 画面が「何で絞っているか」を出すのに要る
            //    (reducer も描く側も本文を持たないので、ここでしか渡せない)
            dispatcher.dispatch({
              type: 'SMART_SCANNED',
              lid,
              lids: out.lids,
              total: out.total,
              spec,
            });
          } catch {
            if (!disposed) dispatcher.dispatch({ type: 'SMART_SCAN_FAILED', lid });
          }
        });
        break;
      }
      case 'REQUEST_QUERY_SCAN': {
        const ask = store.queryScan;
        /**
         * 🔴 **持っていないことを画面へ伝える**(レビュー B-5)。⚠ 黙って break すると
         * 面は「数えています…」を出したまま**永久に止まって見える** ── 落ち方は
         * 「機能が減る」でなければならない(古い worker が service worker の
         * キャッシュに残っている端末では、未知の op が reject で返る)。
         */
        if (!ask) {
          dispatcher.dispatch({ type: 'QUERY_FAILED' });
          break;
        }
        const key = ev.key;
        void ask(key).then(
          (out) => {
            if (disposed) return;
            // ⚠ どの束ね方の答えかを載せる ── reducer が古い結果を捨てる
            dispatcher.dispatch({ type: 'SET_QUERY_SCAN', key, keys: out.keys, groups: out.groups });
          },
          () => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'QUERY_FAILED' });
          },
        );
        break;
      }
      /**
       * 🔴 **タグの候補を集める**(#494 段②)。
       *
       * 🔑 **口は集計と同じ**(`queryScan('tags')`)── タグを数える走査を 2 本
       *   作らない(§7)。返るのは**値と件数だけ**で、本文は 1 バイトも渡らない。
       * ⚠ 持っていない配線(古い worker が service worker に残っている端末)では
       *   **候補が出ないだけ**にする ── 打つこと自体は動く(機能が減る側へ落ちる)。
       *   そのとき `SET_TAG_SUGGESTIONS` に**空を渡す** ── 渡さないと `null` のまま
       *   なので、焦点が当たるたびに頼み直して**毎回 reject を待つ**ことになる。
       */
      case 'REQUEST_TAG_SUGGESTIONS': {
        const ask = store.queryScan;
        if (!ask) {
          dispatcher.dispatch({ type: 'SET_TAG_SUGGESTIONS', tags: [] });
          break;
        }
        // 🔑 綴りは `TAGS_KEY` 1 か所(#550 段④ ── 候補と集計が同じ組を見る)
        void ask(TAGS_KEY).then(
          (out) => {
            if (disposed) return;
            /**
             * ⚠ **「未設定」の組を捨てる** ── `createQueryScan` は tags を持たない
             *   ノートを 1 つの組にまとめて返す。候補に出すと、押した瞬間に
             *   その字がタグとして本文へ入る。
             * 🔑 並びは `queryScan` が既に**件数の多い順**にしている ── ここで
             *   並べ直さない(2 か所で並べると、集計の面と候補で順が食い違う)。
             */
            const tags = (out.groups?.groups ?? [])
              .map((g) => g.value)
              .filter((v) => v !== QUERY_UNSET);
            /**
             * ⚠ **切った件数を黙って捨てない** ── `queryScan` は組の数に上限を
             *   持つ(`omittedGroups`)。候補が全部でないことは、下の
             *   `<datalist>` の作り(打った字はそのまま通る)が吸収する ──
             *   候補は**近道**であって、打てる語の一覧ではない。
             */
            dispatcher.dispatch({ type: 'SET_TAG_SUGGESTIONS', tags });
          },
          () => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'SET_TAG_SUGGESTIONS', tags: [] });
          },
        );
        break;
      }
      case 'REQUEST_TASK_SCAN': {
        const ask = store.taskScan;
        /**
         * 🔴 **持っていないことを画面へ伝える**(集計 #184 と同じ落ち方)。
         * ⚠ 黙って break すると、盤面は「集めています…」で**永久に止まって見える**。
         */
        if (!ask) {
          dispatcher.dispatch({ type: 'TASK_SCAN_FAILED' });
          break;
        }
        void ask().then(
          (scan) => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'SET_TASK_SCAN', scan });
          },
          () => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'TASK_SCAN_FAILED' });
          },
        );
        break;
      }
      /**
       * 🔴 **連絡先を集める**(#278 段①)。⚠ 予定(`REQUEST_TASK_SCAN`)と**同じ形**
       *   ── 持っていないことは**画面へ伝える**(黙って break すると
       *   「集めています…」で永久に止まって見える)。
       */
      case 'REQUEST_CONTACT_SCAN': {
        const ask = store.contactScan;
        if (!ask) {
          dispatcher.dispatch({ type: 'CONTACT_SCAN_FAILED' });
          break;
        }
        void ask().then(
          (scan) => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'SET_CONTACT_SCAN', scan });
          },
          () => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'CONTACT_SCAN_FAILED' });
          },
        );
        break;
      }
      /**
       * 🔴 **雛形を集める**(#196 / B-2)。⚠ 予定(`REQUEST_TASK_SCAN`)と**同じ形**だが、
       *   失敗の出し方だけ違う ── 雛形は**入力の補助**なので、出せないときは
       *   `null` を渡して**静かに畳む**(打っている最中に帯を出さない)。
       */
      case 'REQUEST_SNIPPET_SCAN': {
        const askSnippets = store.snippetScan;
        if (!askSnippets) {
          dispatcher.dispatch({ type: 'SET_SNIPPET_SCAN', scan: null });
          break;
        }
        void askSnippets().then(
          (scan) => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'SET_SNIPPET_SCAN', scan });
          },
          () => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'SET_SNIPPET_SCAN', scan: null });
          },
        );
        break;
      }
      case 'REQUEST_BODY':
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) {
              // schema 上 body は NOT NULL ── null は「行が存在しない」異常系。
              // 空 body に見せかけない(S3 の芽を摘む ── review C')
              dispatcher.dispatch({
                type: 'BODY_LOAD_FAILED',
                lid: ev.lid,
                error: 'entry row missing',
              });
              return;
            }
            dispatcher.dispatch({ type: 'BODY_LOADED', lid: ev.lid, body });
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'BODY_LOAD_FAILED',
                lid: ev.lid,
                error: String(e),
              });
          }
        });
        break;
      /**
       * 🔴 **2 ペインの下見の本文を読む**(#273 残件)。
       *
       * 🔑 **同じ `enqueue` の列に並べる** ── `getBody` を列の外で呼ぶと、
       *   並んでいる書込を追い越して**保存前の本文**を映す(2026-08-17 に踏んだ形)。
       * ⚠ **ここで切る**(`clipPreview`)── 切らずに state へ渡すと、
       *   カーソルを合わせただけで長い本文がそのまま常駐する。
       * ⚠ **読めなかったら黙って終える** ── 下見は補助なので、失敗を帯に出すと
       *   フォルダを送るたびに赤い字が出ることになる(user は何もできない)。
       */
      /**
       * 🔴 **留めた枠の本文を読む**(#505 段②)。
       *
       * ⚠ 下見(`REQUEST_DUAL_PREVIEW`)と違い、**切り詰めない** ── 枠に出るのは
       * 「読むための本文」そのものであり、途中で切れたら並べる意味が無い。
       * 🔑 読む口は同じ `store.getBody`、**同じ直列の列**に並べる(2026-08-17 の
       * 「読みが書込を追い越す」を繰り返さない)。
       */
      case 'REQUEST_SPLIT_BODY':
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            /**
             * 🔴 **入れ物ごと消えていたら、留めを外す**(自己修復)。
             * ⚠ 黙って空の枠を出し続けない ── user から見れば「開かない枠」である。
             * 🔑 `SPLIT_RESTORED` が知らない lid を落とさないのは、ここが拾うからである。
             */
            if (body === null) {
              dispatcher.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: ev.lid });
              return;
            }
            dispatcher.dispatch({ type: 'SPLIT_BODY_LOADED', lid: ev.lid, body });
          } catch {
            // ⚠ 読めなかっただけ ── 留めは外さない(次に開いたときにもう一度読む)
          }
        });
        break;
      case 'REQUEST_DUAL_PREVIEW':
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(ev.lid);
            if (disposed || body === null) return;
            dispatcher.dispatch({
              type: 'DUAL_PREVIEW_LOADED',
              lid: ev.lid,
              body: clipPreview(body),
            });
          } catch {
            // 下見が出ないだけ ── 画面は行の一覧のまま使える
          }
        });
        break;
      case 'PERSIST_ENTRY':
        enqueue(async () => {
          if (disposed) return;
          try {
            const stamps = await store.persistEntry(ev.entry, {
              checkpoint: ev.checkpoint === true,
              // ⚠ 居場所が在るなら**同じ tx で**書かせる(#258)
              ...(ev.parent ? { parent: ev.parent } : {}),
            });
            /**
             * 🔴 **旧ビルドのタブが本体だと `parent` は黙って無視される**
             * (着地前レビュー ⚠-2)。名乗らなかったときだけ 2 手へ落ちる ──
             * ⚠ 新しい worker では**常に名乗る**ので、この追い撃ちは走らない。
             */
            if (ev.parent && stamps.parentWritten !== true) {
              await store.setEntryParent(ev.entry.lid, ev.parent.parentLid, ev.parent.relationId);
            }
            if (!disposed)
              dispatcher.dispatch({
                type: 'BODY_PERSISTED',
                lid: ev.entry.lid,
                body: ev.entry.body,
              });
            stamp(ev.entry.lid, stamps);
          } catch (e) {
            if (!disposed) dispatcher.dispatch({ type: 'SYS_ERROR', error: String(e) });
          }
        });
        break;
      case 'REQUEST_DELETE':
        enqueue(async () => {
          if (disposed) return;
          try {
            await store.deleteEntry(ev.lid);
          } catch (e) {
            // UI からは既に消えている(楽観)── 失敗は通知し、reload で再出現する
            // (非破壊側に倒れる)
            if (!disposed)
              dispatcher.dispatch({ type: 'OP_FAILED', error: String(e) });
          }
        });
        break;
      case 'REQUEST_SET_PARENT':
        enqueue(async () => {
          if (disposed) return;
          try {
            await store.setEntryParent(ev.lid, ev.parentLid, ev.relationId);
          } catch (e) {
            // ⚠ 画面は既に動かしている(楽観)── 失敗は**必ず言う**。
            //    黙ると「移したつもりで disk は元のまま」になり、次の再読込で戻る
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `居場所を変えられませんでした: ${String(e)}`,
              });
          }
        });
        break;
      case 'REQUEST_RENAME':
        // read→write を 1 op に(同一 lid の先行 persist の後に読む)。
        // body は disk が正 ── 編集中 draft には触れない
        enqueue(async () => {
          if (disposed) return;
          try {
            /**
             * 🔴 **本文を読まない。書き戻さない**(#178、2026-08-22)。
             *
             * ⚠ 直す前は `getBody` → 題名を差し替えて**行全体を書く**形だった ──
             * 読んでから書くまでの間に**別のタブ / 窓が本文を書いていると消える**。
             * しかも本文は変わらないので `maintainChain` は呼ばれず、
             * **履歴にも残らない**(= 上書きされた版はどこからも戻せない)。
             * 🔑 衝突を*検出する*のではなく、**起こらなくする** ── 触らなければよい。
             * ⚠ 抽出列(status / date / archived)も本文由来なので触らない。
             */
            const stamps = await store.renameEntry(ev.lid, ev.title);
            if (disposed) return;
            if (stamps === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `rename: entry row missing (${ev.lid})`,
              });
              return;
            }
            stamp(ev.lid, stamps);
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({ type: 'OP_FAILED', error: String(e) });
          }
        });
        break;
      /**
       * 🔴 **関係を disk へ**(#185)。⚠ port が持っていない配線(古い fake)では
       *   **黙って何もしない** ── 落とすと画面ごと止まるので、機能が減るだけにする。
       * ⚠ 失敗したら**画面へ言う** ── 常駐 state には既に足してあるので、
       *   黙ると「画面には在るが disk に無い」が残る。
       */
      case 'REQUEST_RELATION_UPSERT': {
        const upsert = store.upsertRelation?.bind(store);
        if (!upsert) break;
        enqueue(async () => {
          if (disposed) return;
          try {
            await upsert({ id: ev.id, fromLid: ev.fromLid, toLid: ev.toLid, kind: ev.kind });
          } catch (e) {
            dispatcher.dispatch({ type: 'OP_FAILED', error: `関係を保存できません: ${String(e)}` });
          }
        });
        break;
      }
      case 'REQUEST_RELATION_DELETE': {
        const remove = store.deleteRelation?.bind(store);
        if (!remove) break;
        enqueue(async () => {
          if (disposed) return;
          try {
            await remove(ev.id);
          } catch (e) {
            dispatcher.dispatch({ type: 'OP_FAILED', error: `関係を消せません: ${String(e)}` });
          }
        });
        break;
      }
      case 'REQUEST_REORDER':
        /**
         * 🔴 **並べ替えを disk へ**(2026-08-06。user 報告 2-10)。
         *
         * ⚠ 形は `REQUEST_RENAME` と同じ read→write(本文は disk が正)。
         * ⚠ **1 件ずつ enqueue する** ── 2 件を 1 つの async にまとめると、
         *   片方が落ちたときにもう片方だけ disk へ通り、**並びが壊れた形**で残る
         *   (交換なので片側だけでは順序が表現できない)。直列 queue なので
         *   順番は保たれる。
         */
        for (const row of ev.entries) {
          enqueue(async () => {
            if (disposed) return;
            try {
              /**
               * 🔴 **本文に触らない**(#178 の残り、2026-08-24)。
               *
               * ⚠ 直す前は `getBody` → **本文ごと書き戻す**形だった ── 改名が
               * 踏んでいたのと**同じ穴**である。読んでから書くまでの間に別のタブ /
               * 窓が本文を書いていると、それを消す。しかも `checkpoint` を渡さない
               * ので **amend** になり、**履歴にも残らない**
               * (実測: `storage-worker.test.ts`「expectHash を渡さなければ…」)。
               * 🔑 並べ替えは**本文を必要としていない** ── 触らなければ、
               * 衝突しうる状態そのものが消える(検出ではなく消滅)。
               */
              const stamps = await store.reorderEntry(row.lid, row.entryOrder);
              if (disposed) return;
              if (stamps === null) {
                dispatcher.dispatch({
                  type: 'OP_FAILED',
                  error: `並べ替え: entry が見つかりません(${row.lid})`,
                });
                return;
              }
              stamp(row.lid, stamps);
            } catch (e) {
              // ⚠ 画面は既に動かしている(楽観)── 失敗は必ず言う
              if (!disposed)
                dispatcher.dispatch({
                  type: 'OP_FAILED',
                  error: `並べ替えを保存できませんでした: ${String(e)}`,
                });
            }
          });
        }
        break;
      case 'REQUEST_TILE_UPDATE':
        enqueue(async () => {
          if (disposed) return;
          // ⚠ **どの出口でもロックを解く**(P8 段⑯)── 握ったままにすると
          //    user は二度と設定を変えられず、しかも理由が分からない
          const fail = (): void => {
            if (!disposed)
              dispatcher.dispatch({ type: 'APP_TILE_SAVED', lid: ev.lid, gen: ev.gen, body: null });
          };
          try {
            // 🔴 **disk から読んで書き戻す**(P8 段⑭)。state の body を使わない ──
            //    添付は開いていないことのほうが多く、開いていても古いことがある
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: 'アプリの設定を変えられません(ノートが見つかりません)',
              });
              return fail();
            }
            // ⚠ **原文 splice**で書き換える ── 全文を組み直すと、本文・他の key・
            //    空行が byte 単位で変わる(この repo の規律)
            const next = spliceFrontmatterKeys(body, ev.updates);
            if (next === body) return fail(); // 変わらないなら書かない(ロックは解く)
            const ext = extractMeta(ev.archetype, next);
            /**
             * 🔴 **読んでから書くまでの間に別の窓が書いていたら、1 バイトも書かない**
             * (#178 残り、2026-08-23)── 上の `REQUEST_BODY_REWRITE` と同じ理由。
             * ⚠ `expectHash` を渡さない書込は amend なので、消した版は**履歴にも
             * 入らない**(実測:`storage-worker.test.ts`)。
             * 🔑 ⚠ **どの出口でもロックを解く**(P8 段⑯)── 断る側も `fail()` を通る。
             */
            const stamps = await store.persistEntry(
              {
                lid: ev.lid,
                title: ev.title,
                archetype: ev.archetype,
                body: next,
                entryOrder: ev.entryOrder,
                status: ext.status,
                date: ext.date,
                archived: ext.archived,
              },
              { expectHash: contentHash64Hex(body) },
            );
            if (stamps.conflict === true) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error:
                  '別の窓がこのノートを書き替えたため、設定を保存できませんでした(もう一度押してください)',
              });
              return fail();
            }
            if (disposed) return;
            // ⚠ 書いたら**その場で読み直す** ── 読み直さないと、押した結果が
            //    ランチャーに出るのが「次にタブを開き直したとき」になる
            dispatcher.dispatch({ type: 'APP_TILE_SAVED', lid: ev.lid, gen: ev.gen, body: next });
            stamp(ev.lid, stamps);
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `アプリの設定を保存できませんでした: ${String(e)}`,
              });
            fail();
            return;
          }
          // 🔴 **ack のあとの仕事は別の try**(P8 段㉕)。同じ try に入れていた
          //    ときは、ここが落ちると catch の `fail()` が **2 回目の
          //    `APP_TILE_SAVED`** を撃ち、受け側の計数(`tileWrite.n`)が
          //    1 要求で 2 減っていた ── 連続で 2 つ設定を変えると、2 本目が
          //    飛んでいるのに `tileWrite` が null になって編集へ入れてしまい、
          //    保存で 2 本目の書き戻しの上に旧本文が乗って**設定が黙って消える**
          //    (段⑯ が `tileWrite` を入れて塞いだ H-1 と同型)。
          // ⚠ 読み直しの失敗は **OP_FAILED だけ**で終える(ロックには触らない)
          try {
            // ⚠ 書いたら**その場で読み直す** ── 読み直さないと、押した結果が
            //    ランチャーに出るのが「次にタブを開き直したとき」になる
            const titles = new Map(ev.entries.map((e) => [e.lid, e.title]));
            const rows = await store.getBodies(ev.entries.map((e) => e.lid));
            if (disposed) return;
            const sources: TileSource[] = [];
            for (const row of rows) {
              const title = titles.get(row.lid);
              if (title !== undefined) sources.push({ lid: row.lid, title, body: row.body });
            }
            dispatchTiles(sources);
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `アプリの一覧を読み直せませんでした: ${String(e)}`,
              });
          }
        });
        break;
      case 'REQUEST_ASSET_REPLACE':
        enqueue(async () => {
          if (disposed) return;
          try {
            /**
             * 🔴 **走査も書込も worker の 1 tx**(#205 / #178 の残り / #212、2026-08-25)。
             *
             * ⚠ 直す前はここが `listBodies` で**全ノートの本文を主スレッドへ運び**、
             * `planSaveBack` を掛け、`persistEntry` を**1 件ずつ**呼んでいた。
             * 読んでから書くまでの間に別のタブ / 窓が書くと**それを消し**、
             * `checkpoint` を渡していないので **amend** = **履歴にも残らない**
             * ── 改名 / 並べ替えで塞いだ穴と**まったく同じ形**である(#178)。
             * 🔑 **本文に触る仕事ごと worker へ渡せば、衝突しうる状態が消える**
             *   (検出ではなく消滅 ── 断りもやり直しも要らない)。
             * 🔑 ついでに **#212** も消える ── 全ノートの走査が主スレッドから出るので、
             *   user が字を打っている最中に飛び込まなくなった
             *   (⚠ **速くなったとは言わない**。動いたのは**場所**である)。
             */
            const r = await store.replaceAssetRefs({
              targetLid: ev.targetLid,
              newKey: ev.newKey,
              newHash: ev.newHash,
              newBytes: ev.newBytes,
              newName: ev.newName,
              newMime: ev.newMime,
              savedAt: ev.savedAt,
            });
            if (disposed) return;
            if (r.problem !== null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error:
                  r.problem === 'missing-entry'
                    ? 'Office の保存を書き戻せません(ノートが見つかりません)'
                    : 'Office の保存を書き戻せません(添付の実体が分かりません)',
              });
              return;
            }
            // ⚠ 中身が同じ = 版を積まない。**異常ではない**ので黙って終える
            //    (「取り込みました」は呼び側 `office-save-back.ts` が出す)
            if (r.unchanged) return;

            for (const w of r.wrote) {
              stamp(w.lid, w.stamps);
              // ⚠ 開いている本文なら**その場で差し替える**(次に開き直すまで
              //    古い情報が出る、を作らない)
              dispatcher.dispatch({ type: 'ENTRY_BODY_REFRESHED', lid: w.lid, body: w.body });
            }
            // 🔴 **おかしなことだけ言う。** 「取り込みました」は呼び側が出す
            //    (この層は `showStatus` を持たない ── 出せるのは `state.error` だけ)。
            // ⚠ 書き換え漏れは**件数を出す**(黙ると切れた参照が静かに残る)
            const bad: string[] = [];
            if (r.wrote.length === 0) bad.push('ノートを 1 件も更新できませんでした');
            if (r.stale.length > 0) bad.push(`旧い参照が残りました: ${r.stale.length} 件`);
            if (r.overBudget) bad.push('版の保管上限を超えています');
            if (bad.length > 0)
              dispatcher.dispatch({ type: 'OP_FAILED', error: `Office の保存: ${bad.join(' / ')}` });
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `Office の保存を書き戻せませんでした: ${String(e)}`,
              });
          }
        });
        break;
      case 'REQUEST_LAUNCHER_TILES':
        enqueue(async () => {
          if (disposed) return;
          try {
            // ⚠ **attachment だけ**を読む ── 全 entry の body を読むと、
            // ランチャーを開くたびに全文を舐めることになる。
            // 🔑 **どれを読むかは event が持って来る**(review L-6)── この層は
            // 実行時に state を見ない、という file 冒頭の宣言に合わせた。
            // 🔑 **1 往復で読む**(review L-7)── `getBody` を添付の件数ぶん
            // 呼ぶと、その回数だけ単一 queue の store が塞がる
            const titles = new Map(ev.entries.map((e) => [e.lid, e.title]));
            const rows = await store.getBodies(ev.entries.map((e) => e.lid));
            if (disposed) return;
            const sources: TileSource[] = [];
            for (const row of rows) {
              const title = titles.get(row.lid);
              if (title !== undefined) sources.push({ lid: row.lid, title, body: row.body });
            }
            dispatchTiles(sources);
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `ランチャーの読込に失敗しました: ${String(e)}`,
              });
          }
        });
        break;
      /**
       * 🔴 **選んだ全部にタグを足す / 外す**(#402 ①)。
       *
       * ⚠ **書換の規則は 1 本**(`applyBodyRewrite` の `kind: 'tag'`)── ここで
       *   frontmatter を組み直さない(§7)。ここが持つのは**繰り返しと数え上げ**だけ。
       * ⚠ **1 件ずつ `expectHash` で守る**(#178 と同じ)── 読んでから書くまでに
       *   別の窓が書いていたら、その 1 件だけ飛ばして数に出す。**当て直さない**
       *   (行番号ではなくタグなので当て直しても壊れないが、user が押した後に
       *   本文が変わったなら、黙って上書きするより言うほうが正しい)。
       * ⚠ **1 通だけ言う** ── 12 件のうち 3 件が既に付いていただけで赤い帯が
       *   3 回出るのは、押した人から見て「失敗した」にしか見えない。
       */
      case 'REQUEST_BULK_TAG':
        enqueue(async () => {
          if (disposed) return;
          let wrote = 0;
          let skipped = 0;
          let failed = 0;
          /**
           * 🔴 **本文にも同じタグが書いてあると、外しても外れない**
           *   (2026-08-29 の動線レビューで確定)。
           *
           * ⚠ 外す口が触るのは **frontmatter だけ**なので、本文の行に
           *   `#買い物` と書いてあるノートは、外した後も**そのタグを持ったまま**である
           *   (索引は文書タグと本文中タグを合わせて当てる)。
           * ⚠ それを黙っていると「外したのに、まだそのタグで集まる」に見える ──
           *   user は**壊れている**と読む。🔑 だから**数えて言う**。
           */
          let stillInBody = 0;
          for (const t of ev.targets) {
            if (disposed) return;
            try {
              const body = await store.getBody(t.lid);
              if (body === null) {
                failed++;
                continue;
              }
              const newBody = applyBodyRewrite(body, {
                kind: 'tag',
                tag: ev.tag,
                mode: ev.mode,
              });
              // ⚠ **`null` は失敗ではない** ── 「既に付いている / 元から無い」も
              //    ここへ来る。数だけ分けて、赤い帯にしない
              if (newBody === null) {
                skipped++;
                continue;
              }
              // ⚠ 外した**後の本文**にまだ残っているか(= 本文の行に書いてある)
              if (ev.mode === 'remove' && collectEntryTags(newBody).inBody.some((t2) => sameTag(t2, ev.tag)))
                stillInBody++;
              const ext = extractMeta(t.archetype, newBody);
              const stamps = await store.persistEntry(
                {
                  lid: t.lid,
                  title: t.title,
                  archetype: t.archetype,
                  body: newBody,
                  entryOrder: t.entryOrder,
                  status: ext.status,
                  date: ext.date,
                  archived: ext.archived,
                },
                { expectHash: contentHash64Hex(body) },
              );
              if (stamps.conflict === true) {
                failed++;
                continue;
              }
              wrote++;
              stamp(t.lid, stamps);
              if (!disposed)
                dispatcher.dispatch({
                  type: 'BODY_REWRITTEN',
                  lid: t.lid,
                  body: newBody,
                  rewrite: { kind: 'tag', tag: ev.tag, mode: ev.mode },
                  status: ext.status,
                  date: ext.date,
                  archived: ext.archived,
                });
            } catch {
              failed++;
            }
          }
          if (disposed) return;
          /**
           * ⚠ **何が起きたかを全部言う** ── 「12 件に付けました」だけだと、
           *   3 件が既に付いていたことも 1 件が失敗したことも消える。
           */
          const verb = ev.mode === 'add' ? '付けました' : '外しました';
          const parts = [`${wrote} 件に${verb}`];
          if (skipped > 0)
            parts.push(ev.mode === 'add' ? `${skipped} 件は既に付いていました` : `${skipped} 件は付いていませんでした`);
          if (failed > 0) parts.push(`${failed} 件は書けませんでした(別の窓が書き替えた可能性があります)`);
          /**
           * 🔴 **外しきれていないことを言う**(2026-08-29)。⚠ 黙ると
           *   「外したのに、まだそのタグで集まる」= 壊れて見える。
           */
          if (stillInBody > 0)
            parts.push(`${stillInBody} 件は本文の中にも書いてあるので、まだこのタグが付いています`);
          dispatcher.dispatch({ type: 'OP_NOTICE', message: parts.join(' / ') });
        });
        break;
      case 'REQUEST_REVISION_LIST':
        enqueue(async () => {
          if (disposed) return;
          try {
            /**
             * 🔴 **一覧と増減を一緒に引く**(#398 段①)。
             *
             * ⚠ **本文は 1 バイトも越えない** ── 増減は worker の中で数えて
             *   数字だけ返る(`revisionDiffStats`)。
             * ⚠ **数が引けなくても一覧は出す** ── 増減は手がかりであって、
             *   無いなら無いで履歴は開けなければならない(片方の失敗で
             *   もう片方まで殺さない)。
             */
            const [rows, stats] = await Promise.all([
              store.listRevisionMetas(ev.lid),
              store.revisionDiffStats(ev.lid).catch(() => []),
            ]);
            if (disposed) return;
            const statOf = new Map(stats.map((x) => [x.id, x]));
            dispatcher.dispatch({
              type: 'REVISION_LIST_LOADED',
              lid: ev.lid,
              items: rows.map((r) => ({
                id: r.id,
                revOrder: r.rev_order,
                createdAt: r.created_at,
                title: r.title,
                // ⚠ 引けなかった版は `null`(0 と潰さない ── 意味が違う)
                added: statOf.get(r.id)?.added ?? null,
                removed: statOf.get(r.id)?.removed ?? null,
              })),
            });
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `履歴の取得に失敗しました: ${String(e)}`,
              });
          }
        });
        break;
      /**
       * 🔴 **戻す前に中身を見る**(#398 段②)。⚠ **読むだけ**(1 バイトも書かない)。
       *
       * 🔑 **`enqueue` に載せる** ── 書込と**同じ 1 本の chain** なので、
       *   履歴を開く直前の保存を追い越さない(CLAUDE.md §7、2026-08-17 の実測
       *   「読みは書込の chain の外に居て、11/12 で古い本文を掴んだ」)。
       *   ⚠ **2 本目の待ち口を作らない** ── ここに独自の `settled()` を足すと、
       *   待つ規則が 2 か所になる。
       */
      case 'REQUEST_REVISION_BODY':
        enqueue(async () => {
          if (disposed) return;
          try {
            const rev = await store.getRevision(ev.revId);
            if (disposed) return;
            if (rev === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: 'その版の本文を読めませんでした(履歴が整理された可能性があります)',
              });
              return;
            }
            dispatcher.dispatch({
              type: 'REVISION_PREVIEW_LOADED',
              lid: ev.lid,
              revId: ev.revId,
              body: rev.body,
            });
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `版の読み出しに失敗しました: ${String(e)}`,
              });
          }
        });
        break;
      case 'REQUEST_RESTORE':
        // 前進変異(P5 設計 §1): 現状を先に積んでから revision 内容で上書き。
        // rewind ではないので「復元の取り消し」も履歴から戻れる
        enqueue(async () => {
          if (disposed) return;
          try {
            const rev = await store.getRevision(ev.revId);
            if (disposed) return;
            if (!rev) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: '復元対象の履歴が見つかりません',
              });
              return;
            }
            // 復元先の存在確認(消えた entry を復活させない ── review P5b F2 と対)
            const current = await store.getBody(ev.lid);
            if (disposed) return;
            if (current === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `restore: entry row missing (${ev.lid})`,
              });
              return;
            }
            // title も revision の値へ戻す(無ければ現 title 維持)。archetype は
            // 現在値が正(PKC3 に flavor 変更 UI は無い ── PKC2 の archetype
            // mismatch guard をフレーバー不変で単純化)
            const title = rev.title ?? ev.title;
            const ext = extractMeta(ev.archetype, rev.body);
            // 前進変異(P5 設計 §1): checkpoint で「現在の disk body」が履歴に
            // 積まれてから revision 内容が書かれる ── 復元の取り消しも履歴から戻れる
            const stamps = await store.persistEntry(
              {
                lid: ev.lid,
                title,
                archetype: ev.archetype,
                body: rev.body,
                entryOrder: ev.entryOrder,
                status: ext.status,
                date: ext.date,
                archived: ext.archived,
              },
              { checkpoint: true },
            );
            if (!disposed)
              dispatcher.dispatch({
                type: 'ENTRY_RESTORED',
                mode: 'revision',
                meta: {
                  lid: ev.lid,
                  title,
                  archetype: ev.archetype,
                  createdAt: null,
                  updatedAt: null,
                  entryOrder: ev.entryOrder,
                  status: ext.status,
                  date: ext.date,
                  archived: ext.archived,
                  // ⚠ worker が同じ本文から数え直す値と**同じ式**で置く(§7)
                  bodyChars: rev.body.length,
                },
                body: rev.body,
              });
            // ⚠ `ENTRY_RESTORED` は meta を丸ごと置き換える(createdAt: null)ので、
            //    刻むのは**その後** ── 前に置くと消える
            stamp(ev.lid, stamps);
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `復元に失敗しました: ${String(e)}`,
              });
          }
        });
        break;
      case 'REQUEST_TRASH_LIST':
        enqueue(async () => {
          if (disposed) return;
          try {
            const rows = await store.listTrash();
            if (disposed) return;
            dispatcher.dispatch({
              type: 'TRASH_LIST_LOADED',
              items: rows.map((r) => ({
                revId: r.id,
                entryLid: r.entry_lid,
                createdAt: r.created_at,
                title: r.title,
                archetype: r.archetype,
              })),
            });
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `ゴミ箱の取得に失敗しました: ${String(e)}`,
              });
          }
        });
        break;
      case 'REQUEST_TRASH_RESTORE':
        enqueue(async () => {
          if (disposed) return;
          try {
            const rev = await store.getRevision(ev.revId);
            if (disposed) return;
            if (!rev) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: '復元対象の履歴が見つかりません',
              });
              return;
            }
            // bulk import 由来の行は title / archetype が NULL になりうる(P5a F5)
            const archetype = rev.archetype ?? 'text';
            const title = rev.title ?? '(無題)';
            const ext = extractMeta(archetype, rev.body);
            const stamps = await store.persistEntry({
              lid: ev.entryLid,
              title,
              archetype,
              body: rev.body,
              entryOrder: ev.entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            });
            /**
             * 🔴 **居場所も一緒に戻す**(2026-08-06。user 報告 2-9)。
             *
             * `deleteEntry` は disk の relations を消さない(消すと戻せない)が、
             * 常駐の `state.relations` からは落ちている ── ここで読み直さないと
             * 「ゴミ箱から戻したのにフォルダの外に出ている」になる。
             * ⚠ **その entry に触るものだけ**渡す(全件を撒くと、他で消された
             *   関係が復活しうる)。
             * ⚠ 読めなくても復元は続ける ── 居場所が戻らないより、entry が
             *   戻らないほうが痛い。
             */
            let restored: Relation[] = [];
            try {
              const rows = await store.listRelations();
              restored = rows
                .filter((r) => r.from_lid === ev.entryLid || r.to_lid === ev.entryLid)
                .map((r) => ({
                  id: r.id,
                  kind: r.kind,
                  fromLid: r.from_lid,
                  toLid: r.to_lid,
                  createdAt: null,
                  updatedAt: null,
                }));
            } catch {
              /* 関係が読めなくても entry の復元は進める */
            }
            if (!disposed)
              dispatcher.dispatch({
                type: 'ENTRY_RESTORED',
                mode: 'trash',
                meta: {
                  lid: ev.entryLid,
                  title,
                  archetype,
                  createdAt: null,
                  updatedAt: null,
                  entryOrder: ev.entryOrder,
                  status: ext.status,
                  date: ext.date,
                  archived: ext.archived,
                  // ⚠ worker が同じ本文から数え直す値と**同じ式**で置く(§7)
                  bodyChars: rev.body.length,
                },
                body: rev.body,
                relations: restored,
              });
            // ⚠ `ENTRY_RESTORED` の後(meta を置き換えるため)
            stamp(ev.entryLid, stamps);
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `復元に失敗しました: ${String(e)}`,
              });
          }
        });
        break;
      case 'REQUEST_TRASH_PURGE':
        enqueue(async () => {
          if (disposed) return;
          try {
            const r = await store.purgeTrash();
            if (!disposed)
              dispatcher.dispatch({ type: 'TRASH_PURGED', purged: r.purged });
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `ゴミ箱を空にできませんでした: ${String(e)}`,
              });
          }
        });
        break;
      /**
       * 🔑 **追記**(P8 段⑧)。read→rewrite→write を 1 op として直列 queue に載せる
       * ── 同一 lid の先行 persist の後に読むことが保証される(基底の取り違え防止)。
       *
       * 🔴 **本文は event に載っていない**。ここで disk から読み直す ── 画面が持つ
       * 本文を基底にすると、別経路の書込(toggle / 復元 / 別タブ)を巻き戻す。
       * ⚠ **失敗しても必ず `APPEND_FAILED` を出す**(ロックを解く)。出さないと
       * user は永久に追記できなくなり、理由も分からない。
       */
      case 'REQUEST_APPEND':
        enqueue(async () => {
          if (disposed) return;
          const fail = (error: string): void => {
            if (disposed) return;
            dispatcher.dispatch({ type: 'APPEND_FAILED', lid: ev.lid, gen: ev.gen, error });
          };
          try {
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) return fail(`追記できません(ノートが見つかりません: ${ev.lid})`);
            /**
             * 🔴 **読んでから書くまでの間に、別の窓が書いていたら足し直す**
             * (#178、2026-08-22)。
             *
             * ⚠ 上の docstring のとおり、この経路は**わざと disk から読み直して**
             * いる ── 画面の古い本文を基底にしない、という防御は既に在る。
             * 残っていたのは **`getBody` と書込の間(数ミリ秒)**だけだが、
             * そこで重なると本文は消え、`checkpoint` を渡していないので
             * **履歴にも残らない**(= どこからも戻せない。改名と同じ形だった)。
             *
             * 🔑 **断るより、やり直すほうが user の意図に近い** ── 追記は
             * 「この見出しの下にこの塊を足す」なので、**新しい本文へ足し直すのが
             * まさに頼まれたこと**である。⚠ ただし **1 回だけ**(無限に回さない)。
             * ⚠ それでも重なったら**黙らない** ── `APPEND_FAILED` で
             * 書込ロックを解き、理由を出す(追記欄の字は残るので押し直せる)。
             */
            const tryAppend = async (
              base: string,
            ): Promise<
              | { stamps: EntryStamps; newBody: string; ext: FlavorExtract; base: string }
              | 'empty'
              | 'missing'
            > => {
              /**
               * 🔴 **入り先は、そのつど本文から解く**(#395 段①)。
               *
               * ⚠ 上のとおりこの関数は**足し直しでもう一度呼ばれる** ── 行番号を
               *   握っていると、別の窓が上に足したときに**違う節へ入る**。
               *   だから印(slug)から毎回解き直す。
               * 🔴 **解けなければ末尾へ落とさない** ── user が「決定事項」を選んだのに
               *   黙って文末へ入るのが、この機構でいちばん悪い負け方である。
               */
              const newBody =
                ev.target === null
                  ? appendBlock(base, ev.heading, ev.text)
                  : resolveAppendAt(base, ev.target) === null
                    ? null
                    : appendIntoSection(base, ev.target, ev.heading, ev.text);
              if (newBody === null) return 'missing';
              if (newBody === base) return 'empty';
              const ext = extractMeta(ev.archetype, newBody);
              const stamps = await store.persistEntry(
                {
                  lid: ev.lid,
                  title: ev.title,
                  archetype: ev.archetype,
                  body: newBody,
                  entryOrder: ev.entryOrder,
                  status: ext.status,
                  date: ext.date,
                  archived: ext.archived,
                },
                { expectHash: contentHash64Hex(base) },
              );
              return { stamps, newBody, ext, base };
            };

            // ⚠ **理由を分けて言う**(「入りませんでした」だけでは押し直すしかない)
            const refuse = (r: 'empty' | 'missing'): void =>
              fail(
                r === 'empty'
                  ? '追記する内容がありません'
                  : '選んだ入り先の見出しが本文に見つかりません(見出しが変わった可能性があります)。入り先を選び直してください',
              );
            let attempt = await tryAppend(body);
            if (attempt === 'empty' || attempt === 'missing') return refuse(attempt);
            if (attempt.stamps.conflict === true) {
              // ⚠ **読み直してから**足し直す(古い基底で再送しない)
              const fresh = await store.getBody(ev.lid);
              if (disposed) return;
              if (fresh === null) return fail(`追記できません(ノートが見つかりません: ${ev.lid})`);
              attempt = await tryAppend(fresh);
              if (attempt === 'empty' || attempt === 'missing') return refuse(attempt);
              if (attempt.stamps.conflict === true)
                return fail(
                  '別の窓がこのノートを書き替えたため、追記できませんでした(もう一度押してください)',
                );
            }
            const { stamps, newBody, ext, base } = attempt;
            if (disposed) return;
            dispatcher.dispatch({
              type: 'ENTRY_APPENDED',
              lid: ev.lid,
              gen: ev.gen,
              body: newBody,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
              /**
               * 🔴 **足した行を「結果から」取り出す**(#395 段①、取り消しのため)。
               *
               * ⚠ 挿し込みの規則(前後に空行を足す作法)を**ここで書き写さない** ──
               *   写すと規則が 2 か所になり、片方だけ古くなる(§7)。
               * ⚠ `base` は**実際に書き込みの基底になった本文**である ── 足し直しが
               *   起きた回は読み直した側で、そこから導かないと取り消しが空振りする。
               */
              inserted: insertedLines(base, newBody),
            });
            stamp(ev.lid, stamps);
          } catch (e) {
            fail(`追記を保存できませんでした: ${String(e)}`);
          }
        });
        break;
      case 'REQUEST_BODY_REWRITE':
        // read→rewrite→write を 1 op として直列 queue に載せる ── 同一 lid の
        // 先行 persist の後に読むことが保証される(基底の取り違え防止)
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) {
              // 行不在: 可視通知(非致命 ── アプリごと止めない)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `body rewrite: entry row missing (${ev.lid})`,
              });
              return;
            }
            // 原文 splice(本文 byte 無傷)→ 唯一の抽出経路 → 行全体 upsert
            // ⚠ 抽出は**そのノートのアーキタイプ**で行う(#276)── 'todo' に
            //   固定していると、普通のノートの日付が列に入らない
            /**
             * ⚠ **当たらなかったら黙って別の所を書かない**(#277)── 行番号は
             * 描いた時の原文のものなので、その後の書換でずれていることがある。
             */
            const newBody = applyBodyRewrite(body, ev.rewrite);
            if (newBody === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: '本文が変わっているため反映できませんでした(開き直してください)',
              });
              return;
            }
            /**
             * 🔑 **1 byte も変わらないなら、書かず・言わない**(UX レビュー所見 2)。
             * `place-move` は「値が同じ」を null(= 競合の顔)ではなく同じ body で
             * 返す ── ここで静かに済ませないと、付箋を元の位置へ戻して離した
             * 取りやめ操作に「開き直してください」という嘘の赤帯が出る。
             * ⚠ どの rewrite でも同じ ── 同じ bytes の書き直しは更新日時だけ動かす。
             */
            if (newBody === body) return;
            const ext = extractMeta(ev.archetype, newBody);
            /**
             * 🔴 **読んでから書くまでの間に別の窓が書いていたら、1 バイトも書かない**
             * (#178 残り、2026-08-23)。
             *
             * ⚠ 実測(`storage-worker.test.ts`「expectHash を渡さなければ…」)──
             * `expectHash` の無い書込は **amend** なので、上書きされた別の窓の版は
             * **disk からも履歴からも消える**。改名・追記と同じ形がここに残っていた。
             *
             * 🔑 **ここは「当て直す」ではなく「断る」** ── `applyBodyRewrite` は
             * `kind: 'task'` / `'line-date'` で **行番号**を使い、その検査は
             * 「その行が項目か」しか見ない。⚠ 別の窓が**行を 1 本足していた**ら、
             * 同じ番号は**別の項目**を指す ── 当て直すと**押していない項目が
             * 裏返る**。⚠ 追記(`REQUEST_APPEND`)が当て直してよいのは、あちらが
             * **見出しの名前**で当てていて、しかも user が打った字を捨てさせない
             * ためである ── ここは押し直しが 1 クリックなので、断るほうが安い。
             */
            const stamps = await store.persistEntry(
              {
                lid: ev.lid,
                title: ev.title,
                archetype: ev.archetype,
                body: newBody,
                entryOrder: ev.entryOrder,
                status: ext.status,
                date: ext.date,
                archived: ext.archived,
              },
              { expectHash: contentHash64Hex(body) },
            );
            if (stamps.conflict === true) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error:
                  '別の窓がこのノートを書き替えたため、反映できませんでした(もう一度押してください)',
              });
              return;
            }
            if (!disposed)
              dispatcher.dispatch({
                type: 'BODY_REWRITTEN',
                lid: ev.lid,
                body: newBody,
                rewrite: ev.rewrite,
                status: ext.status,
                date: ext.date,
                archived: ext.archived,
              });
            stamp(ev.lid, stamps);
          } catch (e) {
            // toggle の失敗は非致命(local state は動いておらず、再クリックが
            // retry)── phase を落として app を止めない(P3-6b review #1)
            if (!disposed)
              dispatcher.dispatch({ type: 'OP_FAILED', error: String(e) });
          }
        });
        break;
    }
  });

  const dispose: StoreEffects = (): void => {
    disposed = true;
    unsubscribe();
  };
  /**
   * ⚠ **その場の tail を掴んでから待つ** ── `queue` は `enqueue` が差し替える
   * 変数なので、待った後にもう一度見て「増えていない」ことまで確かめる。
   * ⚠ chain は `then(op, op)` で失敗しても続くので、ここで reject は起きない。
   */
  /**
   * 🔴 **chain に載せて、結果を返す**(上の注記)。
   * ⚠ chain 自身は `then(op, op)` で**失敗しても続く**ので、ここで投げた仕事が
   *   後続を巻き添えにすることは無い。
   */
  dispose.run = <T,>(job: () => Promise<T>): Promise<T> => {
    const out = queue.then(job, job);
    // ⚠ chain へ戻すのは**失敗を握った版**(呼び側は下の `out` で受け取る)
    queue = out.then(
      () => undefined,
      () => undefined,
    );
    return out;
  };

  dispose.settled = async (): Promise<void> => {
    for (let round = 0; round < SETTLE_ROUNDS_MAX; round += 1) {
      const tail = queue;
      await tail;
      if (queue === tail) return;
    }
  };
  return dispose;
}
