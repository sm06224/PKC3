/**
 * スマホ用画面の**判定だけ**(#632 段①)。
 *
 * 設計 doc: `docs/development/mobile-screen-design-2026-09.md`
 * (user 裁定 2026-08-30「**スマホの幅なら、スマホ用画面に切り替える。それ以下なら
 * 対応外とする。スマホ用画面がないなら、作る**」)。
 *
 * 🔴 **数字はここ 1 か所**(CLAUDE.md §7)── CSS には `720px` / `359px` を
 * **1 文字も書かない**。CSS が読むのは `data-pkc-layout` / `data-pkc-page` の
 * 2 属性だけで、幅を見るのは `adapter/ui/render/phone-layout.ts` の
 * `matchMedia` 2 本である。⚠ 両方に数字を書くと、片方だけ変えた日に
 * **JS と CSS が別の幅で切り替わる**(誰も気づけない形で版面が 2 つに割れる)。
 * `tests/features/phone-layout.test.ts` が「app.css に `720px` が 0 件」を pin する。
 *
 * ⚠ **この file はブラウザの API を 1 つも呼ばない** ── 呼ぶと unit で
 * 全分岐を通せなくなる(画面を作らないと判定が走らない形になる)。
 */
import type { ViewMode } from '@adapter/state/app-state';

/**
 * 🔴 **スマホ用画面へ切り替える上限**(設計 doc §2-1)。
 *
 * ⚠ この値は「app.css が 1 列に折っていた境目」と**同じ数字**である ──
 *   同じにするから版面が増えない(3 列 / ≤1100 の 2 列 / スマホ の 3 つ)。
 * ⚠ 721px 以上は今までどおりの 2 列版面。segmented された端末(横向きのスマホ)は
 *   幅が 720 を超えるのでスマホ用画面にならない ── 裁定が「幅」なので設計はここで止める
 *   (段⓪ の計器が 844×390 で「押せない操作が 1 つある」を出しており、別 issue にする)。
 */
export const PHONE_MAX_PX = 720;

/**
 * 🔴 **対応外の下限**(設計 doc §2-2)。⚠ **画面は変えないし、操作も塞がない** ──
 *   状態の行に 1 度だけ理由を出すだけである(塞ぐと、その幅で開いた user が
 *   自分のノートを取り出せなくなる)。判定を使うのは段③。
 */
export const PHONE_MIN_PX = 360;

/**
 * スマホ用画面で「いま見えている 1 枚」。
 *
 * 🔴 **`pane` を `note` と分ける**(2026-09-02、実装して分かった)。どちらも
 *   中央の器を出すので 1 稿目は同じ `note` にしていたが、**帯を出すかが逆**である
 *   ── 設定・フラグ・ヘルプ・2 ペイン・集計は自分の帯(`pane-bar` の「× 閉じる」)を
 *   持つので、ページの帯を重ねると**戻る口が 2 本並ぶ**。
 * ⚠ 分けないと CSS からは区別できず、「帯のぶんの場所を空ける」規則が
 *   **帯の出ない面にも 36px の隙間を作る**(user には理由の無い余白に見える)。
 */
export type PhonePage = 'list' | 'note' | 'info' | 'pane';

/**
 * 判定に要る材料。⚠ **`AppState` を丸ごと取らない** ── 取ると
 * 「この 2 つ以外は判定に効かない」が読めなくなり、次に足した誰かが
 * 3 つ目の条件をここへ書く。
 */
export interface PhoneShape {
  readonly selectedLid: string | null;
  readonly viewMode: ViewMode;
}

/**
 * 🔴 **いま出すページ**(設計 doc §2-5 / §2-8)。
 *
 * @param infoFor 情報ページを**どのノートで**開いたか(開いていなければ `null`)。
 *
 * 🔑 **真偽値ではなく lid を持つ**のが肝である。設計 doc §2-8 は
 *   「`selectedLid` が変わる / `viewMode` が本文以外になる / 削除で後継に移る、で
 *   **自動的に閉じる**(閉じる code を書かず判定に含める)」と決めたが、
 *   真偽値では**選んでいるノートが変わったことをこの関数から見られない** ──
 *   閉じる副作用を別の場所に書くことになり、書き忘れると
 *   「別のノートを開いたのに、前のノートの情報が出たまま」になる。
 *   lid で持てば `infoFor !== selectedLid` が**そのまま「閉じる」**になる。
 *
 * ⚠ **順番に意味がある**:本文以外の面(設定・フラグ・ヘルプ・2 ペイン・集計)は
 *   情報ページより**強い** ── 面を開いた瞬間に情報は畳む(面と情報が同じセルに
 *   重なっているので、両方見せる場所が無い)。
 */
export function phonePageOf(st: PhoneShape, infoFor: string | null): PhonePage {
  // 中央が自分の面を出している ── 戻る口はその面の帯の「× 閉じる」
  if (st.viewMode !== 'detail') return 'pane';
  if (st.selectedLid === null) return 'list';
  if (infoFor !== null && infoFor === st.selectedLid) return 'info';
  return 'note';
}

/**
 * 🔴 **ページの帯(← 一覧 ｜ 題名 ｜ 情報 ｜ ⋯)を出すか**(設計 doc §2-5)。
 *
 * 🔑 **ページから導く**(state をもう一度読まない)── 2 か所で数えると、
 *   「帯は出ているのに場所が空いていない」が静かに生まれる(CLAUDE.md §7)。
 *   CSS も同じ `data-pkc-page` から場所を空けるので、判定は 1 つで足りる。
 * ⚠ 本文以外の面では出さない ── その面は自分の帯に「× 閉じる」を持っている。
 * ⚠ 一覧ページでも出さない ── 「← 一覧」を一覧の上に出しても押す先が無い。
 */
export function phoneBandShown(page: PhonePage): boolean {
  return page === 'note' || page === 'info';
}
