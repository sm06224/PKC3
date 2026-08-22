/**
 * 🔴 **ディープリンクの解決 ── アドレスの断片を読む唯一の入口**(#300 段②、2026-08-22)。
 *
 * ## なぜ file を分けたか
 *
 * ⚠ user 指示 2026-08-07(不可侵)は「クエリパラメータを読んでよいのは
 * **flag の解決**と**パーマリンク / ディープリンク**だけ」と定めており、
 * `tests/features/flags.test.ts` が **全数走査で**それを守っている。
 * 🔑 だから読む場所を**ここ 1 つ**に閉じる ── `main.ts` に直接
 * `location.hash` を書くと、検査に引っかかるだけでなく、
 * 「どこがアドレスを読んでいるか」が散る。
 *
 * ⚠ **綴りの解釈は features 側**(`features/link/permalink.ts`)。あちらは
 * 「pure: no DOM」を名乗っているので `location` を読めない ── だから
 * **読むのがここ、解くのが向こう**、と分けてある。
 * ⚠ そして**実在の面かどうかの照合はここ**である(`ViewMode` は adapter の型で、
 * features からは引けない)。
 *
 * ## 🔴 読んだら消す(user から見た理由)
 *
 * 断片は「**この画面で開いてくれ**」という 1 回きりの指示であって、
 * 「この画面に居続けろ」ではない。⚠ 残したままにすると:
 * user が別窓でカレンダーを閉じて本文を読み始めた後、
 * **更新の適用や昇格で読み直しが起きた瞬間に、またカレンダーへ飛ぶ**
 * ── 「さっきまでやっていたことが消える」形である(CLAUDE.md 2026-08-22)。
 * 🔑 だから当てたら `history.replaceState` で断片を落とす。
 * ⚠ **bookmark は壊れない** ── 消えるのはその窓の中のアドレスだけで、
 * user が持っている URL は次に開いたときまた効く。
 */
import { VIEW_MODES, viewModeLabel, type ViewMode } from '../state/app-state';
import { parseViewDeepLink } from '../../features/link/permalink';

/** ⚠ 差し替えられるようにしておく(test は DOM を持たずに通す)。 */
export interface DeepLinkTarget {
  /** いまのアドレスの断片(`#pkc?view=…`)。 */
  readonly hash: string;
  /** 断片を落とす。⚠ 履歴を積まない(戻るで断片が戻ってきたら意味が無い)。 */
  readonly clearHash: () => void;
}

/** 既定の的 ── 本物のアドレス。 */
export function windowDeepLinkTarget(): DeepLinkTarget {
  return {
    get hash() {
      return typeof location === 'object' ? location.hash : '';
    },
    clearHash: () => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    },
  };
}

/** 面の名前の集合(`VIEW_MODES` から引く ── 綴りを 2 か所に書かない)。 */
function isViewMode(name: string): name is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(name);
}

/**
 * 起動時に 1 度だけ呼ぶ。断片に `view` が在れば **その面**を返し、断片を落とす。
 *
 * @returns
 *   - `{ view }` ── 面が決まった(呼び側が `SET_VIEW_MODE` を撃つ)
 *   - `{ unknown }` ── `view` は在ったが**そんな面は無い**
 *     ⚠ **黙って捨てない** ── 呼び側が理由を画面に出す
 *   - `null` ── 断片に `view` が無い(ふつうの起動)
 */
export function takeViewDeepLink(
  target: DeepLinkTarget = windowDeepLinkTarget(),
): { view: ViewMode } | { unknown: string } | null {
  const name = parseViewDeepLink(target.hash);
  if (name === null) return null;
  // ⚠ 読み取れた時点で落とす ── 面が実在しなくても残さない
  //   (残すと、読み直しのたびに同じ断り文が出る)
  target.clearHash();
  return isViewMode(name) ? { view: name } : { unknown: name };
}

/** `applyViewDeepLink` が撃つもの。⚠ この 2 つだけ(撃つ先を広げない)。 */
export type DeepLinkAction =
  | { readonly type: 'SET_VIEW_MODE'; readonly mode: ViewMode }
  | { readonly type: 'OP_FAILED'; readonly error: string };

/**
 * 🔴 **起動時の配線はこの 1 本**(`main.ts` は呼ぶだけ)。
 *
 * ⚠ `main.ts` は**どの test からも実行されない**層なので、判断をあそこへ書くと
 * 「全 test 緑のまま出荷される」形になる(CLAUDE.md §2)。だから
 * **文言も含めてここへ置き**、`tests/adapter/deep-link.test.ts` が見る。
 *
 * ⚠ 知らない面の名前は**黙って捨てない** ── user は「開かなかった」ことに
 * 気づけない。⚠ ただし断り文には**綴りをそのまま出さない**
 * (`#pkc?view=<script>` のような字を状態の行へ通さない ── 描画は
 * `textContent` だが、字をそのまま返すと user が自分の打ち間違いを読めるだけで
 * こちらの語彙は増えない)。実在する面の**呼び名**を並べるほうが役に立つ。
 */
export function applyViewDeepLink(
  dispatch: (action: DeepLinkAction) => void,
  target: DeepLinkTarget = windowDeepLinkTarget(),
): void {
  const taken = takeViewDeepLink(target);
  if (taken === null) return;
  if ('view' in taken) {
    dispatch({ type: 'SET_VIEW_MODE', mode: taken.view });
    return;
  }
  dispatch({
    type: 'OP_FAILED',
    error: `そのような画面はありません(本文を開きました)。開けるのは ${VIEW_MODES.map(viewModeLabel).join(' / ')} です`,
  });
}
