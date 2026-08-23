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
 * ⚠ **綴りの取り出しは features 側**(`features/link/permalink.ts`)。あちらは
 * 「pure: no DOM」を名乗っているので `location` を読めない ── だから
 * **読むのがここ、取り出すのが向こう**、と分けてある。
 * ⚠ そして**使える名前かの判定と断り文はここ**である(`ViewMode` は adapter の型で、
 * features からは引けない)。
 *
 * ## 🔴 断片は「見ている間は残す。離れたら消す」(2026-08-22 に翻した)
 *
 * ⚠ **初稿は「読んだ瞬間に消す」だった。動線レビューが否定した。**
 * 理由は user の物語で決まった ── マニュアルは
 * 「アドレスの末尾に付け足して**ブックマークしておけます**」と案内しているのに、
 * 開いた時点で断片が消えるので **`Ctrl+D` が拾うのは素の URL** になる。
 * **成功した人だけがブックマークを作れない**、という逆立ちした形だった。
 * ⚠ さらに、指した画面を見ている最中に `F5` を押すと**本文へ落ちる**
 * (user は更新しただけで、画面を替えたつもりはない)。
 *
 * 🔑 いまの規則は **「その面に居る間は残し、user が自分で離れたら消す」**:
 * - 見ている間 → アドレスにその字が在る(`Ctrl+D` がそのまま効く / `F5` で戻る)
 * - `× 閉じる` / タイル再押下 / `Alt+1` / 別の面へ → **その瞬間に静かに消す**
 *
 * ⚠ これで初稿が心配していた事故(「本文を読み始めた後の読み直しで面へ飛ぶ」)も
 * 起きない ── **飛ぶ元の字が、離れた時点でもう無い**。
 * ⚠ そして**初回訪問の分離のための読み直し**(`coi-reload.ts`。`main.ts` では
 * この配線の**後**に走る)を跨いでも、断片が残っているので指した画面で立ち上がる
 * ── 初稿はここで黙って本文へ落ちていた。
 *
 * ## ⚠ 開いたままのタブで足したときも効く
 *
 * マニュアルはアプリの中(ヘルプの面)に在るので、user は **PKC を開いたまま**
 * アドレス欄へ足す。同一文書内の断片移動では読み直しが起きないので、
 * `hashchange` を購読していないと**何も起きず理由も出ない**。だから購読する。
 * ⚠ 本文の見出しへのリンク(`#slug`)でも `hashchange` は飛ぶが、
 * `#pkc?` で始まらないものは読まないので何もしない(断片も消さない)。
 */
import type { BrowseMode } from '@adapter/ui/render/browse-mode';
import { VIEW_MODES, isViewMode, type ViewMode } from '../state/app-state';
import { isSealedView } from '../../features/sealed';
import {
  dropViewFromHash,
  dropViewWindowToken,
  parseViewDeepLink,
  parseViewDeepLinkEntry,
  parseViewWindowToken,
} from '../../features/link/permalink';
import { announceViewWindow } from './view-window';

/** ⚠ 差し替えられるようにしておく(test は DOM を持たずに通す)。 */
export interface DeepLinkTarget {
  /** いまのアドレスの断片(`#pkc?view=…`)。 */
  readonly hash: string;
  /**
   * 断片から `view` だけを落とす。
   * ⚠ **履歴を積まない**(戻るで断片が戻ってきたら、user は「戻るが効かない」と読む)。
   */
  readonly clearHash: () => void;
  /**
   * 🔴 **1 回限りの合図(`w`)だけを落とす**(#300 段③ の直し)。
   * ⚠ `view` は残す ── 合図は放送した瞬間に用済みだが、面はまだ見ている。
   */
  readonly dropToken: () => void;
}

/** 既定の的 ── 本物のアドレス。 */
export function windowDeepLinkTarget(): DeepLinkTarget {
  return {
    get hash() {
      return typeof location === 'object' ? location.hash : '';
    },
    clearHash: () => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      // ⚠ `search` は残す ── flag のクエリ(`?pkc-flag=…`)を巻き込まない。
      // ⚠ 断片も**丸ごと落とさない** ── 併記された container / entry を道連れにしない。
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}${dropViewFromHash(location.hash)}`,
      );
    },
    dropToken: () => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}${dropViewWindowToken(location.hash)}`,
      );
    },
  };
}

/**
 * 🔴 **開いた窓が「出ましたよ」と返す**(#300 段③ の直し、2026-08-22)。
 *
 * ⚠ **`main.ts` のいちばん最初で呼ぶ** ── storage の初期化を待ってからだと、
 * 開けているのに開いた側が待ち時間を使い切って**退避してしまう**
 * (そのとき本文が消える = user の苦情そのものの再現)。
 * ⚠ 合図は**使ったらアドレスから外す** ── ブックマークに焼き付くと、次に
 * 開いたときに誰も聞いていない放送を撒く。
 *
 * @returns この窓が**こちらが開いたもの**だったか(test の観測点)
 */
