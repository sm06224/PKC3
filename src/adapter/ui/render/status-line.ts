/**
 * 🔴 **「いまの状態」と「一時の知らせ」を 1 か所で決める**(旧「ステータスバーの 1 行」の組み立て。
 * 画面いちばん下の常設の帯は無くなった ── user 指示 2026-11-23「最下段のステータスメッセージが表示されると
 * 非常に見にくい上に消すことも叶わないため邪魔」)。
 *
 * - **いまの状態**(編集中 / 保存先の注意 / 複数タブ / 同期 / 保存中 …)= `StatusModel.state`。左のバーの
 *   「メッセージ」ボタン(バッジ・説明)と、その簡易履歴(ポップオーバー)の「いまの状態」に出す。
 * - **一時の知らせ**(結果・注意・エラー・進行中)= `StatusModel.toast`。消せる浮き札(トースト)に出す。
 * - 読み上げ = `StatusModel.live`(知らせとエラーだけ。常設の見えない領域へ書く)。
 *
 * ## 元の設計(C4 / #1038 台帳③ 段 D。`docs/development/touch-and-unity-design-2026-09.md` §1 P3 / §11 Q2)
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
import { isCorruptRefusalLine } from '@features/storage/db-corruption';

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
  /**
   * 🔴 **保存先の注意が「実害のある警告」か**(#1038 D1。保存領域が使えず閉じると消えるとき)。
   * ⚠ 省略 = 控えめな知らせ。立てると、状態の 1 件(`kind: 'storage'`)が `severe` になり、
   *   メッセージのボタンのバッジが危険色になる(ポップオーバーの「いまの状態」は字を危険色 + 太字にする)。
   */
  readonly statusBaseSevere?: boolean;
  /** 複数タブ / follower のバッジ。 */
  readonly sync: string;
  /**
   * 🔴 **フォルダとの同期の「いまの状態」**(「同期しています…」「最終同期 HH:MM」「同期が止まっています」。#1455)。
   * ⚠ 状態だけ ── 結果・失敗・消えたノートの知らせはメッセージ(システムのノート)へ送る(CLAUDE.md §2-3)。空 = 出さない。
   */
  readonly folderSyncLine?: string;
  readonly portableAssetNote: string;
  readonly persistState: string;
  /** `SavingIndicator.line()`。 */
  readonly savingLine: string;
  /**
   * 🔴 **全体の処理の進行中**(書き出し・取り込み・切り出し・文字起こし等。#1017 C5 Q3)。
   * ⚠ 知らせ(`noticeLine`)とは**別の欄** ── 進行中は結果の知らせで置き換わらず、
   *   終わりの合図で空になる。読み上げの対象にはならない(`status-live` は知らせとエラーだけ)。
   */
  readonly progressLine: string;
  /** 一時の知らせ(コピーした・取り込んだ)。 */
  readonly noticeLine: string;
  readonly errorLine: string;
  /** 外からファイルを掴んで窓に入っている間の字(#1380。空 = 出さない)。 */
  readonly fileDragLine?: string;
  /**
   * 🔴 **実害のある保存先の警告を、浮き札に常設で出す**(2026-11-23 レビュー。14px の赤い「!」だけでは見落とす)。
   * ⚠ 時間で消えない。× で閉じるのは**そのセッションの間だけ**(`ToastDismissal`。次の起動でまた出る)。空 = 出さない。
   */
  readonly severeToastLine?: string;
}


/** 「いまの状態」の 1 件の種類。⚠ 並びは `composeStatusModel` が決める(画面の並びの正本)。 */
export type StateItemKind = 'editing' | 'storage' | 'sync' | 'folder-sync' | 'portable' | 'persist' | 'saving';

/** 「いまの状態」の 1 件。`severe` = 閉じると消える等の実害のある警告(危険色)。 */
export interface StateItem {
  readonly kind: StateItemKind;
  readonly text: string;
  readonly severe: boolean;
  /** `editing` のときだけ: その phase(エラーで止まったときは危険色に使う)。 */
  readonly phase?: AppPhase;
}

/**
 * 🔴 **画面に何を出すかを決める唯一の関数**(旧 `composeStatusLine` / `statusBarWithFileDrag` の後継)。
 *
 * | 欄 | 出し先 |
 * |---|---|
 * | `state` | メッセージのボタン(バッジ・説明)と簡易履歴の「いまの状態」。常設の帯は無い |
 * | `toast` | 消せる浮き札。進行中 → 知らせ → エラーの順(旧い行の並びのまま) |
 * | `live` | 常設の見えない読み上げ領域(知らせ + エラーだけ。状態語・保存中の出入りでは読まない) |
 * | `fileDrag` | 外のファイルをドラッグしている間の 1 行(左の一覧の下端のラベル。`paintFileDragLabel`) |
 */
export interface StatusModel {
  readonly state: readonly StateItem[];
  readonly toast: string;
  /** 🔴 常設の保存先の警告(浮き札の**専用の行**。他の知らせと 1 つの字に混ぜない ── 混ぜると新しい知らせが切れて読めない)。 */
  readonly severe: string;
  readonly live: string;
  readonly fileDrag: string;
}

export function composeStatusModel(parts: StatusLineParts): StatusModel {
  const state: StateItem[] = [];
  const add = (kind: StateItemKind, text: string, severe = false, phase?: AppPhase): void => {
    if (text !== '') state.push({ kind, text, severe, ...(phase === undefined ? {} : { phase }) });
  };
  add('editing', editingStateWord(parts.phase), false, parts.phase);
  add('storage', parts.statusBase, parts.statusBaseSevere === true);
  add('sync', parts.sync);
  add('folder-sync', parts.folderSyncLine ?? '');
  add('portable', parts.portableAssetNote);
  add('persist', parts.persistState);
  add('saving', parts.savingLine);
  const toast = [parts.progressLine, parts.noticeLine, parts.errorLine].filter((t) => t !== '').join(' — ');
  const live = [parts.noticeLine, parts.errorLine].filter((t) => t !== '').join(' — ');
  return { state, toast, severe: parts.severeToastLine ?? '', live, fileDrag: parts.fileDragLine ?? '' };
}

