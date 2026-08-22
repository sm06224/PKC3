/** @vitest-environment happy-dom */
/**
 * 🔴 **編集中に押した操作を、無言で捨てない**(#319)。
 *
 * ## 何が起きていたか
 *
 * 編集中に「ゴミ箱」「戻す」「復元」を押すと、**1 ドットも変わらず理由も出ない**。
 * reducer の `phase !== 'ready'` が `{ state, events: [] }` を返して黙って捨て、
 * ⚠ **binder 側にも門も断りも無かった**(素で dispatch していた)ので、救い手ゼロ。
 * P8 段⑲ で潰した「**無言の操作拒否**」そのものである。
 *
 * ## 直しの向きは 2 つに割れる
 *
 * | 操作 | どうするか | なぜ |
 * |---|---|---|
 * | **ゴミ箱を開く** / 一覧が届く | **門を外す** | 読むだけ。下書きに 1 バイトも触らない |
 * | **戻す** / **復元** | **声に出して断る** | 実際に動かす操作 |
 *
 * 🔑 この割り方は新しくない ── `app-state.ts` の 2 ペインの節が既に
 *   「**断りが要るのは実際に動かす操作だけ**」と書いている。
 *
 * ## ⚠ 対で見るもの(片方だけ直る形を作らない)
 *
 * 「開く」の門だけ外して「一覧が届く」側を残すと、**押せるのに一覧が来ない**という
 * 別の無言になる。だから **2 つを同じ it で**見る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { answerDialog } from './dialog-helper';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const booted = (): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] })
    .state;

/** 編集中の state を作る。⚠ 前提が崩れたら以下は全部無意味なので、必ず assert する。 */
function editing(): AppState {
  let s = booted();
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '本文' }).state;
  s = reduce(s, { type: 'START_EDIT' }).state;
  expect(s.phase, '前提が崩れている(編集中になっていない)').toBe('editing');
  return s;
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('編集中でも、ゴミ箱は開ける(#319)', () => {
  it('🔴 開く要求と、届いた一覧の両方が通る(片方だけ直っていない)', () => {
    const s = editing();

    // ① 開く ── 要求が出る
    const opened = reduce(s, { type: 'SHOW_TRASH' });
    expect(
      opened.events.some((e) => e.type === 'REQUEST_TRASH_LIST'),
      '編集中にゴミ箱を開こうとして無言で捨てられた',
    ).toBe(true);

    // ② 届いた一覧が state に入る(⚠ ①だけ直すと「押せるのに一覧が来ない」になる)
    const loaded = reduce(opened.state, {
      type: 'TRASH_LIST_LOADED',
      items: [
        { entryLid: 'gone', revId: 'r1', title: '消したノート', createdAt: null, archetype: 'text' },
      ],
    }).state;
    expect(loaded.trashPanel, '一覧が届いても捨てられた(片方だけ直っている)').not.toBeNull();
  });

  /**
   * 🔴 **対照群** ── 編集していないときは今までどおり(空振り防止)。
   * ⚠ これが落ちるなら、上は「門を外した」のではなく別の理由で通っている。
   */
  it('対照群: 編集していないときも、これまでどおり通る', () => {
    const r = reduce(booted(), { type: 'SHOW_TRASH' });
    expect(r.events.some((e) => e.type === 'REQUEST_TRASH_LIST')).toBe(true);
  });
});

/**
 * 🔴 **動かす操作は、声に出して断る**(#319)。
 * ⚠ 断り文は `binder.ts` の既存 8 か所と同じ型(`編集を終了してから…てください`)。
 *   面ごとに書き分けない ── 「文言は押した場所と対で pin する」。
 */
describe('編集中の「戻す」「復元」は、理由を出して断る(#319)', () => {
  it('🔴 binder が編集中に断り、reducer まで撃たない', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    // ⚠ コメントに満たされない形で見る(実行する行そのもの)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const [action, phrase] of [
      ['restore-trash', '編集を終了してから戻してください'],
      ['restore-revision', '編集を終了してから復元してください'],
    ] as const) {
      const at = code.indexOf(`'${action}': (`);
      expect(at, `${action} の受け口が無い(この検査は空振り)`).toBeGreaterThan(-1);
      // ⚠ その handler の中だけを見る ── file 全体で探すと別の面の断り文に満たされる
      const body = code.slice(at, code.indexOf("\n  '", at + 10));
      expect(body, `${action}: 編集中の断りが無い(無言で捨てる)`).toContain(phrase);
      expect(body, `${action}: phase を見ていない`).toContain("phase !== 'ready'");
    }
  });

  /**
   * ⚠ **reducer 側の門は残す**(最後の砦)── binder を通らない経路
   * (別タブ・test・将来の呼び口)で本文の裏書換を作らないため。
   */
  it('reducer の門は残っている(binder を通らない経路の最後の砦)', () => {
    const s = editing();
    const r = reduce(s, { type: 'RESTORE_REVISION', revId: 'r1' });
    expect(r.events, '編集中に復元が通ってしまう').toEqual([]);
  });
});

/**
 * 🔴 **「ゴミ箱を空にする」も、待っている間に編集が始まったら断る**(#308)。
 *
 * ⚠ ここが抜けると「ゴミ箱のボタン 3 つのうち、開く・戻すだけ直って
 *   **空にするだけ無言のまま**」という、いちばん見分けにくい形になる
 *   ── 変異試験がまさにこれを生かして教えた(直す前は SURVIVED)。
 */
describe('ゴミ箱を空にする ── 待っている間に編集が始まったら断る(#308)', () => {
  function mount() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    // ⚠ 押す口は器の外に無いので、この test 用に 1 つ置く(binder は委譲で拾う)
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'purge-trash');
    root.append(btn);
    return { d, btn, root };
  }

  it('🔴 待っている間に編集が始まったら、空にせず理由を出す', async () => {
    const { d, btn } = mount();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている').toBe('editing');

    await answerDialog('ok');

    expect(d.getState().error ?? '', '無言で捨てた(理由が出ていない)').toContain(
      '編集を終了してから空に',
    );
  });

  /** 🔴 **対照群** ── 崩れていなければ確認 OK がそのまま通る(空振り防止)。 */
  it('対照群: 崩れていなければ、確認 OK がそのまま通る', async () => {
    const { d, btn } = mount();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await answerDialog('ok');
    expect(d.getState().error ?? '', '崩れていないのに断った').not.toContain('編集を終了');
  });
});
