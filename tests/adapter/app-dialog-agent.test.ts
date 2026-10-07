/** @vitest-environment happy-dom */
/**
 * ブラウザの AI に許すかを聞くダイアログ(#1407 段①)の 3 択。
 *
 * 守る主張:
 * 1. 文は裁定の字(読む側は「本文が AI の提供元へ送られます」と言う / 書く側は作ること)
 * 2. ボタンは「今回だけ」「常に許す」「許さない」の 3 つ。先頭(焦点)は「今回だけ」── 「常に許す」を既定にしない
 * 3. 🔴 押した行がそのまま答え / 「許さない」・Escape・外を押す は全部 deny(押し損ねで通さない)
 * 4. 別のダイアログが開いていれば、閉じるのを待って順に出す(捨てない)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  confirmInApp,
  DIALOG_REGION,
  pickAgentGrantInApp,
  resetAppDialogForTest,
} from '@adapter/ui/render/app-dialog';
import { AGENT_ASK_LABELS, AGENT_ASK_NOTE, AGENT_ASK_TITLE } from '@features/agent/agent-gate';

const q = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel) as T;
const dialog = (): HTMLDialogElement => q<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
const cancelBtn = (): HTMLButtonElement => q<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]');
const rows = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-agent-grant"]'));
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('pickAgentGrantInApp', () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    host = document.createElement('div');
    document.body.append(host);
  });

  it('🔴 読む側の文: 本文が AI の提供元へ送られると言う。3 つのボタンが裁定の字', async () => {
    const answered = pickAgentGrantInApp(host, 'read');
    expect(dialog().open).toBe(true);
    expect(q('[data-pkc-field="dialog-title"]').textContent).toBe(AGENT_ASK_TITLE);
    const note = q('[data-pkc-field="pick-agent-grant-note"]').textContent ?? '';
    expect(note).toBe(
      'ブラウザの AI が、ノートを探して読もうとしています。許すと、見つかったノートの本文が AI の提供元へ送られます。',
    );
    expect(note).toBe(AGENT_ASK_NOTE.read);
    expect(rows().map((b) => b.textContent)).toEqual(['今回だけ', '常に許す']);
    expect(cancelBtn().textContent).toBe('許さない');
    expect(AGENT_ASK_LABELS).toEqual({ once: '今回だけ', always: '常に許す', deny: '許さない' });
    cancelBtn().click();
    expect(await answered).toBe('deny');
  });

  it('書く側の文は作ること。本文が送られるとは言わない(嘘を言わない)', async () => {
    const answered = pickAgentGrantInApp(host, 'write');
    const note = q('[data-pkc-field="pick-agent-grant-note"]').textContent ?? '';
    expect(note).toBe('ブラウザの AI が、ノートを作ろうとしています。');
    expect(note).not.toContain('送られ');
    cancelBtn().click();
    await answered;
  });

  it('🔴 既定の焦点は「今回だけ」(「常に許す」を既定にしない)', async () => {
    const answered = pickAgentGrantInApp(host, 'read');
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0]!.textContent).toBe('今回だけ');
    cancelBtn().click();
    await answered;
  });

  it('押した行がそのまま答え: 今回だけ → once / 常に許す → always', async () => {
    const a = pickAgentGrantInApp(host, 'read');
    rows()[0]!.click();
    expect(await a).toBe('once');
    const b = pickAgentGrantInApp(host, 'read');
    rows()[1]!.click();
    expect(await b).toBe('always');
  });

  it('🔴 「許さない」・外(暗い地)・Escape は全部 deny ── 押し損ねで通さない', async () => {
    const a = pickAgentGrantInApp(host, 'write');
    cancelBtn().click();
    expect(await a).toBe('deny');
    const b = pickAgentGrantInApp(host, 'write');
    dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await b).toBe('deny');
    const c = pickAgentGrantInApp(host, 'write');
    dialog().close(); // Escape と同じ(押さずに閉じる)
    expect(await c).toBe('deny');
  });

  it('別のダイアログが開いていれば待って、閉じたら順に出す(捨てない)', async () => {
    const first = confirmInApp(host, '削除しますか?');
    const asked = pickAgentGrantInApp(host, 'read');
    let settled = false;
    void asked.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    expect(q('[data-pkc-field="dialog-body"]').textContent).toBe('削除しますか?');
    cancelBtn().click();
    await first;
    await tick();
    expect(rows().map((b) => b.textContent)).toEqual(['今回だけ', '常に許す']);
    rows()[0]!.click();
    expect(await asked).toBe('once');
  });

  it('「許さない」の字は他のダイアログへ持ち越さない(次の確認は「やめる」に戻る)', async () => {
    const a = pickAgentGrantInApp(host, 'read');
    cancelBtn().click();
    await a;
    const next = confirmInApp(host, '続けますか?');
    expect(cancelBtn().textContent).toBe('やめる');
    cancelBtn().click();
    await next;
  });
});
