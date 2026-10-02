/**
 * 🔴 **画面いちばん下の行の先頭に「いま何をしているか」の 1 語を出す**
 * (C4 / #1038 台帳③ 段 D。設計 `docs/development/touch-and-unity-design-2026-09.md`
 * §1 P3 / §11 Q2 の裁定 A)。
 *
 * ## 何が変わるか
 *
 * PKC2 は画面の左上に、読んでいるだけか編集しているかを常に一言で出していた
 * (証拠は設計 doc §1.1 P3)。PKC3 は言わずに部品(書式のボタン・追記欄の注意文)を
 * 増やして示していた ── user 指示 2026-08-15「中央の上を潰しすぎ / ボタンがボタン
 * すぎる」と同じ根である。
 *
 * 🔑 **状態を言う場所は 1 つ**(#1017 §3.1「ステータスバー = いま起きていること」)。
 * だから状態の 1 語も、既存のステータスバーの合成へ**先頭**として差し込む。
 *
 * ## ⚠ 保存に失敗して止まったときは、新しい語を作らない
 *
 * 「編集中」に対応する短い語が error phase には無い(止まっている理由が一様でない)。
 * `blockedActionNote('error')` は既に C11(#1045)で 1 か所へ寄せた断り文なので、
 * **そのまま**先頭語として使う ── 新しい言い回しを増やすと、右の列の上の 1 行と
 * 画面の下の 1 行で**また 2 通りの字**に戻る(CLAUDE.md §7「同じ値が複数の場所」)。
 *
 * ## ⚠ なぜ main.ts に書かないか
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)。判断はここに置き、
 * `main.ts` は値を渡すだけにする(`storage-notice.ts` / `status-open.ts` と同じ作法)。
 */
import { blockedActionNote, type AppPhase } from '@adapter/state/app-state';

/**
 * 編集中の状態語。⚠ **追記欄の注意文と同じ字**にする ── 中央のステータスバーと
 * 追記欄が別の言葉で「編集中」を言うと、user は別の状態だと読む
 * (`append-box.ts` がここから import する)。
 */
export const EDITING_STATE_WORD = '編集中';

/**
 * phase から、ステータスバーの先頭に出す語を決める。
 *
 * | phase | 語 |
 * |---|---|
 * | `editing` | `EDITING_STATE_WORD`(短い語 ── 編集はいちばん頻度が高い状態なので、
 * |            | 専用の短い言い方を持つ価値がある)|
 * | `error` | `blockedActionNote('error')` の全文(短い語を作らず、既存の断り文をそのまま)|
 * | `ready` / `initializing` | `''`(読んでいるだけのときは今までどおり ── 何も言わない)|
 *
 * ⚠ **`editing` でも `blockedActionNote(phase)` を呼び直さない** ── あちらは
 * 「押せない理由」(`EDITING_NOTE` の長い文)であって、ここが要るのは状態を指す
 * 短い語である。同じ字を求めているわけではない。
 */
export function editingStateWord(phase: AppPhase): string {
  if (phase === 'editing') return EDITING_STATE_WORD;
  if (phase === 'error') return blockedActionNote('error') ?? '';
  return '';
}

/** `composeStatusLine` への入力。⚠ **状態語以外は main.ts が組んだ字のまま**渡す。 */
export interface StatusLineParts {
  readonly phase: AppPhase;
  /** 保存先の注意(`storage-notice.ts`)。 */
  readonly statusBase: string;
  /** 複数タブ / follower のバッジ。 */
  readonly sync: string;
  readonly portableAssetNote: string;
  readonly persistState: string;
  /** `SavingIndicator.line()`。 */
  readonly savingLine: string;
  /** 一時の知らせ(コピーした・取り込んだ)。 */
  readonly noticeLine: string;
  readonly errorLine: string;
}

/**
 * 🔴 **ステータスバーの 1 行を組む**(`main.ts` の `paint` から取り出した)。
 *
 * ⚠ 順は**状態語が先頭**(見本 3「編集中 — 保存先の注意 …」)。並びそのものは
 * 直す前と同じ(状態語を足しただけ)── 優先順位は変えていない。
 */
export function composeStatusLine(parts: StatusLineParts): string {
  return [
    editingStateWord(parts.phase),
    parts.statusBase,
    parts.sync,
    parts.portableAssetNote,
    parts.persistState,
    parts.savingLine,
    parts.noticeLine,
    parts.errorLine,
  ]
    .filter((t) => t !== '')
    .join(' — ');
}

/**
 * 🔴 **読み上げの対象になる子の印**(#1017 C5 着地後レビュー ⚠1)。
 * `shell.ts` が `aria-live` つきで作り、`paintStatusText` が**同じ要素を使い続ける**。
 */
