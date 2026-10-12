/** @vitest-environment happy-dom */
/**
 * 🔴 別のタブ・窓が編集中のノートへは、**追記の口の全部**が断る(#529 W5-d。Gemini 裁定 Q5 = A)。
 *
 * ## user の物語
 * 別のタブでノートを編集している。このタブで、本文の下の「本文に追記する」(または PDF の「ノートへ引く」/
 * ブラウザの AI の書き足し)で同じノートへ足す。⚠ 直す前は通り、編集中のタブの保存で**上書きされて**
 * 足した字は履歴にだけ残った。いまは**断って理由を出し、打った字は欄に残る**。
 *
 * 守るもの: ① 本文の下の追記欄 ② PDF の引用 ③ AI の書き足し(`pkc_append_note`)── いずれも
 * 「他のタブが握っていたら何も書かない」「取れた(対照群)なら書く・錠は握り続けず返す」。
 * 板の付箋の追記・題名は `place-inline.test.ts`、チェックは `place-task.test.ts` が持つ。
 * ⚠ main.ts の配線(AI / PDF が同じ口を通ること)は main を起動できないので**字の pin**で見る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, reduce, type DomainEvent } from '../../src/adapter/state/app-state';
import { appendUnlessEditedElsewhere } from '../../src/adapter/state/edited-elsewhere';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { quoteIntoNote } from '../../src/adapter/platform/pdf/quote-into-note';
import type { PdfSession } from '../../src/adapter/platform/pdf/pdf-window';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';

const meta = (lid: string, archetype = 'text', title = lid): never =>
  ({
    lid,
    title,
    archetype,
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date: null,
    archived: 0,
  }) as never;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const requests = (events: DomainEvent[]) =>
  events.filter((e): e is Extract<DomainEvent, { type: 'REQUEST_APPEND' }> => e.type === 'REQUEST_APPEND');

/** 本文の下の追記欄(`append-input` + `append-entry` ボタン)を実物の binder に繋ぐ。 */
function panel(services: Partial<BinderServices>) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const input = document.createElement('textarea');
  input.setAttribute('data-pkc-field', 'append-input');
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', 'append-entry');
  root.append(input, btn);
  document.body.append(root);
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  bindActions(root, d, { showStatus: () => {}, ...services });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
  events.length = 0;
  return { d, events, input, btn };
}

