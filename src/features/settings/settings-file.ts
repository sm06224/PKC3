/**
 * 🔴 **設定だけを別の端末へ持っていく**(#414。PKC2 の「Settings File」相当)。
 *
 * ## user の物語
 *
 * 会社の PC で鍵の割当・書式・紙面・編集の仕方を整えた。**家の PC でも同じ使い勝手に
 * したい。** ⚠ いまはバックアップ(`.pkc3.zip`)を取り込むしかなく、それだと
 * **データごと**移るので**家のノートが混ざる**。移したいのは見た目と使い勝手だけである。
 *
 * ## 🔴 **移す物は名指しである**(「端末側に在る物を全部」にしない)
 *
 * ⚠ 全部にすると、**お知らせの既読**や**アプリの許可**まで別の端末へ移る。
 * 許可は**その端末でその中身を見て許した**ものなので、移すと**意味が変わる**
 * (#195 の「許可は container に入れない」と同じ理屈)。
 *
 * ## 🔴 だから「移さない物」も名指しで持つ ── 理由つきで
 *
 * 🔑 **移す一覧だけを持つと、鍵が増えた日に「入れ忘れ」と「わざと入れない」が
 *   区別できない。** ⚠ そして入れ忘れは「**書き出したのに戻らない**」という
 *   **無言の欠落**として出る(誰も気づけない)。
 * 🔑 `tests/features/settings-file.test.ts` が **`src` の `pkc3.*` を全数で拾い、
 *   どちらの一覧にも無い鍵が在れば落とす** ── 次に鍵を足す人は、
 *   **どちらかに書くまで CI が通らない**。
 *
 * ⚠ **pure module**。`localStorage` も DOM も知らない(読み書きは adapter の仕事)。
 */
import { isColumnRule } from '@features/column-rule';
import { isEditorMode } from '@features/editor-mode';
import { resolveUsableBindings } from '@features/keymap';
import { isAppOpenTarget } from '@features/launcher/open-target';
import { isPasteSource } from '@features/markdown/paste-source';
import { parseMessageCap } from '@features/message/message-log';
import { isOpenPlace } from '@features/open-place';
import { isPageFormat } from '@features/page-format';
import { isPaneSizes } from '@features/pane-size';
import { isHiddenPanes } from '@features/pane-visibility';
import { isProseAlign } from '@features/prose-align';
import { isReadColumns } from '@features/read-columns';
import { SCHEDULE_LEAD_OPTIONS } from '@features/schedule/schedule-notify';
import { isTagBadge } from '@features/tag-badge';
import { isTextScale } from '@features/text-scale';

