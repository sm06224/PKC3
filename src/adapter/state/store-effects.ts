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
  persistEntry(entry: EntryUpsert, opts?: { checkpoint?: boolean }): Promise<EntryStamps>;
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
): () => void {
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
            });
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

  return () => {
    disposed = true;
    unsubscribe();
  };
}