describe('① 本文の下の追記欄(append-entry)', () => {
  it('🔴 別のタブが握っていたら何も書かず、理由を出し、打った字は欄に残る', async () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const release = vi.fn();
    const t = panel({ acquireEditLock: acquire, releaseEditLock: release });
    t.input.value = '残す字';
    t.btn.click();
    await flush();
    expect(acquire).toHaveBeenCalledWith('n1');
    expect(requests(t.events), '断られたのに追記を撃った').toHaveLength(0);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
    expect(t.input.value, '打った字が消えた').toBe('残す字');
    expect(t.input.hasAttribute('data-pkc-busy'), '問い合わせの印が残った(次の押しが空振りする)').toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it('対照群:取れたら錠を握り続けずに返し、追記が撃たれる', async () => {
    const acquire = vi.fn(async () => 'granted' as const);
    const release = vi.fn();
    const t = panel({ acquireEditLock: acquire, releaseEditLock: release });
    t.input.value = '通る字';
    t.btn.click();
    await flush();
    expect(release).toHaveBeenCalledWith('n1');
    const r = requests(t.events);
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toBe('通る字');
  });

  it('メインと通信できない(unreachable)ときは断らない', async () => {
    const t = panel({ acquireEditLock: async () => 'unreachable', releaseEditLock: vi.fn() });
    t.input.value = '字';
    t.btn.click();
    await flush();
    expect(requests(t.events)).toHaveLength(1);
  });

  it('問い合わせの間に 2 回押しても 1 回しか撃たない', async () => {
    const acquire = vi.fn(async () => 'granted' as const);
    const t = panel({ acquireEditLock: acquire, releaseEditLock: vi.fn() });
    t.input.value = '字';
    t.btn.click();
    t.btn.click();
    await flush();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(requests(t.events)).toHaveLength(1);
  });

  it('字が空なら問い合わせず、従来どおり同期で reducer が断る', () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const t = panel({ acquireEditLock: acquire, releaseEditLock: vi.fn() });
    t.input.value = '  ';
    t.btn.click();
    expect(acquire).not.toHaveBeenCalled();
    expect(requests(t.events)).toHaveLength(0);
  });

  it('口の無い環境は従来どおり同期で撃つ(非同期に変えない)', () => {
    const t = panel({});
    t.input.value = '字';
    t.btn.click();
    expect(requests(t.events)).toHaveLength(1);
  });

  it('このタブが自分で編集中のノートは問い合わせない(自分の錠を手放さない)', async () => {
    const acquire = vi.fn(async () => 'granted' as const);
    const t = panel({ acquireEditLock: acquire, releaseEditLock: vi.fn() });
    t.d.dispatch({ type: 'START_EDIT' });
    expect(t.d.getState().phase).toBe('editing');
    t.input.value = '字';
    t.btn.click();
    await flush();
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('② PDF の「ノートへ引く」(quoteIntoNote)', () => {
  const session: PdfSession = { token: 't', assetKey: 'k', name: '報告書.pdf', lid: 'att' };
  const rig = () => {
    const booted = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('att', 'attachment', '添付題')],
      relations: [],
    }).state;
    const d = new Dispatcher(booted);
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    return { d, events };
  };

  it('🔴 別のタブが握っていたら何も書かず、理由を窓へ返す', async () => {
    const g = rig();
    const note = vi.fn();
    const r = await quoteIntoNote(g.d, session, '字', 3, note, undefined, {
      acquireEditLock: async () => 'denied',
      releaseEditLock: vi.fn(),
    });
    expect(r).toEqual({ ok: false, message: EDIT_ELSEWHERE_ERROR });
    expect(requests(g.events), '断られたのに追記を撃った').toHaveLength(0);
    expect(note, '「引きました」と言った').not.toHaveBeenCalled();
  });

  it('対照群:取れたら錠を返して追記が撃たれる', async () => {
    const g = rig();
    const release = vi.fn();
    const p = quoteIntoNote(g.d, session, '字', 3, vi.fn(), undefined, {
      acquireEditLock: async () => 'granted',
      releaseEditLock: release,
    });
    await flush();
    expect(release).toHaveBeenCalledWith('att');
    expect(requests(g.events)).toHaveLength(1);
    void p;
  });
});

describe('③ AI の書き足し(pkc_append_note が使う appendUnlessEditedElsewhere)', () => {
  const rig = () => {
    const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] }).state;
    const d = new Dispatcher(booted);
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    return { d, events };
  };

  it('🔴 別のタブが握っていたら refused + 理由(ツールはこれを fail の字にする)で、何も書かない', async () => {
    const g = rig();
    const r = await appendUnlessEditedElsewhere(
      g.d,
      { acquireEditLock: async () => 'denied', releaseEditLock: vi.fn() },
      'n1',
      '字',
      null,
      1000,
    );
    expect(r).toEqual({ ok: false, reason: 'refused', error: EDIT_ELSEWHERE_ERROR });
    expect(requests(g.events)).toHaveLength(0);
  });

  it('対照群:取れたら錠を返し、追記が撃たれる', async () => {
    const g = rig();
    const release = vi.fn();
    const p = appendUnlessEditedElsewhere(
      g.d,
      { acquireEditLock: async () => 'granted', releaseEditLock: release },
      'n1',
      '字',
      null,
      1000,
    );
    await flush();
    expect(release).toHaveBeenCalledWith('n1');
    expect(requests(g.events)).toHaveLength(1);
    void p;
  });
});

describe('main.ts の配線(起動できないので字で pin する)', () => {
  const src = readFileSync('src/main.ts', 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  it('AI の書き足しが同じ口(問い合わせつき)を通る', () => {
    expect(src).toMatch(/append: \(id: string, text: string, heading: string \| null\) =>\s*appendUnlessEditedElsewhere\(dispatcher, editLockPort,/);
  });
  it('PDF の引用が同じ口(問い合わせつき)を通る', () => {
    expect(src).toMatch(/quoteIntoNote\(dispatcher, session, text, page, showStatus, undefined, editLockPort\)/);
  });
});
