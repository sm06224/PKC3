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
import { applyFormat, type FormatOp } from '@features/markdown/text-ops';
import { appendHeadingFor, isAppendable } from '@features/flavor/append-spec';
import { handleCopyMdBlock } from './copy-md-block';

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
  'settings',
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
  /** 未参照 asset の掃除(P4b)。確認・報告の UI も実体側の責務。 */
  purgeOrphanAssets?(): void;
  /** 注意の面を閉じる(P6c review H-2)。 */
  dismissNotices?(): void;
  /**
   * ランチャーのタイルを起動する(P7b 段⑩)。
   * ⚠ blob の貸し出し・`window.open` は実体側 ── binder は DOM を触らない。
   */
  openTile?(lid: string): void;
  /** 配色を切り替える(P7b 段⑨c)。⚠ user の好みで、flag でも container でもない。 */
  setTheme?(theme: string): void;
  /** 左の列の探し方(一覧 / フォルダ / アプリ)。⚠ 中央のビューとは別の軸(P8 段⑤)。 */
  setBrowse?(mode: string): void;
  /** 新しい版に交代する(P7 段⑤)。⚠ 交代を頼むだけ ── 再読込は交代後。 */
  applyUpdate?(): void;
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

const ACTIONS: Record<string, ActionHandler> = {
  'select-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  },
  'start-edit': (dispatcher) => dispatcher.dispatch({ type: 'START_EDIT' }),
  // ⚠ 第 4 引数の **root** を使う(target ではない)── 追記欄の出口は detail の
  //    兄弟なので、押したボタンから題名欄へは辿れない(P8 段⑲)
  'commit-edit': (dispatcher, _target, _services, root) => {
    renameFromEditorInput(dispatcher, root);
    dispatcher.dispatch({ type: 'COMMIT_EDIT' });
  },
  'cancel-edit': (dispatcher, _target, _services, root) => cancelFromEditor(dispatcher, root),
  'create-entry': (dispatcher, target) => {
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
    // 非 detail view で作ると editor が出ない(PKC2 PR-Δ19 の罠)── 先に切替
    if (dispatcher.getState().viewMode !== 'detail')
      dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype,
      lid: generateLid(),
      title: defaultTitle(dispatcher, archetype),
    });
  },
  'delete-entry': (dispatcher, target, services) => {
    // 🔴 書出し / 取込の実行中は消させない(P6f review M-2)。隣に並んだ
    // 「書き出す」を押した直後にここを押せると、走査の途中で entry が消え、
    // **書き出したつもりでファイルが落ちていない**が成立する
    if (services.busy?.()) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '書き出し / 取込が実行中です。完了してから削除してください',
      });
      return;
    }
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
    if (!(window.confirm?.(`「${title}」を削除しますか?(ゴミ箱から戻せます)`) ?? true))
      return;
    dispatcher.dispatch({ type: 'DELETE_ENTRY', lid });
  },
  'copy-md-block': (_dispatcher, target) => handleCopyMdBlock(target),
  /**
   * 書式パネル(P8 段⑥)。⚠ **規則は `applyFormat` が持つ** ── ここは
   * 「選択を読む → 渡す → 書き戻す」だけ。op ごとの知識をここに漏らさない。
   */
  'format-text': (_dispatcher, target, _services, root) => {
    const op = target.getAttribute('data-pkc-format') as FormatOp | null;
    const ta = editorBody(root);
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
    const ok =
      window.confirm?.(
        '追記の書き込みを強制的に打ち切ります。書き込みが実際には進んでいた場合、' +
          'この画面の表示が実際の中身より古くなることがあります(開き直すと直ります)。よろしいですか?',
      ) ?? true;
    if (ok) dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
  },
  /** 左の列の**探し方**を切り替える(P8 段⑤)。⚠ 中央のビューとは別の軸。 */
  'set-browse': (_dispatcher, target, services) => {
    const mode = target.closest('[data-pkc-browse]')?.getAttribute('data-pkc-browse');
    if (mode) services.setBrowse?.(mode);
  },
  'set-view': (dispatcher, target) => {
    const view = target.getAttribute('data-pkc-view') ?? '';
    if (VIEW_MODES.has(view))
      dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: view as ViewMode });
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
  'dismiss-notices': (_dispatcher, _target, services) => {
    services.dismissNotices?.();
  },
  'open-tile': (_dispatcher, target, services) => {
    const lid = target.closest('[data-pkc-tile]')?.getAttribute('data-pkc-tile');
    if (lid) services.openTile?.(lid);
  },
  'set-theme': (_dispatcher, target, services) => {
    // `<select>` なら選ばれた値、ボタンなら属性(どちらの形でも受ける)
    const theme =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-theme-value');
    if (theme) services.setTheme?.(theme);
  },
  'apply-update': (_dispatcher, _target, services) => {
    services.applyUpdate?.();
  },
  'dismiss-update': (_dispatcher, _target, services) => {
    services.dismissUpdate?.();
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
    const ok =
      window.confirm?.(
        'ゴミ箱を空にします(削除済み entry の履歴も消え、元に戻せません)。よろしいですか?',
      ) ?? false;
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
  const onClick = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action]',
    );
    if (!el || !root.contains(el)) return;
    const handler = ACTIONS[el.getAttribute('data-pkc-action') ?? ''];
    handler?.(dispatcher, el, services, root);
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
      if (action) ACTIONS[action]?.(dispatcher, el, services, root);
      return;
    }
    if (!(el instanceof HTMLInputElement)) return;
    // 🔑 チェックボックス / テキスト欄も **change で確定**する(P8 段⑭)。
    //    ⚠ `input` ごとに撃たない ── グループ名を 1 文字打つたびに disk へ
    //    書き戻すことになる(欄を離れた時・Enter を押した時が確定)
    const changeAction = el.getAttribute('data-pkc-action');
    if (changeAction !== null && changeAction.startsWith('set-app-')) {
      ACTIONS[changeAction]?.(dispatcher, el, services, root);
      return;
    }
    if (changeAction === 'toggle-app-tile') {
      ACTIONS[changeAction]?.(dispatcher, el, services, root);
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
    // 追記欄: Ctrl/Cmd+Enter で送る(欄の中だけ ── 画面全体の近道にしない)
    if (field === 'append-input') {
      if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey) && !ke.altKey) {
        ke.preventDefault();
        ACTIONS['append-entry']!(dispatcher, ke.target as HTMLElement, services, root);
      }
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
  root.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('mousedown', onMousedown);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKeydown);
  };
}
