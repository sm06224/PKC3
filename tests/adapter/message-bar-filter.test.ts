/** @vitest-environment happy-dom */
/**
 * 🔴 **メッセージのノートを読む画面の、本文の上の帯**(台帳 #1852 束 L1。依頼 80-3 / 266)。
 *
 * 直す前は、画面下の「未読のメッセージ N 件」から開いたメッセージのノートには書き出す口が無く、
 * 種類(結果・注意・問題・配信)で絞る方法も無かった。
 * 守るもの:
 *   ① 帯に「すべて / 問題 / 注意 / 結果 / 配信」と「メッセージを書き出す」が出る(処理の記録は書き出すだけ)
 *   ② 種類のボタンを押すと、画面の本文がその種類の節だけになる(disk の本文は変えない)。押した印が見た目に出る
 *   ③ 「すべて」で元に戻る / 開き直すと「すべて」に戻る
 *   ④ 書き出しは絞っていても全部(絞りに引きずられない)
 * 守っていないもの:押された印の見た目の濃さ(実ブラウザの計算後の色 ── smoke)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { setMessageKindFilter } from '../../src/adapter/platform/message-filter';
import {
  formatMessageSection,
  SYSTEM_JOB_LID,
  SYSTEM_MESSAGE_LID,
  type MessageKind,
} from '../../src/features/message/message-log';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

const tick = (ms = 40): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

const sec = (kind: MessageKind, text: string, i: number): string =>
  formatMessageSection({ at: `2026-10-1${i % 9}T01:00:0${i % 9}.000Z`, kind, source: 'status', text });
const BODY = [
  sec('problem', '問題その一', 1),
  sec('result', '結果その一', 2),
  sec('caution', '注意その一', 3),
  sec('result', '結果その二', 4),
  sec('delivery', '配信その一', 5),
].join('');

function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  d.onState((s) => detail.render(s));
  const exported: string[] = [];
  bindActions(root, d, {
    readBodies: async (lids) => {
      exported.push(...lids);
      return new Map(lids.map((l) => [l, BODY]));
    },
  });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    // 本物の worker は sys-messages の本文を返す ── どの lid でも同じ本文を返す
    getBody: async () => BODY,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, d, sent, exported };
}

const shown = (root: HTMLElement): string => root.querySelector('[data-pkc-field="detail-body"]')?.textContent ?? '';
const chip = (root: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>('[data-pkc-action="set-message-filter"]')].find((b) => b.textContent === label);

beforeEach(() => setMessageKindFilter(null));
afterEach(() => setMessageKindFilter(null));

describe('メッセージのノートの上の帯(依頼 80-3 / 266)', () => {
  it('🔴 ① 種類のボタンと「メッセージを書き出す」が出る', async () => {
    const h = setup();
    h.d.dispatch({ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID });
    await tick();
    const labels = [...h.root.querySelectorAll('[data-pkc-action="set-message-filter"]')].map((b) => b.textContent);
    expect(labels).toEqual(['すべて', '問題', '注意', '結果', '配信']);
    const exp = h.root.querySelector<HTMLElement>('[data-pkc-field="detail-toolbar"] [data-pkc-action="export-messages"]');
    expect(exp?.textContent).toBe('メッセージを書き出す');
    expect(exp?.getAttribute('data-pkc-message-lid')).toBe(SYSTEM_MESSAGE_LID);
    // 編集の口は出さない(設計 doc §7)
    expect(h.root.querySelector('[data-pkc-action="start-edit"]'), '編集の口が出た').toBeNull();
  });

  it('🔴 ① 処理の記録は「処理の記録を書き出す」だけ(種類は 1 つなので絞りは出さない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'MESSAGES_READ', lid: SYSTEM_JOB_LID });
    await tick();
    expect(h.root.querySelectorAll('[data-pkc-action="set-message-filter"]')).toHaveLength(0);
    const exp = h.root.querySelector<HTMLElement>('[data-pkc-field="detail-toolbar"] [data-pkc-action="export-messages"]');
    expect(exp?.textContent).toBe('処理の記録を書き出す');
    expect(exp?.getAttribute('data-pkc-message-lid')).toBe(SYSTEM_JOB_LID);
  });

  it('🔴 ② 「問題」を押すと問題の節だけが出て、押した印が「問題」に移る', async () => {
    const h = setup();
    h.d.dispatch({ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID });
    await tick();
    // 前提:最初は全部出ている(対照 ── 絞る前の画面)
    expect(shown(h.root)).toContain('結果その一');
    expect(shown(h.root)).toContain('問題その一');
    expect(chip(h.root, 'すべて')?.getAttribute('aria-pressed')).toBe('true');

    chip(h.root, '問題')!.click();
    await tick();
    expect(shown(h.root), '問題が出ていない').toContain('問題その一');
    expect(shown(h.root), '絞ったのに結果が残っている').not.toContain('結果その一');
    expect(shown(h.root), '絞ったのに注意が残っている').not.toContain('注意その一');
    expect(chip(h.root, '問題')?.getAttribute('aria-pressed'), '押した印が移っていない').toBe('true');
    expect(chip(h.root, 'すべて')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('🔴 ② 絞りは「既読にしない」読み直しで効く(MESSAGES_READ を撃たない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID });
    await tick();
    h.sent.length = 0;
    chip(h.root, '結果')!.click();
    await tick();
    expect(h.sent.some((a) => a.type === 'MESSAGES_BODY_REFRESH')).toBe(true);
    expect(h.sent.some((a) => a.type === 'MESSAGES_READ'), '絞っただけで既読にした').toBe(false);
  });

  it('🔴 ③ 「すべて」で元に戻る。該当が 0 件の種類は空にせず 1 行で言う', async () => {
    const h = setup();
    h.d.dispatch({ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID });
    await tick();
    chip(h.root, '結果')!.click();
    await tick();
    expect(shown(h.root)).toContain('結果その二');
    expect(shown(h.root)).not.toContain('配信その一');
    chip(h.root, 'すべて')!.click();
    await tick();
    expect(shown(h.root), 'すべてに戻っても絞ったまま').toContain('配信その一');
  });

  it('🔴 ③ 開き直すと「すべて」に戻る(絞ったまま知らせが見えない画面で開かない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID });
    await tick();
    chip(h.root, '問題')!.click();
    await tick();
    expect(shown(h.root)).not.toContain('結果その一');
    // 「メッセージを開く」の押し口(binder)から開き直す
    const open = document.createElement('button');
    open.setAttribute('data-pkc-action', 'open-messages');
    open.setAttribute('data-pkc-message-lid', SYSTEM_MESSAGE_LID);
    h.root.append(open);
    open.click();
    await tick();
    expect(shown(h.root), '開き直しても絞ったまま').toContain('結果その一');
    expect(chip(h.root, 'すべて')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('🔴 ④ 絞っていても、書き出しは全部(帯のボタンは export-messages の受け手を通る)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID });
    await tick();
    chip(h.root, '問題')!.click();
    await tick();
    const exp = h.root.querySelector<HTMLElement>('[data-pkc-field="detail-toolbar"] [data-pkc-action="export-messages"]')!;
    // ダウンロードは起こさない(読み出しの口まで届くことを見る)
    const a = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    try {
      exp.click();
      await tick();
    } finally {
      HTMLAnchorElement.prototype.click = a;
    }
    expect(h.exported, '書き出しの読み出しに届いていない').toContain(SYSTEM_MESSAGE_LID);
  });
});
