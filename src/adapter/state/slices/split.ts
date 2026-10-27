/**
 * reducer の slice: 横に留める枠・スタック・2 ペインのタブ(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceSplit` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  bodyRewriteGate,
  canStack,
  dropSplitBody,
  dualPreviewTarget,
  goneFromStackNotice,
  loadStackFromBody,
  placeBodiesOf,
  placeLidsOnScreen,
  reduce,
  screenBodyOf,
  withDual,
  withDualFocus,
  withPlaceBody,
} from '../app-state';
import { STACK_ARCHETYPE } from '@features/flavor/stack-flavor';
import {
  PLACE_BODY_CAP,
  type PlaceExcerpt,
  excerptOf,
  placeEmbeddable,
  sameExcerpt,
} from '@features/markdown/place-embed';
import { baseLidOfKey, parseSectionKey, sectionExcerptOf } from '@features/markdown/section-embed';
import { isTabIndex, paneOf, withPane, withTabActive } from '@features/relation/dual-pane';
import { STACK_MAX, normalizeSplitLids, pinSplitLid, unpinSplitLid } from '@features/split-frames';

export type SplitAction = Extract<Dispatchable, { type: 'SWAP_OPEN_ENTRY' | 'PIN_SPLIT_ENTRY' | 'UNPIN_SPLIT_ENTRY' | 'CLEAR_SPLIT' | 'LOAD_STACK' | 'STACK_BODY_LOADED' | 'MOVE_STACK_LINK' | 'SPLIT_BODY_LOADED' | 'PLACE_BODIES_WANTED' | 'PLACE_BODY_LOADED' | 'SPLIT_RESTORED' | 'DUAL_PREVIEW_LOADED' | 'DUAL_TAB_ACTIVATE' }>;

export function reduceSplit(state: AppState, action: SplitAction): ReduceResult {
  switch (action.type) {
    case 'SWAP_OPEN_ENTRY': {
      const i = state.splitLids.indexOf(action.lid);
      const old = state.selectedLid;
      /**
       * ⚠ **入れ替えられないときは、ただ開く**(3 通り)──
       *   ①行き先が枠に居ない ②中央が空 ③同じもの。
       * ⚠ そして **`folder` は枠に置けない**(`PIN_SPLIT_ENTRY` が断る)ので、
       *   中央がフォルダなら入れ替えない ── 入れ替えると**枠が永久に空**になる。
       */
      if (
        i < 0 ||
        old === null ||
        old === action.lid ||
        state.entryMetas.get(old)?.archetype === 'folder'
      )
        return reduce(state, { type: 'SELECT_ENTRY', lid: action.lid });
      /**
       * 🔴 **枠を触る前に、選択が本当に動けるかを確かめる**(#1044 段2 2巡目の修理、R10)。
       *
       * ⚠ 直す前はここで先に `splitLids` を差し替え、その state を内側の `reduce()`
       *   へ渡していた ── 章の欄が開いている間そのノートから離れる遷移を断る門
       *   (`guardSectionDraftTransition`)は選択を戻すだけなので、**渡した state に
       *   すでに焼き込まれていた枠の差し替えは戻らない**。結果「選択の移動は断られた
       *   のに、枠の並びだけ書き換わる」という部分適用になっていた。
       * 🔑 断る条件をここに書き写さない(理由が section draft か編集ロックかに関わらず
       *   同じ形で守れる) ── **触っていない `state` で `reduce()` を試し撃ちし**、
       *   選択が本当に `action.lid` へ動いたかだけを見る。動かなければ、その結果
       *   (章の欄の断り文・編集ロックの無言など、理由が何であれ)をそのまま返し、
       *   枠には 1 バイトも触れない。
       */
      const trial = reduce(state, { type: 'SELECT_ENTRY', lid: action.lid });
      if (trial.state.selectedLid !== action.lid) return trial;
      const swapped = [...state.splitLids];
      swapped[i] = old;
      /**
       * 🔑 **選択の遷移は `SELECT_ENTRY` に任せる**(§7:開く判定を 2 か所に書かない)──
       *   ここがやるのは**枠の中身の差し替え**だけである。
       * ⚠ 枠の本文は**入れ替えた側を捨て、入った側を頼む** ── 捨てないと、
       *   降ろしたノートの本文が器に残り続ける(常駐が積み上がる)。
       */
      const r = reduce(
        {
          ...state,
          splitLids: swapped,
          splitBodies: dropSplitBody(state.splitBodies, action.lid),
        },
        { type: 'SELECT_ENTRY', lid: action.lid },
      );
      return {
        state: r.state,
        events: r.state.splitBodies.has(old)
          ? r.events
          : [...r.events, { type: 'REQUEST_SPLIT_BODY', lid: old }],
      };
    }
    case 'PIN_SPLIT_ENTRY': {
      const meta = state.entryMetas.get(action.lid);
      // ⚠ 居ないものは留めない(消えた lid を指す枠を作らない)
      if (meta === undefined) return { state, events: [] };
      /**
       * ⚠ **フォルダは本文を持たない** ── 留めると枠が永久に空になる。
       * 🔑 断るときは**理由を言う**(黙って何も起きないのが dead click である)。
       */
      if (!canStack(meta))
        return {
          state: { ...state, notice: 'フォルダはスタックに載せられません(本文がありません)' },
          events: [],
        };
      const pinned = pinSplitLid(state.splitLids, action.lid);
      if (pinned === state.splitLids) {
        /**
         * ⚠ 「**もう一番上に在る**」と「**満杯**」を分ける ── 前者は黙ってよいが、後者は言う。
         * 🔑 直す前は「既に在る」を黙っていたが、いまは**載せ直すと先頭へ上がる**ので、
         *   黙るのは**もう先頭に在るとき**だけである(#633 段①)。
         */
        if (state.splitLids[0] === action.lid) return { state, events: [] };
        return {
          state: {
            ...state,
            notice: `スタックに載せられるのは ${String(STACK_MAX)} 件までです(1 つ降ろしてから載せてください)`,
          },
          events: [],
        };
      }
      return {
        state: { ...state, splitLids: pinned },
        // ⚠ 既に読めているなら読み直さない(留め直すたびに全文を往復させない)
        events: state.splitBodies.has(action.lid)
          ? []
          : [{ type: 'REQUEST_SPLIT_BODY', lid: action.lid }],
      };
    }
    case 'UNPIN_SPLIT_ENTRY': {
      const rest = unpinSplitLid(state.splitLids, action.lid);
      if (rest === state.splitLids) return { state, events: [] };
      return {
        state: {
          ...state,
          splitLids: rest,
          splitBodies: dropSplitBody(state.splitBodies, action.lid),
          /**
           * 🔴 **消えたので降ろしたときだけ 1 行言う**(#633 段①)。
           * ⚠ 直す前は無言だった ── user から見ると「札が勝手に消えた」である。
           * ⚠ 題名は**降ろす前の `entryMetas`** から引く(別タブで消された直後は
           *   まだ残っていることが多い。無ければ「消えたノート」)。
           */
          ...(action.gone === true
            ? { notice: goneFromStackNotice(state.entryMetas.get(action.lid)?.title) }
            : {}),
        },
        events: [],
      };
    }
    case 'CLEAR_SPLIT': {
      // ⚠ 空なら**同じ state**を返す(描き直しの指紋を動かさない ── `UNPIN` と同じ作法)
      if (state.splitLids.length === 0) return { state, events: [] };
      return {
        state: { ...state, splitLids: [], splitBodies: new Map<string, string>() },
        events: [],
      };
    }
    case 'LOAD_STACK': {
      const meta = state.entryMetas.get(action.lid);
      if (meta === undefined || meta.archetype !== STACK_ARCHETYPE) return { state, events: [] };
      /**
       * 🔑 本文が画面に在ればその場で積む(`screenBodyOf` ── 主の枠か横の枠)。
       *   無ければ効果層に読ませる(押した瞬間に何も起きない、を作らない)。
       */
      const shown = screenBodyOf(state, action.lid);
      if (shown === null) return { state, events: [{ type: 'REQUEST_STACK_BODY', lid: action.lid }] };
      return loadStackFromBody(state, shown);
    }
    case 'STACK_BODY_LOADED': {
      const meta = state.entryMetas.get(action.lid);
      if (meta === undefined || meta.archetype !== STACK_ARCHETYPE) return { state, events: [] };
      return loadStackFromBody(state, action.body);
    }
    case 'MOVE_STACK_LINK': {
      // ⚠ 入れ物以外では何もしない(押し所はスタックの入れ物にしか生えない ── 綴りの取り違えの防波堤)
      if (state.entryMetas.get(action.lid)?.archetype !== STACK_ARCHETYPE) return { state, events: [] };
      // 🔑 門と event の組み立ては板の書換と**同じ 1 本**(`bodyRewriteGate`(#684 で `placeRewrite` から改名))── 編集中は声に出して断る
      return bodyRewriteGate(state, action.lid, '、並べ替えてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        const openLine = shown.split('\n')[action.line];
        if (openLine === undefined) return null;
        return { kind: 'link-move', line: action.line, openLine, dir: action.dir };
      });
    }
    case 'SPLIT_BODY_LOADED': {
      /**
       * ⚠ **追い越しを捨てる**(`DUAL_PREVIEW_LOADED` と同じ)── 読みは非同期なので、
       * 外した後に届くことが普通に起きる。留めていないものは黙って捨てる。
       */
      if (!state.splitLids.includes(action.lid)) return { state, events: [] };
      if (state.splitBodies.get(action.lid) === action.body) return { state, events: [] };
      const bodies = new Map(state.splitBodies);
      bodies.set(action.lid, action.body);
      return { state: { ...state, splitBodies: bodies }, events: [] };
    }
    case 'PLACE_BODIES_WANTED': {
      /**
       * ⚠ **居ないノートは頼まない**(消えた lid を読んでも何も無い。板は題名の行で断る)。
       * ⚠ **フォルダは頼まない**(本文が無い ── 描く側も同じ判定で札だけにする)。
       *   🔑 添付は**頼む**(#529 W3-②)── 本文は frontmatter だけで小さく、絵を出せる種類か
       *   (画像 / PDF)はそこから分かる。
       * 🔑 持っている物も頼まない。⚠ 1 度に頼める数は `PLACE_BODY_CAP` まで
       *   (それ以上は持てないので、頼んでも手放すだけになる)。
       */
      const have = placeBodiesOf(state);
      const want: string[] = [];
      for (const lid of action.lids) {
        if (want.length >= PLACE_BODY_CAP) break;
        if (have.has(lid) || want.includes(lid)) continue;
        // 🔑 見出しの節(#1459 ①)の鍵は `<lid>#h/<印>` ── 居るか・読めるかは**ノート**で決める
        const meta = state.entryMetas.get(baseLidOfKey(lid));
        if (meta === undefined || !placeEmbeddable(meta.archetype)) continue;
        want.push(lid);
      }
      return {
        state,
        events: want.map((lid) => ({ type: 'REQUEST_PLACE_BODY', lid })),
      };
    }
    case 'PLACE_BODY_LOADED': {
      const have = placeBodiesOf(state);
      // 🔴 読めなかった(`null`)── 見出しの節の鍵だけ「読めなかった」と持つ(「読み込んでいます」で止めない)。
      //    板の抜粋は今までどおり何もしない(板は題名の行で断る)
      if (action.body === null) {
        if (parseSectionKey(action.lid) === null) return { state, events: [] };
        const gone: PlaceExcerpt = { text: '', cut: false, missing: true, gone: true };
        const prevGone = have.get(action.lid);
        if (prevGone !== undefined && sameExcerpt(prevGone, gone)) return { state, events: [] };
        return {
          state: { ...state, placeBodies: withPlaceBody(have, action.lid, gone, () => placeLidsOnScreen(state)) },
          events: [],
        };
      }
      // 🔑 添付は絵を出せるかを**本文(frontmatter)から**読む ── 型は一覧(entryMetas)が知っている
      //    見出しの節の鍵(#1459 ①)は、その節だけを切り出す(板の抜粋と同じ入れ物・同じ口)
      const sec = parseSectionKey(action.lid);
      const next =
        sec !== null
          ? sectionExcerptOf(action.body, sec.id)
          : excerptOf(action.body, state.entryMetas.get(action.lid)?.archetype);
      const prev = have.get(action.lid);
      if (prev !== undefined && sameExcerpt(prev, next)) return { state, events: [] };
      return {
        state: { ...state, placeBodies: withPlaceBody(have, action.lid, next, () => placeLidsOnScreen(state)) },
        events: [],
      };
    }
    case 'SPLIT_RESTORED': {
      const restored = normalizeSplitLids(action.lids);
      if (restored.length === 0) return { state, events: [] };
      /**
       * ⚠ ここでは**知らない lid を落とさない** ── 起動の順で `entryMetas` が
       * まだ空のことがあり、落とすと**憶えた並びが黙って消える**。
       * 🔑 消えたノートは effect が本文 `null` を受けて外す(自己修復)。
       */
      return {
        state: { ...state, splitLids: restored },
        events: restored.map((lid) => ({ type: 'REQUEST_SPLIT_BODY', lid })),
      };
    }
    case 'DUAL_PREVIEW_LOADED': {
      /**
       * ⚠ **追い越しを捨てる**(#273 残件)── 読みは非同期なので、送った先の行を
       *   通り過ぎた後で届くことが普通に起きる。いま指している行のものでなければ
       *   **黙って捨てる**(古い本文を映すほうがずっと悪い)。
       */
      if (!state.dual.previewOn) return { state, events: [] };
      if (dualPreviewTarget(state, state.dual) !== action.lid) return { state, events: [] };
      if (state.dual.preview?.lid === action.lid && state.dual.preview.body === action.body)
        return { state, events: [] };
      return {
        state: {
          ...state,
          dual: { ...state.dual, preview: { lid: action.lid, body: action.body } },
        },
        events: [],
      };
    }
    case 'DUAL_TAB_ACTIVATE': {
      const cur = paneOf(state.dual, action.side);
      // ⚠ **実在するタブを押したときだけ**焦点を移す ── 存在しない添字で
      //    焦点が動くと、「押したものが在る」という嘘の合図になる
      if (!isTabIndex(cur, action.index)) return { state, events: [] };
      const pane = withTabActive(cur, action.index);
      if (pane === cur) return withDualFocus(state, action.side);
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
  }
}
