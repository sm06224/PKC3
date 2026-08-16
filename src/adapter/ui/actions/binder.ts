/**
 * ActionBinder(PKC2 規約の維持): root での event delegation。
 * data-pkc-action を読んで UserAction を dispatch するだけ ── DOM は描かない。
 * action テーブルは登録制(編集系はここ、markdown ブロック系は P3-5 後半)。
 *
 * editor の本文は input delegation で都度 UPDATE_OPEN_BODY に写す(state が常に
 * 現在値を持つ ── dirty 判定・将来の autosave の土台)。1 打鍵 = 1 reduce は
 * openBody の spread のみで、描画側は編集中ガードで DOM を触らない。
 * 実測(run-editor-probe、15k 件・実 UI 経路): 小 body で打鍵 p50 ≈0ms、
 * 200KB body でも dispatch 有無の差は run 間ノイズに埋もれる(textarea 自体の
 * DOM コストが支配的)。⚠ 200KB 級では value 読取が打鍵ごとに O(body) の
 * string を作る ── GC churn が数字に出たら debounce / collect-at-commit へ
 * 切り替える(その時に計測してから)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { ViewMode } from '@adapter/state/app-state';
import { archetypeLabel } from '@adapter/ui/render/sidebar';
import { ARCHETYPE_ICONS, setIcon } from '@adapter/ui/render/icons';
import { applyFormat, type FormatOp } from '@features/markdown/text-ops';
import { appendHeadingFor, isAppendable } from '@features/flavor/append-spec';
import { isEntrySort } from '@features/filter/entry-sort';
import { isPaneId } from '@features/pane-visibility';
import { STRUCTURAL, isRelationKind } from '@features/relation/kinds';
import { appPanes, applyPaneVisibility } from '@adapter/ui/render/pane-visibility';
import { appQueryKey } from '@adapter/ui/render/query-key-store';
import { resolveFilerScope } from '@features/relation/tree';
import { parseLinkTarget } from '@features/entry-ref/link-target';
import { handleCopyMdBlock } from './copy-md-block';
import { finishCopy, selectedMarkdown } from './copy-source';
import { copyMarkdownAndHtml, copyPlainText } from '@adapter/platform/clipboard';
import { cleanForClipboard } from '@features/export/clipboard-html';
import { askConfirm, SUPPRESSED_MESSAGE } from '@adapter/platform/ask-confirm';

type ActionHandler = (
  dispatcher: Dispatcher,
  target: HTMLElement,
  services: BinderServices,
  /** 束ねた root。⚠ **押したボタンから辿れない**ときに使う ── 追記は
   *  START_EDIT で detail を描き直すので、target は既に外れている */
  root: HTMLElement,
) => void;

const VIEW_MODES: ReadonlySet<string> = new Set([
  'detail',
  'calendar',
  'kanban',
  'filer',
  'launcher',
  'query',
  'settings',
  'flags',
  'help',
]);

/** 既定 title の種別ラベル(連番は同 archetype の現在数 + 1)。 */

/** lid: epoch(base36)+ セッション内単調 counter(PKC2 と同系の形式)。 */
let lidCounter = 0;
export function generateLid(): string {
  lidCounter += 1;
  return `${Date.now().toString(36)}-${lidCounter.toString(36).padStart(4, '0')}`;
}

