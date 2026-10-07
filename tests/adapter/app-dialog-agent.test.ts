/** @vitest-environment happy-dom */
/**
 * ブラウザの AI に許すかを聞くダイアログ(#1407 段①)の 3 択。
 *
 * 守る主張:
 * 1. 1 行目は「何を」(探す語 / 題名)+ 裁定の字、2 行目は「この 1 回だけ」の動き
 * 2. ボタンは「この 1 回だけ」「常に許す」「許さない」の 3 つ
 * 3. 🔴 最初の焦点は「許さない」(取り消し側)── 打鍵の最中に出ても、続けた Space / Enter で通さない
 * 4. 🔴 押した行がそのまま答え / 「許さない」・Escape・外を押す は全部 deny
 * 5. 別のダイアログが開いていれば、閉じるのを待って順に出す(捨てない)
 * 6. 🔴 signal が abort されたら、待っている間は出さず、出ていれば閉じて deny
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  confirmInApp,
  DIALOG_REGION,
  pickAgentGrantInApp,
  resetAppDialogForTest,
} from '@adapter/ui/render/app-dialog';
import {
  AGENT_ASK_LABELS,
  AGENT_ASK_NOTE_MORE,
  AGENT_ASK_TITLE,
  agentAskNote,
  type AgentTarget,
} from '@features/agent/agent-gate';

const SEARCH: AgentTarget = { action: 'search', query: '買い物' };
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

  it('🔴 探す側の 1 行目: 探す語を出し、本文が AI の提供元へ送られると言う。2 行目は「続けて呼ばれると、そのたびに聞きます。」', async () => {
    const answered = pickAgentGrantInApp(host, SEARCH);
    expect(dialog().open).toBe(true);
    expect(q('[data-pkc-field="dialog-title"]').textContent).toBe(AGENT_ASK_TITLE);
    const note = q('[data-pkc-field="pick-agent-grant-note"]').textContent ?? '';
    expect(note).toBe(
      'ブラウザの AI が、『買い物』でノートを探して読もうとしています。許すと、当たったノートの本文が AI の提供元へ送られます。',
    );
    expect(note).toBe(agentAskNote(SEARCH));
    expect(q('[data-pkc-field="pick-agent-grant-note-more"]').textContent).toBe(
      '続けて呼ばれると、そのたびに聞きます。',
    );
    expect(AGENT_ASK_NOTE_MORE).toBe('続けて呼ばれると、そのたびに聞きます。');
    cancelBtn().click();
    expect(await answered).toBe('deny');
  });

  it('ボタンは「この 1 回だけ」「常に許す」と、取り消し側の「許さない」', async () => {
    const answered = pickAgentGrantInApp(host, SEARCH);
    expect(rows().map((b) => b.textContent)).toEqual(['この 1 回だけ', '常に許す']);
    expect(cancelBtn().textContent).toBe('許さない');
    expect(AGENT_ASK_LABELS).toEqual({ once: 'この 1 回だけ', always: '常に許す', deny: '許さない' });
    cancelBtn().click();
    await answered;
  });

  it('作る側の 1 行目は題名を出し、本文が送られるとは言わない(嘘を言わない)', async () => {
    const answered = pickAgentGrantInApp(host, { action: 'create', title: 'AI のメモ' });
    const note = q('[data-pkc-field="pick-agent-grant-note"]').textContent ?? '';
    expect(note).toBe('ブラウザの AI が、『AI のメモ』というノートを作ろうとしています。');
    expect(note).not.toContain('送られ');
    cancelBtn().click();
    await answered;
  });

  it('🔴 最初の焦点は「許さない」(取り消し側)── 通す 2 つのどちらでもない', async () => {
    const answered = pickAgentGrantInApp(host, SEARCH);
    expect(document.activeElement).toBe(cancelBtn());
    expect(rows()).not.toContain(document.activeElement);
    cancelBtn().click();
    await answered;
  });

  it('⚠ 対照群: 他の選ぶ器(焦点を指定しないもの)は、いままでどおり先頭の行が焦点', async () => {
    const { pickOfficeShadowInApp } = await import('@adapter/ui/render/app-dialog');
    const answered = pickOfficeShadowInApp(host, 1, 1);
    const first = document.querySelector<HTMLButtonElement>('[data-pkc-field="pick-office-shadow"]');
    expect(document.activeElement).toBe(first);
    cancelBtn().click();
    await answered;
  });

  it('押した行がそのまま答え: この 1 回だけ → once / 常に許す → always', async () => {
    const a = pickAgentGrantInApp(host, SEARCH);
    rows()[0]!.click();
    expect(await a).toBe('once');
    const b = pickAgentGrantInApp(host, SEARCH);
    rows()[1]!.click();
    expect(await b).toBe('always');
  });

  it('🔴 「許さない」・外(暗い地)・Escape は全部 deny ── 押し損ねで通さない', async () => {
    const a = pickAgentGrantInApp(host, SEARCH);
    cancelBtn().click();
    expect(await a).toBe('deny');
    const b = pickAgentGrantInApp(host, SEARCH);
    dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await b).toBe('deny');
    const c = pickAgentGrantInApp(host, SEARCH);
    dialog().close(); // Escape と同じ(押さずに閉じる)
    expect(await c).toBe('deny');
  });

  it('別のダイアログが開いていれば待って、閉じたら順に出す(捨てない)', async () => {
    const first = confirmInApp(host, '削除しますか?');
    const asked = pickAgentGrantInApp(host, SEARCH);
    let settled = false;
    void asked.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    expect(q('[data-pkc-field="dialog-body"]').textContent).toBe('削除しますか?');
    cancelBtn().click();
    await first;
    await tick();
    expect(rows().map((b) => b.textContent)).toEqual(['この 1 回だけ', '常に許す']);
    rows()[0]!.click();
    expect(await asked).toBe('once');
  });

  it('「許さない」の字は他のダイアログへ持ち越さない(次の確認は「やめる」に戻る)', async () => {
    const a = pickAgentGrantInApp(host, SEARCH);
    cancelBtn().click();
    await a;
    const next = confirmInApp(host, '続けますか?');
    expect(cancelBtn().textContent).toBe('やめる');
    cancelBtn().click();
    await next;
  });

  describe('🔴 signal(AI が依頼を取り消した)', () => {
    it('出ているダイアログを閉じて deny にする', async () => {
      const ac = new AbortController();
      const answered = pickAgentGrantInApp(host, SEARCH, ac.signal);
      expect(dialog().open).toBe(true);
      ac.abort();
      expect(await answered).toBe('deny');
      expect(dialog().open, '取り消されたのにダイアログが残っている').toBe(false);
    });

    it('取り消し済みなら、そもそも出さない', async () => {
      const ac = new AbortController();
      ac.abort();
      expect(await pickAgentGrantInApp(host, SEARCH, ac.signal)).toBe('deny');
      expect(document.querySelector(`[data-pkc-region="${DIALOG_REGION}"]`)).toBeNull();
    });

    it('順番を待っている間に取り消されたら、順番が来ても出さない(前のダイアログは影響を受けない)', async () => {
      const first = confirmInApp(host, '削除しますか?');
      const ac = new AbortController();
      const waiting = pickAgentGrantInApp(host, SEARCH, ac.signal);
      await tick();
      ac.abort();
      cancelBtn().click(); // 前のダイアログを閉じる
      await first;
      expect(await waiting).toBe('deny');
      expect(dialog().open, '取り消された依頼のダイアログが出た').toBe(false);
    });

    it('対照群: 取り消されなければ、signal つきでも普通に答えられる', async () => {
      const ac = new AbortController();
      const a = pickAgentGrantInApp(host, SEARCH, ac.signal);
      rows()[1]!.click();
      expect(await a).toBe('always');
    });

    it('答えた後に abort しても、次のダイアログを閉じない(listener を外している)', async () => {
      const ac = new AbortController();
      const a = pickAgentGrantInApp(host, SEARCH, ac.signal);
      rows()[0]!.click();
      await a;
      const next = confirmInApp(host, '続けますか?');
      ac.abort();
      expect(dialog().open, '前の依頼の abort が次のダイアログを閉じた').toBe(true);
      cancelBtn().click();
      await next;
    });
  });
});
