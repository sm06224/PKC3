/** @vitest-environment happy-dom */
/**
 * 🔴 **担当(owner)── エントリ / グループを「タスク」として扱う**(#283 の残り)。
 *
 * 守る主張:
 * 1. 行の `担当:名前` > ノートの前書き `owner:` の順で札に載る / 走査(noteTimes)は担当だけのノートも運ぶ
 * 2. 予定の面を担当で絞れる(全員 / 担当なし / 名前)。選択肢は担当を書いた予定がある間だけ出る
 * 3. 情報ペインの「担当」の行: 付ける・変える・外す(双方向)/ 連絡先と字が一致する名前は押せる札
 * 4. 書換は既存の `frontmatter` 1 本(新しい書込経路を作らない)── 保存された本文を見る
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { scheduleItemsOf } from '../../src/adapter/ui/render/schedule-items';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { noteOwnerFor, noteTimeOf, replaceNoteTime, replaceTaskCards, taskCardsOf } from '../../src/features/schedule/task-cards';
import {
  contactLidFor,
  ownerChoices,
  ownerOfText,
  passesOwnerFilter,
} from '../../src/features/schedule/owner';
import { readScheduleOwner } from '../../src/features/schedule/schedule-keys';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';

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

describe('担当の読み方(pure)', () => {
  it('行の「担当:名前」を読む(全角コロン・前後の空白・句読点の手前まで)', () => {
    expect(ownerOfText('見積を送る 担当:田中')).toBe('田中');
    expect(ownerOfText('見積を送る 担当：田中、確認は鈴木')).toBe('田中');
    expect(ownerOfText('担当: 佐藤 #急ぎ')).toBe('佐藤');
    expect(ownerOfText('見積を送る')).toBeNull();
    // 語の途中の「担当:」は拾わない(「営業担当:」は別の語)
    expect(ownerOfText('営業担当:田中')).toBeNull();
  });

  it('前書きの owner: を読む(空・文字以外は無し)', () => {
    expect(readScheduleOwner(parseFrontmatter('---\nowner: 田中\n---\n本文').meta)).toBe('田中');
    expect(readScheduleOwner(parseFrontmatter('---\nowner: ""\n---\n本文').meta)).toBeNull();
    expect(readScheduleOwner(parseFrontmatter('本文').meta)).toBeNull();
  });

  it('選択肢は重複なし・空を除く / 絞りは null=全員・空文字=担当なし・名前', () => {
    expect(ownerChoices(['鈴木', null, '田中', '鈴木', undefined, ''])).toEqual(['田中', '鈴木']);
    expect(passesOwnerFilter('田中', null)).toBe(true);
    expect(passesOwnerFilter(null, '')).toBe(true);
    expect(passesOwnerFilter('田中', '')).toBe(false);
    expect(passesOwnerFilter('田中', '田中')).toBe(true);
    expect(passesOwnerFilter('鈴木', '田中')).toBe(false);
    expect(passesOwnerFilter(null, '田中')).toBe(false);
  });

  it('連絡先との突き合わせは題名の完全一致(敬称付きは一致しない)', () => {
    const cards = [
      { lid: 'c1', name: '田中' },
      { lid: 'c2', name: '田中 太郎' },
    ];
    expect(contactLidFor('田中', cards)).toBe('c1');
    expect(contactLidFor('田中さん', cards)).toBeNull();
    expect(contactLidFor('田中', [])).toBeNull();
  });
});

describe('担当が札と走査に載る', () => {
  it('行の担当 > ノートの担当 > 無し', () => {
    const body = '---\nowner: 鈴木\n---\n- [ ] A 担当:田中\n- [ ] B\n';
    const cards = taskCardsOf('e1', body);
    expect(cards.map((c) => c.owner)).toEqual(['田中', '鈴木']);
    expect(taskCardsOf('e2', '- [ ] C\n')[0]!.owner).toBeNull();
  });

  it('担当だけを書いた(時刻の無い)日付つきノートも noteTimes に載る / 日付だけのノートは載らない', () => {
    expect(noteTimeOf('n1', '---\ndate: 2026-10-20\nowner: 田中\n---\n')).toEqual({
      lid: 'n1',
      date: '2026-10-20',
      time: null,
      owner: '田中',
    });
    expect(noteTimeOf('n2', '---\ndate: 2026-10-20\n---\n')).toBeNull();
    // 時刻つきは今までどおり(owner キーは無い)
    expect(noteTimeOf('n3', '---\ndate: 2026-10-20 14:00\n---\n')).toEqual({ lid: 'n3', date: '2026-10-20', time: '14:00' });
    expect(noteOwnerFor({ noteTimes: [{ lid: 'n1', date: '2026-10-20', time: null, owner: '田中' }] }, 'n1', '2026-10-20')).toBe('田中');
    // 抽出列の日付と食い違う組は使わない
    expect(noteOwnerFor({ noteTimes: [{ lid: 'n1', date: '2026-10-20', time: null, owner: '田中' }] }, 'n1', '2026-10-21')).toBeNull();
  });
});

function stateWith(bodies: Record<string, string>, dates: Record<string, string> = {}): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [...new Set([...Object.keys(bodies), ...Object.keys(dates)])].map((lid) =>
      meta(lid, dates[lid] === undefined ? {} : { date: dates[lid]! }),
    ),
    relations: [],
  }).state;
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  const noteTimes = Object.entries(bodies)
    .map(([lid, body]) => noteTimeOf(lid, body))
    .filter((x) => x !== null);
  s = reduce(s, {
    type: 'SET_TASK_SCAN',
    scan: { cards, noteTimes, totalNotes: 1, scannedNotes: 1, truncated: false },
  }).state;
  return s;
}

const BODIES = {
  e1: '- [ ] 見積 @2026-10-20 担当:田中\n- [ ] 発注 @2026-10-21 担当:鈴木\n- [ ] 会議 @2026-10-22\n',
  e2: '---\ndate: 2026-10-23\nowner: 田中\n---\n本文\n',
};

describe('予定の面を担当で絞る', () => {
  it('全員 / 担当なし / 名前 で、札とノート 1 件の予定の両方が絞られ、選択肢が出る', () => {
    let s = stateWith(BODIES, { e2: '2026-10-23' });
    expect(scheduleItemsOf(s).owners).toEqual(['田中', '鈴木']);
    expect(scheduleItemsOf(s).items.map((i) => i.text).sort()).toEqual(['t-e2', '会議', '発注 担当:鈴木', '見積 担当:田中'].sort());
    s = reduce(s, { type: 'SET_SCHEDULE_OWNER', owner: '田中' }).state;
    expect(scheduleItemsOf(s).items.map((i) => i.text).sort()).toEqual(['t-e2', '見積 担当:田中'].sort());
    s = reduce(s, { type: 'SET_SCHEDULE_OWNER', owner: '' }).state;
    expect(scheduleItemsOf(s).items.map((i) => i.text)).toEqual(['会議']);
    s = reduce(s, { type: 'SET_SCHEDULE_OWNER', owner: null }).state;
    expect(scheduleItemsOf(s).items).toHaveLength(4);
    // 選択肢は絞っても減らない(絞る前の全部の担当)
    s = reduce(s, { type: 'SET_SCHEDULE_OWNER', owner: '鈴木' }).state;
    expect(scheduleItemsOf(s).owners).toEqual(['田中', '鈴木']);
  });

  it('担当を書いた予定が無ければ選択肢は空', () => {
    const s = stateWith({ e1: '- [ ] 会議 @2026-10-22\n' });
    expect(scheduleItemsOf(s).owners).toEqual([]);
  });

  it('同じ値を選び直しても状態は動かない(参照が同じ)', () => {
    const s = reduce(stateWith(BODIES), { type: 'SET_SCHEDULE_OWNER', owner: '田中' }).state;
    const r = reduce(s, { type: 'SET_SCHEDULE_OWNER', owner: '田中' });
    expect(r.state).toBe(s);
  });
});

describe('予定の面の「担当」の選択(DOM)', () => {
  function rig(bodies: Record<string, string>, dates: Record<string, string> = {}) {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const host = document.createElement('div');
    host.setAttribute('data-pkc-browse-pane', 'schedule');
    regions.browseHost.append(host);
    const view = new ScheduleRenderer(host, () => new Date(2026, 9, 20));
    d.onState((s) => view.render(s));
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: Object.keys(bodies).map((lid) => meta(lid, dates[lid] === undefined ? {} : { date: dates[lid]! })),
      relations: [],
    });
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: {
        cards: Object.entries(bodies).flatMap(([lid, b]) => taskCardsOf(lid, b)),
        noteTimes: Object.entries(bodies).map(([lid, b]) => noteTimeOf(lid, b)).filter((x) => x !== null),
        totalNotes: 1,
        scannedNotes: 1,
        truncated: false,
      },
    });
    const sel = (): HTMLSelectElement => root.querySelector<HTMLSelectElement>('[data-pkc-field="schedule-owner"]')!;
    const shown = (): string[] =>
      [...root.querySelectorAll<HTMLElement>('[data-pkc-region="schedule-cards"] [data-pkc-field="text"]')].map(
        (e) => e.textContent ?? '',
      );
    return { d, sel, shown };
  }

  it('担当を書いた予定があれば選択肢が出て、選ぶと札が絞られ、「すべて」で戻る(双方向)', () => {
    const r = rig(BODIES, { e2: '2026-10-23' });
    expect(r.sel().hidden).toBe(false);
    expect([...r.sel().options].map((o) => o.textContent)).toEqual(['担当: すべて', '担当なし', '田中', '鈴木']);
    expect(r.shown().some((t) => t.includes('会議'))).toBe(true);
    r.sel().value = '田中';
    r.sel().dispatchEvent(new Event('change', { bubbles: true }));
    expect(r.d.getState().scheduleOwner).toBe('田中');
    expect(r.shown().some((t) => t.includes('見積'))).toBe(true);
    expect(r.shown().some((t) => t.includes('会議') || t.includes('発注'))).toBe(false);
    expect(r.sel().value).toBe('田中');
    r.sel().value = '\u0000none';
    r.sel().dispatchEvent(new Event('change', { bubbles: true }));
    expect(r.d.getState().scheduleOwner).toBe('');
    expect(r.shown().filter((t) => t.includes('会議'))).toHaveLength(1);
    r.sel().value = '\u0000all';
    r.sel().dispatchEvent(new Event('change', { bubbles: true }));
    expect(r.d.getState().scheduleOwner).toBeNull();
    expect(r.shown().some((t) => t.includes('発注'))).toBe(true);
  });

  it('担当を書いた予定が無ければ選択肢は出さない(押しても何も起きない口を作らない)', () => {
    const r = rig({ e1: '- [ ] 会議 @2026-10-20\n' });
    expect(r.sel().hidden).toBe(true);
  });
});

describe('情報ペインの「担当」の行', () => {
  function rig(body: string, opts: { contact?: boolean } = {}) {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1'), meta('c1', { title: '田中' })],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'n1', body }).state;
    if (opts.contact === true)
      s = {
        ...s,
        contactScan: { cards: [{ lid: 'c1', name: '田中' }], totalNotes: 1, scannedNotes: 1, truncated: false } as never,
      };
    inspector.render(s);
    const dd = (): HTMLElement => root.querySelector<HTMLElement>('[data-pkc-field="inspector-owner"]')!;
    return { root, dd, inspector, s };
  }

  it('担当が無いと「担当を付ける」だけ(外すは出ない)', () => {
    const r = rig('本文\n');
    expect(r.dd().hidden).toBe(false);
    const set = r.dd().querySelector('[data-pkc-action="set-entry-owner"]')!;
    expect(set.textContent).toBe('担当を付ける');
    expect((r.dd().querySelector('[data-pkc-action="clear-entry-owner"]') as HTMLElement).hidden).toBe(true);
    expect(r.dd().querySelector('[data-pkc-field="inspector-owner-name"]')).toBeNull();
  });

  it('担当があると名前と「担当を変える」「担当を外す」が出る / 連絡先と一致しなければ字のまま', () => {
    const r = rig('---\nowner: 田中\n---\n本文\n');
    const name = r.dd().querySelector('[data-pkc-field="inspector-owner-name"]')!;
    expect(name.textContent).toBe('田中');
    expect(name.tagName).toBe('SPAN');
    expect(r.dd().querySelector('[data-pkc-action="set-entry-owner"]')!.textContent).toBe('担当を変える');
    expect((r.dd().querySelector('[data-pkc-action="clear-entry-owner"]') as HTMLElement).hidden).toBe(false);
  });

  it('連絡先の題名と一致する名前は、連絡先へ飛べる札になる', () => {
    const r = rig('---\nowner: 田中\n---\n本文\n', { contact: true });
    const name = r.dd().querySelector('[data-pkc-field="inspector-owner-name"]')!;
    expect(name.tagName).toBe('BUTTON');
    expect(name.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(name.getAttribute('data-pkc-entry')).toBe('c1');
  });

  it('本文がまだ来ていない間は行ごと畳む(「無し」と嘘をつかない)', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    inspector.render(s);
    expect(root.querySelector<HTMLElement>('[data-pkc-field="inspector-owner"]')!.hidden).toBe(true);
  });
});

describe('担当の書換(frontmatter 1 本)', () => {
  it('SET_ENTRY_OWNER は既存の frontmatter 書換の event を出す / 外すは undefined', () => {
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    const r = reduce(s, { type: 'SET_ENTRY_OWNER', lid: 'n1', owner: '  田中  太郎 ' });
    const ev = r.events.find((e) => e.type === 'REQUEST_BODY_REWRITE') as never as {
      rewrite: { kind: string; keys: Record<string, string | undefined> };
    };
    expect(ev.rewrite).toEqual({ kind: 'frontmatter', keys: { owner: '田中 太郎' } });
    const off = reduce(s, { type: 'SET_ENTRY_OWNER', lid: 'n1', owner: null });
    const ev2 = off.events.find((e) => e.type === 'REQUEST_BODY_REWRITE') as never as {
      rewrite: { keys: Record<string, string | undefined> };
    };
    expect('owner' in ev2.rewrite.keys && ev2.rewrite.keys['owner'] === undefined).toBe(true);
    // 空の名前は何も書かない
    expect(reduce(s, { type: 'SET_ENTRY_OWNER', lid: 'n1', owner: '   ' }).events).toEqual([]);
  });

  it('本文に当てると owner: が入り、外すと消える(往復で他は 1 バイトも変わらない)', () => {
    const body = '---\ndate: 2026-10-20\n---\n本文\n';
    const withOwner = applyBodyRewrite(body, { kind: 'frontmatter', keys: { owner: '田中' } });
    expect(withOwner).toContain('owner: 田中');
    expect(readScheduleOwner(parseFrontmatter(withOwner!).meta)).toBe('田中');
    const back = applyBodyRewrite(withOwner!, { kind: 'frontmatter', keys: { owner: undefined } });
    expect(back).toBe(body);
  });
});

describe('担当だけを書き換えたときも、変化を拾う(#283 レビュー テストの穴 B)', () => {
  it('🔴 replaceTaskCards: 行の 担当: だけを直しても「同じ」と見なさず、新しい札を返す(画面の担当が古いまま残らない)', () => {
    const before = taskCardsOf('e1', '- [ ] 見積 @2026-10-20 担当:田中\n');
    const after = replaceTaskCards(before, 'e1', '- [ ] 見積 @2026-10-20 担当:鈴木\n');
    expect(after, '担当だけの変更が「同じ」と判定された').not.toBe(before);
    expect(after[0]!.owner).toBe('鈴木');
    // 対照群: 何も変えなければ同じ配列(描き直しを増やさない)
    expect(replaceTaskCards(before, 'e1', '- [ ] 見積 @2026-10-20 担当:田中\n')).toBe(before);
  });

  it('🔴 replaceTaskCards: ノートの前書き owner: だけを直しても(行に担当が無い札)変化を拾う', () => {
    const before = taskCardsOf('e1', '---\nowner: 田中\n---\n- [ ] 見積 @2026-10-20\n');
    expect(before[0]!.owner).toBe('田中');
    const after = replaceTaskCards(before, 'e1', '---\nowner: 鈴木\n---\n- [ ] 見積 @2026-10-20\n');
    expect(after).not.toBe(before);
    expect(after[0]!.owner).toBe('鈴木');
  });

  it('🔴 replaceNoteTime: 担当だけの変更を拾う / 同じなら同じ配列 / 担当を外すと一覧から外れる(時刻も無いとき)', () => {
    const body = (o: string): string => `---\ndate: 2026-10-20\n${o === '' ? '' : `owner: ${o}\n`}---\n`;
    const list = replaceNoteTime(undefined, 'n1', body('田中'));
    expect(list).toEqual([{ lid: 'n1', date: '2026-10-20', time: null, owner: '田中' }]);
    const changed = replaceNoteTime(list, 'n1', body('鈴木'));
    expect(changed, '担当だけの変更が「同じ」と判定された').not.toBe(list);
    expect(changed![0]!.owner).toBe('鈴木');
    expect(replaceNoteTime(list, 'n1', body('田中'))).toBe(list);
    expect(replaceNoteTime(list, 'n1', body(''))).toEqual([]);
  });
});
