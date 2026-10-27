/**
 * reducer の slice: SQL ページ(実行・履歴・書き出し・ER 図・接続先・ゲスト)(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceSql` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type DomainEvent,
  type ReduceResult,
  SQL_GUEST_NOT_OPEN_TEXT,
  SQL_GUEST_OPENING_TEXT,
  erAfterDuckWrite,
  erForSource,
  erSourceKey,
  goHistory,
  historyPush,
  schemaRouteOf,
  schemaWhereOf,
  withHistoryEdit,
  withSqlSourceSet,
} from '../app-state';
import { DUCKDB_LOAD_TOO_LONG, DUCKDB_TOO_LONG } from '@adapter/platform/duckdb/duckdb-lease';
import { parquetCopyOf } from '@features/query/duckdb-export';
import { checkDuckDbRunSql, duckDbWriteKind } from '@features/query/duckdb-write';
import { pickErConnection } from '@features/query/er-connect';
import { erSql } from '@features/query/er-sql';
import { schemaModel } from '@features/query/schema-digest';
import { sqlEngineOf } from '@features/query/sql-engine';
import { checkReadOnlySql } from '@features/query/sql-guard';
import { checkAddSource } from '@features/query/sql-multi-source';

export type SqlAction = Extract<Dispatchable, { type: 'SET_SQL_TEXT' | 'RUN_SQL' | 'SQL_HISTORY_STEP' | 'SQL_HISTORY_PICK' | 'SQL_EXPORT_PARQUET' | 'SQL_SCHEMA_TO_NOTE' | 'SQL_ER_TOGGLE' | 'SQL_ER_CONNECT_TOGGLE' | 'SQL_ER_PICK' | 'SQL_ER_UNLINK' | 'SQL_ER_PRESS' | 'SQL_ER_LOADED' | 'SQL_ER_FAILED' | 'SET_SQL_RESULT' | 'SQL_SAVED' | 'SET_SQL_ENGINE' | 'SET_SQL_SOURCE' | 'ADD_SQL_SOURCE' | 'REMOVE_SQL_SOURCE' | 'SQL_GUEST_OPENED' | 'SQL_GUEST_FAILED' | 'SQL_SAVE_FAILED' | 'SQL_DUCK_LOADING' | 'SQL_RUN_FAILED' }>;

export function reduceSql(state: AppState, action: SqlAction): ReduceResult {
  switch (action.type) {
    /** 欄に打っただけ ── **走らせない**(重い問い合わせを打鍵ごとに投げない)。 */
    case 'SET_SQL_TEXT':
      // ⚠ 断りの字は消す(打ち直したのに前の断りが残ると、直したか分からない)
      /**
       * ⚠ 書き出しの知らせも消す(打ち直したのに前の知らせが残ると、いま出た表の話に見える)。
       * 🔴 **開けなかった断りも消す**(#681 の着地前レビュー F4)── 直す前は
       *   `SET_SQL_SOURCE` と `SQL_GUEST_OPENED` でしか消えず、`noteLine` は
       *   **その行をいちばん先に返す**ので、一度 file を開き損ねた人は
       *   **以後の知らせを全部食われていた**(切った / 0 行 / 書き出した、が出ない)。
       */
      return {
        state: {
          ...state,
          sqlPage: {
            ...state.sqlPage,
            sql: action.sql,
            error: '',
            saved: '',
            guestError: '',
            /**
             * 🔴 **履歴の中で直した字は、その場に控える**(#918 段②a、動線レビュー)。
             * ⚠ 控えないと、**直してからもう一度 `↑` を押した瞬間に消える**
             *   (`↓` で帰ってくるのは直す前の字になる)── この repo が
             *   いちばん嫌う「さっきまでやっていたことが消える」形である。
             * ⚠ `-1`(打ちかけ)のときは何もしない ── そこは `sql` 自身が
             *   打ちかけの字であり、控えは `↑` を押す瞬間に取る。
             */
            ...(state.sqlPage.historyAt < 0
              ? // ⚠ 打ちかけを打ち直したら、控えは**古い**ので捨てる ── 残すと
                //   画面の「打ちかけの字を見ています」が嘘になる(戻る先はもう無い)
                { historyDraft: '' }
              : { historyEdits: withHistoryEdit(state.sqlPage, action.sql) }),
          },
        },
        events: [],
      };
    /**
     * 🔴 **走らせる**(#681 段②)。
     * ⚠ 走らせる前に**字で見分ける** ── ここは「断る理由を読める字で言う」ための門で、
     *   境ではない(境は worker 側の `PRAGMA query_only` と進み具合の見張り)。
     * ⚠ **走っている間は受けない** ── 同じ問い合わせを二重に投げない。
     */
    case 'RUN_SQL': {
      if (state.sqlPage.running) return { state, events: [] };
      /**
       * 🔴 **選んだファイルがまだ開けていないときは、走らせない**(#1087)。
       * ⚠ 欄にはファイルの名前が出ているのに、この PKC 自身の DB へ走らせると、
       *   **ファイルの中身を引いたつもりの答え**が返る(いちばん気づけない外し方)。
       * 🔑 開けなかった回は `guestError` が既にいちばん上で理由を言っているので、
       *   そのまま残す(上書きしない)。開いている最中だけ、`error` で待つよう言う。
       */
      if (state.sqlPage.guestChosen !== '' && state.sqlPage.guest === null) {
        if (state.sqlPage.guestError !== '') return { state, events: [] };
        // 開いている最中 = `guestPending` が居る。居ないのは「開けなかった後、打ち直して断りが消えた」回
        const why = state.sqlPage.guestPending !== '' ? SQL_GUEST_OPENING_TEXT : SQL_GUEST_NOT_OPEN_TEXT;
        return { state: { ...state, sqlPage: { ...state.sqlPage, error: why } }, events: [] };
      }
      /**
       * 🔴 **engine ごとに門が違う**(#682 段②)。
       * ⚠ DuckDB には sqlite に無い書き方(`FROM t SELECT x` / `PIVOT`)と、
       *   sqlite に無い危ない語(`INSTALL` / `LOAD` / `SET`)が在るので、
       *   **同じ門では見られない**(`duckdb-guard.ts` の冒頭)。
       * 🔑 どちらで引くかは `sqlEngineOf` **1 か所**が決める ── ここで
       *   `state.sqlPage.engine` を直に読むと、選べない相手のときに
       *   「画面は sqlite なのに DuckDB の門を通す」が起きる。
       */
      const engine = sqlEngineOf(state.sqlPage);
      /**
       * 🔴 **書ける門は DuckDB のときだけ**(#918 段⑧)。⚠ sqlite の門(`checkReadOnlySql`)は
       *   **そのまま** ── この PKC のノートの DB に書く道を作らない(1 行で全ノートを消せる口になる)。
       */
      const checked = engine === 'duckdb' ? checkDuckDbRunSql(state.sqlPage.sql) : checkReadOnlySql(state.sqlPage.sql);
      if (!checked.ok) {
        return {
          state: {
            ...state,
            /**
             * 🔴 **断った回も、直した字を欄へ返す**(2026-09-09 の着地前レビュー)。
             * ⚠ `sql-guard.ts` は「`ok:false` の側にも `sql` を残すのは、断り文の隣に
             *   **直した後の字**を出して『なぜ断られたか』を読めるようにするためである」と
             *   書いているのに、初稿はここで**捨てていた** ── 全角のまま打った人は、
             *   断り文には半角の `DELETE` と出るのに欄は全角のままで、
             *   **画面の中で辻褄が合わない**。
             */
            sqlPage: { ...state.sqlPage, sql: checked.sql, error: checked.why },
          },
          events: [],
        };
      }
      const token = state.sqlPage.runToken + 1;
      return {
        state: {
          ...state,
          // 🔑 **直した字を欄へ戻す**(全角で打った人に、実際に走った字を見せる)
          sqlPage: {
            ...state.sqlPage,
            sql: checked.sql,
            /**
             * 🔴 **走った字だけを憶える**(#918 段②a)── 打ちかけは積まない。
             * ⚠ **同じ字を 2 つ並べない**(直前と同じなら積み直さない)。
             * ⚠ 上限 `SQL_HISTORY_MAX` で切る ── 打つほど重くなる形にしない。
             */
            ...historyPush(state.sqlPage.history, checked.sql),
            historyAt: -1,
            historyDraft: '',
            historyEdits: [],
            running: true,
            duckLoading: false,
            error: '',
            saved: '',
            // 🔴 開けなかった断りもここで消す(#681 F4 ── 上の `SET_SQL_TEXT` と同じ理由)
            guestError: '',
            runToken: token,
          },
        },
        events: [
          {
            type: 'REQUEST_SQL_RUN',
            sql: checked.sql,
            token,
            engine,
            ...(state.sqlPage.guest === null ? {} : { guest: true }),
            /**
             * ⚠ **相手は「いま開いている物」から採る** ── `engine` が `duckdb` に
             *   なるのは**取り込んだ file を選んでいるとき**だけなので
             *   (`enginesForSource` ── csv / tsv / parquet / json。#682 段④c)、
             *   ここで `guest` が `null` になることは無い。⚠ それでも `?.` で書くのは、
             *   将来 engine の表が変わった日に**落ちるのではなく sqlite へ落ちる**ため。
             */
            ...(engine === 'duckdb' && state.sqlPage.guest !== null
              ? { duck: { lid: state.sqlPage.guest.lid, name: state.sqlPage.guest.name } }
              : {}),
            /**
             * 🔴 **足した相手も、いまの相手から採る**(#918 段⑦)。⚠ `engine` を見ない ──
             *   足した相手が在れば `sqlEngineOf` が DuckDB へ固定するので、ここへ来る回は
             *   必ず DuckDB である(`engine === 'duckdb'` を重ねると、決める口が 2 つになる)。
             */
            ...(state.sqlPage.extraGuests.length > 0
              ? { duckExtra: state.sqlPage.extraGuests.map((g) => ({ lid: g.lid, name: g.name })) }
              : {}),
          },
        ],
      };
    }
    /**
     * 🔴 **構造 1 枚をノートへ**(#918 段①)。
     * ⚠ 走っている間は**受けない**(2 本走らせると同じノートが 2 つできる)。
     * 🔑 `running` を立てるので、**終わりを言う 2 つ**(`SQL_SAVED` / `SQL_SAVE_FAILED`)が
     *   必ず降ろす ── 降ろし忘れると、以後ずっと押せなくなる。
     */
    /**
     * 🔴 **前に打った字を戻す / 進む**(#918 段②a)。
     *
     * ⚠ **打ちかけの字を潰さない** ── 遡る前に控え、いちばん新しい所から
     *   さらに ↓ を押したら**それを返す**(shell と同じ手触り)。
     * ⚠ 履歴が空の回は**何も起きない**(押しても字が消えたりしない)。
     */
    case 'SQL_HISTORY_STEP': {
      const p = state.sqlPage;
      if (p.history.length === 0) return { state, events: [] };
      const at = action.back
        ? Math.min(p.historyAt + 1, p.history.length - 1)
        : p.historyAt - 1;
      if (at === p.historyAt) return { state, events: [] };
      return { state: { ...state, sqlPage: goHistory(p, at, p.historyAt) }, events: [] };
    }
    case 'SQL_HISTORY_PICK': {
      const p = state.sqlPage;
      // ⚠ 範囲の外は黙って捨てる(一覧を組み直す前の押しが飛んでくる)
      if (action.at < 0 || action.at >= p.history.length) return { state, events: [] };
      return { state: { ...state, sqlPage: goHistory(p, action.at, p.historyAt) }, events: [] };
    }
    /**
     * 🔴 **答えを Parquet にする**(#918 段⑥)。
     * ⚠ 走っている間は**受けない**(`SQL_SCHEMA_TO_NOTE` と同じ ── 2 本走らせると同じ file が 2 つ落ちる)。
     * 🔑 `running` を立てるので、終わりを言う 2 つ(`SQL_SAVED` / `SQL_SAVE_FAILED`)が必ず降ろす。
     * ⚠ 出す側(選び所)は DuckDB で引いた読む SQL の答えのときしか Parquet を出さないが、**選び所を開いたまま
     *   相手や engine を替えた押し**が飛んでくる ── 受け口でも同じ判定(`parquetCopyOf`)で断り、**理由を画面へ出す**
     *   (黙って捨てると押した人には「壊れている」と「押せていない」の区別が付かない)。
     */
    case 'SQL_EXPORT_PARQUET': {
      const p = state.sqlPage;
      if (p.running) return { state, events: [] };
      const refuse = (error: string): ReduceResult => ({
        state: { ...state, sqlPage: { ...p, error, saved: '' } },
        events: [],
      });
      if (p.ranSql === '' || p.columns.length === 0) return refuse('先に SQL を実行してください');
      if (sqlEngineOf(p) !== 'duckdb' || p.guest === null) {
        return refuse('Parquet は DuckDB で引いた答えだけ書き出せます');
      }
      const copy = parquetCopyOf(p.ranSql);
      if (!copy.ok) return refuse(copy.why);
      return {
        state: { ...state, sqlPage: { ...p, running: true, duckLoading: false, error: '', saved: '' } },
        events: [
          {
            type: 'REQUEST_SQL_EXPORT_PARQUET',
            sql: p.ranSql,
            fileName: action.fileName,
            duck: { lid: p.guest.lid, name: p.guest.name },
            ...(p.extraGuests.length > 0
              ? { duckExtra: p.extraGuests.map((g) => ({ lid: g.lid, name: g.name })) }
              : {}),
          },
        ],
      };
    }
    case 'SQL_SCHEMA_TO_NOTE': {
      if (state.sqlPage.running) return { state, events: [] };
      /**
       * 🔴 **頼み先は 1 か所で決める**(`schemaRouteOf`)。⚠ DuckDB でしか読めない相手や 2 件以上は
       *   DuckDB の器へ頼む(以前はここで断っていた ── #918)。
       */
      const route = schemaRouteOf(state.sqlPage.guest, state.sqlPage.extraGuests);
      return {
        state: { ...state, sqlPage: { ...state.sqlPage, running: true, duckLoading: false, error: '', saved: '' } },
        events: [
          {
            type: 'REQUEST_SQL_SCHEMA',
            where: schemaWhereOf(state.sqlPage.guest, state.sqlPage.extraGuests),
            lid: action.lid,
            relationId: action.relationId,
            parentLid: action.parentLid ?? null,
            ...route,
          },
        ],
      };
    }
    /**
     * 🔴 **つながり図を開く / 閉じる**(#918 段⑤。裁定 2026-09-15 = この窓の中)。
     * ⚠ **開いたら畳める** ── 開きっぱなしにすると答えの表を押し下げ続ける
     *   (#300「補助的な物が主の作業領域を奪わない」)。
     * 🔑 採ってあるのが**いまの相手の構造なら採り直さない**(開くたびに DB を舐めない)。
     */
    case 'SQL_ER_TOGGLE': {
      const p = state.sqlPage;
      if (p.er.open) {
        return {
          state: { ...state, sqlPage: { ...p, er: { ...p.er, open: false, note: '' } } },
          events: [],
        };
      }
      const source = erSourceKey(p.guest, p.extraGuests);
      if (p.er.model !== null && p.er.source === source) {
        return {
          state: { ...state, sqlPage: { ...p, er: { ...p.er, open: true, note: '' } } },
          events: [],
        };
      }
      const token = p.er.token + 1;
      return {
        state: {
          ...state,
          sqlPage: {
            ...p,
            er: {
              open: true,
              loading: true,
              model: null,
              note: '',
              source,
              token,
              // 🔑 まだ開いたことが無い相手でも、`connecting`(入切そのもの)は
              //   user の好みなので持ち越す。`mine` / `pendingFrom` は新しい模型の分。
              connecting: p.er.connecting,
              pendingFrom: null,
              mine: [],
            },
          },
        },
        // 🔴 頼み先は 1 か所で決める(`schemaRouteOf`。DuckDB でしか読めない相手 / 2 件以上は DuckDB の器へ)
        events: [{ type: 'REQUEST_SQL_ER', token, ...schemaRouteOf(p.guest, p.extraGuests) }],
      };
    }
    /**
     * 🔴 **「繋ぐ」モードの入切**(#918 段⑤d-1。user 報告 2026-09-16
     *   「er のキー同士の掛け合わせとかちゃんと描きたいのにできない」)。
     * ⚠ **切るときは `pendingFrom` を必ず捨てる** ── 残すと、入れ直した回に
     *   前の相手が復活して見える(押していないのに「ここから」が付いている)。
     * ⚠ **入れるときも捨てる** ── 前に断られた回の理由(`note`)を、
     *   新しく入れた回まで持ち越さない。
     */
    case 'SQL_ER_CONNECT_TOGGLE': {
      const p = state.sqlPage;
      return {
        state: {
          ...state,
          sqlPage: {
            ...p,
            er: { ...p.er, connecting: !p.er.connecting, pendingFrom: null, note: '' },
          },
        },
        events: [],
      };
    }
    /**
     * 🔴 **繋ぐモード中に図の列を押した**(#918 段⑤d-1)。
     * ⚠ 判定は `pickErConnection`(pure)に寄せる ── ここは結果を state へ写すだけ
     *   (CLAUDE.md §7「同じ値・同じ判定が複数の場所にある」)。
     * 🔑 **`erSql` は 1 バイトも変えない** ── 出来た `SchemaLink` を、宣言された
     *   外部キーとまったく同じ形で `{ kind: 'link', link }` として渡すだけでよい。
     */
    case 'SQL_ER_PICK': {
      const p = state.sqlPage;
      const result = pickErConnection(p.er.model, p.er.mine, p.er.pendingFrom, action.table, action.column);
      if (result.kind === 'from') {
        return {
          state: {
            ...state,
            sqlPage: { ...p, er: { ...p.er, pendingFrom: result.pendingFrom, note: '' } },
          },
          events: [],
        };
      }
      if (result.kind === 'cancel') {
        return {
          state: { ...state, sqlPage: { ...p, er: { ...p.er, pendingFrom: null, note: '' } } },
          events: [],
        };
      }
      if (result.kind === 'denied') {
        // ⚠ **黙って何もしないのは禁止** ── 押したのに繋がらなかった理由を言う。
        //   ⚠ `pendingFrom` は捨てない ── 押し直しのために「ここから」は残す。
        return {
          state: { ...state, sqlPage: { ...p, er: { ...p.er, note: result.why } } },
          events: [],
        };
      }
      // result.kind === 'linked' ── 図には必ず線を足す。SQL への JOIN 追記は
      // 「その場で足せるか」に依るので best-effort(足せなければ理由を note で言う)。
      const mine = [...p.er.mine, result.link];
      const r = erSql(p.sql, { kind: 'link', link: result.link });
      return {
        state: {
          ...state,
          sqlPage: {
            ...p,
            ...(r.ok ? { sql: r.sql, error: '' } : {}),
            er: { ...p.er, mine, pendingFrom: null, note: r.ok ? '' : r.why },
            ...(r.ok && p.historyAt >= 0 ? { historyEdits: withHistoryEdit(p, r.sql) } : {}),
          },
        },
        events: [],
      };
    }
    /**
     * 🔴 **自分で引いた線を消す**(#918 段⑤d-1)。⚠ **片道の操作を作らない** ──
     *   置けるだけで外せないと、間違えて引いた線を消すのに model を採り直すしかない
     *   (CLAUDE.md「面は『映すだけ』にしない」の同じ向き)。
     * ⚠ 宣言された外部キーはここへ来ない(描画側が `mine` の線にしか消す口を出さない)。
     */
    case 'SQL_ER_UNLINK': {
      const p = state.sqlPage;
      const mine = p.er.mine.filter(
        (l) =>
          !(
            l.from === action.link.from &&
            l.fromColumn === action.link.fromColumn &&
            l.to === action.link.to &&
            l.toColumn === action.link.toColumn
          ),
      );
      if (mine.length === p.er.mine.length) return { state, events: [] };
      return { state: { ...state, sqlPage: { ...p, er: { ...p.er, mine } } }, events: [] };
    }
    /**
     * 🔴 **図の中を押した**(#918 段⑤c)。
     * ⚠ **打っている字は捨てない** ── 足せるかを決めるのは `erSql`(pure)で、
     *   足せないときは**理由**を控えて画面へ出す(黙って何もしない形を作らない)。
     * 🔑 履歴の手直しの控えは `SET_SQL_TEXT` と**同じ作法**で取る ── ここだけ
     *   忘れると、図から足した字が `↑` を押した瞬間に消える。
     */
    case 'SQL_ER_PRESS': {
      const p = state.sqlPage;
      const r = erSql(p.sql, action.press);
      if (!r.ok) {
        return {
          state: { ...state, sqlPage: { ...p, er: { ...p.er, note: r.why } } },
          events: [],
        };
      }
      return {
        state: {
          ...state,
          sqlPage: {
            ...p,
            sql: r.sql,
            error: '',
            er: { ...p.er, note: '' },
            ...(p.historyAt < 0 ? {} : { historyEdits: withHistoryEdit(p, r.sql) }),
          },
        },
        events: [],
      };
    }
    /**
     * 構造が採れた(#918 段⑤)。
     * ⚠ **札が違えば捨てる** ── 採っている間に相手を変えられる(`SQL_RUN_DONE` と同じ)。
     * 🔑 **模型を組むのはここ** ── `schemaModel` は pure なので reducer に置ける。
     *   effect に置くと、採る側と組む側が 2 か所に分かれる(§7)。
     */
    case 'SQL_ER_LOADED': {
      const p = state.sqlPage;
      if (p.er.token !== action.token) return { state, events: [] };
      const model = schemaModel({
        source: p.guest?.name ?? '',
        columns: action.columns,
        fks: action.fks,
        ...(action.counts === null ? {} : { counts: action.counts }),
        // 🔴 本文の csv の表も図に出す(#918 段⑤d-2)
        ...(action.csv === null ? {} : { csv: action.csv }),
      });
      return {
        state: {
          ...state,
          sqlPage: {
            ...p,
            // 🔴 DuckDB の器から採った回は、写した報告も受ける(内蔵の sqlite の回は動かさない)
            duckCopy: action.copy ?? p.duckCopy,
            er: { ...p.er, loading: false, model },
          },
        },
        events: [],
      };
    }
    /** 構造を採れなかった(#918 段⑤)。⚠ 黙って空の図を出さない ── 理由を言う。 */
    case 'SQL_ER_FAILED': {
      const p = state.sqlPage;
      if (p.er.token !== action.token) return { state, events: [] };
      return {
        state: {
          ...state,
          sqlPage: {
            ...p,
            // 🔑 `model` を捨てる回は `mine` / `pendingFrom` も一緒に捨てる(#918 段⑤d-1)
            er: { ...p.er, loading: false, model: null, note: action.error, mine: [], pendingFrom: null },
          },
        },
        events: [],
      };
    }
    /**
     * 🔴 **古い回の答えは捨てる**(#681 の着地前レビュー F3-A)。
     * ⚠ 走っている最中に相手を変えられるので、受けると**新しい名札のまま
     *   古い DB の中身**が出る ── 数字は本物なので気づけない。
     */
    case 'SET_SQL_RESULT': {
      const p = state.sqlPage;
      if (p.runToken !== action.token) return { state, events: [] };
      /**
       * 🔴 **DuckDB で書いた文(`CREATE` / `DROP` / `ALTER` …)が通ったら、つながり図を採り直す**
       *   (#682 段④d の着地後レビュー R1)。
       * ⚠ 直す前は `er` に触らず、図は**書く前の構造のまま**だった ── `DROP TABLE 売上` の後も 売上 の四角が残り、
       *   押すと `no such table` で断られる(作った表は四角に出ない)。
       * 🔑 判定は字の門と**同じ 1 本**(`duckDbWriteKind`)。⚠ 図の構造を DuckDB の器から採る相手
       *   (`schemaRouteOf(...).duck`)のときだけ ── 内蔵の sqlite から採る相手の図は、DuckDB で何を書いても変わらない。
       * 🔑 自分で引いた線(`mine`)は残す(user の作業。消えた表を指す線は図が「線にできなかった繋がり」と言う)。
       *   押しかけの「ここから」(`pendingFrom`)は捨てる(その列がもう無いかもしれない)。
       */
      const route = schemaRouteOf(p.guest, p.extraGuests);
      const redraw =
        duckDbWriteKind(action.sql) !== null && route.duck !== undefined
          ? erAfterDuckWrite(p.er, erSourceKey(p.guest, p.extraGuests), route)
          : null;
      return {
        state: {
          ...state,
          sqlPage: {
            ...p,
            ranSql: action.sql,
            columns: action.columns,
            rows: action.rows,
            truncated: action.truncated,
            ms: action.ms,
            running: false,
            duckLoading: false,
            error: '',
            duckCopy: action.copy ?? p.duckCopy,
            ...(redraw === null ? {} : { er: redraw.er }),
          },
        },
        events: redraw === null ? [] : redraw.events,
      };
    }
    /**
     * 🔴 **書き出したことを画面で言う**(#681 段③ の 3 つ目)。
     * ⚠ 別の窓で開いている面なので、**言わないと押せなかったように見える**。
     */
    case 'SQL_SAVED':
      // ⚠ **`running` を必ず降ろす**(#918 段①)── `SQL_SAVE_FAILED` と対である
      return {
        state: {
          ...state,
          sqlPage: {
            ...state.sqlPage,
            running: false,
            saved: action.title,
            savedKind: action.kind,
            savedCapped: action.capped ?? 0,
          },
        },
        events: [],
      };
    /**
     * 🔴 **調べる相手を選ぶ**(#681 段③ の 2 つ目)。
     *
     * ⚠ **前の相手は必ず手放す** ── 選び直すたびに常駐メモリが積み上がる
     *   (不可侵指示 2026-07-27「生成とライフサイクル後の速やかな破棄」)。
     * ⚠ **前の答えも消す** ── 相手が変われば、出ている表は**別の DB の話**である
     *   (残すと「新しい相手を調べた答え」に見える ── いちばん気づけない外し方)。
     */
    /**
     * 🔴 **どのエンジンで引くかを選んだ**(#682 段②)。
     *
     * ⚠ **表も断りも消さない** ── 相手は変わっていないので、いま出ている答えは
     *   そのまま正しい(`SET_SQL_SOURCE` は相手ごと変わるので消す ── 役目が違う)。
     * ⚠ 走っている最中でも受ける ── 次に押したときから効く(押した印は必ず付く)。
     */
    case 'SET_SQL_ENGINE':
      if (state.sqlPage.engine === action.engine) return { state, events: [] };
      return { state: { ...state, sqlPage: { ...state.sqlPage, engine: action.engine } }, events: [] };
    case 'SET_SQL_SOURCE': {
      /**
       * ⚠ **手放すのは「さっきまでの相手」** ── `guestChosen` はまだ書き換えていないので、
       *   ここで読むと前の選択が入っている(#682 段④c)。
       */
      const events: DomainEvent[] = [
        { type: 'REQUEST_SQL_GUEST_CLOSE', prev: state.sqlPage.guestChosen },
      ];
      /**
       * 🔴 **足した相手は、1 件目を選び直したら全部外す**(#918 段⑦)。⚠ 外した分の控え
       *   (手持ちの file)も**ここで手放す** ── 手放さないと、選び直すたびに
       *   `File` を握ったまま積み上がる(不可侵指示 2026-07-27)。
       */
      if (state.sqlPage.extraGuests.length > 0) {
        events.push({
          type: 'REQUEST_SQL_EXTRA_RELEASE',
          lids: state.sqlPage.extraGuests.map((g) => g.lid),
        });
      }
      if (action.lid !== '') {
        events.push({ type: 'REQUEST_SQL_GUEST_OPEN', lid: action.lid, name: action.name });
      }
      /**
       * 🔴 **前の相手の図を持ち越さない**(#918 段⑤)。
       * ⚠ ノートへ戻る回(`lid === ''`)は**その場で採り直せる**が、よその DB へ移る回は
       *   **まだ開いていない**ので頼めない ── 開けた回(`SQL_GUEST_OPENED`)が頼む。
       */
      const er = erForSource(state.sqlPage.er, action.lid, {}, action.lid === '');
      events.push(...er.events);
      return {
        state: {
          ...state,
          sqlPage: {
            ...state.sqlPage,
            guest: null,
            extraGuests: [],
            guestError: '',
            guestPending: action.lid,
            // 🔴 選び所の見た目は、開けたかどうかに関わらずここで確定させる
            guestChosen: action.lid,
            /**
             * 🔴 **走っている答えを無効にする**(#681 F3-A)── 札を進めると、
             *   飛んでいる回の答えは捨てられる。
             * ⚠ `running` も下ろす ── 下ろさないと「走らせています…」が
             *   **永久に消えない**(答えは捨てるので、もう来ない)。
             */
            runToken: state.sqlPage.runToken + 1,
            running: false,
            ranSql: '',
            columns: [],
            rows: [],
            truncated: false,
            ms: 0,
            error: '',
            saved: '',
            duckCopy: null,
            duckLoading: false,
            er: er.er,
          },
        },
        events,
      };
    }
    /**
     * 🔴 **調べる相手をもう 1 つ足す**(#918 段⑦。Gemini 裁定 2026-10-01 = 設問 1 は A、設問 2 は B)。
     *
     * ⚠ **確認は出さない**(設問 2 = B)── 代わりに字で言う(案内文と、作った表が通った直後の 1 行)。
     *   足すと**器を作り直す**ので、作った表は消える(`DUCKDB_TABLE_RESET`)。
     * ⚠ **足せない相手は断りの字を返す**(黙って何も起きない形を作らない)。断った回も
     *   **控えは手放す**(手持ちの file を選んだ直後に断ると、`File` が握られたまま残る)。
     * 🔑 開く仕事は無い ── 足した相手は DuckDB が走らせる回に読む(sqlite へは開かない)。
     */
    case 'ADD_SQL_SOURCE': {
      const p = state.sqlPage;
      const checked = checkAddSource(p.guest, p.extraGuests, { lid: action.lid, name: action.name });
      /**
       * ⚠ **使っている相手の控えは手放さない** ── 同じ lid をもう一度足した回(`はもう並べてあります`)に
       *   手放すと、**使っている file を消す**。判定は lid の一致で見る(種類に寄りかからない)。
       */
      const inUse = p.guest?.lid === action.lid || p.extraGuests.some((e) => e.lid === action.lid);
      if (!checked.ok) {
        return {
          state: { ...state, sqlPage: { ...p, error: checked.why } },
          events: inUse ? [] : [{ type: 'REQUEST_SQL_EXTRA_RELEASE', lids: [action.lid] }],
        };
      }
      const extras = [...p.extraGuests, { lid: action.lid, name: action.name }];
      return withSqlSourceSet(state, extras);
    }
    /**
     * 🔴 **足した相手を外す**(#918 段⑦)。⚠ 1 件目は外せない(選び所で別の相手を選ぶ ──
     *   外す口は「足した分」にだけ在る)。足していない lid は**何もしない**(控えも手放さない)。
     */
    case 'REMOVE_SQL_SOURCE': {
      const p = state.sqlPage;
      if (!p.extraGuests.some((e) => e.lid === action.lid)) return { state, events: [] };
      const extras = p.extraGuests.filter((e) => e.lid !== action.lid);
      const next = withSqlSourceSet(state, extras);
      return {
        state: next.state,
        events: [...next.events, { type: 'REQUEST_SQL_EXTRA_RELEASE', lids: [action.lid] }],
      };
    }
    /**
     * 🔴 **いま選んでいる相手の答えだけ受ける**(#681 段③ の 2 つ目)。
     * ⚠ 選び直した直後は、**前の相手の「開けました」が後から届く** ── 受けると
     *   選んでいない DB を「調べています」と出し、打った SQL はそちらへ飛ぶ。
     */
    case 'SQL_GUEST_OPENED': {
      if (state.sqlPage.guestPending !== action.lid) return { state, events: [] };
      // 開き終わる前に押された断り(RUN_SQL)は、開けた時点で嘘になるので降ろす
      const waitNote = state.sqlPage.error === SQL_GUEST_OPENING_TEXT;
      /**
       * 🔴 開けた相手の構造を採り直す(図を開いているときだけ ── §7 の 1 か所)。
       * ⚠ **`.parquet` / `.json` も採る**(#918)── 頼み先は `schemaRouteOf`(DuckDB の器)。
       *   以前は「採れない」理由をここで書いて頼まなかった。
       */
      const opened = { lid: action.lid, name: action.name };
      const er = erForSource(
        state.sqlPage.er,
        erSourceKey(opened, state.sqlPage.extraGuests),
        schemaRouteOf(opened, state.sqlPage.extraGuests),
        true,
      );
      return {
        state: {
          ...state,
          sqlPage: {
            ...state.sqlPage,
            guest: {
              lid: action.lid,
              name: action.name,
              tables: action.tables,
              bytes: action.bytes,
              truncated: action.truncated,
              ...(action.sjis === true ? { sjis: true } : {}),
            },
            guestError: '',
            guestPending: '',
            ...(waitNote ? { error: '' } : {}),
            er: er.er,
          },
        },
        events: er.events,
      };
    }
    case 'SQL_GUEST_FAILED':
      // ⚠ 断りも**いま選んでいる相手の分だけ**受ける(古い断りで新しい選択を消さない)
      if (state.sqlPage.guestPending !== action.lid) return { state, events: [] };
      /**
       * ⚠ **`guest` は触らない** ── `SET_SQL_SOURCE` が既に `null` にしてあるので、
       *   ここで書くと**外しても誰も落ちない行**になる(変異試験 A5 が SURVIVED で
       *   教えた ── CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
       */
      return {
        state: {
          ...state,
          sqlPage: {
            ...state.sqlPage,
            guestError: action.error,
            guestPending: '',
            /**
             * ⚠ **「採っています」で止めない**(#918 段⑤)── 開けなかったので
             *   構造は永久に来ない。⚠ 理由は `guestError` が言うので、ここでは繰り返さない
             *   (同じ断りが 2 行出ると、別々のことが起きたように見える)。
             * 🔑 `mine` / `pendingFrom` も一緒に捨てる(#918 段⑤d-1)。
             */
            er: { ...state.sqlPage.er, loading: false, model: null, source: '', mine: [], pendingFrom: null },
          },
        },
        events: [],
      };
    /**
     * 🔴 **書き出せなかった理由を画面へ**(#681 の着地前レビュー F1)。
     * ⚠ 断りの色が付く行(`error`)へ出す ── 黙って何も起きない形を作らない。
     */
    case 'SQL_SAVE_FAILED':
      // ⚠ **`running` を必ず降ろす**(#918 段①)── 構造の書き出しはここを終わりにするので、
      //    降ろさないと以後ずっと押せなくなる。⚠ 元から false の回に書いても害は無い。
      return {
        state: {
          ...state,
          sqlPage: { ...state.sqlPage, running: false, error: action.error, saved: '' },
        },
        events: [],
      };
    case 'SQL_DUCK_LOADING': {
      const p = state.sqlPage;
      // ⚠ 古い回の合図・走っていない間の合図は捨てる(終わった画面に「時間がかかります」を残さない)
      if (!p.running || p.runToken !== action.token) return { state, events: [] };
      return { state: { ...state, sqlPage: { ...p, duckLoading: true } }, events: [] };
    }
    case 'SQL_RUN_FAILED':
      /**
       * ⚠ **前の表は残す**(消すと「失敗して 0 件だった」に見える)── 印だけ立てる
       *   (`SEARCH_DETAIL_FAILED` と同じ作法)。
       */
      if (state.sqlPage.runToken !== action.token) return { state, events: [] };
      {
        /**
         * 🔴 **時計で器が畳まれた回は、開いたままのつながり図を採り直す**(着地後レビュー 💭10)。
         * ⚠ 30 秒の門(`DUCKDB_TOO_LONG`)・写す所の 120 秒の門(`DUCKDB_LOAD_TOO_LONG`)が鳴ると器は**畳まれる** ──
         *   写した表も、`CREATE` で作った表も消える。直す前は図に**もう無い表の四角が残り**、押すと `no such table` だった
         *   (`SET_SQL_RESULT` の書き込み後 R1 と同じ症状)。
         * 🔑 作法も R1 と同じ `erAfterDuckWrite`(user が引いた線 `mine` は残す)。⚠ 図の構造を **DuckDB の器から採る相手**
         *   (`schemaRouteOf(...).duck`)のときだけ ── 内蔵の sqlite から採る図は器と関係が無い。
         * 🔑 判定は断りの**字**(`DUCKDB_TOO_LONG` / `DUCKDB_LOAD_TOO_LONG`。字を 1 か所で持つ ── 後ろに写せなかった表の
         *   理由が付いても拾えるよう `includes`)。それ以外の失敗(字の誤り・表が無い)では器は畳まれていないので触らない。
         */
        const p = state.sqlPage;
        const route = schemaRouteOf(p.guest, p.extraGuests);
        const folded =
          route.duck !== undefined &&
          (action.error.includes(DUCKDB_TOO_LONG) || action.error.includes(DUCKDB_LOAD_TOO_LONG));
        const redraw = folded ? erAfterDuckWrite(p.er, erSourceKey(p.guest, p.extraGuests), route) : null;
        return {
          state: {
            ...state,
            sqlPage: { ...p, running: false, duckLoading: false, error: action.error, ...(redraw === null ? {} : { er: redraw.er }) },
          },
          events: redraw === null ? [] : redraw.events,
        };
      }
  }
}
