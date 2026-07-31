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
import { handleCopyMdBlock } from './copy-md-block';

type ActionHandler = (dispatcher: Dispatcher, target: HTMLElement) => void;

const ACTIONS: Record<string, ActionHandler> = {
  'select-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  },
  'start-edit': (dispatcher) => dispatcher.dispatch({ type: 'START_EDIT' }),
  'commit-edit': (dispatcher) => dispatcher.dispatch({ type: 'COMMIT_EDIT' }),
  'cancel-edit': (dispatcher) => dispatcher.dispatch({ type: 'CANCEL_EDIT' }),
  'copy-md-block': (_dispatcher, target) => handleCopyMdBlock(target),
};

function isEditorBody(el: EventTarget | null): el is HTMLTextAreaElement {
  return (
    el instanceof HTMLElement &&
    el.getAttribute('data-pkc-field') === 'editor-body'
  );
}

export function bindActions(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const onClick = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action]',
    );
    if (!el || !root.contains(el)) return;
    const handler = ACTIONS[el.getAttribute('data-pkc-action') ?? ''];
    handler?.(dispatcher, el);
  };
  const onInput = (ev: Event) => {
    if (isEditorBody(ev.target)) {
      dispatcher.dispatch({ type: 'UPDATE_OPEN_BODY', body: ev.target.value });
    }
  };
  const onKeydown = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (!isEditorBody(ke.target)) return;
    // PKC2 慣例: Ctrl/Cmd+S = 保存(ブラウザの保存ダイアログも抑止)、
    // Esc = キャンセル。Ctrl/Cmd+Enter も保存の別名として受ける
    // (PKC2 の章フォーカス編集が両対応だった ── append 系の Ctrl+Enter は
    // textlog UI 側の文脈で導入する)
    if (
      ((ke.key === 's' || ke.key === 'S') && (ke.ctrlKey || ke.metaKey)) ||
      (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey))
    ) {
      ke.preventDefault();
      dispatcher.dispatch({ type: 'COMMIT_EDIT' });
    } else if (ke.key === 'Escape') {
      ke.preventDefault();
      dispatcher.dispatch({ type: 'CANCEL_EDIT' });
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKeydown);
  };
}
