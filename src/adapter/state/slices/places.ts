/**
 * reducer の slice: 配置図(place)の操作(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reducePlaces` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  PLACE_CONNECT_OPEN_REFUSAL,
  PLACE_LINE_REMOVE_OPEN_REFUSAL,
  PLACE_OPEN_BLOCK_REFUSAL,
  PLACE_REMOVE_OPEN_REFUSAL,
  type ReduceResult,
  bodyRewriteGate,
  isPlaceCoord,
  lineOpenLineOf,
  openBlockRefused,
  placeOpenLineOf,
  screenBodyOf,
} from '../app-state';
import { isPlaceStyle } from '@features/markdown/place-color';
import { endsInsideOpenBlock, placeBlockUnclosed, placeTextOf } from '@features/markdown/place-notation';
import { PLACE_RECT_KEYS, isPlaceRectNumber } from '@features/markdown/place-rect';
import { isPlaceShape } from '@features/markdown/place-shape';
import { isPlaceTemplateId } from '@features/markdown/place-template';

export type PlacesAction = Extract<Dispatchable, { type: 'MOVE_PLACE' | 'MOVE_PLACES' | 'GROUP_PLACES' | 'UNGROUP_PLACE' | 'RESIZE_PLACE' | 'CONNECT_PLACE' | 'REMOVE_PLACE_LINE' | 'REMOVE_PLACE' | 'ADD_PLACE' | 'SET_PLACE_RECT' | 'SET_PLACE_TEXT' | 'RAISE_PLACE' | 'LOWER_PLACE' | 'SET_PLACE_SHAPE' | 'SET_PLACE_STYLE' }>;

export function reducePlaces(state: AppState, action: PlacesAction): ReduceResult {
  switch (action.type) {
    /**
     * 🔴 **板の塊を動かす**(#283 P4-b)。門(phase / 画面に出ている本文 / 開き行の捕捉)は
     * `bodyRewriteGate` 1 か所 ── 下の 3 つ(#676)と共有する。
     */
    case 'MOVE_PLACE':
      return bodyRewriteGate(state, action.lid, '、付箋を動かしてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        if (!isPlaceCoord(action.x) || !isPlaceCoord(action.y)) return null;
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-move', line: action.line, openLine, x: action.x, y: action.y };
      });
    case 'MOVE_PLACES':
      return bodyRewriteGate(state, action.lid, '、付箋を動かしてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        if (action.moves.length === 0) return null;
        const moves: Array<{ line: number; openLine: string; x: number; y: number }> = [];
        for (const m of action.moves) {
          if (!isPlaceCoord(m.x) || !isPlaceCoord(m.y)) return null;
          const openLine = placeOpenLineOf(shown, m.line);
          if (openLine === null) return null; // 1 枚でも読めなければ 1 枚も書かない
          moves.push({ line: m.line, openLine, x: m.x, y: m.y });
        }
        return { kind: 'place-move-group', moves };
      });
    case 'GROUP_PLACES':
      return bodyRewriteGate(state, action.lid, '、付箋をグループにしてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        if (action.lines.length < 2) return null;
        const members: Array<{ line: number; openLine: string }> = [];
        for (const line of action.lines) {
          const openLine = placeOpenLineOf(shown, line);
          if (openLine === null) return null;
          members.push({ line, openLine });
        }
        return { kind: 'place-group', members };
      });
    case 'UNGROUP_PLACE':
      return bodyRewriteGate(state, action.lid, '、グループを解いてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-ungroup', line: action.line, openLine };
      });
    /**
     * 🔴 **板を画面から作る・大きさを変える・消す**(#676)── 3 つとも `MOVE_PLACE` と
     * 同じ門(`bodyRewriteGate`)を通る。断り文だけが**押した場所と対**で違う
     * (CLAUDE.md「文言は押した場所と対で pin する」)。
     */
    case 'RESIZE_PLACE':
      return bodyRewriteGate(state, action.lid, '、付箋の大きさを変えてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        if (!isPlaceCoord(action.w) || !isPlaceCoord(action.h)) return null;
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-size', line: action.line, openLine, w: action.w, h: action.h };
      });
    /**
     * 🔴 **板を線で繋ぐ**(#530 段③d)── ⚠ **本文が増える**操作である
     *   (名前の無い板には `#板1` が足される)ので、門は動かすときと同じだけ通す。
     * 🔑 **2 枚とも**開き行を捕える ── 片方だけだと、もう片方が別の塊でも書ける。
     */
    case 'CONNECT_PLACE':
      return openBlockRefused(
        state,
        action.lid,
        PLACE_CONNECT_OPEN_REFUSAL,
        (shown) => endsInsideOpenBlock(shown),
        bodyRewriteGate(state, action.lid, '、付箋を線でつないでください', (shown) => {
          if (shown === null) return null; // 画面に無い本文の行番号は信じない
          const from = placeOpenLineOf(shown, action.line);
          const to = placeOpenLineOf(shown, action.toLine);
          if (from === null || to === null) return null;
          return {
            kind: 'place-connect',
            from: { line: action.line, openLine: from },
            to: { line: action.toLine, openLine: to },
            fromAnchor: action.fromAnchor,
            toAnchor: action.toAnchor,
          };
        }),
      );
    case 'REMOVE_PLACE_LINE':
      return openBlockRefused(
        state,
        action.lid,
        PLACE_LINE_REMOVE_OPEN_REFUSAL,
        (shown) => placeBlockUnclosed(shown, action.line),
        bodyRewriteGate(state, action.lid, '、線を消してください', (shown) => {
          if (shown === null) return null; // 画面に無い本文の行番号は信じない
          const openLine = lineOpenLineOf(shown, action.line);
          if (openLine === null) return null;
          return { kind: 'place-line-remove', line: action.line, openLine };
        }),
      );
    case 'REMOVE_PLACE':
      return openBlockRefused(
        state,
        action.lid,
        PLACE_REMOVE_OPEN_REFUSAL,
        (shown) => placeBlockUnclosed(shown, action.line),
        bodyRewriteGate(state, action.lid, '、付箋を消してください', (shown) => {
          if (shown === null) return null; // 画面に無い本文の行番号は信じない
          const openLine = placeOpenLineOf(shown, action.line);
          if (openLine === null) return null;
          return { kind: 'place-remove', line: action.line, openLine };
        }),
      );
    case 'ADD_PLACE': {
      const gated = bodyRewriteGate(state, action.lid, '、付箋を置いてください', (shown) =>
        // ⚠ 画面に出ていない面へは置かない(押し所は面の上にしか無い ── これまでの門を保つ)
        shown !== null &&
        isPlaceCoord(action.x) &&
        isPlaceCoord(action.y) &&
        (action.template === undefined || isPlaceTemplateId(action.template)) &&
        // 🔴 ほかのノートを置く回(#1662 2)── 置く先が台帳に在るノートのときだけ(居ないノートの付箋は「(見つかりません)」になる)
        (action.entry === undefined || (action.template === undefined && state.entryMetas.has(action.entry)))
          ? action.entry !== undefined
            ? { kind: 'place-add', x: action.x, y: action.y, entry: action.entry }
            : action.template === undefined
              ? { kind: 'place-add', x: action.x, y: action.y }
              : { kind: 'place-add', x: action.x, y: action.y, template: action.template }
          : null,
      );
      /**
       * 🔴 **末尾が閉じていないブロックの中なら、理由を言って断る**(#529)。
       * ⚠ 板は本文の末尾に足すので、閉じていないコードブロックなどの中へ書くと板ではなく**コードの字**になる
       *   (`addPlace` / `addPlaceTemplate` が断る ── 同じ `endsInsideOpenBlock`)。断りは書込側(effect)でも
       *   出るが「本文が変わっているため」と**別の理由**を言うので、押した時点で本当の理由を言う。
       */
      if (gated.events.length > 0) {
        const shown = screenBodyOf(state, action.lid);
        if (shown !== null && endsInsideOpenBlock(shown))
          return { state: { ...state, error: PLACE_OPEN_BLOCK_REFUSAL }, events: [] };
      }
      return gated;
    }
    case 'SET_PLACE_RECT':
      return bodyRewriteGate(state, action.lid, '、付箋の位置と大きさを変えてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        for (const k of PLACE_RECT_KEYS) {
          const v = action.rect[k];
          if (v !== undefined && !isPlaceRectNumber(k, v)) return null;
        }
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-rect', line: action.line, openLine, rect: action.rect };
      });
    case 'SET_PLACE_TEXT':
      return bodyRewriteGate(state, action.lid, '、付箋の字を直してください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        const openLine = placeOpenLineOf(shown, action.line);
        const before = placeTextOf(shown, action.line);
        if (openLine === null || before === null) return null;
        return { kind: 'place-text', line: action.line, openLine, before, text: action.text };
      });
    case 'RAISE_PLACE':
      return bodyRewriteGate(state, action.lid, '、付箋を前へ出してください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-raise', line: action.line, openLine };
      });
    case 'LOWER_PLACE':
      return bodyRewriteGate(state, action.lid, '、付箋を後ろへ送ってください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-lower', line: action.line, openLine };
      });
    case 'SET_PLACE_SHAPE':
      return bodyRewriteGate(state, action.lid, '、付箋の形を変えてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        // ⚠ 綴りは**ここでも**検める ── 型は境界(postMessage / test の手組み)では効かない
        if (!isPlaceShape(action.shape)) return null;
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-shape', line: action.line, openLine, shape: action.shape };
      });
    case 'SET_PLACE_STYLE':
      return bodyRewriteGate(state, action.lid, '、色や太さを変えてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        // ⚠ 綴りは**ここでも**検める ── 型は境界(postMessage / test の手組み)では効かない
        if (!isPlaceStyle(action.style)) return null;
        // 🔑 受ける開き行は付箋と線の両方(どちらの札が書けるかは `setPlaceStyle` が決める)
        const openLine = placeOpenLineOf(shown, action.line) ?? lineOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-style', line: action.line, openLine, style: action.style };
      });
  }
}
