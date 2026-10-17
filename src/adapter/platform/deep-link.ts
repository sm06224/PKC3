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
 * ## 🔴 ノート(`container`+`entry`)は消さない ── **移った先へ書き換える**(#689)
 *
 * ⚠ 面とノートで**向きが違う**。面は「離れた」が起きるが、ノートは
 * **見ている物が移るだけ**で、離れることが無いからである(必ずどれかを見ている)。
 * ⚠ 直す前は書き換えていなかったので、`Alt+1` で本文へ戻った後にノートを渡り歩くと、
 * **`F5` が最初のノートへ引き戻し、`Ctrl+D` の栞もそちらを指していた**
 * (住所が黙って嘘になる = 誰も気づけない)。
 * ⚠ **名乗っていない断片には生やさない** ── ふつうに開いたタブのアドレスが
 * 操作のたびに伸びるのは、誰も頼んでいない見え方の変更である。
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
import { VIEW_MODES, isViewMode, selectBlockReason, type AppPhase, type ViewMode } from '../state/app-state';
import { isSealedView } from '../../features/sealed';
import {
  dropAssetFromHash,
  dropViewFindFromHash,
  dropViewScheduleFromHash,
  dropViewFromHash,
  dropViewWindowToken,
  isHeadingAnchor,
  parseViewDeepLink,
  formatExternalPermalink,
  parseViewDeepLinkAsset,
  parseViewDeepLinkEntry,
  parseViewDeepLinkFind,
  parseViewDeepLinkFragment,
  dropViewFragmentFromHash,
  SECTION_FRAGMENT_PREFIX,
  parseViewDeepLinkSchedule,
  parseViewWindowToken,
  setHashEntry,
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
  /**
   * 🔴 **「探す」で当たった語(`find`)だけを落とす**(#1102 段①)。
   * ⚠ **履歴を積まない**(`replaceState`)。⚠ 残すと、栞や `F5` のたびに本文が塗られる。
   * ⚠ 省略可(古い test の的)── 無ければ落とせないだけで、他は壊れない。
   */
  readonly dropFind?: () => void;
  /**
   * 🔴 **ノートの中の場所(`fragment`)だけを落とす**(#1559)。⚠ **履歴を積まない**(`replaceState`)。
   * ⚠ 残すと、栞や `F5` のたびに同じ行へ飛ばされる(添付の指定と同じ理由)。省略可(古い test の的)。
   */
  readonly dropFragment?: () => void;
  /**
   * 🔴 **予定の見せ方の合図(`sched` / `day`)だけを落とす**(#855 段 A-2)。⚠ 履歴を積まない。
   * ⚠ 残すと、栞や `F5` のたびに見せ方を奪う。省略可(古い test の的)。
   */
  readonly dropSchedule?: () => void;
  /**
   * 🔴 **添付の指定(`asset`)だけを落とす**(2026-10-11)。⚠ 履歴を積まない。
   * ⚠ 開いた後に残すと、`F5` のたびに同じ添付へ戻される(ノートと違い、住所は添付に追随しない)。
   */
  readonly dropAsset?: () => void;
  /**
   * 🔴 **住所を、いま見ているノートへ書き換える**(#689 案 B、2026-09-04)。
   *
   * ⚠ **履歴を積まない**(`replaceState`)── 積むと、ノートを 10 件見た後の
   *   `← 戻る` が **10 回押さないと前の頁へ帰れない**形になる。
   * ⚠ いま住所を名乗っていない断片には**何も生やさない**、
   *   **別の PKC の入れ物なら 1 バイトも触らない**(判定は `setHashEntry` が持つ)。
   */
  readonly setEntry: (containerId: string | null, lid: string) => void;
  /**
   * 🔴 **見出しへ飛んだ後、住所を元へ戻す**(#693 案 A、2026-09-04)。
   *
   * ⚠ **履歴を積まない**(`replaceState`)── そして `replaceState` は
   *   `hashchange` を撃たない(2026-09-04 実測)ので、戻したことで再入はしない。
   * ⚠ **飛びは邪魔しない** ── `hashchange` が届く時点でブラウザの scroll は
   *   済んでいる(2026-09-04 に chromium / headless_shell の両方で実測:
   *   handler の中で `scrollTop` は既に飛び先、`replaceState` の後も動かない)。
   */
  readonly restoreHash: (hash: string) => void;
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
    dropFind: () => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}${dropViewFindFromHash(location.hash)}`,
      );
    },
    dropFragment: () => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}${dropViewFragmentFromHash(location.hash)}`,
      );
    },
    dropAsset: () => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}${dropAssetFromHash(location.hash)}`,
      );
    },
    dropSchedule: () => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}${dropViewScheduleFromHash(location.hash)}`,
      );
    },
    setEntry: (containerId, lid) => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      const next = setHashEntry(location.hash, containerId, lid);
      // ⚠ **同じなら触らない** ── `replaceState` は履歴を積まないが、
      //    呼ぶたびにアドレス欄が書き換わる(選択が動くたびに走る経路である)
      if (next === location.hash) return;
      history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
    },
    restoreHash: (hash) => {
      if (typeof history !== 'object' || typeof location !== 'object') return;
      // ⚠ `search` は残す(flag のクエリを巻き込まない)── `clearHash` と同じ作法
      history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
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
 * 🔴 **この窓は「PKC 自身が開いた窓」か**を憶える鍵(#685 着地前レビュー 🔴1、2026-09-04)。
 *
 * ⚠ `sessionStorage` は **browsing context ごと**である ── `noopener` の窓は
 *   新しい群なので**継承されない**。だから「この窓だけ」を憶えるのにちょうど良い。
 */
export const OPENED_BY_US_KEY = 'pkc3.opened-by-us';

/**
 * 🔴 **「断片がノートを名指す」を「この窓は付箋だ」と読み替えない**
 *   (#685 着地前レビュー 🔴1、2026-09-04)。
 *
 * ⚠ 直す前は `container`+`entry` が在るだけで付箋の旗が立っていた。⚠ ところが
 *   **その形の URL は user が写して開く**(マニュアルが「付箋のアドレス欄をコピーすると
 *   そのノートを直接開くリンクになります」と**やり方まで書いている**)。
 * 🔴 そのふつうのタブが付箋扱いになると、台帳の `mine` が**選んでいるノートに追随する**ので、
 *   **そのタブでは「別の窓で開く」が二度と効かない** ── しかも出るのは
 *   「いま見ているこのウィンドウで開いています」という**説明の顔をした字**なので、
 *   user は不具合だと気づけない(この repo がいちばん嫌う形)。
 * 🔑 見分ける印は**既に在る**:`w=`(1 回限りの合図)は**こちらが開いた窓にしか付かず**、
 *   起動直後に `dropToken()` でアドレスから外れる ── だから **user が写した URL には無い**。
 * ⚠ F5 を跨いでも保つ必要があるので、`sessionStorage` に控える。
 *
 * @param opened `announceOpenedWindow()` の返り値(この起動で合図を持っていたか)
 * @param store `sessionStorage`。⚠ 使えない箱では `null` を渡す(その回だけの判定になる)
 */
export function noteOpenedByUs(
  opened: boolean,
  store: Pick<Storage, 'getItem' | 'setItem'> | null,
): boolean {
  if (store === null) return opened;
  try {
    if (opened) store.setItem(OPENED_BY_US_KEY, '1');
    return opened || store.getItem(OPENED_BY_US_KEY) === '1';
  } catch {
    // ⚠ 使えない箱(privacy 設定 / file://)では、その回の合図だけで決める
    return opened;
  }
}

/**
 * 🔴 **この窓は「特定の 1 つのために開かれた」か**(#685 動線レビュー 欠陥 1、2026-09-04)。
 *
 * ⚠ 直す前は、起動したときのお知らせが**どの窓でも無条件に出ていた**。
 *   付箋は 420px = 1 枚ずつの画面なので、お知らせは `grid-area: detail; z-index: 2` で
 *   **面いっぱい**に出て、上の帯まで覆う ── **押したのに、頼んだ物が 1 つも見えない**。
 * 🔴 しかも当たるのは**新しい機能を初めて押した 1 回目**である
 *   (お知らせを読んで押しに行くのだから、その時点でまだ未読)。
 *   ⚠ いちばん印象に残る回が、まるごとこれになっていた。
 * 🔑 判定は #300 段④(follower の帯)と**同じ理屈**である ── この窓は
 *   **user が 1 つの物のために自分で開いた**ので、起動の案内を出す場所ではない。
 *   本体の窓では今までどおり出る。
 */
export function isPurposeWindow(held: {
  readonly view: ViewMode | null;
  readonly note: boolean;
}): boolean {
  return held.view !== null || held.note;
}

/**
 * 🔴 **窓の題名**(#300 段③ / #685 着地前レビュー ⚠3)。
 *
 * ⚠ **タスクバーで見分けるため**に在る ── 直す前は何枚開いても全部「PKC3」で、
 *   どれがどれか押すまで分からなかった。
 * 🔑 **形を 1 か所に持つ** ── 面の窓(面の名前)も付箋(ノートの題名)も同じ形にする。
 *   ⚠ 2 か所に書くと、片方だけ体裁が変わっても誰も気づかない(CLAUDE.md §7)。
 * ⚠ 空の題名は `null` と同じに扱う ── `` — PKC3`` という頭の欠けた字を出さない。
 */
export function windowTitleFor(base: string, label: string | null): string {
  return label === null || label.trim() === '' ? base : `${label} — ${base}`;
}

/**
 * 🔴 **アラームが鳴ったのに、見えていないタブの題名**(依頼 75-2。Gemini の回答「推薦どおり」= A)。
 *
 * ⚠ 音を消している端末や聞き逃したときは、別のタブからは気づく手段が無かった。
 * 🔑 通知の許可は求めない決まりなので、**タブの題名の頭に「🔔」を付ける**(「🔔 打ち合わせ — PKC3」)。
 *   付けるのは鳴ってから**そのタブを開くまで**の間だけ(呼び元が決める)。
 */
export function ringingTitle(title: string, ringing: boolean): string {
  return ringing ? `🔔 ${title}` : title;
}

/**
 * 🔴 **2 枚目を止めたときの字**(#685 段② / #690 I3、2026-09-04)。
 *
 * ⚠ 直す前は「すでに別のウィンドウで開いています」だけで、**どの窓か**が無かった
 *   ── 小窓を 5 枚並べている人は、タスクバーのどれを探せばよいか分からない。
 * 🔑 窓の題名(`windowTitleFor` の形そのまま)を添える ── タスクバーに出ている字と
 *   **同じ字**なので、そのまま探せる。⚠ 形を写さず `windowTitleFor` を通す
 *   (題名の体裁が変わった日に、ここだけ古い形で残らないように)。
 * ⚠ 題名が無い(空)ノートでは器の名前(`PKC3`)だけになる ── それも
 *   タスクバーと同じ字である。
 *
 * @param base 器の名前(`CONTAINER_TITLE`)
 * @param title そのノートの題名(`entryMetas` から。無ければ `null`)
 */
export function noteOpenElsewhereMessage(base: string, title: string | null): string {
  // 🔑 台帳が古いこともある(閉じた窓が残っている)── 探しても見つからないときの出口を添える。
  //    1 回目の押しは「前に出て」と頼む(点呼もこのとき一緒に打つ)。**頼んだ直後にもう一度押すと、
  //    点呼の答えを待たず新しく開く**(時間だけで決める ── `note-window-registry.ts` の `decideNoteOpen`)
  return `このノートは、すでに別のウィンドウで開いています(『${windowTitleFor(base, title)}』)。見つからないときは、もう一度押すと開きます`;
}

/**
 * 小窓の中で同じノートを押したときの字。⚠ 題名は添えない ── **いま見ているのがそれ**なので、
 * 探す相手が居ない。
 */
export const NOTE_OPEN_HERE_MESSAGE = 'このノートは、いま見ているこのウィンドウで開いています';

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
  // ⚠ 古いアドレスで来た人が探している名前(カレンダー / かんばん)で言う(#1087)
  'カレンダーとかんばんは、左のペインの「予定」にまとまりました(チェックの付いた行が日付ごとに並びます)。そちらを開きました';

export function unusableViewMessage(): string {
  /**
   * ⚠ 区切りは `/` だけ(2026-09-04、#278 段③ で連絡先が加わり 8 面になったとき、
   *   ` / ` では状態の行の予算(幅 90)を 1 単位はみ出した ── `deep-link.test.ts`)。
   *   並ぶのは**打つ字**なので、空白を挟まないほうが「そのまま打てる」向きでもある。
   */
  return `画面名は ${openableViewNames().join('/')} のどれかです`;
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
   * 🔴 **この PKC の入れ物の id**(2026-10-11)。⚠ 渡すと、リンクが**別の PKC を指しているとき**
   *   (共有で受け取ったリンクを、別のコピーで開いた)に**黙らず理由を出す**。
   *   渡さない(古い test の的)と、従来どおり `selectEntry` 側が黙って捨てる。
   */
  readonly ownContainerId?: () => string | null;
  /** 🔴 **この PKC にそのノートが在るか**(同上)。⚠ 無ければ「見つかりません」と言う。 */
  readonly hasEntry?: (lid: string) => boolean;
  /**
   * 🔴 **いまの phase**(#1087)。⚠ 編集中・保存失敗中は `SELECT_ENTRY` が黙って捨てるので、
   *   リンクを押しても何も起きない(dead click)。渡すと、そのとき理由を出す。
   */
  readonly phase?: () => AppPhase;
  /**
   * 🔴 **添付を名指したリンクを開く**(`#pkc?container=…&asset=…`。2026-10-11)。
   *   key → 添付ノートの逆引き(`findAssetOwner`)は非同期なので、見つからない理由も呼ばれる側が言う。
   */
  readonly selectAsset?: (assetKey: string, ownerLid: string | null) => void;
  /**
   * 🔴 **「探す」で当たった語で、いま選んだノートの本文を塗って送る**(#1102 段①)。
   *
   * ⚠ **`selectEntry` の後**に呼ぶ(選んでいない物は塗れない)。⚠ 語は**使ったらアドレスから
   * 外す**(`DeepLinkTarget.dropFind`)── 栞や `F5` に探していた語を焼き付けない。
   * ⚠ ノートを名指すだけの断片(面を指していない)でだけ呼ぶ ── 面には塗る本文が無い。
   */
  readonly searchJump?: (lid: string, find: string) => void;
  /**
   * 🔴 **ノートの中の見出し(ログの 1 行)へ送って光らせる**(#1559)── `fragment=h/<見出しの id>` のリンク。
   *
   * ⚠ **`selectEntry` の後**に呼ぶ。⚠ 見出しが無い(字を直した / 消した)・ノートを開けなかったときの
   *   理由は**呼ばれる側が言う**(描き終わりを待ってから探すので非同期)。⚠ 使ったらアドレスから外す。
   */
  readonly sectionJump?: (lid: string, slug: string) => void;
  /**
   * 🔴 **予定の面を「週」で開く**(#855 段 A-2)── 左の列の「週」が別のウィンドウで開くとき運ぶ合図。
   * ⚠ 面が `schedule` のときだけ呼ぶ。**面を開いた後**に呼ぶ(見せ方は面の状態)。
   *   使ったらアドレスから外す(`DeepLinkTarget.dropSchedule`)。
   */
  readonly scheduleView?: (mode: 'week' | 'month', day: string | null) => void;
  /**
   * 🔴 **いま断片が指している面が変わったら呼ばれる**(#300 段③ の直し)。
   *
   * `null` = もう指していない(user が自分で離れた)。
   * 🔑 これを見て「この窓はアプリの窓か」を決める ── 題名も、
   * `× 閉じる` が**窓ごと閉じるか**もこれで分かれる。
   */
  readonly onHold?: (view: ViewMode | null) => void;
  /**
   * 🔴 **この窓が「付箋」であることを伝える**(#685 着地前レビュー 🔴1 / ⚠3、2026-09-04)。
   *
   * `true` = 断片が**面ではなくノート**を名指している(= `⋯ の「別の窓で開く」`
   * で出た窓、または同じ形のリンクで開いた窓)。
   *
   * ⚠ **`onHold` では届かない** ── あちらは `view=` を指したときだけ呼ばれるので、
   *   付箋の窓は `hold()` を 1 度も通らない。その結果 2 つが**同時に**壊れていた:
   *   ① 題名が index.html の既定(`PKC3`)のまま ── **何枚開いても全部「PKC3」**で、
   *      タスクバーで見分けられない(#300 段③ が解いた当の問題が「何枚でも」で戻る)
   *   ② 「複数タブ: このタブの保存はメインのタブ経由です」が**出っぱなし**になる ──
   *      #300 段④ が消した理由(user が自分で開いた 2 枚目 / できることは無い /
   *      状態の行 1 行を占めて読ませたい文を押し出す)が**そのまま当てはまる**。
   * 🔑 だから旗を 1 つだけ増やし、**題名と帯の両方をこれで決める**。
   */
  readonly onHoldEntry?: (holding: boolean) => void;
  /** 使えない名前だったときの理由(画面の下に出す)。 */
  readonly fail: (message: string) => void;
  /** いまの面が変わったら呼ばれる購読(返り値で解除)。 */
  readonly onViewChange: (fn: (view: ViewMode) => void) => () => void;
  /**
   * 🔴 **選んでいるノートが変わったら呼ばれる購読**(#689 案 B、2026-09-04)。
   *
   * ⚠ **面の `onViewChange` と非対称である** ── 面は「離れたら**消す**」、
   *   ノートは「移った先へ**書き換える**」。理由は `setHashEntry` の docstring:
   *   面から離れた人はもうその面を見ていないが、**ノートは見ている物が移っただけ**
   *   なので、住所は消すのではなく正しくするのが `Ctrl+D` / `F5` の期待に合う。
   * 🔴 **optional にしない**(#689 着地前レビュー ⚠3)── 配線を落としても
   *   tsc が黙る形にすると、戻ってくる症状は「**`F5` で 30 分前のノートへ戻る**」
   *   = #689 そのものである。⚠ いま守っているのは
   *   `bootstrap-wiring.test.ts` の**字面 pin 1 本だけ**なので、型で受けさせる
   *   (CLAUDE.md § 7「待ちの口は optional にしない」と同じ理屈)。
   * ⚠ **入れ物も一緒に渡す**(#689 動線レビュー 欠陥 1)── 読む側は
   *   「この PKC の入れ物か」まで検めるので、書く側も同じ 2 段を通す。
   */
  readonly onSelectedEntry: (
    fn: (containerId: string | null, lid: string | null) => void,
  ) => () => void;
  /** アドレスの断片が変わったら呼ばれる購読(返り値で解除)。 */
  readonly onHashChange?: (fn: () => void) => () => void;
  readonly target?: DeepLinkTarget;
}

/** 🔴 別の PKC を指すリンクを開いたときの理由(2026-10-11)。⚠ 黙って捨てると dead click になる。 */
export const FOREIGN_ENTRY_LINK_MESSAGE =
  'このリンクは別の PKC のノートを指しています(この PKC には開けません。送り主にノートを書き出して渡してもらってください)';
export const FOREIGN_ASSET_LINK_MESSAGE =
  'このリンクは別の PKC の添付を指しています(この PKC には開けません。送り主に添付を書き出して渡してもらってください)';
export const NOT_READY_LINK_MESSAGE = 'PKC の準備ができていないため、このリンクを開けませんでした。開き終わってからもう一度試してください';
/** 🔴 `fragment` が読めない綴りのとき(PKC2 の `log/<id>` など)。ノートは開く ── 場所だけ言う。 */
export const UNREADABLE_PLACE_MESSAGE =
  'このリンクの場所の指定は読めませんでした(ノートだけ開きました。ログの行を指すリンクは、この PKC で作り直してください)';
/** 🔴 ノートを指さずに場所だけを指すリンク(`fragment` だけ / 面を開くリンクに付いた)。 */
export const PLACE_WITHOUT_NOTE_MESSAGE =
  'このリンクにはノートの指定が無いため、行や章の場所だけでは開けません';
export const MISSING_ENTRY_LINK_MESSAGE =
  'このリンクのノートが見つかりません(ゴミ箱にあれば戻せます。ゴミ箱は左のペインの「フォルダ」の中です)';

/** ノートのリンクを開けない理由。⚠ 開けるなら `null`。材料が配線されていなければ判断しない。 */
function linkProblem(wiring: DeepLinkWiring, containerId: string, lid: string): string | null {
  const own = wiring.ownContainerId?.();
  if (own === undefined) return null;
  // 🔴 入れ物がまだ決まっていない(起動の途中)── 黙って捨てない。
  //   実配線では `connectViewDeepLink` は `SYS_BOOTED` の後に呼ばれる(`startApp` が返ってから)ので来ないはずだが、
  //   来たときに無言の dead click にしない
  if (own === null) return NOT_READY_LINK_MESSAGE;
  if (own !== containerId) return FOREIGN_ENTRY_LINK_MESSAGE;
  if (wiring.hasEntry !== undefined && !wiring.hasEntry(lid)) return MISSING_ENTRY_LINK_MESSAGE;
  // 🔴 ノートは在るが、編集中・保存失敗中は `SELECT_ENTRY` が黙って捨てる(app-state.ts)── 理由を言う
  const phase = wiring.phase?.();
  const blocked = phase === undefined ? null : selectBlockReason(phase);
  if (blocked !== null) return `${blocked}リンクのノートを開いてください`;
  return null;
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

  /** いま「断片がノートを名指している」か。⚠ 面(`held`)とは**別の軸**である。 */
  let heldEntry = false;

  const hold = (view: ViewMode | null): void => {
    if (held === view) return;
    held = view;
    wiring.onHold?.(view);
  };

  /** ⚠ 変わったときだけ伝える(`apply` は面が変わるたび走る)。 */
  const holdEntry = (on: boolean): void => {
    if (heldEntry === on) return;
    heldEntry = on;
    wiring.onHoldEntry?.(on);
  };

  /**
   * 🔴 **付箋が名乗っていた住所**(`#pkc?container=…&entry=…`。#693 案 A)。
   *
   * ⚠ 目次(`:::toc`)と脚注のリンクは素の `<a href="#…">` なので、押すと
   *   ブラウザが断片を **`#<見出し id>` に丸ごと入れ替える**。直す前はそれを
   *   `apply` が「ノートを名指していない」と読んで `holdEntry(false)` を撃ち、
   *   **題名が「PKC3」に戻る / 「複数タブ」の帯が復活する / 同じノートの 2 枚目が
   *   開く / `F5` でノートが出ない / 住所の追随(#689)が止まる**が同時に起きていた。
   * 🔑 だから**戻すための住所を控えておく**(ノートを名指した断片を読んだとき /
   *   追随で書き換えたとき)── 見出しへ飛んだ後、ここへ戻す。
   */
  let entryHash: string | null = null;
  const rememberEntryHash = (): void => {
    // 🔑 場所(`fragment`)は控えない ── 戻す先に残すと、見出しへ飛ぶたびに同じ行へ引き戻される
    if (parseViewDeepLinkEntry(target.hash) !== null) entryHash = dropViewFragmentFromHash(target.hash);
  };

  /**
   * 🔴 **住所の `entry` に、最後に「合っている」と分かっているノート**(#1559 着地前レビュー)。
   *   読んだ住所の entry か、追随で書いた entry。⚠ 追随は**選択が実際に変わったとき**だけ、
   *   かつ**住所をこちらが書き換えていないとき**だけ書く ── 保存の完了などで状態の通知は何度も来るので、
   *   リンクを貼った直後(`hashchange` が届く前)に古い選択を書き戻すと、リンクの `entry` が潰れて
   *   別のノートが開く。
   */
  let followed: string | null = null;

  /** 開く先のノートが無い断片に `fragment` が付いていたら、理由を出して落とす。 */
  const dropOrphanPlace = (): void => {
    if (parseViewDeepLinkFragment(target.hash) === null) return;
    wiring.fail(PLACE_WITHOUT_NOTE_MESSAGE);
    target.dropFragment?.();
  };

  const apply = (): void => {
    const named = parseViewDeepLinkEntry(target.hash);
    if (named !== null) followed = named.lid;
    const read = readViewDeepLink(target);
    if (read === null) {
      /**
       * 🔴 **面を指していなくても、ノートは開く**(#685 段①、2026-09-04)。
       *
       * ⚠ 直す前は `view` の無い断片で**何も起きなかった** ──
       *   `#pkc?container=c1&entry=e1` は PKC Link の仕様(form 3、
       *   External Permalink)の形なのに、**作る側も読む側も 0 件**だった
       *   (`formatExternalPermalink` / `parseExternalPermalink` の呼び側は
       *   `src/` に 1 件も無い)。
       * 🔑 これが在って初めて「**このノートを別の窓で開く**」が組める ──
       *   窓は URL でしか行き先を渡せない(#685 の裁定 A)。
       *
       * ⚠ **断片は消さない** ── 面(`view`)と違って、ここは「いまこのノートを
       *   見ている」という**正しい住所**である。消すと栞にできない。
       * ⚠ **`container` と `entry` の両方が要る**(`parseViewDeepLinkEntry` の規則)
       *   ── 片方だけで拾うと、別の container の lid と**偶然一致して
       *   無関係なノートを選ぶ**。
       * ⚠ 居ない lid は呼び側(`main.ts` → `SELECT_ENTRY`)が黙って捨てる ──
       *   判定をここへ写さない(CLAUDE.md §7)。
       */
      const here = parseViewDeepLinkEntry(target.hash);
      // 🔴 **この窓は付箋である**(上の `onHoldEntry` の docstring)── 題名と帯が
      //    これで決まる。⚠ 面の窓(`view=`)は下の枝で `false` に戻す
      holdEntry(here !== null);
      if (here !== null) {
        rememberEntryHash();
        const why = linkProblem(wiring, here.containerId, here.lid);
        if (why !== null) {
          // 🔴 **黙って捨てない**(2026-10-11)── 共有されたリンクが開かないとき、理由が無いと
          //   「壊れている」としか読めない
          wiring.fail(why);
          /**
           * 🔴 **開けなかった回も、探していた語と場所は落とす**(#1087)── `entry` は残すが(住所は正しい)、
           *   `find` / `fragment` を残すと、住所の追随が他の key を残すので**次に選んだ別のノートへ付いて回る**。
           */
          if (parseViewDeepLinkFind(target.hash) !== null) target.dropFind?.();
          if (parseViewDeepLinkFragment(target.hash) !== null) target.dropFragment?.();
          return;
        }
        wiring.selectEntry?.(here.containerId, here.lid);
        /**
         * 🔴 **探していた語があれば、当たった所へ送って塗る**(#1102 段①)。
         * ⚠ **取ったらすぐ落とす** ── 住所の追随(`setEntry`)は他の key を残すので、
         *   落とさないと次のノートへ移っても語が付いて回る。
         */
        const find = parseViewDeepLinkFind(target.hash);
        if (find !== null) {
          wiring.searchJump?.(here.lid, find);
          target.dropFind?.();
        }
        /**
         * 🔴 **ノートの中の場所があれば、そこへ送って光らせる**(#1559)。
         * ⚠ **読めない綴りは黙らない**(ノートは開いている ── 場所だけ言う)。
         * ⚠ 取ったらすぐ落とす(`F5` のたびに同じ行へ戻さない ── 添付の指定と同じ作法)。
         */
        const place = parseViewDeepLinkFragment(target.hash);
        if (place !== null) {
          if (place.kind === 'section') wiring.sectionJump?.(here.lid, place.slug);
          else wiring.fail(UNREADABLE_PLACE_MESSAGE);
          target.dropFragment?.();
        }
      } else {
        // 🔴 ノートの指定が無い断片の場所指定も黙って残さない(開く先が無い ── 理由を言って落とす)
        dropOrphanPlace();
      }
      /**
       * 🔴 **添付を名指したリンク**(2026-10-11)。⚠ ノートと違って**断片を落とす**
       *   (開いた添付に住所は追随しないので、残すと `F5` で引き戻される)。
       */
      const asset = parseViewDeepLinkAsset(target.hash);
      if (asset !== null) {
        const own = wiring.ownContainerId?.();
        if (own === null) {
          wiring.fail(NOT_READY_LINK_MESSAGE);
        } else if (own !== undefined && own !== asset.containerId) {
          wiring.fail(FOREIGN_ASSET_LINK_MESSAGE);
        } else {
          wiring.selectAsset?.(asset.assetKey, asset.ownerLid);
        }
        target.dropAsset?.();
      }
      return;
    }
    if ('view' in read) {
      // 🔴 面を開くリンクの場所指定は使い道が無い ── 黙って残さず、理由を言って落とす
      dropOrphanPlace();
      hold(read.view);
      // ⚠ 面を指しているなら付箋ではない(題名は `onHold` が面の名前で書く)
      holdEntry(false);
      // 🔑 **ノートが先、面が後**(上の docstring の理由)
      const here = parseViewDeepLinkEntry(target.hash);
      // 🔴 ノートの門は付箋の枝と同じ 1 本(`linkProblem`)── 居ない / 編集中 / 別の PKC のときは選ばず、理由を言う(面は開く)
      const why = here === null ? null : linkProblem(wiring, here.containerId, here.lid);
      if (here !== null && why === null) wiring.selectEntry?.(here.containerId, here.lid);
      wiring.openView(read.view);
      if (why !== null) wiring.fail(why);
      if (read.view === 'schedule') {
        const sched = parseViewDeepLinkSchedule(target.hash);
        if (sched !== null) {
          wiring.scheduleView?.(sched.mode, sched.day);
          target.dropSchedule?.();
        }
      }
      return;
    }
    if ('moved' in read) {
      /**
       * 🔴 **引っ越し先を開いて、そう言う**(段⑤)。
       * ⚠ 黙って開くと「打った字と違う所が出た」になる ── **理由を出す**。
       * ⚠ 断片は消す(残すと読み直しのたびに同じ案内が出る)。
       */
      hold(null);
      holdEntry(false);
      const here = parseViewDeepLinkEntry(target.hash);
      const why = here === null ? null : linkProblem(wiring, here.containerId, here.lid);
      if (here !== null && why === null) wiring.selectEntry?.(here.containerId, here.lid);
      target.clearHash();
      wiring.openBrowse?.(read.moved);
      wiring.fail(MOVED_MESSAGE);
      // 🔴 ノートを開けなかった理由は後に言う(最後に出る字が、user のやり直せる側)
      if (why !== null) wiring.fail(why);
      return;
    }
    // ⚠ 使えない名前は**残す意味が無い**ので、その場で消す
    //   (残すと読み直しのたびに同じ断り文が出る)
    hold(null);
    holdEntry(false);
    target.clearHash();
    wiring.fail(unusableViewMessage());
  };

  apply();

  const offView = wiring.onViewChange((view) => {
    // ⚠ 自分が撃った `SET_VIEW_MODE` でも呼ばれる ── **同じ面なら何もしない**
    if (held === null || view === held) return;
    hold(null);
    holdEntry(false);
    target.clearHash();
  });
  const offHash = wiring.onHashChange?.(() => {
    /**
     * 🔴 **付箋の中で見出しへ飛んだら、住所だけ元へ戻す**(#693 案 A)。
     *
     * ⚠ 飛びは邪魔しない ── `hashchange` が届く時点で scroll は済んでいる
     *   (`restoreHash` の docstring の実測)。戻すのは**住所と身元**だけで、
     *   `apply` は通さない(通すと `holdEntry(false)` = 旗が降りる)。
     * ⚠ **本体の窓(付箋でない)では今までどおり** ── 見出し id のアンカー
     *   リンク(#658)を壊さない。あちらは `apply` が `#slug` を読まずに返すだけ。
     * ⚠ 戻す先が無い(`entryHash === null`)なら今までどおり `apply` へ落とす
     *   ── ここで黙って握り続けると、旗と住所が食い違ったまま残る。
     */
    if (heldEntry && entryHash !== null && isHeadingAnchor(target.hash)) {
      target.restoreHash(entryHash);
      return;
    }
    apply();
  });
  /**
   * 🔴 **住所を、いま見ているノートへ追随させる**(#689 案 B)。
   *
   * ⚠ **何も選んでいない回は触らない** ── boot の途中や削除の直後に
   *   `null` が流れてくるが、そこで住所を消すと**栞ごと消える**。
   *   住所が古いままでも `F5` は「居ない lid」として黙って捨てるだけである。
   * 🔑 「そもそも住所を名乗っているか」「この PKC の入れ物か」の判定は
   *   `setHashEntry` が持つ ── ここで二重に持たない(§ 7)。
   */
  const offSelect = wiring.onSelectedEntry((containerId, lid) => {
    if (lid === null) return;
    // 🔴 変わっていない選択では書かない / 住所をこちらが書き換えていない(リンクが貼られた)ときも書かない
    if (lid === followed) return;
    const cur = parseViewDeepLinkEntry(target.hash);
    if (followed !== null && cur !== null && cur.lid !== followed) return;
    followed = lid;
    target.setEntry(containerId, lid);
    // 🔑 追随した先が、次に見出しへ飛んだときの「戻す先」になる(#693)──
    //    控え直さないと、ノートを移った後の飛びで**最初のノートの住所**へ戻る
    rememberEntryHash();
  });

  return () => {
    offView();
    offHash?.();
    offSelect();
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

/**
 * 🔴 **外から開けるリンク**(ノート / 添付)を組む唯一の口(2026-10-11)。
 *
 * ⚠ 「リンクをコピー」の 3 つの面(右クリック・情報ペイン・操作を探す)と添付の詳細が、
 *   全部ここを通る ── `location` を読むのはこの file だけ(`currentBaseUrl`)。
 * ⚠ 本文に貼る参照(`entry:` / `asset:`)とは**別物**: こちらはブラウザやメールに貼ると
 *   この PKC のこの物が開く。組めないとき(入れ物 id が無い / 綴りが通らない)は `null`。
 */
export function entryPermalink(containerId: string | null, lid: string): string | null {
  if (containerId === null) return null;
  return formatExternalPermalink({
    baseUrl: permalinkBaseUrl(),
    kind: 'entry',
    containerId,
    targetId: lid,
  });
}

/**
 * 🔴 **ノートの中の 1 か所(見出し = ログの 1 行)を指すリンク**(#1559)。
 *   `entryPermalink` に `fragment=h/<見出しの id>` を足した形 ── 綴りは本文の参照(`entry:<lid>#h/<id>`)と同じ。
 *   ⚠ base の作法(`?query` を運ばない)は `entryPermalink` と同じ 1 本(`permalinkBaseUrl`)。
 */
export function sectionPermalink(containerId: string | null, lid: string, slug: string): string | null {
  if (containerId === null || slug === '') return null;
  return formatExternalPermalink({
    baseUrl: permalinkBaseUrl(),
    kind: 'entry',
    containerId,
    targetId: lid,
    fragment: `${SECTION_FRAGMENT_PREFIX}${slug}`,
  });
}

export function assetPermalink(
  containerId: string | null,
  assetKey: string,
  ownerLid: string | null = null,
): string | null {
  if (containerId === null) return null;
  const url = formatExternalPermalink({
    baseUrl: permalinkBaseUrl(),
    kind: 'asset',
    containerId,
    targetId: assetKey,
  });
  // 🔴 持ち主の添付ノートも運ぶ(`owner`)。⚠ `entry=` ではない ── `parseExternalPermalink` は
  //   entry と asset の併記を断る(どちらか一方)ので、本文に貼ったリンクが読めなくなる
  if (url === null || ownerLid === null || !/^[A-Za-z0-9_-]+$/.test(ownerLid)) return url;
  return `${url}&owner=${encodeURIComponent(ownerLid)}`;
}

/**
 * 🔴 **添付のリンクの「開く」の実体**(#1087)。⚠ 持ち主を探した後の**ノートを開く口は、他のリンクと同じ門**
 *   (`open` = `selectEntryOrExplain`)を通す ── 直す前は `SELECT_ENTRY` を直に撃っていたので、編集中・保存失敗中に
 *   押すと黙って捨てられ、章の下書きの確認も、スマホ幅の本文ページへの切り替えも通らなかった。
 *   `main.ts` は test から走らないので、判断はここに置く。
 * @param a.open ノートを開く(断る理由は呼ばれる側が言う)
 * @param a.fail 見つからない / 解決できないときの理由の出し先
 */
export async function openAssetOwner(a: {
  assetKey: string;
  ownerLid: string | null;
  what: '参照' | 'リンク';
  assetKeyOf: (lid: string) => Promise<string | null>;
  findOwner: (assetKey: string) => Promise<string | null>;
  open: (lid: string) => void;
  fail: (message: string) => void;
  errorText: (e: unknown) => string;
}): Promise<void> {
  try {
    const found = await resolveAssetOwner(a);
    if (found !== null) a.open(found);
    else a.fail(`この${a.what}の添付が見つかりません(「使われていない添付を消す」で消えた可能性があります)`);
  } catch (e) {
    a.fail(`${a.what}を解決できません: ${a.errorText(e)}`);
  }
}

/**
 * 🔴 **外へ渡すリンクの base**(オリジン + パス)。⚠ `?query` は持たない ──
 *   `currentBaseUrl` は `?pkc-flag=…` など**送り主の切替**まで運ぶので、受け取った人の PKC がその設定で立ち上がる。
 *   `file://` は origin が `null` になるので、protocol + host + pathname で組む(host は空)。
 */
export function permalinkBaseUrl(): string {
  if (typeof location !== 'object') return '';
  return `${location.protocol}//${location.host}${location.pathname}`;
}

/**
 * 🔴 **添付のリンクの行き先ノート**。持ち主として運ばれた lid が**本当にその添付を持っているとき**だけ
 *   それを開く(同じ file を 2 つのノートに付けると key が同じなので、逆引きだけでは別のノートが開きうる)。
 *   持っていない / 運ばれていない / 読めない → 逆引き。判断を `main.ts`(test が届かない)に置かない。
 */
export async function resolveAssetOwner(a: {
  assetKey: string;
  ownerLid: string | null;
  /** その lid の添付 key(添付のノートでなければ `null`) */
  assetKeyOf: (lid: string) => Promise<string | null>;
  findOwner: (assetKey: string) => Promise<string | null>;
}): Promise<string | null> {
  if (a.ownerLid !== null) {
    try {
      if ((await a.assetKeyOf(a.ownerLid)) === a.assetKey) return a.ownerLid;
    } catch {
      // 読めなかった → 逆引きへ
    }
  }
  return a.findOwner(a.assetKey);
}

/**
 * 🔴 **リンクを開く配線のうち、この PKC の状態から決まる 3 つ**(`main.ts` はこれを広げて渡すだけ)。
 *   `main.ts` はどの test からも実行されないので、ここに置いて挙動を test する
 *   (入れ物の id / 居るノート / 添付を開くときの断りの字)。
 */
export function linkOpenerFor(app: {
  dispatcher: { getState(): { cid: string | null; entryMetas: ReadonlyMap<string, unknown>; phase: AppPhase } };
  navigateAssetRef(assetKey: string, what?: '参照' | 'リンク', ownerLid?: string | null): void;
}): Pick<DeepLinkWiring, 'ownContainerId' | 'hasEntry' | 'phase' | 'selectAsset'> {
  return {
    ownContainerId: () => app.dispatcher.getState().cid,
    hasEntry: (lid) => app.dispatcher.getState().entryMetas.has(lid),
    phase: () => app.dispatcher.getState().phase,
    selectAsset: (assetKey, ownerLid) => app.navigateAssetRef(assetKey, 'リンク', ownerLid),
  };
}