/** UI サービス面(storage 依存の操作は main が実体を注入。test は fake)。 */
export interface BinderServices {
  attachFiles?(files: File[]): void;
  downloadAsset?(assetKey: string, name: string): void;
  /**
   * 🔴 **貼る用に画像を持ち歩ける形へ**(#193)。`blob:` → `data:` の対応を返す。
   * ⚠ **省略可** ── 無ければ画像は文字に置き換わる(壊れた画像を貼らせない)。
   */
  inlineImages?(urls: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * 🔴 **添付を別の窓で見る**(#192 で画像、2026-08-15 に PDF を追加)。
   * ⚠ 実体は adapter/platform 側(ObjectURL の寿命が絡むので、binder は**呼ぶだけ**)。
   * ⚠ `mime` は**押した要素が運ぶ** ── 開く側で引き直さない。
   */
  viewAsset?(assetKey: string, name: string, mime: string): void;
  /** 未参照 asset の掃除(P4b)。確認・報告の UI も実体側の責務。 */
  purgeOrphanAssets?(): void;
  /** 注意の面を閉じる(P6c review H-2)。 */
  dismissNotices?(): void;
  /**
   * ランチャーのタイルを起動する(P7b 段⑩)。
   * ⚠ blob の貸し出し・`window.open` は実体側 ── binder は DOM を触らない。
   */
  openTile?(lid: string): void;
  /**
   * 🔴 **選んでいる添付を起動する**(P10、user 指示 2026-08-05
   * 「HTML アセットの詳細画面から起動できない」)。
   *
   * ⚠ タイル(`openTile`)とは**別**である ── あちらは「アプリとして登録」した
   * ものを lid で引くが、こちらは**登録の有無に依存しない**(開けることと
   * 一覧に並べることは別の話)。
   * ⚠ `sameOrigin` は詳細画面の別のボタンからのみ true になる。
   */
  launchAsset?(lid: string, opts: { sameOrigin: boolean }): void;
  /**
   * 🔴 **添付を Office の別窓で開く**(#88 / O3-c。user 裁定 2026-08-10)。
   *
   * ⚠ `launchAsset` とは**別**である ── あちらは HTML アプリを囲いの中で走らせる。
   * こちらは LibreOffice wasm の窓に文書を流し込む。
   * ⚠ **同期で呼ぶ**(実体側が `window.open` を user gesture の中で撃つ)。
   * ⚠ 引数は押したボタンの属性から採る ── lid から本文を読み直す暇が無い。
   */
  openOffice?(target: { name: string; mime: string; assetKey: string; lid: string }): void;
  /**
   * 🔴 **Office 一式(約 77MB)を入れる / 消す**(#88 / O6-a。user 裁定 2026-08-10
   * 「実行したい人が手動で設定した際に追加ダウンロードと idb とか opfs に配備して」)。
   *
   * ⚠ **勝手に取りに行かない** ── 押した人にだけ取らせる。
   * ⚠ `installOfficePackFromFile` は**配布元に届かない環境の唯一の道**なので、
   *   保険ではなく一級の導線として扱う(user 裁定「ローカルとかを介して」)。
   */
  installOfficePack?(): void;
  installOfficePackFromFile?(file: File): void;
  removeOfficePack?(): void;
  /** 配色を切り替える(P7b 段⑨c)。⚠ user の好みで、flag でも container でもない。 */
  setTheme?(theme: string): void;
  /**
   * 外部の画像を読み込むかの設定(2026-08-06、user 裁定)。
   * ⚠ 「常にオン / 常に確認 / 常にオフ」の 3 択。⚠ flag ではない(正規設定)。
   */
  setExternalImages?(mode: string): void;
  /**
   * 紙面(2026-08-08、user 裁定「A4 と A3、フル HD と 4:3 の縦横」)。
   * ⚠ **flag ではない**(正規設定)── 散文の読み幅と、印刷の紙が決まる。
   */
  setPageFormat?(format: string): void;
  /**
   * 編集の仕方(#104 第 2 弾。user 裁定 2026-08-08)。
   * ⚠ **flag ではない**(正規設定)── 効くのは次に編集を開いたとき。
   */
  setEditorMode?(mode: string): void;
  /**
   * 添付の携帯参照(`pkc://<自分>/asset/<key>`)から**所有ノートへ飛ぶ**(#100 段②)。
   * ⚠ 見つからないときは黙らない(OP_FAILED で断る ── 無言の dead click を作らない)。
   */
  navigateAssetRef?(assetKey: string): void;
  /**
   * 編集権を取る(#177 多重タブ ── 同じノートの 2 枚目編集を止める)。
   * false = 別のタブが編集中。⚠ 判断(台帳)は storage proxy 側が持つ。
   * ⚠ 解放の正本は main.ts の phase 遷移 watcher ── ここの release は
   *   「取ったのに編集に入れなかった」ときの返却だけ。
   */
  acquireEditLock?(lid: string): Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEditLock?(lid: string): void;
  /**
   * フラグの切替(P11。user 指示 2026-08-07)。
   * ⚠ **設定ではない** ── 開発者・パワーユーザー向けで、いつか畳まれる。
   */
  setFlag?(name: string, on: boolean): void;
  resetFlags?(): void;
  /**
   * いま開いているノートについて答えた(「常に確認」の帯の 2 つのボタン)。
   * ⚠ **ノート単位**で、覚えるのはタブを閉じるまで。⚠ 設定は変えない ──
   *   1 件の判断で全ノートの既定を動かさない。
   */
  answerExternalImages?(allow: boolean): void;
  /** 左の列の探し方(一覧 / フォルダ / アプリ)。⚠ 中央のビューとは別の軸(P8 段⑤)。 */
  setBrowse?(mode: string): void;
  /** 新しい版に交代する(P7 段⑤)。⚠ 交代を頼むだけ ── 再読込は交代後。 */
  applyUpdate?(): void;
  /**
   * 起動したときのお知らせ(P11 段⑤)。
   * ⚠ `dismiss` は**読んだことにする**(次から出ない)。`mute` は**今後出さない**
   *   ── 設定から戻せる(戻せない導線は作らない)。
   */
  dismissAnnounce?(): void;
  muteAnnounce?(): void;
  /**
   * お知らせを出すかの設定(P11 段⑤)。⚠ **flag ではない**(正規設定)──
   * 開放先は user で、畳む予定も無い。⚠ 帯の「今後は出さない」の**戻し道**である。
   */
  setNoticesEnabled?(on: boolean): void;
  /** 更新の案内を見送る(次に開いたときに再び出る)。 */
  dismissUpdate?(): void;
  /** アーカイブ書出し(P6d)。 */
  exportArchive?(): void;
  /** 可搬 HTML の書出し(P6d 段③)。 */
  exportHtml?(): void;
  /** md ZIP の書出し(P6d 段④)。 */
  exportMarkdown?(): void;
  /** このノートだけをアーカイブとして書き出す(P6f)。 */
  exportEntry?(lid: string): void;
  /**
   * 図 1 枚をベクタ(`.svg`)で書き出す(P8 段⑦)。
   * ⚠ 画面に置くのは PNG、書き出すのは SVG(user 指示 2026-08-03)。
   * @param index 同じ本文の中で**何枚目か**(0 始まり ── 名前は 1 始まりにする)
   */
  /** ⚠ **Promise を返す** ── 押した側が「終わった」を知らないと待ちを出せない。 */
  exportDiagram?(source: string, index: number): void | Promise<void>;
  /** 文字列をクリップボードへ(P8 段⑱)。⚠ 失敗も可視で終える。 */
  copyText?(text: string): void;
  /**
   * 添付 gate(書出し / 取込 / 整理)が実行中か。
   * ⚠ **破壊的操作を止めるために要る**(P6f review M-2)── 「書き出す」と「削除」を
   * 隣に並べた以上、走査中に消せてしまうと **user は書き出したつもりでファイルが
   * 1 個も落ちていない**状態になる。
   */
  busy?(): boolean;
  /**
   * 🔴 **開いた md を元ファイルへ書き戻す**(2026-08-05、user 報告
   * 「スポットの編集プレビュー導線も存在しない」)。
   * ⚠ 確認・許可・書込は実体側 ── binder は「押された」を伝えるだけ。
   */
  writeBackFile?(lid: string): void;
  /** PKC2 ファイルの取込(P6b)。判別・変換・書込は実体側の責務。 */
  /** 取込(PKC2 の書出し / 素の Markdown)。振り分けは import-file.ts が持つ。 */
  importFiles?(files: File[]): void;
}

function defaultTitle(dispatcher: Dispatcher, archetype: string): string {
  const label = archetypeLabel(archetype);
  let n = 0;
  for (const m of dispatcher.getState().entryMetas.values()) {
    if (m.archetype === archetype) n += 1;
  }
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date} ${label} ${n + 1}`;
}

/**
 * cancel 経路: fresh entry(作成直後)で title だけ入力されていた場合は、
 * title を RENAME で保存してから cancel する ── 「title を打って Esc」で
 * entry ごと消えて入力が失われる非対称の解消(P3-7a review 中)。
 * 非 fresh の cancel は破棄の意味論どおり title input も捨てる。
 */
function cancelFromEditor(dispatcher: Dispatcher, root: HTMLElement): void {
  const s = dispatcher.getState();
  const lid = s.openBody?.lid;
  if (lid && s.freshLid === lid) {
    const input = editorTitle(root);
    const current = s.entryMetas.get(lid)?.title ?? '';
    if (input && input.value.trim() !== '' && input.value.trim() !== current) {
      // RENAME が fresh を解除する ── 直後の CANCEL は entry を残す
      dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
    }
  }
  dispatcher.dispatch({ type: 'CANCEL_EDIT' });
}

/**
 * いま画面に出ている題名欄。
 *
 * 🔴 **root から引く**(P8 段⑲。押したボタンから `closest` で辿らない)。
 * 直す前は `from.closest('[data-pkc-region="detail"]')` だったが、
 * 追記欄(`append` region)の **保存して解放 / 編集を破棄** は detail の
 * **兄弟**なので `closest` が null を返し、題名欄が 1 度も見つからなかった
 * ── その出口から保存すると**題名の変更が丸ごと捨てられて**いた。
 * 同じ「保存」なのに押す場所で結果が違う、という壊れ方である。
 * ⚠ 入口は 1 つに寄せる(`editorBody` と同じ引き方)。
 */
function editorTitle(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(
    '[data-pkc-region="detail"] [data-pkc-field="editor-title"]',
  );
}

/** editor 表示中なら title input の現在値で RENAME を先行 dispatch する
 *  (楽観 meta 更新 → 直後の COMMIT_EDIT が新 title で行を組む。
 *  input が見つからなければ何もしない = 既存 title 維持 ── PKC2 の
 *  「title が消える」bug の防波堤と同じ向き)。 */
function renameFromEditorInput(dispatcher: Dispatcher, root: HTMLElement): void {
  const input = editorTitle(root);
  const lid = dispatcher.getState().openBody?.lid;
  if (input && lid)
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
}

/** いま画面に出ている編集欄(root にスコープする ── document 全域は他 root を拾う)。 */
function editorBody(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(
    '[data-pkc-region="detail"] [data-pkc-field="editor-body"]',
  );
}

/**
 * 🔴 **書式の効く先**(2026-08-08)。2 列なら `editor-body`、live の 1 面なら
 * **活性の行の入力欄**(`row-source`)── 直す前は live 面で書式パネルと
 * Ctrl+B/I/K が `editor-body` を探して**無言 no-op** だった(押しても何も
 * 起きず、理由もどこにも出ない)。
 * ⚠ 2 つは同時には存在しない(live ↔ 2 列は排他。live の退避は `editor-body`)。
 * ⚠ `writeBack` の `value` 直代入は行の中の Ctrl+Z を捨てる ── 行は Escape で
 * 丸ごと戻せるので、2 列の editor と同じ理由で受け入れる。
 */
function formatTarget(root: HTMLElement): HTMLTextAreaElement | null {
  return (
    root.querySelector<HTMLTextAreaElement>(
      '[data-pkc-region="detail"] [data-pkc-field="row-source"]',
    ) ?? editorBody(root)
  );
}

/** 読む面の描画済み本文(コピーの書式付き / 選択範囲が読む)。 */
function viewBodyHost(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '[data-pkc-region="detail"] [data-pkc-field="detail-body"]',
  );
}

/**
 * 書き換えた本文を編集欄へ戻す。
 *
 * 🔴 **`input` を自分で撃つ**。ここで state へ直に `UPDATE_OPEN_BODY` を送ると、
 * 経路が 2 本になる(binder の delegation と、この関数)── 片方を壊しても
 * もう片方に救われて test が緑のまま通るので、**入口は 1 つに寄せる**。
 * プレビューも textarea の `input` で駆動しているので、これ 1 発で state と
 * 画面の両方が追いつく。
 *
 * ⚠ `value` の直代入はブラウザの取り消し履歴(Ctrl+Z)を捨てる。書式パネルは
 * 「保存 / キャンセル」で丸ごと戻せるので、ここでは受け入れる ── 取り消しを
 * 残すには `execCommand('insertText')` が要るが、経路が 2 本になる。
 */
function writeBack(
  ta: HTMLTextAreaElement,
  next: { text: string; start: number; end: number },
  toBottom = false,
): void {
  ta.value = next.text;
  ta.setSelectionRange(next.start, next.end);
  ta.focus();
  // 追記はカーソルが末尾 ── 見えていないと「押しても何も起きない」に見える
  if (toBottom) ta.scrollTop = ta.scrollHeight;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 🔴 **書出し / 取込の実行中は、本文を書き換えさせない**(P8 段㉑)。
 *
 * 直す前この判定は `delete-entry` **1 か所だけ**にあった。ところが書出しは
 * 本文を 4MB ずつページングし(`await` を跨ぐ)、そのあとで履歴の鎖を引く ──
 * バッチの隙間に保存が割り込むと、**同じノートの本文は旧版、鎖の頭は新 tip 基準**
 * という噛み合わないアーカイブができる。取り込み直すと検査が発火して
 * 「履歴が噛み合いません」だけが出て、そのノートの履歴が丸ごと落ちる
 * (title / status は検査が無いので**黙って**旧値が入る)。
 *
 * 「削除は止めるのに保存は止めない」= 同じ危険に対して入口ごとに答えが違う、
 * という状態だった。⚠ **規則は 1 本**にして、本文を書き換える入口すべてに掛ける。
 */
const BODY_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'start-edit',
  'commit-edit',
  'append-entry',
  'toggle-todo',
  'toggle-app-tile',
  'delete-entry',
  'restore-revision',
  'restore-trash',
  'purge-trash',
  // ⚠ 本文は書かないが **disk への書込**である(取込は relations を総入れ替えする
  //    ので、走っている最中に居場所を変えると片方が消える)
  'move-entry',
  // ⚠ user の**ファイル**を上書きする ── 取込・書出しの最中に走らせない
  'write-back-file',
]);

/**
 * 🔴 **確認が出ていないことを黙らせない**(2026-08-06。user 報告 minor)。
 *
 * ⚠ 抑止は**解除できない**(仕様)。ここがするのは理由を出すことだけ ──
 * 判定と文言は `platform/ask-confirm.ts` の 1 か所に置く(規則を 2 つ書かない)。
 * @param whenAbsent confirm が**無い**環境での既定(呼び側の倒し方を持ち込む)
 */
function confirmOrExplain(
  dispatcher: Dispatcher,
  message: string,
  whenAbsent: boolean,
): boolean {
  const r = askConfirm(message, { whenAbsent });
  if (r.suppressed) dispatcher.dispatch({ type: 'OP_FAILED', error: SUPPRESSED_MESSAGE });
  return r.ok;
}

function refuseWhileBusy(
  action: string,
  dispatcher: Dispatcher,
  services: BinderServices,
): boolean {
  if (!BODY_WRITE_ACTIONS.has(action) || services.busy?.() !== true) return false;
  // ⚠ **可視に断る**(無言の操作拒否を作らない)
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: '書き出し / 取込が実行中です。完了してから操作してください',
  });
  return true;
}

/** 並べ替えの 2 つの向きで同じことをする(規則を 2 か所に書かない)。 */
function moveOrder(
  dispatcher: Dispatcher,
  target: HTMLElement,
  direction: 'up' | 'down',
): void {
  const lid = target.getAttribute('data-pkc-entry');
  if (!lid) return;
  dispatcher.dispatch({ type: 'MOVE_ENTRY_ORDER', lid, direction });
}

/**
 * 本文のリンク(`entry:` / `@card`)から別のノートを開く。
 *
 * 🔴 **規則は 1 本**(`link-target.ts`)。⚠ 断る 3 つはどれも**可視に**返す ──
 * `SELECT_ENTRY` は編集中 / error / 未知 lid で**黙って何もしない**ので、
 * 素直に撃つと「押しても無言」が残る(直そうとしている当のものになる)。
 */
function navigateToLink(dispatcher: Dispatcher, raw: string | null): void {
  const t = parseLinkTarget(raw ?? '');
  if (t.kind === 'invalid') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'リンクの書き方が読めません' });
    return;
  }
  if (t.foreign) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'このリンクは別の PKC のノートを指しています',
    });
    return;
  }
  if (!selectEntryOrExplain(dispatcher, t.lid, 'リンク先')) return;
}

/**
 * 🔴 **ノートを開く。開けないときは理由を出す**(2026-08-08)。
 *
 * ⚠ `SELECT_ENTRY` は reducer が **編集中 / error / 未知 lid で黙って捨てる**
 * (`app-state.ts`)。素直に撃つと**押しても無言**になる ── この repo が
 * 繰り返し踏んできた形である。
 *
 * 🔑 **規則を 1 か所に寄せる**(CLAUDE.md「同じ判定が 2 か所に生えたら…」)──
 * 本文のリンク(`navigate-*`)も一覧の行(`select-entry`)も、
 * 「ノートを開きたい」という同じ意図であり、断る条件も同じである。
 *
 * ⚠ **開けるようにはしない。** 面の切替(設定 / フラグ / ヘルプ)は面が常駐する
 * ので開けるようにしたが(user 裁定 2026-08-08)、**別のノートへ移るのは下書きを
 * 捨てることになる** ── ここは止めるのが正しく、無言なのが間違いだった。
 *
 * @param what 断り文に入れる呼び名(「リンク先」/「ノート」)
 * @returns 開いたら true
 */
function selectEntryOrExplain(dispatcher: Dispatcher, lid: string, what: string): boolean {
  const state = dispatcher.getState();
  if (state.phase === 'editing') {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `編集を終了してから${what}を開いてください`,
    });
    return false;
  }
  if (!state.entryMetas.has(lid)) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${what}のノートが見つかりません` });
    return false;
  }
  dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  return true;
}

