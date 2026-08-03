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
import { handleCopyMdBlock } from './copy-md-block';

type ActionHandler = (
  dispatcher: Dispatcher,
  target: HTMLElement,
  services: BinderServices,
) => void;

const VIEW_MODES: ReadonlySet<string> = new Set([
  'detail',
  'calendar',
  'kanban',
  'filer',
  'launcher',
]);

/** 既定 title の種別ラベル(連番は同 archetype の現在数 + 1)。 */
const ARCHETYPE_LABELS: Record<string, string> = {
  text: 'ノート',
  todo: 'Todo',
  textlog: 'ログ',
  spreadsheet: 'シート',
  folder: 'フォルダ',
};

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
  const label = ARCHETYPE_LABELS[archetype] ?? archetype;
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
function cancelFromEditor(dispatcher: Dispatcher, from: HTMLElement): void {
  const s = dispatcher.getState();
  const lid = s.openBody?.lid;
  if (lid && s.freshLid === lid) {
    const scope = from.closest<HTMLElement>('[data-pkc-region="detail"]');
    const input = scope?.querySelector<HTMLInputElement>(
      '[data-pkc-field="editor-title"]',
    );
    const current = s.entryMetas.get(lid)?.title ?? '';
    if (input && input.value.trim() !== '' && input.value.trim() !== current) {
      // RENAME が fresh を解除する ── 直後の CANCEL は entry を残す
      dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
    }
  }
  dispatcher.dispatch({ type: 'CANCEL_EDIT' });
}

/** editor 表示中なら title input の現在値で RENAME を先行 dispatch する
 *  (楽観 meta 更新 → 直後の COMMIT_EDIT が新 title で行を組む。
 *  input が見つからなければ何もしない = 既存 title 維持 ── PKC2 の
 *  「title が消える」bug の防波堤と同じ向き)。
 *  query は detail region にスコープする(document 全域は他 root を拾いうる)。 */
function renameFromEditorInput(dispatcher: Dispatcher, from: HTMLElement): void {
  const scope = from.closest<HTMLElement>('[data-pkc-region="detail"]');
  const input = scope?.querySelector<HTMLInputElement>(
    '[data-pkc-field="editor-title"]',
  );
  const lid = dispatcher.getState().openBody?.lid;
  if (input && lid)
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
}

const ACTIONS: Record<string, ActionHandler> = {
  'select-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  },
  'start-edit': (dispatcher) => dispatcher.dispatch({ type: 'START_EDIT' }),
  'commit-edit': (dispatcher, target) => {
    renameFromEditorInput(dispatcher, target);
    dispatcher.dispatch({ type: 'COMMIT_EDIT' });
  },
  'cancel-edit': (dispatcher, target) => cancelFromEditor(dispatcher, target),
  'create-entry': (dispatcher, target) => {
    const archetype = target.getAttribute('data-pkc-archetype');
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
  'download-asset': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? 'download';
    if (key) services.downloadAsset?.(key, name);
  },
  'dismiss-notices': (_dispatcher, _target, services) => {
    services.dismissNotices?.();
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
  'show-history': (dispatcher) => dispatcher.dispatch({ type: 'SHOW_HISTORY' }),
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
    handler?.(dispatcher, el, services);
  };
  const onInput = (ev: Event) => {
    if (isEditorBody(ev.target)) {
      dispatcher.dispatch({ type: 'UPDATE_OPEN_BODY', body: ev.target.value });
    }
  };
  const onChange = (ev: Event) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement)) return;
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
    if (field !== 'editor-body' && field !== 'editor-title') return;
    // 🔴 IME ガード(PKC2 repo 慣行)── 変換中の Esc は「変換の取り消し」で
    // あって編集キャンセルではない。ガードが無いと draft 丸ごと破棄になる
    if (ke.isComposing) return;
    // PKC2 慣例: Ctrl/Cmd+S = 保存(ブラウザの保存ダイアログも抑止)、
    // Esc = キャンセル。Ctrl/Cmd+Enter も保存の別名として受ける
    // (PKC2 の章フォーカス編集が両対応だった ── append 系の Ctrl+Enter は
    // textlog UI 側の文脈で導入する)。altKey は除外(AltGr = Ctrl+Alt 誤発火)
    if (
      !ke.altKey &&
      (((ke.key === 's' || ke.key === 'S') && (ke.ctrlKey || ke.metaKey)) ||
        (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)))
    ) {
      ke.preventDefault();
      renameFromEditorInput(dispatcher, ke.target as HTMLElement);
      dispatcher.dispatch({ type: 'COMMIT_EDIT' });
    } else if (ke.key === 'Escape') {
      ke.preventDefault();
      cancelFromEditor(dispatcher, ke.target as HTMLElement);
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKeydown);
  };
}
