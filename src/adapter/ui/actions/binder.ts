/**
 * ActionBinder(PKC2 規約の維持): root での event delegation。
 * data-pkc-action を読んで UserAction を dispatch するだけ ── DOM は描かない。
 * action テーブルは登録制(P3-5 以降の編集系 action もここに足す)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

type ActionHandler = (dispatcher: Dispatcher, target: HTMLElement) => void;

const ACTIONS: Record<string, ActionHandler> = {
  'select-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  },
};

export function bindActions(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const onClick = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action]',
    );
    if (!el || !root.contains(el)) return;
    const handler = ACTIONS[el.getAttribute('data-pkc-action') ?? ''];
    handler?.(dispatcher, el);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
