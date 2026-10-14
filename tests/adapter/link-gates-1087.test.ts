/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートを開く口の門をそろえる**(#1087)。
 *
 * 口ごとに「開けない理由」を断る条件が違った ── 一覧 / リンクは編集中だけを断り、保存失敗中は
 * reducer が黙って捨てるのに続きの処理が走って原因違いの字が出る / 添付のリンクは `SELECT_ENTRY` を
 * 直に撃つので何も出ない / 面つき・引っ越しのアドレスは居ないノートも編集中も見ない。
 * ここは**断る条件が 1 本(`selectBlockReason`)**であること、全部の口がそれを通ることを見る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import { bindActions, selectEntryOrExplain, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  entryListChanged,
  initialState,
  reduce,
  selectBlockReason,
  type AppPhase,
  type AppState,
} from '../../src/adapter/state/app-state';
import {
  MISSING_ENTRY_LINK_MESSAGE,
  MOVED_MESSAGE,
  connectViewDeepLink,
  openAssetOwner,
  type DeepLinkTarget,
} from '../../src/adapter/platform/deep-link';
import {
  dropViewFindFromHash,
  dropViewFragmentFromHash,
  dropViewFromHash,
  setHashEntry,
} from '../../src/features/link/permalink';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const META = (lid: string, title = `t-${lid}`): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 0,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function bootState(lids = ['a', 'b']): AppState {
  return reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: lids.map((l) => META(l)),
    relations: [],
  }).state;
}

function boot(phase: AppPhase = 'ready'): Dispatcher {
  return new Dispatcher({ ...bootState(), phase } as AppState);
}

let root: HTMLElement;
beforeEach(() => {
  document.body.textContent = '';
  root = document.createElement('div');
  document.body.append(root);
});

describe('断る条件は 1 本(selectBlockReason)', () => {
  it('🔴 reducer が SELECT_ENTRY を捨てる phase(editing / error)だけを断る', () => {
    expect(selectBlockReason('editing')).toContain('編集');
    expect(selectBlockReason('error')).toContain('ノートを保存し直す');
    // 対照群: reducer が通す phase まで断らない(`phase !== 'ready'` にすると reducer とずれる)
    expect(selectBlockReason('ready')).toBeNull();
    expect(selectBlockReason('initializing')).toBeNull();
    // 前提の裏取り: 本物の reducer が捨てる phase と一致している
    for (const phase of ['editing', 'error', 'ready', 'initializing'] as AppPhase[]) {
      const s = { ...bootState(), phase } as AppState;
      const out = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
      expect(out.selectedLid === 'b', `${phase}: reducer の捨て方と断る条件がずれている`).toBe(
        selectBlockReason(phase) === null,
      );
    }
  });
});

describe('1. 本文のリンク: 保存失敗中も、原因の合った字を出す', () => {
  function entryLink(href: string): HTMLAnchorElement {
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('data-pkc-action', 'navigate-entry-ref');
    a.setAttribute('data-pkc-entry-ref', href);
    root.append(a);
    return a;
  }

  it('🔴 保存失敗中に見出しつきのリンクを押すと、「見出しが見つかりません」ではなく再保存を案内する', () => {
    const d = boot('error');
    const stop = bindActions(root, d);
    entryLink('entry:b#h/zzz').click();
    const err = d.getState().error ?? '';
    expect(err).toContain('ノートを保存し直す');
    expect(err).toContain('リンク先のノートを開いてください');
    expect(err, '原因違いの字').not.toContain('見出し');
    stop();
  });

  it('対照群: ready では開く', () => {
    const d = boot('ready');
    const stop = bindActions(root, d);
    entryLink('entry:b').click();
    expect(d.getState().selectedLid).toBe('b');
    stop();
  });
});