export const STATUS_LIVE_FIELD = 'status-live';

/** 読み上げの子を作る(`shell.ts` と `paintStatusText` の 2 か所が同じ形で作る ── 形はここが正本)。 */
export function createStatusLive(doc: Document): HTMLElement {
  const live = doc.createElement('span');
  live.setAttribute('data-pkc-field', STATUS_LIVE_FIELD);
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  return live;
}

/**
 * 🔴 **状態の 1 語だけを別の器に入れて描く**(#1038 台帳③ C4 の着地前レビュー)。
 *
 * ⚠ 1 稿目は行全体を 1 つの字として出していた ──「編集中」が「複数タブ: …」のような
 *   控えめな知らせと**同じ色・同じ大きさ**で並び、user 目線のレビューが
 *   「気づかれない字は無いのと同じ」と指摘した(設計 doc §9「気づきにくければ色を付ける」)。
 * 🔑 付けるのは色相ではなく**濃さ**(本文と同じ濃い字 + 太字)── 主のボタンと同じ
 *   「色ではなく濃さで段を作る」(user 裁定 2026-09-06)。保存に失敗して止まったときだけ
 *   危険の赤(CSS の `[data-pkc-phase='error']`)。
 * ⚠ 行の字(`textContent`)は `composeStatusLine` と**1 字も変わらない** ── 字を読む
 *   受け手(smoke・状態の比較)はそのまま動く。
 *
 * 🔴 **読み上げに載せるのは「知らせ」と「エラー」だけ**(#1017 C5 着地後レビュー ⚠1)。
 * ⚠ 1 稿目は footer 全体に `aria-live` を付けたので、状態語・保存先の注意・`⏳ 保存中…` の
 *   出入りのたびに読み上げが起きた(ここが毎回子を作り直すので、`aria-atomic=false` でも
 *   全部が「追加」に見える)。🔑 だから**知らせとエラーを写す子 1 つ**(`status-live`)だけに
 *   `aria-live` を付け、その外(状態語・保存先・保存中)は読み上げの外に置く。
 * ⚠ **その子は作り直さない** ── 外して付け直すと、読み上げの対象として登録される前の
 *   要素に字が入った形になり、読まれないことがある。字が**変わったときだけ**書く。
 *
 * @returns 描いた行の字(`composeStatusLine` と同じ値)
 */
export function paintStatusText(el: HTMLElement, parts: StatusLineParts): string {
  const text = composeStatusLine(parts);
  const word = editingStateWord(parts.phase);
  const doc = el.ownerDocument;
  // 読み上げに載せる尾 = 行の末尾(知らせ + エラー)。⚠ 区切りの ' — ' は頭の側に置く
  const liveText = [parts.noticeLine, parts.errorLine].filter((t) => t !== '').join(' — ');
  const head = text.slice(0, text.length - liveText.length);

  let live: HTMLElement | null = null;
  for (const c of Array.from(el.children)) {
    if (c.getAttribute('data-pkc-field') === STATUS_LIVE_FIELD) live = c as HTMLElement;
  }
  if (live === null) {
    live = createStatusLive(doc);
    el.append(live);
  }
  // 🔑 live 以外を消す(live 自体は触らない ── 登録済みの要素を作り直さない)
  for (const c of Array.from(el.childNodes)) if (c !== live) c.remove();
  if (word !== '') {
    const state = doc.createElement('span');
    state.setAttribute('data-pkc-field', 'status-state');
    state.setAttribute('data-pkc-phase', parts.phase);
    state.textContent = word;
    el.insertBefore(state, live);
    const rest = head.slice(word.length);
    if (rest !== '') el.insertBefore(doc.createTextNode(rest), live);
  } else if (head !== '') {
    el.insertBefore(doc.createTextNode(head), live);
  }
  if (live.textContent !== liveText) live.textContent = liveText;
  return text;
}

/**
 * 🔴 **ステータスバーの行を畳むかどうかを判定する**(#1071、#671 の裁定 3)。
 *
 * 以下のいずれかに当てはまる場合は、行のテキストが空でも畳まず表示する（hidden = false）:
 * 1. 画面幅不足の断り書きが出ている（`hasTooNarrow === true`）── #671
 * 2. 未読メッセージが 1 件以上ある（`hasUnreadMessages === true`）── #1071
 *
 * それ以外は、行のテキスト（`text === ''`）が空であれば畳む（hidden = true）。
 */
export function shouldHideStatusBar(options: {
  readonly text: string;
  readonly hasTooNarrow: boolean;
  readonly hasUnreadMessages: boolean;
}): boolean {
  if (options.hasTooNarrow) return false;
  if (options.hasUnreadMessages) return false;
  return options.text === '';
}