/** 1 件の設定。⚠ 値は保存されている**生の文字列**のまま運ぶ(解釈しない)。 */
export interface SettingsEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * 🔴 **移す鍵**(#414)。⚠ **見た目と使い勝手で、端末に依らない物だけ**。
 * ⚠ ここへ足すときは「別の端末で**同じ意味になるか**」を問う。
 */
export interface PortableKey {
  readonly key: string;
  readonly label: string;
  /**
   * 🔴 **この値を端末の読み手が読めるか**(#1087)。⚠ **読み手と同じ判定を渡す**(別に書き写さない)。
   *   無いと、読み手が既定へ丸める値(`pkc3.messages.cap` = `9999` など)も「入れました」と言ってしまう。
   *   読み手が features に無い鍵は、呼び側(adapter)が `planSettingsImport` の第 3 引数で渡す。
   */
  readonly valid?: (value: string) => boolean;
}

/**
 * 🔴 **入 / 切の鍵の検査**(#1087)。⚠ 書き手は `'1'` / `'0'` しか書かない。読み手は `=== '1'` か `!== '0'` で
 *   読むので、それ以外の字は「入れたのに別の意味に化ける」(`!== '0'` の読み手では `banana` が入になる)。
 */
const isOnOff = (v: string): boolean => v === '1' || v === '0';

function parsedJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** 鍵の割当の保存形(`KeymapStore.load` が読む形)── JSON のオブジェクト。 */
const isKeymapJson = (v: string): boolean => {
  const o = parsedJson(v);
  return typeof o === 'object' && o !== null && !Array.isArray(o);
};

/** 畳んでいるグループの名前の並び(`decodeFolded` が読む形)── 文字列の JSON 配列。 */
const isFoldedGroupsJson = (v: string): boolean => {
  const o = parsedJson(v);
  return Array.isArray(o) && o.every((x) => typeof x === 'string');
};

export const PORTABLE_KEYS: readonly PortableKey[] = [
  { key: 'pkc3.theme', label: '見た目' },
  { key: 'pkc3.panes', label: 'ペインの折りたたみ方', valid: isHiddenPanes },
  /**
   * ⚠ **畳み方と対**(#497)── 片方だけ運ぶと「畳んだのは移ったのに幅は既定」に
   * なる。⚠ px なので端末で意味が変わりそうに見えるが、値は
   * `clamp(0px, Npx, 45vw)` として当たるので**狭い端末では自分で縮む**
   * (`pkc3.text-scale` と同じ考え方 ── 使い方の好みは人に付く)。
   */
  { key: 'pkc3.pane-sizes', label: 'ペインの幅', valid: isPaneSizes },
  { key: 'pkc3.editor-mode', label: '編集の仕方', valid: (v) => isEditorMode(v) },
  { key: 'pkc3.open-in-edit', label: '「開く」で編集に入るか', valid: isOnOff },
  { key: 'pkc3.page-format', label: 'ページ設定', valid: (v) => isPageFormat(v) },
  /**
   * ⚠ **紙面と対**(#722、2026-09-08)── 片方だけ運ぶと「読み幅は移ったのに
   *   置き場所は既定」になる。⚠ 別の端末でも**同じ意味**になる
   *   (中央で読みたいか左端で読みたいかは**人に付く**)。
   */
  { key: 'pkc3.prose-align', label: '本文の置き場所', valid: (v) => isProseAlign(v) },
  // ⚠ 別の端末でも**同じ意味**になる(見づらいと感じる大きさは人に付く)── 移す
  { key: 'pkc3.text-scale', label: '文字の大きさ', valid: (v) => isTextScale(v) },
  { key: 'pkc3.read-columns', label: '本文の段組み', valid: (v) => isReadColumns(v) },
  // ⚠ 段組みと**対**(#525)── 片方だけ運ぶと「段組みは移ったのに線は既定」になる。
  //    見分けにくいと感じる濃さは**人に付く**(文字の大きさと同じ考え方)
  { key: 'pkc3.column-rule', label: '段の境界線', valid: (v) => isColumnRule(v) },
  { key: 'pkc3.tag-badge', label: '本文のタグの見せ方', valid: (v) => isTagBadge(v) },
  { key: 'pkc3.keymap', label: 'ショートカットキーの割り当て', valid: isKeymapJson },
  { key: 'pkc3.browse', label: '探し方のタブ' },
  { key: 'pkc3.dual-preview', label: '2 ペインのプレビュー', valid: isOnOff },
  { key: 'pkc3.paste-source', label: '貼り付けの判定', valid: (v) => isPasteSource(v) },
  { key: 'pkc3.query-key', label: '集計のグループ化' },
  { key: 'pkc3.alarm', label: '予定の時刻に知らせるか', valid: isOnOff },
  // ⚠ 予定の知らせの好み 2 つ(#855 20-C)。別の端末でも同じ意味になる(何分前に知らせたいかは人に付く)
  { key: 'pkc3.schedule-lead', label: '予定表を書き出すときの知らせる時間', valid: (v) => v.trim() !== '' && SCHEDULE_LEAD_OPTIONS.includes(Number(v)) },
  { key: 'pkc3.schedule-missed', label: '次に開いたとき見逃した予定を知らせるか', valid: isOnOff },
  // ⚠ 週の始まり(#1163 の依頼 191)。別の端末でも同じ意味になる(月曜から数えたいかは人に付く)
  { key: 'pkc3.schedule-week-start', label: '予定表の週の始まり', valid: (v) => v === '0' || v === '1' },
  /**
   * ⚠ **人に付く好み**である(#772 段① B)── 「声を聞き取りやすくしたい」かどうかは
   *   端末の事情ではなく、**聞く人の耳**に付く(`pkc3.alarm` と同じ考え方)。
   * ⚠ 運んだ先に音を整える仕組みが無くても**害が出ない** ── 整わずにそのまま鳴る
   *   だけで、鳴らなくなることはない。
   */
  { key: 'pkc3.voice-boost', label: '音を聞きやすくするか', valid: isOnOff },
  // ⚠ 同じ節の切り替え 2 つ(#952 B2・B3)。聞く人の耳に付く好みなので、`pkc3.voice-boost` と同じく運ぶ
  { key: 'pkc3.voice-level', label: '音量をそろえるか', valid: isOnOff },
  { key: 'pkc3.voice-crossfeed', label: '頭の中で鳴る感じを和らげるか', valid: isOnOff },
  /**
   * ⚠ 別の端末でも**同じ意味**になる(#826)── 「本文を見ながら選びたい」かどうかは
   *   **人に付く**好みである。⚠ 端末側の事情(ポップアップを止めている)で効かない回は
   *   その場で理由を出すので、移して害が出ない。
   */
  { key: 'pkc3.open-place', label: 'zip ファイルを開く場所', valid: (v) => isOpenPlace(v) },
  /**
   * ⚠ **人に付く好み**である(#884 段①)── 「アプリは別の窓で使いたい」かどうかは
   *   端末の事情ではない(`pkc3.open-place` と同じ考え方)。
   * ⚠ 端末側の事情で**そのとおりにならない回**はある ── 指で触る端末には窓が無いので、
   *   「別の窓」を選んでいてもブラウザがタブにする。🔑 それでも**運んで害が出ない**
   *   (元の挙動に落ちるだけで、user が何かを失わない)。
   */
  { key: 'pkc3.app-open-target', label: 'アプリの開き方', valid: (v) => isAppOpenTarget(v) },
  /**
   * ⚠ **人に付く好み**である(#278 段②)── 「本文の番号から掛けたい」かどうかは
   *   端末の事情ではない。⚠ 掛けられるかは端末しだいだが、**押せる字にするか**は
   *   読み方の好みなので運ぶ(`pkc3.alarm` と同じ考え方)。
   */
  { key: 'pkc3.phone-links', label: '本文の電話番号を押せるようにするか', valid: isOnOff },
  /**
   * ⚠ **人に付く好み**である(#1169)── 「本文の `@日付` を押してその日のノートを開きたい」
   *   かどうかは端末の事情ではない(`pkc3.phone-links` と同じ考え方)。
   * ⚠ 既定は**入**(`phone-links` と逆)なので、運ばれるのは**切にした人の `0`** が主になる。
   */
  { key: 'pkc3.date-links', label: '本文の日付を押せるようにするか', valid: isOnOff },
  /**
   * ⚠ **人に付く好み**である(#1225)── 日付の右に日数を見たいかは端末の事情ではない。
   *   既定は**入**なので、運ばれるのは**切にした人の `0`** が主になる。
   */
  { key: 'pkc3.relative-days', label: '本文の日付の右に今日からの日数を添えるか', valid: isOnOff },
  /**
   * ⚠ **人に付く好み**である(#1224)── 色コードの隣に見本を見たいかは端末の事情ではない。
   *   既定は**入**なので、運ばれるのは**切にした人の `0`** が主になる。
   */
  { key: 'pkc3.color-swatch', label: '本文の色コードの左に色の見本を出すか', valid: isOnOff },
  /**
   * ⚠ **人に付く好み**である(#1174 段①)── 「無いノートへのリンクに点線を見たいか」は
   *   端末の事情ではない。運んだ先に点線の仕組みが無くても**害が出ない**
   *   (印が出ないだけ)。
   */
  { key: 'pkc3.missing-links', label: 'リンク先が無いリンクを薄い字と点線で見せるか', valid: isOnOff },
  /**
   * ⚠ **人に付く好み**(#1087)── 「長いコード枠を最初から畳みたいか」は端末の事情ではない。
   *   運んだ先に仕組みが無くても害は出ない(畳まれないだけ)。
   */
  { key: 'pkc3.code-collapse', label: '長いコードブロックを最初から折りたたむか', valid: isOnOff },
  /** ⚠ **人に付く好み**(#1087)── 手が滑りやすいので切りたいかは端末ではなく人で決まる。 */
  { key: 'pkc3.inline-code-copy', label: '文中の短いコードを押すとコピーするか', valid: isOnOff },
  /** ⚠ **人に付く好み**(#1449 / #1450)── 打ちながら補完の候補を出したいかは端末ではなく人で決まる。 */
  { key: 'pkc3.inline-complete', label: '入力中に補完の候補を出すか', valid: isOnOff },
  /**
   * ⚠ **人に付く好み**(#275 段①)── PDF を PKC の画面で読みたいかは端末の事情ではない。
   *   既定は**切**なので、運ばれるのは**入にした人の `1`** が主になる。運んだ先に窓の仕組みが無くても
   *   **害が出ない**(ブラウザ内蔵の表示のままになるだけ)。
   */
  { key: 'pkc3.pdf-reader', label: 'PDF を PKC3 の PDF ビューアで開くか', valid: isOnOff },
  /**
   * ⚠ **`pkc3.panes`(列の畳み方)と同じ扱い**(#857 段④)── 「畳んでおきたい」は
   *   **人に付く**好みである。
   * 🔑 中身はグループの**名前**であって lid ではない ── だから `pkc3.split-lids`
   *   (運ばない)と違い、別の container へ運んでも**当たらないだけ**である
   *   (居ないノートを指す枠が復活する、が起きない)。`pkc3.query-key`
   *   (集計の束ね方 = 本文の鍵の名前)と同じ型である。
   */
  { key: 'pkc3.app-group-folded', label: 'アプリのグループの折りたたみ方', valid: isFoldedGroupsJson },
  /**
   * ⚠ **人に付く好み**である(設計 doc §7、段②a)── 「何件保管したいか」は
   *   端末の事情ではない。運んでも害は出ない(既定へ丸めて読むだけ)。
   */
  { key: 'pkc3.messages.cap', label: 'メッセージの保管件数', valid: (v) => parseMessageCap(v) !== null },
  /**
   * ⚠ **人に付く好み**である(#813 段②)── 「フォルダの面で下の階層まで平らに見たいか」は
   *   端末の事情ではない(`pkc3.dual-preview` と同じ考え方)。🔑 中身は `0` / `1` だけで、
   *   lid を持たない ── 別の container へ運んでも「居ないノートを指す」が起きない。
   */
  { key: 'pkc3.filer-flatten', label: 'フォルダのタブで下の階層まで全部出すか', valid: isOnOff },
];

/**
 * 🔴 **わざと移さない鍵と、その理由**(#414)。
 *
 * ⚠ **理由を書かない行を足さない** ── 理由が無いと、次に読む人が
 *   「入れ忘れでは?」と考え直すところから始める(CLAUDE.md「戒めには
 *   何のための禁止かを書く」)。
 */
export const SKIPPED_KEYS: readonly { readonly key: string; readonly why: string }[] = [
  {
    key: 'pkc3.capture-accepted',
    why: '設定ではない(#1087)。取り込みのブックマークで開いたそのタブが、もう 1 件受け取ったという記録(sessionStorage)。タブを閉じれば消える一時の事実で、運ぶ物は無い',
  },
  {
    key: 'pkc3.settings-probe',
    why: '設定ではない(#1087)。この端末が設定を保存できるかを確かめるために書いて、すぐ消す値。残ることは無く、運ぶ物も無い',
  },
  {
    key: 'pkc3.schedule-last-open',
    why: 'この端末でコレクションを最後に開いていた時刻(#855 20-C)。コレクションごとの id で持つ端末の事実なので、運ぶと別の端末の「見逃した」を間違えて数える',
  },
  {
    key: 'pkc3.split-lids',
    why: '中身が ID そのもの(#505 段②)。別の端末・別のコレクションへ運ぶと、そこにいないノートを指す枠が復活する。並べ方は運べても「どのノートか」は運べない',
  },
  {
    key: 'pkc3.flags',
    why: 'フラグは設定ではない(最大 15 個 + 廃止する条件の宣言 + フラグ画面という別の機構)。運ぶと、廃止する条件が違う別の端末へ持ち込むことになる',
  },
  {
    key: 'pkc3.copy.history',
    why: 'コピーした物である。その端末で、いま貼りたい物。別の端末へ運ぶ物でも、誰かに渡す物でもない(#678)',
  },
  {
    key: 'pkc3.opened',
    why: '中身が ID そのもの(#215 残り①)。別のコレクションへ運ぶと、そこにいないノートを「最近開いた」に並べる。そのうえ「何を読んでいたか」は設定ではなく行動の記録なので、渡す物でもない',
  },
  {
    key: 'pkc3.search-history',
    why: '探した語は行動の記録であって設定ではない(#1172)。何を探していたかは、設定ファイルを渡した相手に見せる物でも、別の端末へ持ち込む物でもない',
  },
  {
    key: 'pkc3.saved-searches',
    why: '保存した検索は探した語の記録であって設定ではない(#1038 C1)。何を探していたかは、設定ファイルを渡した相手に見せる物でも、別の端末へ持ち込む物でもない(最近探した語と同じ判断)',
  },
  {
    key: 'pkc3.recent-commands',
    why: '最後に実行した操作の記録であって設定ではない(#274)。左の探す欄の `>` の一覧から何を使ったかは、設定ファイルを渡した相手に見せる物でも、別の端末へ持ち込む物でもない',
  },
  {
    key: 'pkc3.create-kind',
    why: '好みの設定ではなく最後の操作の記録である(#1045)。▼ で選んだ「作る種類」は、その端末でその場で選んだ事実にすぎない。別の端末へ運ぶと、そこで選んだことのない種類が最初から選ばれた状態になる',
  },
  {
    key: 'pkc3.entry-sort',
    why: '好みの設定ではなく最後の操作の記録である(依頼 82-3)。一覧で最後に選んだ並び順は、その端末でその場で選んだ事実にすぎない。別の端末へ運ぶと、そこの一覧の並びが勝手に変わる',
  },
  {
    key: 'pkc3.list-place',
    why: '好みの設定ではなく最後の操作の記録である(依頼 277)。左の一覧で最後に開いていたフォルダと選んでいた種類の絞りは、その端末でその場で選んだ事実にすぎない。中身はそのコレクションのノートの ID なので、別の端末へ運んでも指す先が無い',
  },
  {
    key: 'pkc3.pc-folder-place',
    why: '好みの設定ではなく最後の操作の記録である(#215)。PC タブで最後に開いていたフォルダ名の並びは、その端末のフォルダ構成の事実にすぎない。別の端末へ運んでも同じ名前のフォルダがあるとは限らず、フォルダの場所を人に渡す物でもない',
  },
  {
    key: 'pkc3.external-images',
    why: '許可である。その端末でその中身を見て許したもの',
  },
  {
    key: 'pkc3.extension-grants',
    why: '許可である。その端末でその相手を見て許したもの',
  },
  {
    key: 'pkc3.agent-grants',
    why: '許可である。その端末でブラウザの AI に許したもの(書き出して渡すと、相手の端末でも「AI に読ませてよい」が立ってしまう)',
  },
  {
    key: 'pkc3.agent-origin-grants',
    why: '許可である。その端末で、組み込み先のページの AI に許したもの(書き出して渡すと、相手の端末でも「そのページの AI に読ませてよい」が立ってしまう)',
  },
  {
    key: 'pkc3.same-origin-grants',
    why: '許可である。その端末でその相手を見て許したもの',
  },
  {
    key: 'pkc3.embed-origins',
    why: '許可である。その端末でその相手を見て許したもの',
  },
  {
    key: 'pkc3.notices.seen',
    why: '既読はその端末で読んだ事実。運ぶと、別の端末でまだ読んでいないお知らせが消える',
  },
  {
    key: 'pkc3.notices.off',
    why: 'お知らせを止めたかどうかは、その端末での選択である',
  },
  {
    key: 'pkc3.too-narrow-ok',
    why: '狭い画面の断り書きに OK を押したのは、その端末の画面幅を見て押した事実。別の端末では幅が違う(#687 E-1)',
  },
  {
    key: 'pkc3.popup-hint-shown',
    why: '外部リンクを初めて押したときの案内を、その端末で見せた事実(依頼 69-B2)。別の端末では、まだ見ていないことがある',
  },
  {
    key: 'pkc3.dual-bookmarks',
    why: 'ID を持つ。別の端末では別のノートを指す(あるいはどこも指さない)',
  },
  {
    key: 'pkc3.timer-runs',
    why: '計っている途中の時刻(台帳 #1852 O1 / 依頼 240)。ID を持ち、リロードした同じタブが続きを計るための一時の事実なので、運ぶ物は無い',
  },
  {
    key: 'pkc3.timer-beats',
    why: '計っている途中のタブが「まだ動いている / 閉じた」を残す時刻(依頼 75-1)。閉じられたタブの計測を見分けるための一時の事実で、運ぶ物は無い',
  },
  {
    key: 'pkc3.tab-id',
    why: '設定ではない(依頼 240)。このタブを見分ける番号(sessionStorage)。タブを閉じれば消える一時の事実で、運ぶ物は無い',
  },
  {
    key: 'pkc3.app.storage',
    why: '保存のキーではない。組み込みアプリとのやりとりに使う合図の名前',
  },
  {
    key: 'pkc3.ext.port',
    why: '保存のキーではない。拡張とのやりとりに使う合図の名前',
  },
  {
    key: 'pkc3.opened-by-us',
    why: 'そのウィンドウ 1 枚だけの事実(付箋として開いたか)。`sessionStorage` にあり、運ぶ物ではない',
  },
  {
    key: 'pkc3.messages.read-at',
    why: '既読はその端末で読んだ事実(設計 doc §7、段②a)。pkc3.notices.seen と同じ考え方。運ぶと、別の端末でまだ読んでいないメッセージが既読に化ける',
  },
  {
    key: 'pkc3.notices.delivered',
    why: '「配信」としてメッセージへ流したかの記録(設計 doc §7、段②b)。その端末での事実。運ぶと、別の端末でまだ配信していないお知らせが配信済みに化ける',
  },
];

/** 書き出す形の目印。⚠ 版が変わっても**読めるところまでは読む**(下の注記)。 */
export const SETTINGS_FILE_KIND = 'pkc3-settings';
export const SETTINGS_FILE_VERSION = 1;

/** 1 件の値の上限。⚠ **手違いの検出**(壊れた保存を運ばない)。 */
export const MAX_SETTING_CHARS = 64_000;

export interface SettingsFile {
  readonly kind: string;
  readonly version: number;
  readonly entries: readonly SettingsEntry[];
  /**
   * 🔴 **書き出した端末で「標準」のままだった設定の鍵**(依頼 207。Gemini 裁定 = 推薦 A)。
   *
   * > 画面の物語:会社の PC が文字の大きさ「標準」、家の PC が「特大」のとき、会社の設定を書き出して家で取り込むと、
   * > 文字は「特大」のまま残った。取り込みの画面も、そのことを言わなかった。
   *
   * ⚠ 値は載せない ── 「標準」の綴りは項目ごとに違い(鍵ごと消える物・`0` の物)、**消す**のが「標準に戻す」の実体である。
   *   取り込む側は、ここに在る鍵を**標準に戻す**(`entries` に在る鍵は、そちらを優先する)。
   * ⚠ 省略できる(古い版が書いた file には無い)。無いときは従来どおり「こちらの設定がそのまま残る」。
   */
  readonly defaults?: readonly string[];
}

/** 書き出す。⚠ **無い鍵は入れない**(空文字と「設定していない」を混ぜない)。 */
export function buildSettingsFile(read: (key: string) => string | null): SettingsFile {
  const entries: SettingsEntry[] = [];
  for (const { key } of PORTABLE_KEYS) {
    const value = read(key);
    if (value === null || value === '') continue;
    if (value.length > MAX_SETTING_CHARS) continue;
    entries.push({ key, value });
  }
  // 🔴 標準のままの鍵も運ぶ(依頼 207)。⚠ 長すぎて落とした値は「標準」ではない ── 取り込み先を標準に戻してしまうので入れない
  const defaults: string[] = [];
  for (const { key } of PORTABLE_KEYS) {
    const value = read(key);
    if (value === null || value === '') defaults.push(key);
  }
  return { kind: SETTINGS_FILE_KIND, version: SETTINGS_FILE_VERSION, entries, defaults };
}

/**
 * 🔴 **長すぎて書き出しに入らない設定の名前**(#1087)。
 * ⚠ `buildSettingsFile` は 1 件 `MAX_SETTING_CHARS` 字を超える値を落とす ── 落としたことを言わないと、
 *   user は「全部持ち出した」と思い、別の端末で入れたときに初めて気づく。呼び側がこの名前を知らせる。
 */
export function settingsTooLongToExport(read: (key: string) => string | null): string[] {
  const out: string[] = [];
  for (const { key, label } of PORTABLE_KEYS) {
    const value = read(key);
    if (value !== null && value.length > MAX_SETTING_CHARS) out.push(label);
  }
  return out;
}

/**
 * 🔴 **当てた結果の 1 行**(#1087)。⚠ 書けなかった件数を言う ── 直す前は書けた件数だけを言い、
 *   全部書けなかったとき(私用ウィンドウ・容量の上限)も「0 件入れました」と成功と同じ形だった。
 */
export function settingsAppliedNote(wrote: number, failed: number): string {
  // 🔴 配色・文字の大きさ・ページ設定などの見た目は取り込んだこのタブにも**すぐ**当たる(依頼 312)。それ以外は起動時に読むので再読み込みが要る
  const head = `設定を ${String(wrote)} 件入れました(配色・文字の大きさ・ページ設定などの見た目はすぐ変わります。ほかの項目は再読み込みしてから出ます)`;
  if (failed === 0) return head;
  return `${head}。${String(failed)} 件はこの端末に保存できず、入っていません(ブラウザの保存領域がいっぱいか、保存を止める設定になっています)`;
}

/**
 * 落とす file の名前。⚠ **日付を入れる**(2 つ持っていてもどちらが新しいか分かる)。
 *
 * ⚠ **器の題名は入れない** ── `AppState` は器の題名を持っていない(`cid` だけ)。
 *   🔑 埋められない引数を口に残すと、呼び側が毎回 `''` を渡す**嘘の引数**になる
 *   (CLAUDE.md「計器の名前が、見ている範囲と違う」の API 版)。
 */
export function settingsFileName(today: string): string {
  return `PKC3-settings-${today}.json`;
}

/**
 * 読み込んだ物の中身。
 *
 * 🔴 **「変わるもの」と「知らない鍵」を分ける** ── 前者は当てる前に見せ、
 *   後者は**件数を言う**(黙って捨てない ── 版が違う設定ファイルを読んだとき、
 *   user は「全部入った」と思ってしまう)。
 */
export interface SettingsPlan {
  /** 当てると変わるもの(いまの値と違う)。 */
  readonly changes: readonly {
    readonly key: string;
    readonly label: string;
    readonly from: string | null;
    /** `null` = 標準に戻す(依頼 207。書き出した側で標準のままだった項目)。 */
    readonly to: string | null;
  }[];
  /** 読めたが、いまと同じだったもの。 */
  readonly same: number;
  /** 🔴 **移さないと決めている鍵**が入っていた(古い版 / 手で足した)。 */
  readonly refused: readonly string[];
  /** 🔴 **こちらが知らない鍵**(新しい版で書かれた)。 */
  readonly unknown: readonly string[];
  /** 🔴 **長すぎて入れない鍵**(1 件 `MAX_SETTING_CHARS` 字を超える)。黙って捨てない(#1087)。 */
  readonly tooLong: readonly string[];
  /**
   * 🔴 **値が文字列でない / 空の鍵**(#1087)。書き出しは空の値を入れない(`exportSettings`)ので、
   *   読み込み側で通すと、端末の設定を空の字で上書きして消していた(キーの割り当てが全部消える)。
   */
  readonly unreadable: readonly string[];
  /**
   * 🔴 **読み込んでも使えないキーの割り当て**の件数(#1087)。割り当てるときと同じ検査(素のキー・
   * 再読込などブラウザの鍵・同じ場所で効く操作との重なり)を通らなかった物。入ることは入るが、使われない。
   */
  readonly unusableBindings: number;
  /**
   * 🔴 **ショートカットキーの割り当ては、全体が置き換わる**(1 つずつ足されない)ので、その件数(#1087)。
   * `from` = いま変えてある割り当ての件数、`to` = ファイルの件数。割り当てが変わらない回は `null`。
   */
  readonly keymapReplace: { readonly from: number; readonly to: number } | null;
  /** 🔴 ファイルが「標準のままの項目」を持っていたか(依頼 207)。古い版の file は持たない。 */
  readonly defaultsIncluded: boolean;
  /** 読めなかった理由。`null` なら読めた。 */
  readonly error: string | null;
}

const EMPTY_PLAN: SettingsPlan = {
  changes: [],
  same: 0,
  refused: [],
  unknown: [],
  tooLong: [],
  unreadable: [],
  unusableBindings: 0,
  keymapReplace: null,
  defaultsIncluded: false,
  error: null,
};

const KEYMAP_KEY = 'pkc3.keymap';

/** キー割り当ての保存の値(JSON)の、変えてある割り当ての件数(コマンド単位)。無い・読めない値は 0 件。 */
function countOverriddenBindings(value: string | null): number {
  if (value === null) return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 0;
    return Object.values(parsed as Record<string, unknown>).filter((v) => Array.isArray(v)).length;
  } catch {
    return 0;
  }
}

