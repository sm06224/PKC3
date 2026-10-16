/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の面 ── 目盛りに置けない予定と、空のときの理由**(#1087)。
 *
 * ① 暦に無い日付(`@2026-02-30`)の予定は、一覧に出るのに「日 / 週 / 月」では黙って消えていた
 *    ── 日付なしの束と同じ場所に出す
 * ② 日付を書いた予定が「片付けたノート」にだけ在るとき、空の理由が「まだありません」と言っていた
 *
 * ⚠ 観測点は面(`schedule-group` の region)の中。root 全体の `textContent` で探すと
 *   別の面・お知らせの字に満たされる。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

const TODAY = new Date(2026, 7, 23);

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

function setup(bodies: Record<string, string>, archived: ReadonlySet<string> = new Set()) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const host = document.createElement('div');
  host.setAttribute('data-pkc-view-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d, {});
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((lid) => meta(lid, archived.has(lid) ? { archived: true } : {})),
    relations: [],
  });
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  d.dispatch({
    type: 'SET_TASK_SCAN',
    scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
  });
  const groupsText = (): string =>
    [...root.querySelectorAll('[data-pkc-region="schedule-group"]')]
      .map((g) => g.textContent ?? '')
      .join('\n');
  const noteText = (): string =>
    root.querySelector('[data-pkc-field="schedule-note"]')?.textContent ?? '';
  return { d, root, groupsText, noteText };
}

const BODY =
  '- [ ] 二月三十日 @2026-02-30\n- [ ] 十三月 @2026-13-01\n- [ ] 普通の予定 @2026-08-25\n';

describe('暦に無い日付の予定は、どの見せ方でも出る(#1087)', () => {
  it.each(['list', 'day', 'week', 'month'] as const)('🔴 %s でも出る', (mode) => {
    const { d, groupsText } = setup({ e1: BODY });
    d.dispatch({ type: 'SET_SCHEDULE_MODE', mode });
    const text = groupsText();
    expect(text, `${mode}: 暦に無い日の予定が消えた`).toContain('二月三十日');
    expect(text, `${mode}: 暦に無い日の予定が消えた`).toContain('十三月');
  });

  it('対照群: 実在する日の予定は、一覧では束に出て、週では束の器に重ねない', () => {
    const { d, groupsText } = setup({ e1: BODY });
    expect(groupsText()).toContain('普通の予定');
    d.dispatch({ type: 'SET_SCHEDULE_MODE', mode: 'week' });
    expect(groupsText(), '目盛りに置ける予定を二重に出した').not.toContain('普通の予定');
  });
});

describe('空の理由 ── 片付けたノートにだけ予定が在るとき(#1087)', () => {
  it('🔴 「まだありません」とは言わず、片付けたものを出すよう案内する', () => {
    const { noteText } = setup({ e1: '- [ ] 予定 @2026-08-25\n' }, new Set(['e1']));
    expect(noteText()).toBe(
      '片付けたノートの予定は隠れています。「出すもの」で「片付けたもの」を出すと見えます。',
    );
  });

  it('案内の字は画面に実在する(「片付けたもの」の切替の字)', () => {
    const { root } = setup({ e1: '- [ ] 予定 @2026-08-25\n' }, new Set(['e1']));
    const label = root.querySelector('[data-pkc-action="toggle-show-archived"]')?.closest('label');
    expect(label?.textContent).toContain('片付けたもの');
  });

  it('対照群: 片付けていないノートに日付が無ければ、従来の「まだありません」', () => {
    const { noteText } = setup({ e1: '- [ ] 日付なし\n' });
    expect(noteText()).toContain('日付を書いた予定がまだありません');
  });

  it('対照群: 片付けたものを出していれば、予定が出て理由は要らない', () => {
    const { root, noteText, groupsText } = setup(
      { e1: '- [ ] 予定 @2026-08-25\n' },
      new Set(['e1']),
    );
    root.querySelector<HTMLElement>('[data-pkc-action="toggle-show-archived"]')!.click();
    expect(groupsText()).toContain('予定');
    expect(noteText()).toBe('');
  });
});