describe('2. 添付のリンクの「開く」はノートを開く門を通る', () => {
  const base = {
    assetKey: 'k',
    ownerLid: null,
    what: 'リンク' as const,
    assetKeyOf: async () => null,
    errorText: (e: unknown) => String(e),
  };

  it('🔴 持ち主が見つかると open に渡す / 見つからなければ理由 / 逆引きが落ちても理由', async () => {
    const opened: string[] = [];
    const failed: string[] = [];
    const common = { ...base, open: (l: string) => void opened.push(l), fail: (m: string) => void failed.push(m) };
    await openAssetOwner({ ...common, findOwner: async () => 'b' });
    expect(opened).toEqual(['b']);
    await openAssetOwner({ ...common, findOwner: async () => null });
    expect(failed[0]).toContain('このリンクの添付が見つかりません');
    await openAssetOwner({ ...common, findOwner: () => Promise.reject(new Error('boom')) });
    expect(failed[1]).toContain('リンクを解決できません');
    expect(opened, '見つからないのに開いた').toEqual(['b']);
  });

  it.each(['editing', 'error'] as const)('🔴 %s 中に押すと、黙らず理由が出て、選択は動かない', async (phase) => {
    const d = boot(phase);
    await openAssetOwner({
      ...base,
      findOwner: async () => 'b',
      open: (lid) => void selectEntryOrExplain(d, lid, 'この添付のノート', root, {} as BinderServices),
      fail: (error) => d.dispatch({ type: 'OP_FAILED', error }),
    });
    expect(d.getState().error ?? '', '無言で捨てた').toContain('この添付のノートを開いてください');
    expect(d.getState().selectedLid).not.toBe('b');
  });

  it('対照群: ready では選ぶ', async () => {
    const d = boot('ready');
    await openAssetOwner({
      ...base,
      findOwner: async () => 'b',
      open: (lid) => void selectEntryOrExplain(d, lid, 'この添付のノート', root, {} as BinderServices),
      fail: () => {},
    });
    expect(d.getState().selectedLid).toBe('b');
  });

  it('🔴 main.ts は SELECT_ENTRY を直に撃たず、openAssetOwner → selectEntryOrExplain を通している(原文 pin)', () => {
    const code = readFileSync('src/main.ts', 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    const at = code.indexOf('navigateAssetRef: (assetKey, what');
    expect(at).toBeGreaterThan(0);
    const body = code.slice(at, code.indexOf('setExternalImages', at));
    expect(body).toContain('openAssetOwner(');
    expect(body).toContain('selectEntryOrExplain(dispatcher,');
    expect(body, '直に撃っている').not.toContain("type: 'SELECT_ENTRY'");
  });
});

/** 的つきの試験台(`find` / `fragment` を落とす的も持つ)。 */
function opener(hash: string, own: { lids: string[] }, phase: AppPhase = 'ready') {
  const log: string[] = [];
  const target: DeepLinkTarget & { hash: string } = {
    hash,
    clearHash: () => {
      log.push('clearHash');
      target.hash = dropViewFromHash(target.hash);
    },
    dropToken: () => {},
    dropFind: () => {
      log.push('dropFind');
      target.hash = dropViewFindFromHash(target.hash);
    },
    dropFragment: () => {
      log.push('dropFragment');
      target.hash = dropViewFragmentFromHash(target.hash);
    },
    setEntry: (c, l) => {
      target.hash = setHashEntry(target.hash, c, l);
    },
    restoreHash: (h) => {
      target.hash = h;
    },
  };
  connectViewDeepLink({
    openView: (v) => log.push(`open-view:${v}`),
    openBrowse: (m) => log.push(`open-browse:${m}`),
    selectEntry: (c, l) => log.push(`select:${c}:${l}`),
    ownContainerId: () => 'c1',
    hasEntry: (l) => own.lids.includes(l),
    phase: () => phase,
    searchJump: (l, f) => log.push(`search:${l}:${f}`),
    fail: (m) => log.push(`fail:${m}`),
    onViewChange: () => () => {},
    onSelectedEntry: () => () => {},
    target,
  });
  return { log, target };
}

describe('3. 面つき・引っ越しのアドレスも、ノートの門を通る', () => {
  it('🔴 面つき: 居ないノートは選ばず理由を言う(面は開く)', () => {
    const o = opener('#pkc?container=c1&entry=gone&view=schedule', { lids: ['n1'] });
    expect(o.log.some((l) => l.startsWith('select:'))).toBe(false);
    expect(o.log).toContain('open-view:schedule');
    expect(o.log).toContain(`fail:${MISSING_ENTRY_LINK_MESSAGE}`);
  });
  it('🔴 面つき: 編集中は選ばず理由を言う / 対照群: ready では選ぶ', () => {
    const e = opener('#pkc?container=c1&entry=n1&view=schedule', { lids: ['n1'] }, 'editing');
    expect(e.log.some((l) => l.startsWith('select:'))).toBe(false);
    expect(e.log).toContain('open-view:schedule');
    expect(e.log.some((l) => l.startsWith('fail:編集を保存するか'))).toBe(true);
    const r = opener('#pkc?container=c1&entry=n1&view=schedule', { lids: ['n1'] });
    expect(r.log).toEqual(['select:c1:n1', 'open-view:schedule']);
  });
  it('🔴 引っ越し: 居ないノートは理由を言う(引っ越しの案内は残す)/ 対照群: ready では選ぶ', () => {
    const o = opener('#pkc?container=c1&entry=gone&view=calendar', { lids: ['n1'] });
    expect(o.log.some((l) => l.startsWith('select:'))).toBe(false);
    expect(o.log).toContain('open-browse:schedule');
    expect(o.log).toContain(`fail:${MOVED_MESSAGE}`);
    expect(o.log[o.log.length - 1], '最後に出る字は、やり直せる側(開けなかった理由)').toBe(
      `fail:${MISSING_ENTRY_LINK_MESSAGE}`,
    );
    const r = opener('#pkc?container=c1&entry=n1&view=calendar', { lids: ['n1'] });
    expect(r.log).toContain('select:c1:n1');
    expect(r.log).not.toContain(`fail:${MISSING_ENTRY_LINK_MESSAGE}`);
  });
});

describe('4. 開けなかったリンクの find / fragment は住所に残さない', () => {
  it('🔴 居ないノート: find と fragment を落とす(entry は残す)', () => {
    const o = opener('#pkc?container=c1&entry=gone&find=abc&fragment=h/xyz', { lids: ['n1'] });
    expect(o.log).toContain('dropFind');
    expect(o.log).toContain('dropFragment');
    expect(o.target.hash).not.toContain('find=');
    expect(o.target.hash).not.toContain('fragment=');
    expect(o.target.hash).toContain('entry=gone');
  });
  it('🔴 編集中で断った回も落とす', () => {
    const o = opener('#pkc?container=c1&entry=n1&find=abc', { lids: ['n1'] }, 'editing');
    expect(o.log).toContain('dropFind');
    expect(o.target.hash).not.toContain('find=');
  });
  it('対照群: 付いていなければ触らない / 開けるときは今までどおり使って落とす', () => {
    const none = opener('#pkc?container=c1&entry=gone', { lids: ['n1'] });
    expect(none.log).not.toContain('dropFind');
    expect(none.log).not.toContain('dropFragment');
    const ok = opener('#pkc?container=c1&entry=n1&find=abc', { lids: ['n1'] });
    expect(ok.log).toEqual(['select:c1:n1', 'search:n1:abc', 'dropFind']);
  });
});

describe('5. 参照元は、ノートの増減・改名で取り直す', () => {
  const booted = (): AppState => bootState(['a', 'b', 'c']);
  const selected = (): AppState => reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
  const asks = (events: readonly { type: string }[]): number =>
    events.filter((e) => e.type === 'REQUEST_BACKLINKS').length;

  it('🔴 参照元の改名 / 削除で、選択中のノートの参照元を 1 回取り直す', () => {
    const s = reduce(selected(), { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b'], truncated: false }).state;
    const renamed = reduce(s, { type: 'RENAME_ENTRY_TITLE', lid: 'b', title: '別の題' });
    expect(asks(renamed.events)).toBe(1);
    expect(renamed.events).toContainEqual({ type: 'REQUEST_BACKLINKS', lid: 'a' });
    // 取り直す間も前の答えは消さない(保存のたびに「調べています…」へ戻ってちらつかない)
    expect(renamed.state.backlinks?.lids).toEqual(['b']);
    const deleted = reduce(s, { type: 'DELETE_ENTRY', lid: 'b' });
    expect(asks(deleted.events)).toBe(1);
  });

  it('🔴 対照群: 題名も件数も変わらない entryMetas の作り直し(保存の印)では取り直さない', () => {
    const s = selected();
    const m = s.entryMetas.get('a')!;
    const out = reduce(s, {
      type: 'ENTRY_STAMPED',
      lid: 'a',
      createdAt: m.createdAt,
      updatedAt: '2026-10-14T00:00:00Z',
    });
    expect(out.state.entryMetas).not.toBe(s.entryMetas); // 前提: 作り直されている
    expect(asks(out.events), '打鍵ごとに引いている').toBe(0);
  });

  it('対照群: 選択が動いたときは今までどおり 1 回(重ねて撃たない)', () => {
    expect(asks(reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).events)).toBe(1);
  });

  it('🔴 調べられなかったときの字は、取り直す条件と一致している(同じ行の押し直しでは取り直さない)', () => {
    let s = selected();
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false, failed: true }).state;
    // 約束の裏取り: 同じ行を押し直しても取り直さない / ほかのノートへ移って戻れば取り直す
    expect(asks(reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).events), '同じ行の押し直しで取り直している').toBe(0);
    const away = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' });
    expect(asks(reduce(away.state, { type: 'SELECT_ENTRY', lid: 'a' }).events)).toBe(1);
    const region = document.createElement('div');
    document.body.append(region);
    new InspectorRenderer(region).render(s);
    const text = region.querySelector('[data-pkc-field="inspector-backlinks"]')?.textContent ?? '';
    expect(text).toContain('参照元を調べられませんでした');
    expect(text, '押し直しでは取り直さないのに「選び直すと」とだけ言っている').toContain('ほかのノートを選んでから');
  });

  it('entryListChanged: 増減 / 題名 / 差し替えだけ', () => {
    const a = new Map([
      ['a', META('a')],
      ['b', META('b')],
    ]);
    expect(entryListChanged(a, new Map(a))).toBe(false);
    expect(entryListChanged(a, new Map([['a', META('a')]]))).toBe(true);
    expect(
      entryListChanged(
        a,
        new Map([
          ['a', META('a')],
          ['b', META('b', 'x')],
        ]),
      ),
    ).toBe(true);
    expect(
      entryListChanged(
        a,
        new Map([
          ['a', META('a')],
          ['c', META('c')],
        ]),
      ),
    ).toBe(true);
  });
});