/** キー割り当ての保存の値(JSON)のうち、使えない割り当ての件数。読めない値は 0 件。 */
function countUnusableBindings(value: string): number {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 0;
    return resolveUsableBindings(parsed as Record<string, unknown>).unusable.length;
  } catch {
    return 0;
  }
}

/**
 * 読んだ JSON を「何が変わるか」に直す。
 *
 * ⚠ **当てない。見せるだけ** ── 当てるのは呼び側(user が押してから)。
 * ⚠ **知らない鍵で止めない** ── 読めるところまで読んで、残りは件数で言う
 *   (新しい版の設定を古い版で読んだとき、**全部拒むほうが害が大きい**)。
 */
export function planSettingsImport(
  text: string,
  read: (key: string) => string | null,
  /** 🔴 読み手が adapter にある鍵の検査(`PortableKey.valid` と同じ働き。例:配色)。 */
  extraValid: Readonly<Record<string, (value: string) => boolean>> = {},
): SettingsPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY_PLAN, error: '設定ファイルとして読めませんでした' };
  }
  if (typeof raw !== 'object' || raw === null)
    return { ...EMPTY_PLAN, error: '設定ファイルとして読めませんでした' };
  const o = raw as Record<string, unknown>;
  if (o['kind'] !== SETTINGS_FILE_KIND)
    return {
      ...EMPTY_PLAN,
      error: 'これは PKC3 の設定ファイルではありません(バックアップの取り込みは左下です)',
    };
  // 🔴 kind は合っているのに中身の形が違う file(entries が配列でない)を「変わるものはありません」と読ませない(#1087)
  if (!Array.isArray(o['entries']))
    return { ...EMPTY_PLAN, error: '設定ファイルとして読めませんでした(中身が読めない形です)' };
  const list: unknown[] = o['entries'];
  const labelOf = new Map(PORTABLE_KEYS.map((p) => [p.key, p.label]));
  const portable = new Map(PORTABLE_KEYS.map((p) => [p.key, p]));
  const skipped = new Set(SKIPPED_KEYS.map((s) => s.key));
  const changes: { key: string; label: string; from: string | null; to: string | null }[] = [];
  const refused: string[] = [];
  const unknown: string[] = [];
  const tooLong: string[] = [];
  const unreadable: string[] = [];
  let same = 0;
  let unusableBindings = 0;
  let keymapReplace: { from: number; to: number } | null = null;
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const key = typeof e['key'] === 'string' ? e['key'] : '';
    const value = typeof e['value'] === 'string' ? e['value'] : '';
    // ⚠ 同じ鍵が 2 度書いてあっても 1 度しか数えない(後勝ちにしない ── 先を採る)
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (value === '') {
      unreadable.push(key);
      continue;
    }
    if (value.length > MAX_SETTING_CHARS) {
      tooLong.push(key);
      continue;
    }
    if (skipped.has(key)) {
      refused.push(key);
      continue;
    }
    const label = labelOf.get(key);
    if (label === undefined) {
      unknown.push(key);
      continue;
    }
    // 🔴 端末の読み手が読めない値は入れない(読み手は既定へ丸めるので、「入れました」が偽になる。#1087)
    const valid = portable.get(key)?.valid ?? extraValid[key];
    if (valid !== undefined && !valid(value)) {
      unreadable.push(key);
      continue;
    }
    const from = read(key);
    if (from === value) {
      same += 1;
      continue;
    }
    changes.push({ key, label, from, to: value });
    if (key === KEYMAP_KEY) {
      unusableBindings += countUnusableBindings(value);
      keymapReplace = { from: countOverriddenBindings(from), to: countOverriddenBindings(value) };
    }
  }
  /**
   * 🔴 **書き出した側で標準のままだった項目は、こちらも標準に戻す**(依頼 207)。
   * ⚠ ファイルの `entries` に在る鍵は上で扱い済み(`seen`)── そちらを優先する。
   * ⚠ こちらが元から標準(値が無い)なら変わらないので、変更に数えない。
   */
  const defaultsRaw = o['defaults'];
  const defaultsIncluded = Array.isArray(defaultsRaw);
  if (Array.isArray(defaultsRaw)) {
    for (const k of defaultsRaw as unknown[]) {
      if (typeof k !== 'string' || seen.has(k)) continue;
      const label = labelOf.get(k);
      if (label === undefined) continue; // 移す鍵でない物はここでは扱わない(消してよい物は名指しの一覧だけ)
      seen.add(k);
      const from = read(k);
      if (from === null || from === '') continue;
      changes.push({ key: k, label, from, to: null });
      if (k === KEYMAP_KEY) keymapReplace = { from: countOverriddenBindings(from), to: 0 };
    }
  }
  return {
    changes,
    same,
    refused,
    unknown,
    tooLong,
    unreadable,
    unusableBindings,
    keymapReplace,
    defaultsIncluded,
    error: null,
  };
}