const ACTIONS: Record<string, ActionHandler> = {
  /**
   * 🔴 **本文のリンクで別のノートへ飛ぶ**(2026-08-08。user 裁定「任せます」)。
   *
   * markdown は `[題名](entry:<lid>)` と `@[card](entry:<lid>)` に
   * `data-pkc-action` を焼いていたのに、**受け手が 1 つも無かった** ──
   * 記法だけ移植して置き忘れた形で、押しても無言で何も起きなかった。
   *
   * ⚠ **無言で断らない**(`delete-entry` と同じ倒し方)。断る先は 3 つ:
   *  ① 編集中(下書きを守る。⚠ 面の切替とは別 ── あちらは開けるようにした)
   *  ② 解けないリンク(壊れた綴り)③ このアプリに無い / 別コンテナのノート
   * ⚠ **fragment は見ない** ── 飛び先の要素を出す実装が `src` に無い 4 形が
   *   あるので、いまは lid まで開く(`link-target.ts` に理由)。
   */
  'navigate-entry-ref': (dispatcher, target) => {
    navigateToLink(dispatcher, target.getAttribute('data-pkc-entry-ref'));
  },
  /**
   * `@[card](…)` の placeholder。⚠ **解決器は `entry:` と同じ 1 本**
   * (target は `entry:` か `pkc://<cid>/entry/<lid>` のどちらか)。
   */
  'navigate-card-ref': (dispatcher, target) => {
    navigateToLink(dispatcher, target.getAttribute('data-pkc-card-target'));
  },
  /**
   * `pkc://<自分>/asset/<key>` ── 添付の**所有ノートへ飛ぶ**(#100 段②)。
   * ⚠ key → lid の逆引きは storage worker(`findAssetOwner`)なので非同期 ──
   *   判断は services 側(main.ts が worker へ問い、見つかれば SELECT_ENTRY)。
   */
  'navigate-asset-ref': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-ref');
    if (key) services.navigateAssetRef?.(key);
  },
  /**
   * 一覧 / フォルダ / かんばん / カレンダーの行。
   *
   * 🔴 **編集中は無言で捨てられていた**(2026-08-08 に直した)。reducer が
   * `phase === 'editing'` で何もせず返すので、**押しても 1 ドットも動かず、
   * 理由もどこにも出ない** ── user から見ると「クリックが効かない」。
   * ⚠ 行は 4 つの面が出しているので、**受け手 1 か所で直すと 4 面とも直る**。
   */
  'select-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) selectEntryOrExplain(dispatcher, lid, 'ノート');
  },
  /**
   * ✏️ 編集に入る。#177: 多重タブでは**先に編集権を取ってから**入る。
   * ⚠ reducer のガード(ready / openBody 一致 / writeLock)は**ここに写さない**
   *   ── 取ってから dispatch し、入れなかったら返す(判定は reducer 1 か所)。
   */
  /**
   * 🔴 **タグで探す**(#182)。⚠ 押した札の語を**絞り込み欄へ入れる** ── 別建ての
   * タグ絞り込み機構を作らない(#181 の全文検索が frontmatter ごと引く)。
   * ⚠ 欄の値も state 経由で同期される(renderer が書き戻す)。
   */
  'filter-by-tag': (dispatcher, target) => {
    const tag = target.getAttribute('data-pkc-tag');
    if (tag) dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: tag });
  },
  /**
   * 🔴 **選択の戻る・進む**(#190)。⚠ **行き先をここで決めない** ── 履歴は state が
   * 持ち、`NAV_HISTORY` が行き先も採否も決める(binder が lid を選ぶと二重帳簿になる)。
   */
  /**
   * 🔴 **ペインを畳む・戻す**(#197)。⚠ **state に持たせない** ── これはこの端末の
   * 見え方であって、ノートのデータでも container の状態でもない(`editor-mode` と
   * 同じ扱い)。畳んだ状態は保存され、次に開いたときも同じ配置になる。
   */
  'toggle-pane': (_dispatcher, target) => {
    const id = target.getAttribute('data-pkc-pane');
    if (id === null || !isPaneId(id)) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    applyPaneVisibility(root, appPanes.toggle(id));
  },
  /**
   * 🔴 **置換の帯を開く・閉じる**(#191)。⚠ 開いたら**探す欄へ focus** ──
   * 開いただけで打てないと、user は 2 手目を探すことになる。
   */
  'toggle-replace': (_dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="replace-bar"]');
    if (!bar) return;
    bar.hidden = !bar.hidden;
    target.setAttribute('aria-expanded', bar.hidden ? 'false' : 'true');
    if (!bar.hidden)
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')?.focus();
  },
  /**
   * 🔴 **全部置換**(#191)。⚠ 判定(編集中か / 何件当たるか)は**reducer 1 か所**。
   * ここでは欄の値を渡すだけ ── binder が「0 件なら押さない」等を持つと二重帳簿になる。
   */
  'replace-all': (dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const find = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')?.value ?? '';
    const replace =
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-with"]')?.value ?? '';
    dispatcher.dispatch({ type: 'REPLACE_IN_BODY', find, replace });
  },
  /**
   * 🔴 **関係を足す**(#185)。⚠ 相手は**題名で指す**(lid は user に見えない)。
   * ⚠ 見つからない / 曖昧なときは**理由を言う** ── 押して無反応にしない。
   * ⚠ 判定(自分自身・重複・居場所)は **reducer 1 か所**。ここは解決だけ。
   */
  'add-relation': (dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const nameEl = root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]');
    const kindEl = root.querySelector<HTMLSelectElement>('[data-pkc-field="relation-kind"]');
    const name = (nameEl?.value ?? '').trim();
    const state = dispatcher.getState();
    const fromLid = state.selectedLid;
    if (fromLid === null) return;
    if (name === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '相手の題名を入れてください' });
      return;
    }
    const hits = [...state.entryMetas.values()].filter(
      (m) => m.title === name && m.lid !== fromLid,
    );
    if (hits.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」というノートが見つかりません`,
      });
      return;
    }
    if (hits.length > 1) {
      // ⚠ 同じ題名が複数 ── **どれかを勝手に選ばない**(user の意図が決まらない)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」が ${hits.length} 件あります。題名を分けてから足してください`,
      });
      return;
    }
    const kind = kindEl?.value ?? '';
    if (!isRelationKind(kind) || kind === STRUCTURAL) return;
    dispatcher.dispatch({
      type: 'ADD_RELATION',
      id: generateLid(),
      fromLid,
      toLid: hits[0]!.lid,
      kind,
    });
    if (nameEl) nameEl.value = '';
  },
  /** 関係を消す(#185)。⚠ **id で消す**(押した札が持っている)。 */
  'remove-relation': (dispatcher, target) => {
    const id = target.getAttribute('data-pkc-relation');
    if (id) dispatcher.dispatch({ type: 'REMOVE_RELATION', id });
  },
  'nav-back': (dispatcher) => dispatcher.dispatch({ type: 'NAV_HISTORY', dir: 'back' }),
  'nav-forward': (dispatcher) => dispatcher.dispatch({ type: 'NAV_HISTORY', dir: 'forward' }),
  /** 一覧の並び順(#183)。⚠ 妥当性の判定は `isEntrySort` 1 か所。 */
  'set-entry-sort': (dispatcher, target) => {
    const v = (target as HTMLSelectElement).value;
    if (isEntrySort(v)) dispatcher.dispatch({ type: 'SET_ENTRY_SORT', sort: v });
  },
  /**
   * 集計の束ね方(#184)。⚠ 空文字は「選んでいない」── `null` へ落とす
   * (空文字の key で問い合わせると、全件が「未設定」の 1 組になる)。
   */
  'set-query-key': (dispatcher, target) => {
    const v = (target as HTMLSelectElement).value;
    const key = v === '' ? null : v;
    // ⚠ 覚えるのは**端末側**(container に書かない ── 作業の都合であってデータではない)
    appQueryKey.set(key);
    dispatcher.dispatch({ type: 'SET_QUERY_KEY', key });
  },
  /**
   * 数え直す(#184)。集計は保存のたびに自動では走らない(全本文の先頭を舐めるので、
   * 打つたびには回さない)。
   * 🔴 ⚠ **`SET_VIEW_MODE` を借りない**(レビュー B-2)── 借りると
   * `revisionPanel` / `trashPanel` が畳まれ、**ゴミ箱を開いたまま数え直すと
   * 理由なく閉じる**。P8 段⑤ で「アプリ」タブが同じ形の事故を起こしている。
   */
  'refresh-query': (dispatcher) => {
    dispatcher.dispatch({ type: 'REFRESH_QUERY' });
  },
  'start-edit': (dispatcher, _target, services) => {
    const lock = services.acquireEditLock;
    const lid = dispatcher.getState().openBody?.lid ?? null;
    if (!lock || lid === null) {
      dispatcher.dispatch({ type: 'START_EDIT' });
      return;
    }
    void lock(lid).then((grant) => {
      if (grant !== 'granted') {
        // ⚠ 文言は理由と対(§1 / レビュー M-7)── holder 不在を「別のタブで編集中」と
        //    言うと、user は存在しない編集タブを探す
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error:
            grant === 'denied'
              ? 'このノートは別のタブで編集中です(そちらを閉じるか保存してください)'
              : '本体タブと通信できません(少し待ってもう一度お試しください)',
        });
        return;
      }
      // 🔴 dispatch の**前**に自分の lid か確かめる(レビュー M-3)── acquire を待つ間に
      //    user が別のノートを選んでいると、reducer は**そのノート**の編集を受理する
      //    = ロック無しの編集が成立してしまう。dispatch は同期なのでここの検査に窓は無い
      if (dispatcher.getState().openBody?.lid !== lid) {
        services.releaseEditLock?.(lid);
        return;
      }
      dispatcher.dispatch({ type: 'START_EDIT' });
      // ⚠ 「editing に居るか」では足りない ── reducer が断る理由は選択以外にもある
      //    (writeLock / tileWrite 中)。**自分の lid が入ったか**で見る
      const st = dispatcher.getState();
      if (!(st.phase === 'editing' && st.openBody?.lid === lid))
        services.releaseEditLock?.(lid);
    });
  },
  // ⚠ 第 4 引数の **root** を使う(target ではない)── 追記欄の出口は detail の
  //    兄弟なので、押したボタンから題名欄へは辿れない(P8 段⑲)
  'commit-edit': (dispatcher, _target, _services, root) => {
    renameFromEditorInput(dispatcher, root);
    dispatcher.dispatch({ type: 'COMMIT_EDIT' });
  },
  'cancel-edit': (dispatcher, _target, _services, root) => cancelFromEditor(dispatcher, root),
  'create-entry': (dispatcher, target, services) => {
    // 🔑 種類は**隣の `<select>`**から取る(P8 ── ボタンを種類ぶん並べない)。
    // ⚠ 旧来どおりボタン自身が `data-pkc-archetype` を持つ形も受ける
    // (かんばん等の面から直接作る導線が将来生えても壊れない)
    const archetype =
      target.getAttribute('data-pkc-archetype') ??
      target
        .closest('[data-pkc-region="create-bar"]')
        ?.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]')?.value ??
      null;
    if (!archetype) return;
    /**
     * 🔴 **いま見ているフォルダの中に作る**(2026-08-05、user 報告
     * 「フォルダ整理のための導線がない」の片翼)。直す前は、フォルダを開いて
     * 「+ ノート」を押しても**ルートに落ちて**いた ── フォルダの中身は
     * 「作ってから入れ直す」以外に増やしようが無かった。
     *
     * ⚠ 入れ先は**選択の純関数**(filer と同じ `resolveFilerScope`)── 「どの
     * 探し方を開いているか」では変えない。左の列の状態で保存先が変わると、
     * user からは同じ操作が場所によって違う結果を出すように見える。
     * ⚠ `SET_VIEW_MODE` より**前**に読む(切替は選択を動かさないが、
     * 読む順を先に固定しておく)。
     */
    const st = dispatcher.getState();
    const parent = resolveFilerScope(st.selectedLid, st.entryMetas, st.relations);
    // 非 detail view で作ると editor が出ない(PKC2 PR-Δ19 の罠)── 先に切替
    if (st.viewMode !== 'detail') dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    const lid = generateLid();
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype,
      lid,
      title: defaultTitle(dispatcher, archetype),
      parentLid: parent?.lid ?? null,
      relationId: generateLid(),
    });
    // #177: 作成 → 即編集の編集権。lid は今生まれたばかりなので必ず取れる ──
    // 「取れてから入る」順に直すと user gesture の同期性を失うだけで守るものが無い。
    // 別タブは 'changed' でこの lid を知るため、登録が先に着けばよい
    if (dispatcher.getState().phase === 'editing') void services.acquireEditLock?.(lid);
  },
  'delete-entry': (dispatcher, target) => {
    // ⚠ 実行中(書出し / 取込)のガードは `refuseWhileBusy` が 1 本で持つ
    // 🔴 **無言で断らない**(P8 段⑲)。`DELETE_ENTRY` は `phase !== 'ready'` で
    //    何も返さないので、直す前は**確認ダイアログまで出してから黙って捨てて**いた
    //    ── user は消したつもりで画面を離れる。detail.ts が確立した
    //    「無言の操作拒否を作らない」に揃える。⚠ confirm より**前**に断る
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから削除してください',
      });
      return;
    }
    // 属性はボタン自身ではなく「entry を表す要素」(行 / カード)から closest で
    // 引く ── ボタン直付けだと selectedLid fallback が別 entry を消す罠になる
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (!lid) return;
    const title = dispatcher.getState().entryMetas.get(lid)?.title ?? lid;
    // P3-7a は native confirm(inline dialog は UI 磨きの回で)。
    // 🔴 文言が**嘘になっていた**(P7 段⑥ round-2 review M-8)。P3-7a の時点では
    // hard delete だったので「元に戻せません」と書いたが、P5b でゴミ箱と復元が
    // 着地している(削除直前の snapshot を同 tx で積み、`RESTORE_TRASH` で戻せる)
    // ── **必要以上に怖がらせる側の嘘**を出荷していた。
    // ⚠ 「戻せる」ことは `docs/manual.md` §6 にも書いてある(そちらが正しかった)
    // confirm の無い環境(headless test)は自動化として通す
    // 🔴 **抑止されていたら理由を出す**(2026-08-06。user 報告 minor)── 黙って
    //    false が返るので、そのままだとボタンが恒久的に無反応に見える
    if (!confirmOrExplain(dispatcher, `「${title}」を削除しますか?(ゴミ箱から戻せます)`, true))
      return;
    dispatcher.dispatch({ type: 'DELETE_ENTRY', lid });
  },
  'copy-md-block': (_dispatcher, target) => handleCopyMdBlock(target),
  /**
   * 🔴 **読む面のコピー**(2026-08-08。user 裁定「markdown のテキストとしての
   * コピーと HTML 書式ありのコピーの両方」)。押しても画面が変わらない操作なので、
   * 渡ったらボタンが光り(`copy-md-block` と同じ合図)、渡らなければ理由が出る。
   * ⚠ 本文待ちの間は renderer 側が disabled にしている ── ここの早期 return は
   * その裏書き(押せない物は押せない)であって、無言の断りの口ではない。
   */
  'copy-note-md': (dispatcher, target) => {
    const body = dispatcher.getState().openBody?.body;
    if (body === undefined) return;
    finishCopy(dispatcher, target, copyPlainText(body));
  },
  /**
   * 🔴 **よそのアプリへ貼る用に掃除してから渡す**(#193)。
   *
   * ⚠ 直す前は `host.innerHTML` を**そのまま**渡していた ── 画面の DOM には
   * 「CSS で隠してあるだけのソース」「押せない操作子」「この document でしか
   * 有効でない `blob:` 画像」が入っており、Word / Notion に貼ると**全部出る**
   * (図の下に生の原文、壊れた画像、押せないボタン)。
   * ⚠ 掃除は**複製に対して**行う ── 画面には触れない。
   * ⚠ 落としたものは**数えて言う**(黙って消さない)。
   */
  'copy-note-rich': (dispatcher, target, services, root) => {
    const body = dispatcher.getState().openBody?.body;
    const host = viewBodyHost(root);
    if (body === undefined || host === null) return;
    const clone = host.cloneNode(true) as HTMLElement;
    const inline = services.inlineImages;
    const run = (urls: ReadonlyMap<string, string>): void => {
      const { html, droppedImages } = cleanForClipboard(clone, urls);
      // plain 側は原文(markdown)── 貼り付け先が editor なら原文、rich なら描画
      finishCopy(dispatcher, target, copyMarkdownAndHtml(body, html));
      if (droppedImages > 0)
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `画像 ${droppedImages} 件は貼り先で読めないため文字に置き換えました`,
        });
    };
    if (!inline) {
      run(new Map());
      return;
    }
    const blobs = [...clone.querySelectorAll('img')]
      .map((i) => i.getAttribute('src') ?? '')
      .filter((u) => u.startsWith('blob:'));
    if (blobs.length === 0) {
      run(new Map());
      return;
    }
    void inline(blobs).then(run, () => run(new Map()));
  },
  /**
   * 選択範囲を Markdown の原文でコピーする。逆引きの規則は `copy-source.ts` の
   * 1 本(活性の判定と同じ端点の規則)。
   * ⚠ 解決できない選択は**理由を出す**(活性が selectionchange と競り合って
   * 押せてしまう瞬間があるので、ここでも無言にしない)。
   */
  'copy-selection-md': (dispatcher, target, _services, root) => {
    const body = dispatcher.getState().openBody?.body;
    const host = viewBodyHost(root);
    const text = body !== undefined && host !== null ? selectedMarkdown(host, body) : null;
    if (text === null) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '本文の中を選択してからコピーしてください',
      });
      return;
    }
    finishCopy(dispatcher, target, copyPlainText(text));
  },
  /**
   * 書式パネル(P8 段⑥)。⚠ **規則は `applyFormat` が持つ** ── ここは
   * 「選択を読む → 渡す → 書き戻す」だけ。op ごとの知識をここに漏らさない。
   */
  'format-text': (_dispatcher, target, _services, root) => {
    const op = target.getAttribute('data-pkc-format') as FormatOp | null;
    // ⚠ live の 1 面では活性の行(`row-source`)に効く(`formatTarget` の注記)
    const ta = formatTarget(root);
    if (!op || !ta) return;
    writeBack(ta, applyFormat({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, op));
  },
  /**
   * 🔑 **追記**(P8 段⑧)。編集画面を開かず、打った内容をそのまま末尾へ足す。
   *
   * 🔴 段⑥ の「編集に入って末尾へ飛ぶ」は**作り直した**(user 指示 2026-08-03
   * 「追記型は今すぐ実装して、今のままだと、なんの意味もない」)── 5000 行の
   * ログでも毎回全文を textarea に載せる形は、追記型の意味を成していなかった。
   *
   * ⚠ 日時見出しは**ここで作る**(reducer は純粋のまま ── `Date` を呼ばない)。
   * ⚠ 欄は**空にしない** ── 通ったときだけ描画側が空にする(失敗で打鍵が消えない)。
   */
  'append-entry': (dispatcher, _target, _services, root) => {
    const s = dispatcher.getState();
    const lid = s.selectedLid;
    const archetype = lid ? s.entryMetas.get(lid)?.archetype : undefined;
    if (!lid || !isAppendable(archetype)) return;
    const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
    const text = input?.value ?? '';
    // ⚠ **空判定をここに持たない**(P8 段⑧ の変異試験で判明)── reducer が
    // 同じ判定を持っており、3 か所(binder / reducer / `appendBlock`)が互いに
    // 救い合って**どれ 1 つ消しても test が緑**だった。判定は下 2 つに寄せる:
    // reducer =「ロックも取らずに断る」、`appendBlock` =「本文を変えない」
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid,
      text,
      heading: appendHeadingFor(archetype!, new Date()),
    });
  },
  /**
   * 🔴 **強制解放**(user 指示 2026-08-03「競合ロックと強制解放も念頭に」)。
   * 返ってこない書込で**永久に追記できなくなる**のを防ぐ最後の出口。
   * ⚠ 押した人が結果を分かっていること ── 確認を出す(確認の無い環境は通す)。
   */
  'force-release': (dispatcher) => {
    const ok = confirmOrExplain(
      dispatcher,
      '追記の書き込みを強制的に打ち切ります。書き込みが実際には進んでいた場合、' +
        'この画面の表示が実際の中身より古くなることがあります(開き直すと直ります)。よろしいですか?',
      true,
    );
    if (ok) dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
  },
  /** 左の列の**探し方**を切り替える(P8 段⑤)。⚠ 中央のビューとは別の軸。 */
  'set-browse': (_dispatcher, target, services) => {
    const mode = target.closest('[data-pkc-browse]')?.getAttribute('data-pkc-browse');
    if (mode) services.setBrowse?.(mode);
  },
  'set-view': (dispatcher, target) => {
    const view = target.getAttribute('data-pkc-view') ?? '';
    if (!VIEW_MODES.has(view)) return;
    // 🔴 **もう一度押したら戻る**(P8 段⑲)。直す前の 設定 は行きっぱなしで、
    //    閉じる導線がどこにも無かった ── 抜けられるのは左のタブを押すか
    //    新規作成だけで、user から見ると「画面から出られない」
    const cur = dispatcher.getState().viewMode;
    const next = (cur === view ? 'detail' : view) as ViewMode;
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: next });
    /**
     * 🔴 **集計の束ね方を思い出す**(#184)。⚠ **開いたときだけ**読む ──
     * boot で読むと、集計を一度も開かない user にも全本文の走査を負わせる。
     * ⚠ 順序が効く: 先に `SET_VIEW_MODE`(目録を頼む)→ 後に `SET_QUERY_KEY`
     * (表を頼む)。逆にすると同じ走査を 2 回頼むことになる。
     */
    /**
     * ⚠ **実際に開けたときだけ**(レビュー B-1)── 1 稿目は `next` を見ていたので、
     * **編集中に押すと面は開かないのに走査だけ飛んで**いた(`SET_VIEW_MODE` は
     * 編集中に捨てられるが、`SET_QUERY_KEY` にはその門が無い)。
     */
    if (dispatcher.getState().viewMode === 'query' && dispatcher.getState().queryKey === null) {
      const remembered = appQueryKey.get();
      if (remembered !== null) dispatcher.dispatch({ type: 'SET_QUERY_KEY', key: remembered });
    }
  },
  'toggle-todo': (dispatcher, target) => {
    // data-pkc-entry は「entry を表す要素」専用 ── ボタンからは closest で引く
    const lid = target
      .closest('[data-pkc-entry]')
      ?.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'TOGGLE_TODO_STATUS', lid });
  },
  'calendar-nav': (dispatcher, target) => {
    // 遷移先は renderer が描画時に焼き込む(binder は「今の月」を推定しない)
    const year = Number(target.getAttribute('data-pkc-nav-year'));
    const month = Number(target.getAttribute('data-pkc-nav-month'));
    if (!Number.isInteger(year) || !Number.isInteger(month)) return;
    dispatcher.dispatch({ type: 'SET_CALENDAR_MONTH', year, month });
  },
  'calendar-today': (dispatcher) => {
    const now = new Date();
    dispatcher.dispatch({
      type: 'SET_CALENDAR_MONTH',
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    });
  },
  'toggle-show-archived': (dispatcher) =>
    dispatcher.dispatch({ type: 'TOGGLE_SHOW_ARCHIVED' }),
  'retry-persist': (dispatcher) => dispatcher.dispatch({ type: 'RETRY_PERSIST' }),
  'filer-root': (dispatcher) => dispatcher.dispatch({ type: 'DESELECT_ENTRY' }),
  /**
   * 🔴 **居場所を変える**(2026-08-05、user 報告「フォルダ整理のための導線がない」)。
   * 空値 = ルートへ出す。⚠ 動かす当人は**帯自身**が持っている
   * (`selectedLid` を読み直すと、選び直した直後に別のものを動かす)。
   */
  'move-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (!lid) return;
    const value = target instanceof HTMLSelectElement ? target.value : '';
    dispatcher.dispatch({
      type: 'SET_ENTRY_PARENT',
      lid,
      parentLid: value === '' ? null : value,
      relationId: generateLid(),
    });
  },
  /**
   * 🔴 **並べ替え**(2026-08-06。user 報告 2-10)。⚠ 動かす当人は帯が持つ
   * (`move-entry` と同じ理由 ── 押した瞬間に選択が変わっていても取り違えない)。
   */
  'move-order-up': (dispatcher, target) => moveOrder(dispatcher, target, 'up'),
  'move-order-down': (dispatcher, target) => moveOrder(dispatcher, target, 'down'),
  'attach-file': (_dispatcher, target) => {
    // 常設の hidden input を開く(動的生成にしない ── smoke の setInputFiles と
    // ブラウザの user-gesture 要件の両方に効く)
    target
      .closest('[data-pkc-region="shell"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="attach-input"]')
      ?.click();
  },
  /**
   * 図を保存する(P8 段⑦)。⚠ 画面は PNG だが、**書き出すのはベクタ**
   * (user 指示 2026-08-03「SVG は書き出しのときだけ」)。
   * ⚠ 「何枚目か」は**描いた側の並び**から数える ── 器に番号を焼き込むと、
   * 図を 1 個消したときに番号が飛ぶ
   */
  'export-diagram': (_dispatcher, target, services, root) => {
    const host = target.closest<HTMLElement>('[data-pkc-mermaid-src]');
    const source = host?.getAttribute('data-pkc-mermaid-src');
    if (!host || !source) return;
    const all = [...root.querySelectorAll('[data-pkc-mermaid-src]')];
    const done = services.exportDiagram?.(source, Math.max(0, all.indexOf(host)));
    // 🔴 **無言で待たせない**(P8 段⑬ review M-3)。ベクタは原文から焼き直すので、
    //    mermaid 本体の読み込みを含めて秒が掛かる。何も起きないように見えると
    //    user は連打する ── 押せなくして、そのボタン自身に状態を出す
    const btn = target.closest<HTMLButtonElement>('[data-pkc-action="export-diagram"]');
    if (!btn || !(done instanceof Promise)) return;
    const label = btn.querySelector<HTMLElement>('[data-pkc-field="label"]');
    const was = label?.textContent ?? '';
    btn.disabled = true;
    btn.setAttribute('data-pkc-busy', '');
    if (label) label.textContent = '書き出し中…';
    const reset = (): void => {
      btn.disabled = false;
      btn.removeAttribute('data-pkc-busy');
      if (label) label.textContent = was;
    };
    // ⚠ **`finally` ではなく `then(reset, reset)`** ── `finally` は元の失敗を
    //    そのまま流すので、service が reject すると**未処理の rejection**になる
    //    (実際に test の stderr で出た。この repo は stderr 0 行を保つ規律)。
    //    失敗の**報告**は service 側が持つ ── ここは見た目を戻すだけ
    void done.then(reset, reset);
  },
  /**
   * ランチャーのタイル設定(P8 段⑭)。
   * ⚠ 対象は**いま選んでいるノート** ── この 3 つは添付の画面にしか出ない
   */
  'toggle-app-tile': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, registered: target.checked });
  },
  'set-app-group': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, group: target.value.trim() });
  },
  'set-app-icon': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, icon: target.value.trim() });
  },
  /**
   * 添付の参照(`asset:<key>`)をコピーする(P8 段⑱)。
   * ⚠ 本文に貼れる形そのものを渡す ── key だけ渡すと user が書式を覚える必要がある
   */
  'copy-asset-ref': (_dispatcher, target, services) => {
    // ⚠ 渡すのは**貼れる 1 行**(`![名前](asset:key)`)── 裸の `asset:key` を
    //    渡していた頃は、貼っても markdown としてはただの文字列だった(段⑱)。
    //    組み立ては描画側(`asset-ref-format.ts` 経由)。ここでは組み立て直さない
    const ref = target
      .closest<HTMLElement>('[data-pkc-asset-ref]')
      ?.getAttribute('data-pkc-asset-ref');
    if (ref) services.copyText?.(ref);
  },
  'download-asset': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? 'download';
    if (key) services.downloadAsset?.(key, name);
  },
  /**
   * 🔴 **画像を別窓で見る**(#192)。⚠ 開けなかったとき(popup 阻止)の後始末は
   *   呼ばれる側が持つ ── ここで持つと、経路が増えたときに片方だけ古くなる。
   */
  'view-asset': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? '添付';
    // ⚠ MIME を**押した要素から**運ぶ ── 開く側で引き直すと、開くまでに
    //    選択が移った場合に**別の添付の種類**で開いてしまう
    const mime = target.getAttribute('data-pkc-asset-mime') ?? '';
    if (key) services.viewAsset?.(key, name, mime);
  },
  'dismiss-notices': (_dispatcher, _target, services) => {
    services.dismissNotices?.();
  },
  'open-tile': (_dispatcher, target, services) => {
    const lid = target.closest('[data-pkc-tile]')?.getAttribute('data-pkc-tile');
    if (lid) services.openTile?.(lid);
  },
  /**
   * 🔑 **作る種類の一覧を開く / 閉じる**(P10 の分割ボタン)。
   * ⚠ `<details>` を使わない ── この repo は「主要な導線を畳まない」を規律に持ち、
   *   shell に `<details>` が 0 件であることを test で pin している。
   */
  'toggle-create-menu': (_dispatcher, target, _services, root) => {
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    target.setAttribute('aria-expanded', open ? 'true' : 'false');
  },
  /**
   * 🔑 **作る種類を選ぶ**(P10)。押した種類を「いま作るもの」にして、
   * **本体のボタンの文言・図案**と **`Ctrl+N` の対象**を同時に切り替える。
   * ⚠ 保持場所は `<select>` 1 か所 ── ボタンの属性と select が食い違うと、
   *   押した種類と出来るものが別になる(いちばん困る形)。
   */
  'pick-create-kind': (_dispatcher, target, _services, root) => {
    const archetype = target.getAttribute('data-pkc-archetype');
    if (!archetype) return;
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]');
    if (select) select.value = archetype;
    const run = root.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    if (run) {
      run.setAttribute('data-pkc-archetype', archetype);
      const label = run.querySelector('[data-pkc-field="label"]');
      // ⚠ 文言は**選んだ項目の文言**をそのまま使う(表を 2 つ持たない)
      const picked = target.querySelector('[data-pkc-field="label"]')?.textContent ?? archetype;
      if (label) label.textContent = `+ ${picked}`;
      const icon = run.querySelector('[data-pkc-icon]');
      // ⚠ `textContent` で書かない(図案は要素)── `setIcon` で入れ替える
      if (icon) setIcon(icon, ARCHETYPE_ICONS[archetype] ?? 'dot');
    }
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (menu) menu.hidden = true;
    root
      .querySelector('[data-pkc-field="create-pick"]')
      ?.setAttribute('aria-expanded', 'false');
  },
  // ⚠ 対象は**いま選んでいる添付** ── 詳細画面のボタンなので lid は state が持つ
  'launch-asset': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) services.launchAsset?.(lid, { sameOrigin: false });
  },
  'launch-asset-raw': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) services.launchAsset?.(lid, { sameOrigin: true });
  },
  /**
   * 🔴 **Office の別窓で開く**(#88 / O3-c)。
   *
   * ⚠ **同期のうちに渡しきる。** 窓は user gesture の中でしか開けないので、
   * ここで lid から本文を読み直す(= `await`)ことはできない ── 開くのに要る
   * 4 つは**押したボタンの属性**に載っている(`office-entry-view.ts` が載せる)。
   */
  'open-office': (_dispatcher, target, services) => {
    const assetKey = target.getAttribute('data-pkc-asset-key');
    if (!assetKey) return;
    services.openOffice?.({
      assetKey,
      name: target.getAttribute('data-pkc-asset-name') ?? '',
      mime: target.getAttribute('data-pkc-asset-mime') ?? '',
      // 🔴 **保存の戻り先**(#205)。⚠ 読み落とすと、Office での上書き保存が
      //    このノートを更新せず、新しい添付ノートを増やす
      lid: target.getAttribute('data-pkc-office-lid') ?? '',
    });
  },
  /**
   * Office 一式(#88 / O6-a)。⚠ どれも**実体が判断を持つ** ── ここは渡すだけ。
   * ⚠ `choose-office-pack` は picker を開くだけ(`attach-file` と同じ作法で、
   *   input は常設 hidden。動的生成にすると user gesture の要件を外す)。
   */
  'install-office-pack': (_dispatcher, _target, services) => {
    services.installOfficePack?.();
  },
  'choose-office-pack': (_dispatcher, target) => {
    target
      .closest('[data-pkc-region="settings-office"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="office-pack-input"]')
      ?.click();
  },
  'remove-office-pack': (_dispatcher, _target, services) => {
    services.removeOfficePack?.();
  },
  'set-theme': (_dispatcher, target, services) => {
    // `<select>` なら選ばれた値、ボタンなら属性(どちらの形でも受ける)
    const theme =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-theme-value');
    if (theme) services.setTheme?.(theme);
  },
  'set-external-images': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const mode =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-external-images-value');
    if (mode) services.setExternalImages?.(mode);
  },
  'set-page-format': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const format =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-page-format-value');
    if (format) services.setPageFormat?.(format);
  },
  'set-editor-mode': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const mode =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-editor-mode-value');
    if (mode) services.setEditorMode?.(mode);
  },
  'set-flag': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    const name = target.getAttribute('data-pkc-flag');
    if (name && target instanceof HTMLInputElement) services.setFlag?.(name, target.checked);
  },
  'reset-flags': (_dispatcher, _target, services) => {
    services.resetFlags?.();
  },
  'allow-external-images': (_dispatcher, _target, services) => {
    services.answerExternalImages?.(true);
  },
  'deny-external-images': (_dispatcher, _target, services) => {
    services.answerExternalImages?.(false);
  },
  'apply-update': (_dispatcher, _target, services) => {
    services.applyUpdate?.();
  },
  'dismiss-update': (_dispatcher, _target, services) => {
    services.dismissUpdate?.();
  },
  'set-notices-enabled': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setNoticesEnabled?.(target.checked);
  },
  'dismiss-announce': (_dispatcher, _target, services) => {
    services.dismissAnnounce?.();
  },
  'mute-announce': (_dispatcher, _target, services) => {
    services.muteAnnounce?.();
  },
  'export-archive': (_dispatcher, _target, services) => {
    services.exportArchive?.();
  },
  'export-html': (_dispatcher, _target, services) => {
    services.exportHtml?.();
  },
  'export-markdown': (_dispatcher, _target, services) => {
    services.exportMarkdown?.();
  },
  'export-entry': (dispatcher, target, services) => {
    // ⚠ 解決規則は `delete-entry` と**同じ**にする(review M-3)── 隣に並べる
    // ボタンなので、片方だけ `selectedLid` 固定だと filer / sidebar の行に
    // 並べた瞬間に「A を書き出して B を削除する」が成立する
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (lid) services.exportEntry?.(lid);
  },
  'purge-orphan-assets': (_dispatcher, _target, services) => {
    services.purgeOrphanAssets?.();
  },
  'import-file': (_dispatcher, target) => {
    target
      .closest('[data-pkc-region="shell"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="import-input"]')
      ?.click();
  },
  // ── P5b: 履歴 / ゴミ箱 ──
  'show-history': (dispatcher) => {
    // 🔴 **無言で断らない**(P8 段⑲)── `SHOW_HISTORY` は `phase !== 'ready'` で
    //    何も返さず、押しても panel も理由も出なかった
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから履歴を開いてください',
      });
      return;
    }
    dispatcher.dispatch({ type: 'SHOW_HISTORY' });
  },
  'hide-history': (dispatcher) => dispatcher.dispatch({ type: 'HIDE_HISTORY' }),
  'restore-revision': (dispatcher, target) => {
    // 前進変異(復元前に現状が履歴に積まれる)なので confirm は要らない ──
    // 「復元の取り消し」も履歴から戻れる
    const revId = target.getAttribute('data-pkc-rev-id');
    if (revId) dispatcher.dispatch({ type: 'RESTORE_REVISION', revId });
  },
  'write-back-file': (dispatcher, target, services) => {
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (lid) services.writeBackFile?.(lid);
  },
  'show-trash': (dispatcher) => dispatcher.dispatch({ type: 'SHOW_TRASH' }),
  'hide-trash': (dispatcher) => dispatcher.dispatch({ type: 'HIDE_TRASH' }),
  'restore-trash': (dispatcher, target) => {
    const revId = target.getAttribute('data-pkc-rev-id');
    const entryLid = target.getAttribute('data-pkc-trash-lid');
    if (revId && entryLid)
      dispatcher.dispatch({ type: 'RESTORE_TRASH', entryLid, revId });
  },
  'purge-trash': (dispatcher) => {
    // 一括・不可逆(revision の物理削除)なので fail closed(purge-orphan-assets
    // と同じ倒し方 ── 単発 delete-entry の ?? true とは桁が違う)
    const ok = confirmOrExplain(
      dispatcher,
      'ゴミ箱を空にします(削除済み entry の履歴も消え、元に戻せません)。よろしいですか?',
      false,
    );
    if (ok) dispatcher.dispatch({ type: 'PURGE_TRASH' });
  },
};

