/**
 * effect 層(P3 設計メモ §1): DomainEvent を購読して store I/O を行い、
 * SystemCommand で reducer に還流する。reducer は純粋のまま。
 *
 * **直列化(storage review #5 の解消)**: store への op は 1 本の promise chain に
 * 直列化する。worker handler が将来 async 化しても、app 側から見た op 順序は
 * ここで保証される(「init 以外は同期」という暗黙 invariant に依存しない)。
 */
import type { EntryStamps, EntryUpsert } from '@adapter/platform/storage/schema';
import { extractMeta } from '@features/flavor';
import { withTodoStatus } from '@features/flavor/todo-flavor';
import { appendBlock } from '@features/markdown/text-ops';
import { spliceFrontmatterKeys } from '@features/markdown/frontmatter';
import { buildTiles, withBuiltinTiles, type TileSource } from '@features/launcher/tiles';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { planSaveBack } from '@features/asset/asset-replace-plan';
import { readVersions, totalHistoryBytes } from '@features/flavor/attachment-versions';
import type {
  GroupResult as QueryGroups,
  KeyResult as QueryKeys,
} from '@features/query/group-by';
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
   * 集計(#184)。⚠ **省略可** ── 持たない環境(test の fake / 旧い配線)では
   * 面が「この版では数えられません」と断るだけで、他は壊れない。
   * ⚠ 返るのは**束ねた結果**だけで、本文は 1 バイトも渡らない。
   * ⚠ 目録と表は **1 回の走査**で返る(`key` が `null` なら表は `null`)。
   */
  queryScan?(key: string | null): Promise<{ keys: QueryKeys; groups: QueryGroups | null }>;
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
  persistEntry(
    entry: EntryUpsert,
    opts?: {
      checkpoint?: boolean;
      parent?: { parentLid: string | null; relationId: string };
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
  const stamp = (lid: string, s: EntryStamps): void => {
    if (disposed) return;
    dispatcher.dispatch({
      type: 'ENTRY_STAMPED',
      lid,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
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
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `rename: entry row missing (${ev.lid})`,
              });
              return;
            }
            const ext = extractMeta(ev.archetype, body);
            const stamps = await store.persistEntry({
              lid: ev.lid,
              title: ev.title,
              archetype: ev.archetype,
              body,
              entryOrder: ev.entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            });
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
              const body = await store.getBody(row.lid);
              if (disposed) return;
              if (body === null) {
                dispatcher.dispatch({
                  type: 'OP_FAILED',
                  error: `並べ替え: entry が見つかりません(${row.lid})`,
                });
                return;
              }
              const ext = extractMeta(row.archetype, body);
              const stamps = await store.persistEntry({
                lid: row.lid,
                title: row.title,
                archetype: row.archetype,
                body,
                entryOrder: row.entryOrder,
                status: ext.status,
                date: ext.date,
                archived: ext.archived,
              });
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
            const stamps = await store.persistEntry({
              lid: ev.lid,
              title: ev.title,
              archetype: ev.archetype,
              body: next,
              entryOrder: ev.entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            });
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
            // 🔴 **disk から読む**(state の body は開いていないことのほうが多い)
            const targetBody = await store.getBody(ev.targetLid);
            if (disposed) return;
            if (targetBody === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: 'Office の保存を書き戻せません(ノートが見つかりません)',
              });
              return;
            }
            const oldKey = readAttachmentMeta(targetBody).assetKey;
            if (oldKey === null) {
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: 'Office の保存を書き戻せません(添付の実体が分かりません)',
              });
              return;
            }
            const oldSize = readAttachmentMeta(targetBody).size ?? 0;

            // ⚠ **全ノートの本文を 1 度舐める。** 参照(`asset:`)はどのノートにも
            //    書けるので、範囲を狭めると**書き換え漏れ**が出る(旧 key を指した
            //    まま残り、GC が実体を消した時点で切れる)。
            //    🔑 **測った**(2026-08-16、着地前レビュー R9 を受けて):
            //      | ノート数 | 本文計 | この計画づくり |
            //      |---|---|---|
            //      | 100 | 0.1MB | 3.0ms |
            //      | 1,000 | 0.9MB | 16.6ms |
            //      | 5,000 | 4.3MB | **36.7ms** |
            //    対照群(`oldKey === newKey` = 早期 return)は全件 0.0〜0.1ms なので、
            //    費用は**走査そのもの**である。⚠ 手法の範囲: node の V8 で 1 サンプル、
            //    2KB / 件・参照を持つのは 1%。**実ブラウザでは測っていない**。
            //    🔑 保存 1 回につき 1 度で、long task の目安 50ms は下回る ── ただし
            //    これは **user の操作起点ではない**(別窓からの到着)ので、
            //    件数が伸びたらワーカーへ出す(そのときの分水嶺はこの表)
            const bodies = new Map<string, string>();
            let after: { entryOrder: number; lid: string } | undefined;
            for (;;) {
              const page = await store.listBodies(after, 1 << 20);
              if (disposed) return;
              for (const row of page.rows) bodies.set(row.lid, row.body);
              if (page.done || page.next === undefined) break;
              // 🔴 **前へ進んでいないなら止める**(2026-08-16、着地前レビュー R8)。
              //    ⚠ この鎖は単一 queue なので、ここで回り続けると**以降の store
              //    effect が 1 件も走らなくなる**(保存も永続化も止まる)── 画面は
              //    生きているので user は気づけない。他の全走査 3 か所と同じ形
              const next = page.next;
              if (
                after !== undefined &&
                !(next.entryOrder > after.entryOrder ||
                  (next.entryOrder === after.entryOrder && next.lid > after.lid))
              ) {
                throw new Error('本文の読み出しが進みません(カーソルが前進していません)');
              }
              after = next;
            }
            // 🔴 **添付ノート自身を必ず入れる**(`planSaveBack` は入っていないと
            //    frontmatter の差し替えを 1 件も出さない ── 黙って何も起きなくなる)
            bodies.set(ev.targetLid, targetBody);

            const plan = planSaveBack({
              targetLid: ev.targetLid,
              oldKey,
              newKey: ev.newKey,
              newHash: ev.newHash,
              newBytes: ev.newBytes,
              oldBytes: oldSize,
              savedAt: ev.savedAt,
              bodies,
              // 🔴 **他の添付が既に使っている分を数える**(2026-08-16、着地前
              //    レビュー R5)。⚠ 渡さないと上限が**この添付の中だけ**で閉じ、
              //    全体では超える ── 30MB × 5 世代 のノートが 10 件で 1.5GB になり、
              //    `overBudget` も一度も立たないので誰も気づけない。
              //    🔑 数えるが**落とさない**(無関係なノートの履歴を巻き添えにしない)
              otherBytes: totalHistoryBytes(
                [...bodies]
                  .filter(([lid]) => lid !== ev.targetLid)
                  .map(([, body]) => readVersions(body)),
              ),
            });
            // ⚠ 中身が同じ = 版を積まない。**異常ではない**ので黙って終える
            //    (「取り込みました」は呼び側 `office-save-back.ts` が出す)
            if (plan.unchanged) return;

            const metas = new Map(ev.entries.map((e) => [e.lid, e]));
            let wrote = 0;
            for (const edit of plan.edits) {
              const meta = metas.get(edit.lid);
              if (!meta) continue; // 走査の間に消えた
              // ⚠ `planSaveBack` は**変わるものしか返さない**(添付ノート本人は
              //    frontmatter が必ず変わり、他ノートは `rewrote > 0` のときだけ
              //    入る)── だから「変わっていないなら書かない」の門は置かない。
              //    🔑 置いても**絶対に発火しない = 変異試験で殺せない行**になる
              const base = edit.nextText ?? bodies.get(edit.lid) ?? '';
              const next = edit.frontmatter
                ? spliceFrontmatterKeys(base, edit.frontmatter)
                : base;
              const ext = extractMeta(meta.archetype, next);
              const stamps = await store.persistEntry({
                lid: edit.lid,
                title: meta.title,
                archetype: meta.archetype,
                body: next,
                entryOrder: meta.entryOrder,
                status: ext.status,
                date: ext.date,
                archived: ext.archived,
              });
              if (disposed) return;
              wrote += 1;
              stamp(edit.lid, stamps);
              // ⚠ 開いている本文なら**その場で差し替える**(次に開き直すまで
              //    古い情報が出る、を作らない)
              dispatcher.dispatch({ type: 'ENTRY_BODY_REFRESHED', lid: edit.lid, body: next });
            }
            // 🔴 **おかしなことだけ言う。** 「取り込みました」は呼び側が出す
            //    (この層は `showStatus` を持たない ── 出せるのは `state.error` だけ)。
            // ⚠ 書き換え漏れは**件数を出す**(黙ると切れた参照が静かに残る)
            const bad: string[] = [];
            if (wrote === 0) bad.push('ノートを 1 件も更新できませんでした');
            if (plan.stale.length > 0) bad.push(`旧い参照が残りました: ${plan.stale.length} 件`);
            if (plan.overBudget) bad.push('版の保管上限を超えています');
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
      case 'REQUEST_REVISION_LIST':
        enqueue(async () => {
          if (disposed) return;
          try {
            const rows = await store.listRevisionMetas(ev.lid);
            if (disposed) return;
            dispatcher.dispatch({
              type: 'REVISION_LIST_LOADED',
              lid: ev.lid,
              items: rows.map((r) => ({
                id: r.id,
                revOrder: r.rev_order,
                createdAt: r.created_at,
                title: r.title,
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
            const newBody = appendBlock(body, ev.heading, ev.text);
            if (newBody === body) return fail('追記する内容がありません');
            const ext = extractMeta(ev.archetype, newBody);
            const stamps = await store.persistEntry({
              lid: ev.lid,
              title: ev.title,
              archetype: ev.archetype,
              body: newBody,
              entryOrder: ev.entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            });
            if (disposed) return;
            dispatcher.dispatch({
              type: 'ENTRY_APPENDED',
              lid: ev.lid,
              gen: ev.gen,
              body: newBody,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            });
            stamp(ev.lid, stamps);
          } catch (e) {
            fail(`追記を保存できませんでした: ${String(e)}`);
          }
        });
        break;
      case 'REQUEST_TODO_TOGGLE':
        // read→rewrite→write を 1 op として直列 queue に載せる ── 同一 lid の
        // 先行 persist の後に読むことが保証される(基底の取り違え防止)
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) {
              // 行不在の toggle: 可視通知(非致命 ── アプリごと止めない)
              dispatcher.dispatch({
                type: 'OP_FAILED',
                error: `todo toggle: entry row missing (${ev.lid})`,
              });
              return;
            }
            // 原文 splice(本文 byte 無傷)→ 唯一の抽出経路 → 行全体 upsert
            const newBody = withTodoStatus(body, ev.nextStatus);
            const ext = extractMeta('todo', newBody);
            const stamps = await store.persistEntry({
              lid: ev.lid,
              title: ev.title,
              archetype: 'todo',
              body: newBody,
              entryOrder: ev.entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            });
            if (!disposed)
              dispatcher.dispatch({
                type: 'TODO_TOGGLED',
                lid: ev.lid,
                body: newBody,
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
  dispose.settled = async (): Promise<void> => {
    for (let round = 0; round < SETTLE_ROUNDS_MAX; round += 1) {
      const tail = queue;
      await tail;
      if (queue === tail) return;
    }
  };
  return dispose;
}
