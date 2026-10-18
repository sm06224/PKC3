/** @vitest-environment happy-dom */
/**
 * 🔴 **グループの名前を変える**(依頼 83-2。Gemini の回答「推薦どおり」= C = 見出しのメニューの「名前を変える…」+ 欄の候補)。
 *
 * 観測点は「書く行(`REQUEST_TILE_ORDER` の rows)の顔ぶれと値」「グループ用のノートの題名」「見出しのメニューの顔ぶれ」「欄の候補」。
 * 対照群: 組み込みだけのグループは変えられない(理由を言う)/ 同じ名前・空は何もしない / 他のグループのアプリは書かない。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  appGroupRenamable,
  knownAppGroupNames,
  type DomainEvent,
} from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { LauncherTile } from '../../src/features/launcher/tiles';
import { appGroupMenuActions } from '../../src/features/entry-actions';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

const meta = (lid: string, title: string, archetype = 'attachment'): EntryMeta => ({
  lid,
  title,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 0,
});

const tile = (lid: string, group: string, kind: LauncherTile['kind'] = 'app'): LauncherTile => ({
  lid,
  title: lid,
  group,
  kind,
});

function booted(extra: EntryMeta[] = []) {
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('t1', 'アプリ 1'), meta('t2', 'アプリ 2'), meta('t3', 'アプリ 3'), ...extra],
    relations: [],
  });
  d.dispatch({
    type: 'LAUNCHER_TILES_LOADED',
    tiles: [tile('t1', '資料'), tile('t2', '資料'), tile('t3', '作業'), tile('builtin:manual', '組み込みアプリ', 'manual')],
  });
  events.length = 0;
  return { d, events };
}

describe('RENAME_APP_GROUP(依頼 83-2)', () => {
  it('🔴 そのグループの自分のアプリ全部の group を新しい名前で書く(他のグループは書かない)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'RENAME_APP_GROUP', from: '資料', to: '参考' });
    const order = events.find((e) => e.type === 'REQUEST_TILE_ORDER');
    expect(order, '書く依頼が出ていない').toBeDefined();
    const rows = (order as Extract<DomainEvent, { type: 'REQUEST_TILE_ORDER' }>).rows;
    expect(rows.map((r) => r.lid).sort()).toEqual(['t1', 't2']);
    for (const r of rows) expect(r.updates).toEqual({ 'attachment.app_group': '参考' });
    // 画面は先に動く
    expect(d.getState().launcherTiles?.filter((t) => t.group === '参考').map((t) => t.lid).sort()).toEqual(['t1', 't2']);
    expect(d.getState().launcherTiles?.find((t) => t.lid === 't3')?.group).toBe('作業');
    expect(d.getState().notice).toContain('「資料」を「参考」に変えました');
    // 書いた後に読み直す(画面を先に動かしたので、書けなかった回は disk の答えへ戻る)
    expect(events.some((e) => e.type === 'REQUEST_APP_GROUP_NOTES')).toBe(true);
  });

  it('🔴 グループ用のノート(目印・並び順)の題名も一緒に変わる / 行き先に同じ名前のノートが在れば動かさない', () => {
    const a = booted([meta('g1', '資料', 'appgroup')]);
    a.d.dispatch({ type: 'RENAME_APP_GROUP', from: '資料', to: '参考' });
    expect(a.d.getState().entryMetas.get('g1')?.title).toBe('参考');
    expect(a.events.some((e) => e.type === 'REQUEST_RENAME')).toBe(true);
    const b = booted([meta('g1', '資料', 'appgroup'), meta('g2', '参考', 'appgroup')]);
    b.d.dispatch({ type: 'RENAME_APP_GROUP', from: '資料', to: '参考' });
    expect(b.d.getState().entryMetas.get('g1')?.title, '同じ題名のノートを 2 つ作った').toBe('資料');
  });

  it('対照群: 同じ名前・空の名前・組み込みだけのグループ・知らないグループは書かず、理由を言う(または何もしない)', () => {
    const same = booted();
    same.d.dispatch({ type: 'RENAME_APP_GROUP', from: '資料', to: ' 資料 ' });
    expect(same.events).toEqual([]);
    const empty = booted();
    empty.d.dispatch({ type: 'RENAME_APP_GROUP', from: '資料', to: '  ' });
    expect(empty.events.filter((e) => e.type === 'REQUEST_TILE_ORDER')).toEqual([]);
    expect(empty.d.getState().error ?? '').toContain('名前が空');
    const builtin = booted();
    builtin.d.dispatch({ type: 'RENAME_APP_GROUP', from: '組み込みアプリ', to: 'x' });
    expect(builtin.events.filter((e) => e.type === 'REQUEST_TILE_ORDER')).toEqual([]);
    expect(builtin.d.getState().error ?? '').toContain('最初から入っているアプリ');
    const none = booted();
    none.d.dispatch({ type: 'RENAME_APP_GROUP', from: '無い', to: 'x' });
    expect(none.events.filter((e) => e.type === 'REQUEST_TILE_ORDER')).toEqual([]);
  });

  it('編集中は書かず、理由を言う', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 't1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 't1', body: 'x' });
    d.dispatch({ type: 'START_EDIT' });
    events.length = 0;
    d.dispatch({ type: 'RENAME_APP_GROUP', from: '資料', to: '参考' });
    expect(events.filter((e) => e.type === 'REQUEST_TILE_ORDER')).toEqual([]);
    expect(d.getState().error ?? '').toContain('名前を変えられます');
  });
});

describe('見出しのメニューと欄の候補', () => {
  it('🔴 名前を変えられるグループにだけ「名前を変える…」が出る(先頭)', () => {
    const { d } = booted();
    expect(appGroupRenamable(d.getState(), '資料')).toBe(true);
    expect(appGroupRenamable(d.getState(), '組み込みアプリ')).toBe(false);
    expect(appGroupRenamable(d.getState(), '')).toBe(false);
    const withIt = appGroupMenuActions(false, true);
    expect(withIt[0]).toEqual({ action: 'rename-app-group', label: '名前を変える…' });
    expect(appGroupMenuActions(false, false).map((a) => a.action)).not.toContain('rename-app-group');
    expect(appGroupMenuActions(true, true).map((a) => a.action)).toContain('reset-app-group-order');
  });

  it('🔴 欄の候補は、自分のアプリが入っているグループとグループ用のノートの題名(組み込みのグループは入れない)', () => {
    const { d } = booted([meta('g9', '予備', 'appgroup')]);
    expect(knownAppGroupNames(d.getState())).toEqual(['予備', '作業', '資料']);
  });

  it('🔴 押すと名前を聞き、答えた名前で RENAME_APP_GROUP を撃つ(やめたら撃たない)', async () => {
    resetAppDialogForTest();
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const { d } = booted();
    const sent: string[] = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: { type: string }) => {
      sent.push(a.type);
      return raw(a as never);
    }) as typeof d.dispatch;
    const stop = bindActions(root, d, {});
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'rename-app-group');
    b.setAttribute('data-pkc-group', '資料');
    root.append(b);
    b.click();
    await new Promise((r) => setTimeout(r, 0));
    const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="prompt-input"]');
    expect(input, '名前を聞く窓が開いていない').not.toBeNull();
    expect(input!.value, '初期値がいまの名前でない').toBe('資料');
    input!.value = '参考';
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toContain('RENAME_APP_GROUP');
    expect(d.getState().launcherTiles?.find((t) => t.lid === 't1')?.group).toBe('参考');
    stop();
  });
});