/**
 * 下見の 1 行。⚠ **中身(値)は出さない** ── 鍵の割当は長く、紙面は JSON である。
 *   出しても読めないので、**何が変わるか**だけを言う。
 */
export function settingsChangeText(c: {
  readonly label: string;
  readonly from: string | null;
  readonly to?: string | null;
}): string {
  if (c.to === null) return `${c.label} を標準に戻します`;
  return c.from === null ? `${c.label} を設定します` : `${c.label} を入れ替えます`;
}

/** 下見のまとめ。⚠ **0 件でもそう言う**(押しても何も起きない理由を出す)。 */
export function settingsPlanNote(plan: SettingsPlan): string {
  if (plan.error !== null) return plan.error;
  const parts: string[] = [];
  parts.push(
    plan.changes.length === 0 ? '変わるものはありません' : `${plan.changes.length} 件が変わります`,
  );
  if (plan.same > 0) parts.push(`${plan.same} 件はいまと同じです`);
  // 🔴 **黙って捨てない**(版が違う設定ファイルを読んだとき、全部入ったと思われる)
  if (plan.refused.length > 0)
    parts.push(`${plan.refused.length} 件はこの端末だけで使う記録(許可・フラグ・お知らせの既読・履歴など)なので入れません`);
  if (plan.unknown.length > 0)
    parts.push(`${plan.unknown.length} 件はこのバージョンが知らない設定なので入れません`);
  if (plan.unreadable.length > 0)
    parts.push(`${plan.unreadable.length} 件は中身が空か読めない形なので入れません`);
  if (plan.tooLong.length > 0)
    parts.push(`${plan.tooLong.length} 件は長すぎるので入れません(1 件 ${MAX_SETTING_CHARS.toLocaleString('en-US')} 字まで)`);
  // 🔴 割り当ては**全体が置き換わる**(ファイルに無い割り当ては、いまのものも消える)── 件数で言う(#1087)
  if (plan.keymapReplace !== null)
    parts.push(
      `ショートカットキーの割り当ては、いま変えてある割り当て ${plan.keymapReplace.from} 件が、ファイルの ${plan.keymapReplace.to} 件に置き換わります`,
    );
  if (plan.unusableBindings > 0)
    parts.push(
      `ショートカットキーの割り当てのうち ${plan.unusableBindings} 件は、ブラウザが使うキーや他の操作とぶつかるため、入れても使われません`,
    );
  // 🔴 標準のままだった項目は、ファイルが運んでいれば標準に戻る(依頼 207)/ 古い版のファイルは運ばない ── こちらの設定が残る(#1087)
  if (!plan.defaultsIncluded)
    parts.push('このファイルには、書き出した側で標準のままだった項目が入っていません。その項目は、こちらの設定がそのまま残ります');
  return `${parts.join('。')}。`;
}

/** 当ててよいか。⚠ 変わるものが 1 件も無ければ押せない(空押しを作らない)。 */
export const canApplySettings = (plan: SettingsPlan): boolean =>
  plan.error === null && plan.changes.length > 0;