/**
 * 近道のキー。⚠ **書式パネルに在る操作だけ**を割り当てる ── ここにしか無い
 * 操作を作ると「キーを知っている人にしかできないこと」が生まれる。
 */
const FORMAT_KEYS: Readonly<Record<string, FormatOp>> = {
  b: 'bold',
  i: 'italic',
  k: 'link',
};

function isEditorBody(el: EventTarget | null): el is HTMLTextAreaElement {
  return (
    el instanceof HTMLTextAreaElement &&
    el.getAttribute('data-pkc-field') === 'editor-body'
  );
}

export function bindActions(
  root: HTMLElement,
  dispatcher: Dispatcher,
  services: BinderServices = {},
): () => void {
  /**
   * action を 1 本の口から回す。⚠ **ここを通さない呼び方をしない** ──
   * 実行中(書出し / 取込)のガードはここに 1 回だけ置く(P8 段㉑)。
   * 入口ごとに書くと、必ずどれかが素通しになる(実際そうだった)。
   */
  const run = (action: string | null, el: HTMLElement): void => {
    if (!action) return;
    const handler = ACTIONS[action];
    if (!handler) return;
    if (refuseWhileBusy(action, dispatcher, services)) return;
    handler(dispatcher, el, services, root);
  };
  const onClick = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action]',
    );
    if (!el || !root.contains(el)) return;
    /**
     * 🔴 **アプリ内リンクは、ブラウザに遷移させない**(2026-08-08)。
     *
     * 本文の `[題名](entry:<lid>)` は `<a href="entry:…">` として出る
     * (`markdown-render.ts`)。ここは `preventDefault` を呼んでいなかったので、
     * ⚠ **押すとブラウザが未知スキームへの遷移を試みる**。`asset:` の枝だけは
     * 焼く側で href を剥がして避けていた ── **対称の反対側が放置されていた**。
     *
     * 🔑 **href を剥がす側では直さない**。剥がすと `<a>` が**フォーカスできなく
     * なり**、キーボードの動線が落ちる(= 記法を減らすのと同じ向き)。
     * ⚠ **`<a href>` に限る** ── checkbox(`set-flag` / `set-notices-enabled`)で
     *   呼ぶと**チェック状態が巻き戻る**。`data-pkc-action` を持つ `<a href>` は
     *   アプリ内リンクしか無い(`download-asset` は href を剥がしてある /
     *   目次・脚注は action を持たない)。
     */
    if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) ev.preventDefault();
    run(el.getAttribute('data-pkc-action'), el);
  };
  /**
   * ⚠ 書式パネルのボタンは **focus を奪わない**。奪うと押すたびに編集欄が
   * focus を失って画面がちらつく(選択位置自体は残るので壊れはしない)。
   */
  const onMousedown = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-action]');
    if (el?.getAttribute('data-pkc-action') === 'format-text') ev.preventDefault();
  };
  const onInput = (ev: Event) => {
    if (isEditorBody(ev.target)) {
      dispatcher.dispatch({ type: 'UPDATE_OPEN_BODY', body: ev.target.value });
      return;
    }
    // 🔑 一覧の絞り込み(P7b 段⑨c)。⚠ **state に写す** ── renderer は
    // DOM から値を読まない、というこのリポジトリの規約
    const el = ev.target;
    if (
      el instanceof HTMLInputElement &&
      el.getAttribute('data-pkc-field') === 'entry-filter'
    ) {
      dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: el.value });
    }
  };
  const onChange = (ev: Event) => {
    const el = ev.target;
    // 🔑 `<select>` は click ではなく change で決まる ── 配色のように
    // 「選んだ瞬間に効く」ものはここで拾う(P8)
    if (el instanceof HTMLSelectElement) {
      const action = el.getAttribute('data-pkc-action');
      run(action, el);
      return;
    }
    if (!(el instanceof HTMLInputElement)) return;
    // 🔑 チェックボックス / テキスト欄も **change で確定**する(P8 段⑭)。
    //    ⚠ `input` ごとに撃たない ── グループ名を 1 文字打つたびに disk へ
    //    書き戻すことになる(欄を離れた時・Enter を押した時が確定)
    const changeAction = el.getAttribute('data-pkc-action');
    if (changeAction !== null && changeAction.startsWith('set-app-')) {
      run(changeAction, el);
      return;
    }
    if (changeAction === 'toggle-app-tile') {
      run(changeAction, el);
      return;
    }
    const field = el.getAttribute('data-pkc-field');
    if (field === 'attach-input') {
      const files = el.files ? [...el.files] : [];
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (files.length > 0) services.attachFiles?.(files);
    } else if (field === 'import-input') {
      // ⚠ 添付と同じく**全件**渡す ── md は複数選択できる(1 件ずつ entry に
      // なる)。PKC2 の書出しが複数来たときに断るのは import-file.ts の仕事で、
      // ここで 1 件目だけ拾って黙って落とさない
      const files = el.files ? [...el.files] : [];
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (files.length > 0) services.importFiles?.(files);
    } else if (field === 'office-pack-input') {
      // ⚠ **1 件だけ**(一式は zip 1 本)。複数選ばれても先頭で決める ──
      //    2 本目を黙って捨てるのではなく、そもそも 1 本しか意味を持たない
      const file = el.files?.[0] ?? null;
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (file) services.installOfficePackFromFile?.(file);
    }
  };
  const onKeydown = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    // editor の 2 field(本文 textarea / title input)でのみ有効
    const field =
      ke.target instanceof HTMLElement
        ? ke.target.getAttribute('data-pkc-field')
        : null;
    // 🔴 IME ガード(PKC2 repo 慣行)── 変換中の Esc は「変換の取り消し」で
    // あって編集キャンセルではない。ガードが無いと draft 丸ごと破棄になる。
    // ⚠ **追記欄より先に置く** ── 変換確定の Enter で送ってしまうと、
    // 日本語で書く人は「打ち終わる前に飛ぶ」を毎回踏む
    if (ke.isComposing) return;
    /**
     * 🔴 **`role="link"` のものは Enter / Space で押せる**(2026-08-08)。
     *
     * `@card` の placeholder は `<span role="link" tabindex="0">` で出る
     * (`markdown-render.ts`)── PKC3 で `tabindex="0"` を持つ要素は**これだけ**で、
     * ⚠ 直す前はこの下の `data-pkc-field` の門で**必ず抜けていた**ので、
     * **フォーカスできるのに Enter が効かない**要素が 1 種類だけ存在していた
     * (user 指示「マウスだけで完結し、キーボードは近道」の破れ)。
     *
     * ⚠ **`data-pkc-field` の門より前**に置く(placeholder は field を持たない)。
     * ⚠ `<button>` / `<a>` はブラウザ既定で Enter → click に乗るので**対象外** ──
     *   二重に撃たないよう `[tabindex]` を持つものだけ拾う。
     */
    if (ke.key === 'Enter' || ke.key === ' ') {
      const el = ke.target instanceof HTMLElement ? ke.target : null;
      if (el?.hasAttribute('tabindex') && el.hasAttribute('data-pkc-action')) {
        // ⚠ Space は既定でページを送る ── 押した先が動くほうが正しい
        ke.preventDefault();
        run(el.getAttribute('data-pkc-action'), el);
        return;
      }
    }
    // 追記欄: Ctrl/Cmd+Enter で送る(欄の中だけ ── 画面全体の近道にしない)
    if (field === 'append-input') {
      if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey) && !ke.altKey) {
        ke.preventDefault();
        run('append-entry', ke.target as HTMLElement);
      }
      return;
    }
    /**
     * 🔴 **live 面の行の入力欄にも書式の近道(Ctrl+B/I/K)を効かせる**(2026-08-08)。
     * 直す前は下の門(editor-body / editor-title)で弾かれて**無言 no-op** だった。
     * ⚠ ここで受けるのは FORMAT_KEYS **だけ** ── Ctrl+S / Esc は行の側
     * (`row-swap.ts`)が「行の確定 / 行の取り消し」として持つ。ここで
     * `COMMIT_EDIT` / `CANCEL_EDIT` を撃つと**編集の面ごと閉じてしまう**(別の操作)。
     */
    if (
      field === 'row-source' &&
      !ke.altKey &&
      (ke.ctrlKey || ke.metaKey) &&
      FORMAT_KEYS[ke.key.toLowerCase()] !== undefined
    ) {
      ke.preventDefault();
      const ta = ke.target as HTMLTextAreaElement;
      writeBack(
        ta,
        applyFormat(
          { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
          FORMAT_KEYS[ke.key.toLowerCase()]!,
        ),
      );
      return;
    }
    if (field !== 'editor-body' && field !== 'editor-title') return;
    // PKC2 慣例: Ctrl/Cmd+S = 保存(ブラウザの保存ダイアログも抑止)、
    // Esc = キャンセル。Ctrl/Cmd+Enter も保存の別名として受ける
    // (PKC2 の章フォーカス編集が両対応だった)。altKey は除外(AltGr = Ctrl+Alt 誤発火)
    // ⚠ 追記(P8 段⑥)は**編集欄そのものを書き換える**ので、PKC2 のように
    // 「追記専用の textarea + Ctrl+Enter で確定」を別に持たない ── 別経路にすると
    // 編集中の draft と競合し、追記した節が保存で黙って消える(PKC2 の実測)
    if (
      !ke.altKey &&
      (((ke.key === 's' || ke.key === 'S') && (ke.ctrlKey || ke.metaKey)) ||
        (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)))
    ) {
      ke.preventDefault();
      // ⚠ 近道キーも同じ規則に乗せる(ボタンだけ止めても意味が無い)
      if (refuseWhileBusy('commit-edit', dispatcher, services)) return;
      renameFromEditorInput(dispatcher, root);
      dispatcher.dispatch({ type: 'COMMIT_EDIT' });
    } else if (
      // 🔑 **キーボードは近道**(業務画面の作法 ── user 指示 2026-08-03)。
      // 本文だけ。題名に太字を入れても意味が無い。⚠ `isComposing` は上で弾き済み
      field === 'editor-body' &&
      !ke.altKey &&
      (ke.ctrlKey || ke.metaKey) &&
      FORMAT_KEYS[ke.key.toLowerCase()] !== undefined
    ) {
      ke.preventDefault();
      const ta = ke.target as HTMLTextAreaElement;
      writeBack(
        ta,
        applyFormat(
          { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
          FORMAT_KEYS[ke.key.toLowerCase()]!,
        ),
      );
    } else if (ke.key === 'Escape') {
      ke.preventDefault();
      cancelFromEditor(dispatcher, root);
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('mousedown', onMousedown);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  /**
   * 🔑 **画面全体の近道**(P10)。いまは `Ctrl/Cmd+N` = いま選んでいる種類で作る
   * (user 指示「追加ボタンと ctrl+n の対象を更新」)。
   *
   * 🔴 **document で受ける** ── `root` に付けると、focus が root の外(`body` 等)に
   * あるときに届かない。編集をやめた直後は focus が消えた要素から body へ落ちるので、
   * **そこで効かない近道**になっていた(実測で落ちた)。
   * ⚠ `root` が外れていたら何もしない ── test が root を作り直しても、
   * 古い binder の handler が生き残って二重に作らないため。
   * ⚠ 編集中の欄では受けない(打っている途中に別のノートへ飛ぶのは事故)。
   * ⚠ `altKey` を除く(AltGr = Ctrl+Alt の誤発火)。
   * ⚠ ブラウザの「新しいウィンドウ」を止める(`preventDefault`)。
   */
  const onShortcut = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (ke.isComposing || !root.isConnected) return;
    const field =
      ke.target instanceof HTMLElement ? ke.target.getAttribute('data-pkc-field') : null;
    const typing =
      field === 'editor-body' || field === 'editor-title' || field === 'append-input';
    /**
     * 🔴 **選択の戻る・進む**(#190)。`Alt+←` / `Alt+→` ── ブラウザと同じ手。
     * ⚠ 打っている途中でも**効かせる**(戻るは編集を壊さない ── reducer が
     *   `editing` の間は選択を動かさないので、ここで弾く必要が無い)。
     *   ⚠ ただし変換中(`isComposing`)は上で弾いている。
     * ⚠ `ctrl/meta` との同時押しは受けない(OS 側の割り当てと衝突する)。
     */
    if ((ke.key === 'ArrowLeft' || ke.key === 'ArrowRight') && ke.altKey && !ke.ctrlKey && !ke.metaKey) {
      ke.preventDefault();
      dispatcher.dispatch({ type: 'NAV_HISTORY', dir: ke.key === 'ArrowLeft' ? 'back' : 'forward' });
      return;
    }
    /**
     * 🔴 **ペインの開閉の近道**(#197 / #190)。`Alt+[` = 左、`Alt+]` = 右。
     * ⚠ 押しボタンを**そのまま押す** ── 同じ操作が 2 通りの経路を持たない(§7)。
     */
    if ((ke.key === '[' || ke.key === ']') && ke.altKey && !ke.ctrlKey && !ke.metaKey) {
      const pane = ke.key === '[' ? 'sidebar' : 'inspector';
      const btn = root.querySelector<HTMLElement>(
        `[data-pkc-action="toggle-pane"][data-pkc-pane="${pane}"]`,
      );
      if (!btn) return;
      ke.preventDefault();
      btn.click();
      return;
    }
    /**
     * 🔴 **置換の近道**(#191)。`Ctrl+H` ── 他のアプリと同じ手。
     * ⚠ ボタンを**そのまま押す**(同じ操作が 2 通りの経路を持たない)。
     */
    if ((ke.key === 'h' || ke.key === 'H') && (ke.ctrlKey || ke.metaKey) && !ke.altKey) {
      const btn = root.querySelector<HTMLElement>('[data-pkc-action="toggle-replace"]');
      if (!btn) return;
      ke.preventDefault();
      btn.click();
      return;
    }
    /**
     * 🔴 **ヘルプ**(#190)。`F1` ── 面は既にあるので開くだけ。
     * ⚠ 入力中でも効かせる(`F1` は文字を打つ鍵ではない)。
     */
    if (ke.key === 'F1' && !ke.ctrlKey && !ke.metaKey && !ke.altKey) {
      ke.preventDefault();
      dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
      return;
    }
    if (!(ke.key === 'n' || ke.key === 'N') || !(ke.ctrlKey || ke.metaKey) || ke.altKey) return;
    if (typing) return;
    const run = root.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    if (!run) return;
    ke.preventDefault();
    run.click();
  };
  const doc = root.ownerDocument;
  doc.addEventListener('keydown', onShortcut);
  root.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('mousedown', onMousedown);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    doc.removeEventListener('keydown', onShortcut);
    root.removeEventListener('keydown', onKeydown);
  };
}