export function announceOpenedWindow(
  target: DeepLinkTarget = windowDeepLinkTarget(),
  announce: (token: string) => void = announceViewWindow,
): boolean {
  const token = parseViewWindowToken(target.hash);
  if (token === null) return false;
  announce(token);
  target.dropToken();
  return true;
}

/**
 * 🔴 **アドレスに書ける画面の名前**(user へ出す一覧はここ 1 つ)。
 * ⚠ 封印中の面は外す ── ボタンを畳んだのにアドレスからは開ける、を作らない。
 */
export function openableViewNames(): readonly ViewMode[] {
  return VIEW_MODES.filter((v) => !isSealedView(v));
}

/**
 * ⚠ **判定は借りる**(`app-state.ts` の `isViewMode` が「実在する面か」の正本)。
 * ここが足すのは**封印の分だけ**である ── 同名のコピーを作ると、
 * 向こうに条件が足された日に**アドレスからだけ古い判定で開ける**ようになる。
 */
function isOpenable(name: string): name is ViewMode {
  return isViewMode(name) && !isSealedView(name);
}

/**
 * 断片から「使える面」を読む。⚠ **ここでは消さない**(消す契機は「離れたとき」)。
 *
 * @returns
 *   - `{ view }` ── 使える面
 *   - `{ unusable: true }` ── `view` は書いてあるが**使える名前ではない**
 *     ⚠ **黙って捨てない** ── 呼び側が理由を画面に出す。
 *     ⚠ 綴りは返さない(外から来た字を画面へ通さない)
 *   - `null` ── 断片に `view` が無い(ふつうの起動)
 */
export function readViewDeepLink(
  target: DeepLinkTarget = windowDeepLinkTarget(),
): { view: ViewMode } | { moved: BrowseMode } | { unusable: true } | null {
  const name = parseViewDeepLink(target.hash);
  if (name === null) return null;
  const moved = MOVED_VIEWS[name];
  // 🔴 **引っ越した面は、引っ越し先へ送る**(下の表)── 断らない
  if (moved !== undefined) return { moved };
  return isOpenable(name) ? { view: name } : { unusable: true };
}

/**
 * 🔴 **引っ越した面**(#292 段⑤、2026-08-23)。
 *
 * カレンダーと やることの板 は**中央の面をやめて、左の列の「予定」タブ**になった。
 * ⚠ アドレスに書けた字を**黙って断らない** ── 栞にしていた人には、
 *   ある日から「画面名は …」という断り文だけが出ることになる。
 * 🔑 **同じものが在る場所へ送る**のが引っ越しの作法である(消すのではない)。
 * ⚠ 表に載せた字は `isOpenable` より**先に**見る ── そうしないと、
 *   `VIEW_MODES` から消した瞬間に「使えない名前」として弾かれる。
 */
const MOVED_VIEWS: Readonly<Record<string, BrowseMode>> = {
  calendar: 'schedule',
  kanban: 'schedule',
};

/**
 * 🔴 **断り文**(user が次に何を打てばよいかが分かる形)。
 *
 * ⚠ 初稿は**画面の呼び名**(本文 / カレンダー / …)を並べていたが、それは
 * **アドレスに打てない字**である ── 直し方を教えるはずの文が、直せない書き方だけを
 * 教えていた(動線レビュー)。🔑 出すのは**打つ字**。
 * ⚠ これは外から来た綴りではなく**こちらが持っている固定の一覧**なので、
 * 「打ち間違いの字をそのまま画面へ返さない」には触れない。
 * 🔑 **打つ字を先頭に置く** ── 状態の行は 1 行なので、狭い窓では後ろが切れる。
 */
/**
 * 引っ越しの案内。⚠ **どこへ行ったか**を書く(「使えません」で終わらせない)。
 */
export const MOVED_MESSAGE =
  'カレンダーとやることの板は、左の列の「予定」に移りました。そちらを開きました';

export function unusableViewMessage(): string {
  return `画面名は ${openableViewNames().join(' / ')} のどれかです`;
}