/**
 * 🔴 **浮き札を出すか**。字があるか、画面幅不足の断り書き(`OK` を押す口を持つ。#671)が出ている間は出す
 * ── 畳むと `OK` ごと画面から消え、user は消し方を持たない。
 */
export function shouldShowToast(options: { readonly toast: string; readonly severe?: string; readonly hasTooNarrow: boolean }): boolean {
  return options.hasTooNarrow || options.toast !== '' || (options.severe ?? '') !== '';
}

/**
 * 🔴 **状態の言葉を 1 行に連ねる**(メッセージのボタンの説明に使う)。⚠ 「編集中」の次に保存先の注意…という
 * 並びは `composeStatusModel` の `state` の並びのまま。
 */
export function stateSummary(items: readonly StateItem[]): string {
  return items.map((i) => i.text).join(' / ');
}

/** 読み上げの子の印(常設の見えない領域。`shell.ts` が作り、`paintStatusLive` が書く)。 */
export const STATUS_LIVE_FIELD = 'status-live';

/** 読み上げの領域を作る(`shell.ts` が 1 度だけ作る)。⚠ `hidden` にしない ── 畳むと読まれない。見えなくするのは CSS の視覚的な隠し方。 */
export function createStatusLive(doc: Document): HTMLElement {
  const live = doc.createElement('div');
  live.setAttribute('data-pkc-field', STATUS_LIVE_FIELD);
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  return live;
}

/**
 * 🔴 **読み上げの領域に知らせとエラーを書く**。⚠ 作り直さず、字が**変わったときだけ**書く
 * (外して付け直すと、登録される前の要素に字が入った形になり、読まれないことがある。#1017 C5 着地後レビュー ⚠1)。
 */
export function paintStatusLive(live: HTMLElement, text: string): void {
  if (live.textContent !== text) live.textContent = text;
}

/** 浮き札の字を書く。⚠ 同じ字なら触らない(打鍵ごとの DOM の変異を避ける)。 */
export function paintToastText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * 🔴 **× で消してよい浮き札か**。押す口が消えると進めなくなる知らせ(保存データの確認へ送る断り書き。`isCorruptRefusalLine`)は消せない
 * (消すと「保存データの確認を開く」ごと画面から無くなる)。判断はここ 1 本(`main.ts` の × と CSS の × の出し入れが同じ答えを持つ)。
 */
export function isToastDismissible(toastText: string): boolean {
  return !isCorruptRefusalLine(toastText);
}

/**
 * 🔴 **× で閉じたエラー・進行中・保存先の警告を、字が変わる(消える)まで出さない記憶**(`main.ts` の `paint` が使う。判断を `main.ts` に置かない)。
 * - エラー / 進行中: 同じ字の間だけ隠す。**字が変わる / 一度消えると解く**(次の別のエラーはまた出る)。
 * - 保存先の警告: そのセッションの間だけ隠す(新しいページの読み込みで空に戻る = 次の起動でまた出る)。
 */
export class ToastDismissal {
  private error: string | null = null;
  private progress: string | null = null;
  private severe = false;

  /** 現在の字を渡して、隠すものを空にした入力を返す。 */
  apply<T extends { errorLine: string; progressLine: string; severeToastLine?: string }>(parts: T): T {
    if (parts.errorLine === '') this.error = null;
    if (parts.progressLine === '') this.progress = null;
    return {
      ...parts,
      errorLine: parts.errorLine === this.error ? '' : parts.errorLine,
      progressLine: parts.progressLine === this.progress ? '' : parts.progressLine,
      severeToastLine: this.severe ? '' : (parts.severeToastLine ?? ''),
    };
  }

  /** 時間が来て、エラーの浮き札を降ろす(保存先の警告は触らない)。消してはいけない物なら何もしない。 */
  dismissError(errorLine: string): boolean {
    if (errorLine === '' || !isToastDismissible(errorLine)) return false;
    this.error = errorLine;
    return true;
  }

  /** × が押された。`toast` は押した時点の浮き札の字(消してはいけない物なら何もしない)。 */
  dismiss(current: { errorLine: string; progressLine: string }, toast: string): boolean {
    if (!isToastDismissible(toast)) return false;
    if (current.errorLine !== '') this.error = current.errorLine;
    if (current.progressLine !== '') this.progress = current.progressLine;
    // ⚠ 保存先の警告はここでは隠さない(「コピーしました」の × で実害の警告が消えない)── 専用の × は `dismissSevere`
    return true;
  }

  /** 保存先の警告の専用の ×。そのセッションの間だけ隠す。 */
  dismissSevere(): void {
    this.severe = true;
  }
}

/**
 * 🔴 **読んでいる間か**(マウスが浮き札の上 / 焦点が中)。⚠ **引く側**で、時間が来た瞬間に評価する(押す側の `mouseover` / `focusin` の
 * 記憶は、焦点を持ったまま浮き札が畳まれると真のまま固まる)。畳まれた札は読まれていない。
 */
export function isToastHeld(
  toast: { readonly hidden: boolean | string; matches(selector: string): boolean; contains(node: Node | null): boolean },
  active: Node | null,
): boolean {
  if (toast.hidden !== false) return false;
  return toast.matches(':hover') || (active !== null && toast.contains(active));
}
