/**
 * コマンドシェル(#274)と 2 ペインのコマンドライン(#241)の**打つ欄のキー操作**。DOM だけを触る(state は触らない)。
 *
 * - `Enter` = 実行 / `↑` `↓` = 履歴(`↓` で打ちかけに戻る)/ `Tab` = 補完(共通の頭まで入れ、1 件なら確定)/ `Esc` = 候補を閉じる(候補が無ければ欄を空にする)
 * - 変換中(IME)の Enter・Tab は握らない(呼び側が `isComposing` を先に弾く)
 * - ⚠ マウスだけで完結する: 候補・履歴は全部ボタンで、押すと欄へ入る(`shell-pick` / `shell-recall`)
 */
import { commonPrefix, type Completion } from '@features/shell/complete';
import { stepShellHistory } from '@features/shell/history';
import { paintCompletion, sessionByName, type ShellSession } from '../render/cmdshell';

export function shellRegion(from: Element): HTMLElement | null {
  return from.closest<HTMLElement>('[data-pkc-region="shell-prompt"]');
}

export function shellSessionOf(from: Element): ShellSession | null {
  return sessionByName(shellRegion(from)?.getAttribute('data-pkc-session') ?? null);
}

export function shellInputOf(from: Element): HTMLInputElement | null {
  return shellRegion(from)?.querySelector<HTMLInputElement>('[data-pkc-field="shell-input"]') ?? null;
}

export function completeHostOf(from: Element): HTMLElement | null {
  return shellRegion(from)?.querySelector<HTMLElement>('[data-pkc-region="shell-complete"]') ?? null;
}

/** 候補を閉じる。 */
export function closeCompletion(from: Element): void {
  const host = completeHostOf(from);
  if (host !== null) paintCompletion(host, null);
}

/** 欄の `from`〜`to` を `insert` に置き換え、caret を末尾へ。 */
export function replaceRange(input: HTMLInputElement, from: number, to: number, insert: string): void {
  const v = input.value;
  input.value = `${v.slice(0, from)}${insert}${v.slice(to)}`;
  const at = from + insert.length;
  input.setSelectionRange(at, at);
}

/** 欄の字を丸ごと置く(履歴・もう一度)。 */
export function setLine(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.focus();
}

export type ShellKeyResult = 'run' | 'handled' | null;

/**
 * 打つ欄のキー。
 * @returns `run` = 実行してほしい / `handled` = 握った / `null` = 触らない
 */
export function handleShellKeydown(
  ke: KeyboardEvent,
  input: HTMLInputElement,
  session: ShellSession,
  complete: (line: string) => Completion,
): ShellKeyResult {
  const plain = !ke.ctrlKey && !ke.metaKey && !ke.altKey;
  if (ke.key === 'Enter' && plain && !ke.shiftKey) {
    ke.preventDefault();
    return 'run';
  }
  if ((ke.key === 'ArrowUp' || ke.key === 'ArrowDown') && plain && !ke.shiftKey) {
    const dir = ke.key === 'ArrowUp' ? 'older' : 'newer';
    // 打ちかけは、履歴へ入る最初の 1 回で控える(`↓` で戻れる)
    if (session.at === -1 && dir === 'older') session.draft = input.value;
    const step = stepShellHistory(session.history, session.at, dir);
    ke.preventDefault();
    if (step === null) return 'handled';
    session.at = step.at;
    setLine(input, step.text ?? session.draft);
    closeCompletion(input);
    return 'handled';
  }
  if (ke.key === 'Tab' && plain && !ke.shiftKey) {
    // 欄が空のときは握らない(Tab で次の部品へ出る道を残す)
    if (input.value === '') return null;
    const c = complete(input.value);
    if (c.items.length === 0) return null;
    ke.preventDefault();
    const prefix = commonPrefix(c.items);
    if (c.items.length === 1) {
      const it = c.items[0]!;
      replaceRange(input, c.from, c.to, `${it.insert} `);
      closeCompletion(input);
      return 'handled';
    }
    const current = input.value.slice(c.from, c.to);
    if (prefix.length > current.length) replaceRange(input, c.from, c.to, prefix);
    const host = completeHostOf(input);
    if (host !== null) paintCompletion(host, complete(input.value));
    return 'handled';
  }
  if (ke.key === 'Escape' && plain) {
    const host = completeHostOf(input);
    if (host !== null && !host.hidden) {
      ke.preventDefault();
      ke.stopPropagation();
      paintCompletion(host, null);
      return 'handled';
    }
    if (input.value !== '') {
      ke.preventDefault();
      ke.stopPropagation();
      input.value = '';
      session.at = -1;
      return 'handled';
    }
  }
  return null;
}

/** 打つたびに候補を出し直す。履歴を遡っている途中で打ち直したら、遡りをやめる。 */
export function handleShellInput(input: HTMLInputElement, session: ShellSession, complete: (line: string) => Completion): void {
  session.at = -1;
  const host = completeHostOf(input);
  if (host === null) return;
  paintCompletion(host, input.value.trim() === '' ? null : complete(input.value));
}