/** `connectViewDeepLink` の配線。⚠ 購読は**解除できる形**で渡す。 */
export interface DeepLinkWiring {
  /**
   * 🔴 **面を開く。** ⚠ `SET_VIEW_MODE` を撃つだけの関数を渡さないこと ──
   * 開いた後の後始末(集計の束ね方を思い出す)が抜けて、
   * **アドレスから開いた集計だけ表が出ない**形になる(`open-view.ts` を渡す)。
   */
  readonly openView: (mode: ViewMode) => void;
  /**
   * 🔴 **引っ越した面を開く**(#292 段⑤)── 左の列のタブ。
   * ⚠ 省略可 ── 無い配線(古い test)では**開かないだけ**で、他は壊れない。
   */
  readonly openBrowse?: (mode: BrowseMode) => void;
  /**
   * 🔴 **連れてきたノートを選ぶ**(#300 段③ の直し、2026-08-22)。
   *
   * ⚠ **`containerId` を渡す** ── 受け側で自分の container と突き合わせる。
   * 別の container の lid を拾うと、**偶然の一致で無関係なノートを選ぶ**
   * (`SYS_BOOTED` が `cid` を検めているのと同じ理由)。
   * ⚠ 面より**先に**呼ぶ ── 選択が後だと、開いた瞬間だけ
   * 「ノートを選んでください」が見えてから入れ替わる。
   */
  readonly selectEntry?: (containerId: string, lid: string) => void;
  /**
   * 🔴 **いま断片が指している面が変わったら呼ばれる**(#300 段③ の直し)。
   *
   * `null` = もう指していない(user が自分で離れた)。
   * 🔑 これを見て「この窓はアプリの窓か」を決める ── 題名も、
   * `× 閉じる` が**窓ごと閉じるか**もこれで分かれる。
   */
  readonly onHold?: (view: ViewMode | null) => void;
  /** 使えない名前だったときの理由(画面の下に出す)。 */
  readonly fail: (message: string) => void;
  /** いまの面が変わったら呼ばれる購読(返り値で解除)。 */
  readonly onViewChange: (fn: (view: ViewMode) => void) => () => void;
  /** アドレスの断片が変わったら呼ばれる購読(返り値で解除)。 */
  readonly onHashChange?: (fn: () => void) => () => void;
  readonly target?: DeepLinkTarget;
}

/**
 * 🔴 **起動時の配線はこの 1 本**(`main.ts` は呼ぶだけ)。
 *
 * ⚠ `main.ts` は**どの test からも実行されない**層なので、判断をあそこへ書くと
 * 「全 test 緑のまま出荷される」形になる(CLAUDE.md §2)。だから
 * **文言も消す契機も全部ここへ置き**、`tests/adapter/deep-link.test.ts` が見る。
 *
 * @returns 配線を解く関数(購読を全部外す)
 */
export function connectViewDeepLink(wiring: DeepLinkWiring): () => void {
  const target = wiring.target ?? windowDeepLinkTarget();
  /** いま「断片が指している面」。⚠ ここから離れたら断片を消す。 */
  let held: ViewMode | null = null;

  const hold = (view: ViewMode | null): void => {
    if (held === view) return;
    held = view;
    wiring.onHold?.(view);
  };

  const apply = (): void => {
    const read = readViewDeepLink(target);
    if (read === null) return;
    if ('view' in read) {
      hold(read.view);
      // 🔑 **ノートが先、面が後**(上の docstring の理由)
      const here = parseViewDeepLinkEntry(target.hash);
      if (here !== null) wiring.selectEntry?.(here.containerId, here.lid);
      wiring.openView(read.view);
      return;
    }
    if ('moved' in read) {
      /**
       * 🔴 **引っ越し先を開いて、そう言う**(段⑤)。
       * ⚠ 黙って開くと「打った字と違う所が出た」になる ── **理由を出す**。
       * ⚠ 断片は消す(残すと読み直しのたびに同じ案内が出る)。
       */
      hold(null);
      const here = parseViewDeepLinkEntry(target.hash);
      if (here !== null) wiring.selectEntry?.(here.containerId, here.lid);
      target.clearHash();
      wiring.openBrowse?.(read.moved);
      wiring.fail(MOVED_MESSAGE);
      return;
    }
    // ⚠ 使えない名前は**残す意味が無い**ので、その場で消す
    //   (残すと読み直しのたびに同じ断り文が出る)
    hold(null);
    target.clearHash();
    wiring.fail(unusableViewMessage());
  };

  apply();

  const offView = wiring.onViewChange((view) => {
    // ⚠ 自分が撃った `SET_VIEW_MODE` でも呼ばれる ── **同じ面なら何もしない**
    if (held === null || view === held) return;
    hold(null);
    target.clearHash();
  });
  const offHash = wiring.onHashChange?.(() => apply());

  return () => {
    offView();
    offHash?.();
  };
}

/**
 * 🔴 **いまのアドレスから、断片を落とした base を作る**(#300 段③、2026-08-22)。
 *
 * ⚠ `document.baseURI` を使ってはいけない ── **断片を含む**(2026-08-22 実測:
 * `…/#pkc?view=calendar` で開くと `baseURI` も同じ字を返す)。`formatViewDeepLink` は
 * base に `#` があると `null` を返すので、**黙って組めなくなる**。
 * 🔑 アドレスを読むのはこの file の役目なので、作法もここに置く
 * (`permalink.ts` の docstring が書いている `location.href.split('#')[0]`)。
 */
export function currentBaseUrl(): string {
  return typeof location === 'object' ? location.href.split('#')[0]! : '';
}
