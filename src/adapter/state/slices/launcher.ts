/**
 * reducer の slice: アプリ一覧(タイル・グループ・アイコン・並べ替え)(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceLauncher` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type DomainEvent,
  type ReduceResult,
  appGroupWriteRefusal,
  appTileRefusal,
  attachmentEntries,
  findAppGroupLid,
  phaseBlockReason,
  readAppGroupNotes,
  reduce,
  refreshSmartHits,
  refreshTaskCards,
  sameShownBodies,
  syncShownBodies,
} from '../app-state';
import { normalizeQuery } from '@features/filter/title-filter';
import {
  APP_GROUP_ARCHETYPE,
  appGroupName,
  appGroupSeed,
  withAppGroupIcon,
  writeAppGroupIcon,
  writeAppGroupOrder,
} from '@features/launcher/app-group-spec';
import { planGroupMove } from '@features/launcher/group-order';
import { applyTileWrites, isMovableTile, planTileMove } from '@features/launcher/tile-order';

export type LauncherAction = Extract<Dispatchable, { type: 'REFRESH_LAUNCHER_TILES' | 'PICK_APP_TILE' | 'SET_LAUNCHER_REORDER' | 'LAUNCHER_TILES_LOADED' | 'APP_GROUP_NOTES_LOADED' | 'MOVE_APP_GROUP' | 'RESET_APP_GROUP_ORDER' | 'RENAME_APP_GROUP' | 'SET_APP_GROUP_ICON' | 'APP_TILE_SAVED' | 'OFFICE_ASSET_SAVED' | 'ENTRY_BODY_REFRESHED' | 'SET_APP_TILE' | 'MOVE_APP_TILE' }>;

export function reduceLauncher(state: AppState, action: LauncherAction): ReduceResult {
  switch (action.type) {
    case 'REFRESH_LAUNCHER_TILES':
      // ⚠ **毎回要求する**。ただし前回のタイルは消さない(古い並びを出したまま
      //    読み直し、届いたら差し替える ── 「読み込んでいます…」を挟まない)
      return {
        state,
        events: [
          { type: 'REQUEST_LAUNCHER_TILES', entries: attachmentEntries(state) },
          /**
           * ⚠ **引き金は同じでも、読み筋は別**(#857 段②)── 混ぜると
           *   `tileFrom` が両方を同じ土俵で処理することになる。
           */
          readAppGroupNotes(state),
        ],
      };
    /**
     * 🔴 **1 回目の押し ── 印を付けるだけ**(#857 段①b)。
     * ⚠ 右の列に何を出すかは `selectedLid` のままなので、**ここでは触らない**
     *   (entry を持つタイルは呼び側が `SELECT_ENTRY` も撃つ ── 判定の正本は
     *   `tileSelectsEntry` 1 本で、ここに 2 つ目を書かない)。
     */
    case 'PICK_APP_TILE':
      if (state.launcherPick === action.lid) return { state, events: [] };
      return { state: { ...state, launcherPick: action.lid }, events: [] };
    /**
     * 🔴 **並べ替えモードへ入る / 出る**(#857 段①b-2)。
     *
     * ⚠ **入るときだけ門を通す** ── 出るのはいつでもできる(閉じ込めない)。
     * 🔑 門は `MOVE_APP_TILE` と**同じ 2 つ**(`phase` と絞り込み)だけにする ──
     *   保存中(`writeLock` / `tileWrite`)は**数百ミリ秒で消える**ので、入口で
     *   断ると「押しても入れない」が偶発的に起きる。**動かすときに断れば足りる**。
     */
    case 'SET_LAUNCHER_REORDER': {
      if (!action.on) {
        if (!state.launcherReorder) return { state, events: [] };
        return { state: { ...state, launcherReorder: false }, events: [] };
      }
      const blocked = phaseBlockReason(state.phase);
      if (blocked !== null)
        return { state: { ...state, error: `${blocked}並べ替えられます` }, events: [] };
      if (normalizeQuery(state.filterQuery) !== '')
        return {
          state: {
            ...state,
            error: '絞り込みを消してから並べ替えられます(いまは一部しか出ていません)',
          },
          events: [],
        };
      if (state.launcherReorder) return { state, events: [] };
      return { state: { ...state, launcherReorder: true }, events: [] };
    }
    case 'LAUNCHER_TILES_LOADED':
      return { state: { ...state, launcherTiles: action.tiles }, events: [] };
    case 'APP_GROUP_NOTES_LOADED':
      /**
       * 🔴 **世代が違う読み直しは画面に当てない**(#857 段③。
       * 実ブラウザ smoke が 3 回に 1 回落ちて見つかった)。
       *
       * ⚠ 落ちていたのは「**名前順へ戻したのに、まだ『すべて名前順に戻す』が出ている**」。
       *   並べ替えが積んだ読み直しが**戻す操作のあとに**返ってきて、
       *   **戻す前の本文**(= まだ番号が載っている)を画面へ当てていた。
       * 🔑 `APP_TILE_SAVED` が既に持っている作法を、こちらにも置いた
       *   (**片側にしか無い門**は §7 の型である)。
       * ⚠ 捨てても画面は置き去りにならない ── 世代を進めた側が必ず読み直しを
       *   1 本積むので、**すぐ後ろに正しい答えが来る**。
       */
      if (action.gen !== state.appGroupGen) return { state, events: [] };
      return {
        state: { ...state, appGroupIcons: action.icons, appGroupOrders: action.orders },
        events: [],
      };
    /**
     * 🔴 **グループを 1 つ上へ / 下へ**(#857 段③)。
     *
     * 🔑 計画は `planGroupMove`(純関数)── **どこへ入るか**の規則をここに書かない。
     * ⚠ **書くのは「動かした先より上に在る群」まで** ── 番号のある群は必ず先に来るので、
     *   部分的には付けられない(`group-order.ts` の説明)。
     * ⚠ 動かせるのは**名前の付いた、動かせるタイルを持つ群**だけ ── 組み込みは末尾に固定。
     */
    case 'MOVE_APP_GROUP': {
      // ⚠ 門は `MOVE_APP_TILE` と同じ 2 つ(保存中は触らせない / 絞り込み中は動かさない)
      // 🔴 断るときは理由を出す(#1087。黙って返すと、押したのに何も起きない)
      const moveRefusal = appGroupWriteRefusal(state, '並べ替えられます');
      if (moveRefusal !== null) return { state: { ...state, error: moveRefusal }, events: [] };
      if (normalizeQuery(state.filterQuery) !== '')
        return {
          state: {
            ...state,
            error: '絞り込みを消してから並べ替えられます(いまは一部しか出ていません)',
          },
          events: [],
        };
      const tiles = state.launcherTiles;
      if (tiles === null) return { state, events: [] };
      /**
       * ⚠ **動かせる群だけを渡す** ── 組み込みしか居ない群を混ぜると、
       *   「押せるのに末尾から動かない」という食い違いになる。
       */
      const movable: string[] = [];
      for (const t of tiles)
        if (t.group !== '' && isMovableTile(t) && !movable.includes(t.group)) movable.push(t.group);
      const plan = planGroupMove(movable, state.appGroupOrders, appGroupName(action.name), action.by);
      if (plan.length === 0) return { state, events: [] };
      /**
       * ⚠ **lid が足りなければ書かない** ── 呼び側が採り損ねたぶんを別の群の lid で
       *   埋めると、**別のノートを書き潰す**(いちばん戻せない壊れ方)。
       */
      const rows: Array<{
        name: string;
        order: number;
        lid: string;
        title: string;
        archetype: string;
        entryOrder: number;
      }> = [];
      /**
       * 🔴 **無い群のノートは、ここで `CREATE_ENTRY` を通して作る**
       *   ── effect に作らせない(2026-09-13。CI の全数門が入口になって判った)。
       *
       * ⚠ 直す前は effect が `store.persistEntry` で直に行を作っていた。門は
       *   「書込 1 回に刻み 1 回」を**数える**だけなので、刻みを 1 つ足せば緑になる
       *   ── ⚠ **ところがその刻みは届かない**:`ENTRY_STAMPED` は
       *   **`entryMetas` に居ない lid を捨てる**ので、作ったばかりの行には当たらない。
       * 🔴 つまり本当の欠陥は刻みではなく、**作った物が state に入らないこと**だった
       *   ── サイドバーにも目録にも出ず、**次に開き直すまで存在しないように見える**。
       * 🔑 だから作り方を目印(`SET_APP_GROUP_ICON`)と揃える ── 作る口は
       *   **既存の 1 本**(`CREATE_ENTRY`)。⚠ `CREATE_ENTRY` は本文ごと書くので、
       *   新しく作る群は `REQUEST_APP_GROUP_ORDER` の行に**入れなくてよい**
       *   (番号は雛形に入っている)。
       */
      let next = state;
      let fresh = 0;
      const created: DomainEvent[] = [];
      for (const w of plan) {
        const lid = findAppGroupLid(next.order, next.entryMetas, w.name);
        if (lid !== null) {
          const meta = next.entryMetas.get(lid)!;
          rows.push({
            name: w.name,
            order: w.order,
            lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
          });
          continue;
        }
        const newLid = action.newLids[fresh];
        fresh += 1;
        /**
         * ⚠ **lid が足りなければ 1 バイトも書かない** ── 呼び側が採り損ねたぶんを
         *   別の群の lid で埋めると、**別のノートを書き潰す**(いちばん戻せない壊れ方)。
         * 🔴 **黙って止まらない**(2026-09-13、着地前レビュー)── 呼び側は確認の小窓を
         *   出す**前**に lid を採るので、user が「はい」を押すまでの間に別のタブが群を
         *   増やすと、ここで足りなくなる。⚠ 何も言わずに返すと
         *   **「はい」を押したのに画面が 1 ドットも変わらない**(無言の dead click)。
         */
        if (newLid === undefined)
          return {
            state: {
              ...state,
              error: '一覧が変わったため、並べ替えを保存しませんでした(もう一度押してください)',
            },
            events: [],
          };
        const made = reduce(next, {
          type: 'CREATE_ENTRY',
          archetype: APP_GROUP_ARCHETYPE,
          lid: newLid,
          title: w.name,
          body: writeAppGroupOrder(appGroupSeed(w.name), w.order),
          // 🔴 見ていた物を退かさない(目印と同じ ── user は並べ替えたいだけである)
          keepSelection: true,
        });
        next = made.state;
        created.push(...made.events);
      }
      /**
       * 🔑 **画面は先に動かす**(タイルと同じ)── disk の往復を待つと数百 ms 動かず、
       *   「押したのに動かない」になる。⚠ 番号は state に持つので、書き戻しは要らない。
       * 🔴 **世代を 1 つ進める**(#857 段③)── 画面を先に動かした以上、
       *   **この瞬間より前に積んだ読み直しは、書き換える前の本文を読む**ので当ててはいけない。
       */
      const moved: AppState = {
        ...next,
        appGroupOrders: Object.fromEntries([
          ...Object.entries(next.appGroupOrders),
          ...plan.map((w) => [w.name, w.order] as const),
        ]),
        appGroupGen: next.appGroupGen + 1,
      };
      return {
        state: moved,
        events: [
          ...created,
          { type: 'REQUEST_APP_GROUP_ORDER', rows },
          /**
           * 🔴 **書いた「あと」に必ず読み直す**(2026-09-13、着地前レビュー)。
           *
           * ⚠ 画面は先に動かす(上)ので、**書込が途中で止まると画面と disk が食い違う** ──
           *   別の窓が先に書いていれば `expectHash` が弾いて 1 行目までしか書けないのに、
           *   画面は最後まで動いた姿を出し続ける(`F5` まで誰も気づかない)。
           * 🔑 effect の列は 1 本なので、ここへ置けば**書込のあと**に走り、
           *   成功でも衝突でも `appGroupOrders` を disk の実値へ戻す
           *   (`REQUEST_TILE_ORDER` が同じことをしている)。
           */
          readAppGroupNotes(moved),
        ],
      };
    }
    /**
     * 🔴 **並べ替えをやめて名前順へ戻す**(#857 段③。着地前の動線レビューが出した)。
     *
     * ⚠ **片道の操作を作らない**(CLAUDE.md 不可侵)── 「上へ / 下へ」を逆に押せば
     *   見た目は戻るが、**番号はノートに残り続ける**ので「番号の付いていない状態」へは
     *   帰れなかった。目印は「なし」で 1 回で外せるのに、並びだけ戻せないのは
     *   釣り合いが崩れている。
     * 🔑 **ノートは消さない** ── 消すのは `appgroup.order` の 1 行だけである
     *   (目印や説明が同じノートに載っているので、丸ごと片付けない)。
     */
    case 'RESET_APP_GROUP_ORDER': {
      // 🔴 断るときは理由を出す(#1087)
      const resetRefusal = appGroupWriteRefusal(state, '名前順に戻せます');
      if (resetRefusal !== null) return { state: { ...state, error: resetRefusal }, events: [] };
      const rows: Array<{
        name: string;
        order: number | null;
        lid: string;
        title: string;
        archetype: string;
        entryOrder: number;
      }> = [];
      for (const name of Object.keys(state.appGroupOrders)) {
        const lid = findAppGroupLid(state.order, state.entryMetas, name);
        // ⚠ ノートが消えていれば書く先が無い ── その群は state から落ちるだけでよい
        if (lid === null) continue;
        const meta = state.entryMetas.get(lid)!;
        rows.push({
          name,
          order: null,
          lid,
          title: meta.title,
          archetype: meta.archetype,
          entryOrder: meta.entryOrder,
        });
      }
      /**
       * ⚠ **番号が 1 つも無ければ何も起きない**(押し所はそもそも出ないが、門は両側に置く)。
       *
       * 🔴 **`rows.length === 0 &&` を外した**(2026-09-13。自分の diff を読み直して検算)。
       * ⚠ `rows` は `appGroupOrders` の key から作るので、**番号が空なら rows も必ず空** ──
       *   前半は後半に含まれる、**書いても何も守らない条件**だった。
       * ⚠ 実測で両方向を見た:**前半だけ外すと緑のまま**(= 冗長)/
       *   **門を丸ごと外すと落ちる**(= 門そのものは効いている)。
       * 🔑 CLAUDE.md「『これが無いと壊れる』と書いたら、外して壊れることを 1 度は見る。
       *   見ないなら書かない」── 見たら、前半は書いてはいけない側だった。
       * ⚠ 番号は在るのにノートが消えている(`rows` だけ空)ときは、**通してよい** ──
       *   画面の番号を落として名前順へ戻すのが正しい(書く先が無いだけである)。
       */
      if (Object.keys(state.appGroupOrders).length === 0) return { state, events: [] };
      // 🔑 画面は先に戻す(書き戻しを待たない ── 動かすときと同じ流儀)。
      // 🔴 世代を進める理由は `MOVE_APP_GROUP` と同じ ── ここが**当の症状**が出た所で、
      //    「戻したのに、また『すべて名前順に戻す』が出る」は飛んでいた読み直しの仕業だった。
      const cleared: AppState = { ...state, appGroupOrders: {}, appGroupGen: state.appGroupGen + 1 };
      return {
        state: cleared,
        events: [
          { type: 'REQUEST_APP_GROUP_ORDER', rows },
          // 🔴 書いたあとに読み直す(上の `MOVE_APP_GROUP` と同じ理由)
          readAppGroupNotes(cleared),
        ],
      };
    }
    case 'RENAME_APP_GROUP': {
      // 🔴 断るときは理由を出す(目印・並べ替えと同じ門 + タイル設定の書込中)
      const renameRefusal = appGroupWriteRefusal(state, '名前を変えられます');
      if (renameRefusal !== null) return { state: { ...state, error: renameRefusal }, events: [] };
      const from = appGroupName(action.from);
      const to = appGroupName(action.to);
      if (from === '' || to === from) return { state, events: [] };
      if (to === '')
        return {
          state: {
            ...state,
            error:
              'グループの名前が空です(グループから外すには、アプリの設定の「グループ」の欄を空にしてください)',
          },
          events: [],
        };
      if (state.tileWrite)
        return {
          state: { ...state, error: 'いまアプリの設定を保存しています。終わってから、もう一度押してください' },
          events: [],
        };
      const tiles = state.launcherTiles;
      if (tiles === null) return { state, events: [] };
      // ⚠ 動かせるのは自分のアプリだけ(組み込みは entry を持たない)
      const members = tiles.filter((t) => isMovableTile(t) && t.group === from);
      if (members.length === 0)
        return {
          state: {
            ...state,
            error: 'このグループは名前を変えられません(最初から入っているアプリだけのグループです)',
          },
          events: [],
        };
      const rows: Array<{
        lid: string;
        updates: Record<string, string | number | undefined>;
        title: string;
        archetype: string;
        entryOrder: number;
      }> = [];
      for (const t of members) {
        const meta = state.entryMetas.get(t.lid);
        if (meta === undefined)
          return { state: { ...state, error: '名前を変えられません(ノートが見つかりません)' }, events: [] };
        rows.push({
          lid: t.lid,
          updates: { 'attachment.app_group': to },
          title: meta.title,
          archetype: meta.archetype,
          entryOrder: meta.entryOrder,
        });
      }
      /**
       * 🔑 グループ用のノート(目印・並び順を持つ)も題名を合わせる。⚠ 行き先の名前のノートが既に在るときは動かさない
       *   (同じ題名のノートを 2 つ作らない ── そのときは行き先のグループへまとまる)。
       */
      let next = state;
      const pre: DomainEvent[] = [];
      const noteLid = findAppGroupLid(state.order, state.entryMetas, from);
      const renamedNote = noteLid !== null && findAppGroupLid(state.order, state.entryMetas, to) === null;
      if (noteLid !== null && renamedNote) {
        const made = reduce(state, { type: 'RENAME_ENTRY_TITLE', lid: noteLid, title: to });
        next = made.state;
        pre.push(...made.events);
      }
      const rekey = <T>(o: Readonly<Record<string, T>>): Record<string, T> =>
        Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v] as const));
      const moved: AppState = {
        ...next,
        launcherTiles: tiles.map((t) => (isMovableTile(t) && t.group === from ? { ...t, group: to } : t)),
        appGroupIcons: renamedNote ? rekey(next.appGroupIcons) : next.appGroupIcons,
        appGroupOrders: renamedNote ? rekey(next.appGroupOrders) : next.appGroupOrders,
        appGroupGen: next.appGroupGen + 1,
        tileWrite: { lid: rows[0]!.lid, n: 1 },
        notice: `グループ「${from}」を「${to}」に変えました(${String(rows.length)} 件のアプリ)`,
      };
      return {
        state: moved,
        events: [
          ...pre,
          {
            type: 'REQUEST_TILE_ORDER',
            lid: rows[0]!.lid,
            gen: state.lockGen,
            rows,
            entries: attachmentEntries(state),
          },
          // 🔴 書いた「あと」に読み直す(画面を先に動かしたので、書けなかった回は disk の答えへ戻る)
          readAppGroupNotes(moved),
        ],
      };
    }
    case 'SET_APP_GROUP_ICON': {
      // ⚠ 書込が飛んでいる間は触らせない(`SET_APP_TILE` と同じ規律 ── 読んで
      //    書き戻す操作なので、途中に別の書込が挟まると片方が消える)
      // 🔴 断るときは理由を出す(#1087)
      const iconRefusal = appGroupWriteRefusal(state, '目印を変えられます');
      if (iconRefusal !== null) return { state: { ...state, error: iconRefusal }, events: [] };
      const name = appGroupName(action.name);
      // ⚠ 名前の無い群は見出しを持たない ── 目印を置く場所がそもそも無い
      if (name === '') return { state, events: [] };
      /**
       * 🔴 **画面を先に動かす**(#1076)。
       *
       * ⚠ 直す前は `appGroupIcons` が変わるのが**読み直しの ack が返ってから**で、
       *   その間に「目印を選ぶ…」を開き直すと**選ぶ前の絵に枠が付いていた**
       *   (表は開いた瞬間の値で組まれ、開いている間は変わらない)── 見出しの絵も同じ間だけ古い。
       * 🔑 **世代を進める** ── 先に飛んでいた読み直し(この変更を知らない本文)に
       *   巻き戻させない(§7。`MOVE_APP_GROUP` と同じ作法)。disk の答えは、
       *   下で積む読み直しが**必ず後ろから**持って来る(書けなかったときはそれで戻る)。
       */
      const optimistic = (s: AppState): AppState => ({
        ...s,
        appGroupIcons: withAppGroupIcon(s.appGroupIcons, name, action.icon),
        appGroupGen: s.appGroupGen + 1,
      });
      const found = findAppGroupLid(state.order, state.entryMetas, name);
      if (found !== null) {
        const meta = state.entryMetas.get(found)!;
        const next = optimistic(state);
        return {
          state: next,
          events: [
            {
              type: 'REQUEST_APP_GROUP_ICON_WRITE',
              lid: found,
              title: meta.title,
              archetype: meta.archetype,
              entryOrder: meta.entryOrder,
              icon: action.icon,
            },
            // ⚠ 書いた**あと**に読み直す(effect の列は 1 本なので順番は保たれる)──
            //    読み直さないと、押した結果が出るのは「次にタブを開き直したとき」になる
            // ⚠ **進めた後の世代で**積む(当てる前の state で積むと、出た瞬間に捨てられる)
            readAppGroupNotes(next),
          ],
        };
      }
      /**
       * ⚠ **外すだけなら作らない** ── 目印の無いグループで「なし」を押したときに
       *   空のノートが生えると、user は**頼んでいない物**を片付ける羽目になる。
       */
      if (action.icon === null) return { state, events: [] };
      /**
       * 🔑 **作る口は既存の 1 本を通す**(`CREATE_ENTRY`)── ここで並びも目録も
       *   自分で組むと、作り方が 2 つになる(§7)。
       */
      const created = reduce(state, {
        type: 'CREATE_ENTRY',
        archetype: APP_GROUP_ARCHETYPE,
        lid: action.newLid,
        title: name,
        body: writeAppGroupIcon(appGroupSeed(name), action.icon),
        /**
         * 🔴 **見ていた物を退かさない**(`keepSelection`)。
         *
         * ⚠ 既定の `CREATE_ENTRY` は「作って開く」なので、そのまま呼ぶと
         *   **目印を選んだだけで右の面が作りたてのノートに変わり、絞り込みの欄と
         *   種類の絞りまで消える** ── user は見出しに絵を置きたかっただけである
         *   (CLAUDE.md「欠陥の多くは『さっきまでやっていたことが消える』形で出る」)。
         * 🔑 `keepSelection` は選択・絞り込み・開いている本文を**そのまま残し**、
         *   編集にも入らない(この case の docstring がそう書いている)。
         */
        keepSelection: true,
      });
      const next = optimistic(created.state);
      return {
        state: next,
        events: [
          ...created.events,
          // ⚠ **作った後の並び**で読む(作りたてのノートが入っていないと、目印が出ない)
          readAppGroupNotes(next),
        ],
      };
    }
    case 'APP_TILE_SAVED': {
      // 🔴 **世代が違う ack は本文に触らない**が、**ロックは必ず解く**
      //    (追記と同じ ── 握ったままにすると user は二度と設定を変えられない)
      const left = (state.tileWrite?.n ?? 1) - 1;
      const released: AppState = {
        ...state,
        tileWrite: left > 0 && state.tileWrite ? { ...state.tileWrite, n: left } : null,
      };
      // ⚠ 世代が違う ack は本文に触らないが、**数は必ず減らす**
      //    (減らさないと user は二度と設定を変えられず、しかも理由が分からない)
      if (action.gen !== state.lockGen) return { state: released, events: [] };
      // 失敗(書けなかった)── ロックだけ解いて本文は触らない
      if (action.body === null) return { state: released, events: [] };
      const body = action.body;
      const ob = state.openBody;
      /**
       * 🔴 **主の枠が別のノートを開いていても、留めた枠には映す**(#848、2026-09-13)。
       *
       * ⚠ 直す前はここで丸ごと捨てていた ── 留めた枠に出した設定を押すと、
       *   **disk には書けるのに画面が 1 ドットも変わらない**(主の枠が別のノートを
       *   開いていると `ob?.lid !== action.lid` で返っていたため)。
       * 🔑 押した物と効く先を揃えた口(`data-pkc-target-lid`)を出す以上、
       *   **その結果が戻る経路も同じ数だけ要る**(CLAUDE.md §7)。
       */
      if (ob?.lid !== action.lid) {
        return { state: { ...released, ...syncShownBodies(state, action.lid, body) }, events: [] };
      }
      /**
       * 🔴 **留めた枠にも追随させる**(#848、2026-09-13)。
       *
       * ⚠ ここだけ `syncSplitBody` を通っていなかった ── 同じノートを
       *   **横に並べた枠に留めている**と、添付の設定を変えても**そちらは古い本文のまま**で、
       *   押しても**何も変わらないように見える**(`aria-pressed` も動かない)。
       * 🔑 書込の口を数え上げると `BODY_REWRITTEN` / `BODY_PERSISTED` / `REMOTE_BODY` は
       *   通っており、**ここだけが非対称**だった(CLAUDE.md §7「片側を直したら反対側を疑う」)。
       * ⚠ 編集中の枝でも通す ── draft は触らないが、**留めた枠が映すのは disk の姿**である。
       */
      if (state.phase === 'editing') {
        // 🔴 **draft は触らないが、disk が進んだ印は残す**(P8 段⑯。レビュー H-1)。
        //    かつては丸ごと捨てていたので、無変更 commit / cancel で**旧本文が
        //    disk を上書きし、書けたはずの設定が消えた**(実測で再現)。
        //    `TODO_TOGGLED` の editing 窓と同型に揃える ── 変更ありの commit は
        //    draft が勝ち(可視内容の last-write-wins)、無変更 commit / cancel は
        //    disk を採る
        return {
          state: {
            ...released,
            openBody: { ...ob, persisted: body, diskAhead: true },
            ...syncShownBodies(state, action.lid, body),
          },
          events: [],
        };
      }
      return {
        state: {
          ...released,
          openBody: { lid: action.lid, body, baseline: body, persisted: body, diskAhead: false },
          ...syncShownBodies(state, action.lid, body),
        },
        events: [],
      };
    }
    case 'OFFICE_ASSET_SAVED': {
      // 🔴 **`ready` でなければ何もしない。** ⚠ ただし**捨ててよいのは、呼び側が
      //    棚から消さずに撃ち直すから**である(`office-save-back.ts`)── その対を
      //    崩すと、編集中に届いた保存が消える
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      // 消された / 添付でなくなったノートへは書かない(呼び側が新規作成へ倒す)
      if (!meta || meta.archetype !== 'attachment') return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_ASSET_REPLACE',
            targetLid: action.lid,
            newKey: action.newKey,
            newHash: action.newHash,
            newBytes: action.newBytes,
            newName: action.newName,
            newMime: action.newMime,
            savedAt: action.savedAt,
            // 🔑 **ノートの一覧はもう運ばない**(2026-08-25)── 走査ごと
            //    worker の 1 tx へ移したので、題名も並びも **worker が自分で読む**。
            //    ⚠ 運び続けると「受け手のいない payload」になる(5,000 件の meta を
            //    毎回作って捨てることになるうえ、次に読む人が「効く」と思う)。
          },
        ],
      };
    }
    case 'ENTRY_BODY_REFRESHED': {
      const ob = state.openBody;
      // 🔴 **留めた枠にも映す**(#1087)── 主の枠が別のノートを開いていても、留めた枠だけが
      //    このノートを映していることがある。⚠ 直す前は丸ごと捨てていたので古い本文のままだった
      //    (持っていない lid では `syncShownBodies` は何もしない)
      if (ob?.lid !== action.lid) {
        const shown = syncShownBodies(state, action.lid, action.body);
        return { state: sameShownBodies(state, shown) ? state : { ...state, ...shown }, events: [] };
      }
      // 🔴 **編集中の draft は触らない**(`APP_TILE_SAVED` と同じ ── 捨てると
      //    無変更 commit / cancel で旧本文が disk を上書きする)
      if (state.phase === 'editing') {
        return {
          state: {
            ...state,
            openBody: { ...ob, persisted: action.body, diskAhead: true },
            ...syncShownBodies(state, action.lid, action.body),
          },
          events: [],
        };
      }
      return {
        state: {
          ...state,
          ...syncShownBodies(state, action.lid, action.body),
          openBody: {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
          // ⚠ 名前のとおり**本文が入れ替わる**所 ── 札も組み直す(上と同じ理由)
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.lid,
            action.body,
            state.entryMetas,
          ),
        },
        events: [],
      };
    }
    case 'SET_APP_TILE': {
      // ⚠ 書込が飛んでいる間は触らせない(追記と同じ規律)── 読んで書き戻す
      //    操作なので、途中に別の書込が挟まると片方が消える
      // ⚠ 追記が飛んでいる間は触らない(あちらは本文を丸ごと書き戻す)
      // 🔴 **断るときは理由を出す**(並べ替え `MOVE_APP_TILE` と同じ)── 黙って捨てると、
      //   欄には新しい値が残ったまま何も保存されない(押したのに効いていない)。
      const refusal = appTileRefusal(state, action.lid);
      if (refusal !== null) return { state: { ...state, error: refusal }, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      const updates: Record<string, string | boolean | undefined> = {};
      // ⚠ **false は書かない**(PKC2 と同じ)── 既定値を明示的に持つと、
      //    frontmatter が「登録していない」行で埋まる
      if (action.registered !== undefined)
        updates['attachment.registered_as_app'] = action.registered ? true : undefined;
      if (action.group !== undefined) {
        // ⚠ **書くときも前後の空白を落とす**(#857 段②)── 残すと、見出しの字と
        //    グループ用のノートの題名が食い違い、目印が引けなくなる(読む側も同じ口を通す)
        const g = appGroupName(action.group ?? '');
        updates['attachment.app_group'] = g === '' ? undefined : g;
      }
      if (action.icon !== undefined) {
        updates['attachment.app_icon'] =
          action.icon === null || action.icon === '' ? undefined : action.icon;
        /**
         * 🔴 **字や図案を選んだら、取り込んだ絵は外す**(#856 段②)。
         *
         * ⚠ 出す側は**絵を字より先に**使うので、外さないと
         *   **選んだのに画面が変わらない** ── この repo がいちばん嫌う
         *   無言の dead click になる。
         * ⚠ 「なし」(空文字)でも外す ── user が求めているのは
         *   「印を出さない」ことであって、「字だけ消す」ことではない。
         * 🔑 **規則を 1 つにする**(例外を作らない)── 絵に戻したければ
         *   もう一度「リンク先の印を取り込む」を押せばよい。
         */
        updates['attachment.app_icon_asset_key'] = undefined;
      }
      if (action.iconAssetKey !== undefined)
        updates['attachment.app_icon_asset_key'] =
          action.iconAssetKey === null || action.iconAssetKey === ''
            ? undefined
            : action.iconAssetKey;
      if (Object.keys(updates).length === 0) return { state, events: [] };
      const meta = state.entryMetas.get(action.lid)!;
      return {
        // 🔴 **飛んでいる数を数える**(P8 段⑯。レビュー H-1/H-7)。これは
        //    **読んで書き戻す**操作なので、往復の窓に編集が割り込むと片方が消える。
        //    実測で再現: 登録にチェック → ack が返る前に編集して保存 → disk に
        //    着地した `registered_as_app: true` が旧本文の書き戻しで**黙って消えた**。
        //    ⚠ `writeLock` を借りると**連続した設定変更が無言で落ちる**(登録 →
        //    グループ → 目印 を続けて触ると 2 件目以降が拒否される。smoke が実際に
        //    落ちた)── タイルの書込どうしは disk を読み直すので互いに安全
        state: { ...state, tileWrite: { lid: action.lid, n: (state.tileWrite?.n ?? 0) + 1 } },
        events: [
          {
            type: 'REQUEST_TILE_UPDATE',
            lid: action.lid,
            gen: state.lockGen,
            updates,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            entries: attachmentEntries(state),
          },
        ],
      };
    }
    /**
     * 🔴 **タイルを並べ替える**(#857 段①)。
     *
     * 🔑 計画は `planTileMove`(純関数)── **どこへ入るか**の規則をここに書かない。
     * 🔑 画面は**先に**動かす(`applyTileWrites`)── 掴んだ手を離してから disk の
     *   往復を待つと数百 ms 動かず、「掴めたのに動かない」になる。
     */
    case 'MOVE_APP_TILE': {
      const tiles = state.launcherTiles;
      // ⚠ まだ読み込んでいない(タブを開いた直後)── 掴めないので、ここへは来ない
      if (tiles === null) return { state, events: [] };
      const moved = tiles.find((t) => t.lid === action.lid);
      if (moved === undefined) return { state, events: [] };
      /**
       * 🔴 **断るときは理由を出す**(無言の操作拒否を作らない)。
       * ⚠ `SET_APP_TILE` は黙って落とすが、あちらは**押し直せば済む設定**である。
       *   並べ替えは**掴んで離した後**なので、黙って元へ戻ると「壊れている」に見える。
       */
      const refuse = (error: string): ReduceResult => ({ state: { ...state, error }, events: [] });
      // ⚠ 組み込みは entry を持たない ── 掴ませない側でも止めるが、門は 2 枚置く
      if (!isMovableTile(moved)) return refuse('最初から入っているアプリは並べ替えられません');
      /**
       * 🔴 **`phase !== 'ready'` を「編集中」と読み替えない**(`app-state.ts` の
       * `phaseBlockReason` が戒めている当のもの ── 1 稿目はそれを踏んでいた)。
       * ⚠ `phase` には `'error'`(保存に失敗したときの保護)も `'initializing'` も
       *   在るので、一律に「編集を終えてから」と出すと**嘘になる** ── user は
       *   編集していないのに、**存在しない編集画面を探す**。
       */
      const blocked = phaseBlockReason(state.phase);
      if (blocked !== null) return refuse(`${blocked}並べ替えられます`);
      /**
       * 🔴 **絞り込んでいる間は並べ替えない**(動線レビュー D3)。
       *
       * ⚠ 画面に出ているのは絞った後のタイルだが、並び順の正本は**全件**である ──
       *   隠れたタイルをまたぐ移動になるので、「上へ」を 1 回押しても
       *   **画面が 1 ドットも動かない**(隣の隠れた 1 枚と入れ替わっただけ)。
       *   落とすほうも、線を引いた所と**違う場所に着く**。
       * 🔑 どちらも「効いていないように見えて、実は書いている」という
       *   いちばん読めない形なので、**受けずに理由を言う**側へ倒す。
       *   ⚠ 掴ませない門は `launcher.ts` にも置いてある(門は 2 枚)。
       */
      if (normalizeQuery(state.filterQuery) !== '')
        return refuse('絞り込みを消してから並べ替えられます(いまは一部しか出ていません)');
      if (state.writeLock)
        return refuse('いま保存しています。少し待ってから、もう一度動かしてください');
      if (state.tileWrite)
        return refuse('いま並べ替えを保存しています。終わってから、もう一度動かしてください');

      const plan = planTileMove(tiles, action.lid, action.target);
      if (plan.length === 0) {
        /**
         * 🔴 **端で押したときは理由を言う**(動線レビュー D2)。
         * ⚠ 「上へ」を押して**画面も言葉も動かない**のは、この repo がいちばん嫌う
         *   無言の dead click である(フォルダの帯は同じ場面で押せなくして
         *   「すでに先頭です」と出している)。
         * 🔑 **落とし戻した回とは分ける** ── あちらは「動かさないと決めた」操作なので
         *   断りではない。⚠ 刻みの移動で計画が空になるのは**端のときだけ**である。
         */
        if (action.target.kind === 'step')
          return refuse(
            action.target.by < 0
              ? 'すでにこのまとまりのいちばん上です'
              : 'すでにこのまとまりのいちばん下です',
          );
        // ⚠ 元の位置へ落とし戻した回 ── **断りではない**ので、理由は出さない
        return { state, events: [] };
      }

      const rows: Array<{
        lid: string;
        updates: Record<string, string | number | undefined>;
        title: string;
        archetype: string;
        entryOrder: number;
      }> = [];
      for (const w of plan) {
        const meta = state.entryMetas.get(w.lid);
        /**
         * ⚠ 素性の読めない行が 1 つでもあれば、**1 件も書かずにやめる**。
         *
         * 🔴 **これが守れるのは「書き始める前」までである**(2026-09-12 に訂正)。
         *   1 稿目はここに「丸ごとやめる」と書いていたが、⚠ 書き始めた後に
         *   別の窓との衝突が起きた回は **effect が途中で止まり、書いた分は戻らない**
         *   (`store-effects.ts` の `REQUEST_TILE_ORDER`)── 元でも狙いでもない
         *   第 3 の並びが disk に残る。
         * 🔑 だから断り文のほうを事実に合わせてある(「途中まで」と言う)。
         *   ⚠ 本当に全か無かにするには worker の 1 tx が要る ── そこまでは今やらない。
         */
        if (meta === undefined) return refuse('並べ替えられません(ノートが見つかりません)');
        const updates: Record<string, string | number | undefined> = {
          'attachment.app_order': w.order,
        };
        // ⚠ 群は**変わるときだけ**書く。既定群(空文字)へ移すのは**行ごと消す**
        //    (`SET_APP_TILE` と同じ意味論 ── 既定値で frontmatter を埋めない)
        if (w.group !== undefined)
          updates['attachment.app_group'] = w.group === '' ? undefined : w.group;
        rows.push({
          lid: w.lid,
          updates,
          title: meta.title,
          archetype: meta.archetype,
          entryOrder: meta.entryOrder,
        });
      }
      return {
        state: {
          ...state,
          launcherTiles: applyTileWrites(tiles, plan),
          // ⚠ 数えるのは 1 つ ── effect は最後に 1 回だけ ack を撃つ
          tileWrite: { lid: action.lid, n: 1 },
        },
        events: [
          {
            type: 'REQUEST_TILE_ORDER',
            lid: action.lid,
            gen: state.lockGen,
            rows,
            entries: attachmentEntries(state),
          },
        ],
      };
    }
  }
}
