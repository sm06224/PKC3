/** @vitest-environment happy-dom */
/**
 * P6f: 「書き出す」と「削除」を**隣に並べた**ことで生まれた縁を pin する。
 *
 * 🔴 変異試験で 3 件が**誰にも守られていなかった**(review M-1〜M-3)。
 * どれも「書き出したつもりでファイルが落ちていない」に直結する。
 */
import { describe, expect, it, vi } from 'vitest';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { exportEntry, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

function source(over: Partial<ArchiveSource> = {}): ArchiveSource {
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      {
        lid: 'n1',
        title: 'ノート',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ],
    listBodies: async () => ({ rows: [{ lid: 'n1', body: 'x' }], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
    ...over,
  };
}

function deps(src: ArchiveSource): ExportDeps & { files: string[] } {
  const files: string[] = [];
  return {
    source: src,
    download: (name) => files.push(name),
    report: () => {},
    now: () => new Date('2026-08-02T00:00:00Z'),
    files,
  };
}

const fakeDispatcher = (phase: string) => {
  const dispatched: Array<{ type: string; error?: string }> = [];
  return {
    dispatched,
    dispatcher: {
      getState: () => ({ phase }),
      dispatch: (a: { type: string; error?: string }) => dispatched.push(a),
    } as unknown as Dispatcher,
  };
};

describe('1 ノート書出し — 断るなら読む前に断る', () => {
  it('🔴 編集中は store を**1 度も読まずに**断る', async () => {
    // ガードが読みの後ろにあると「30MB 読んでから編集中ですと言う」になり、
    // さらに読みの途中で編集が確定すると body と鎖の基準 tip が別時刻になる
    const getBody = vi.fn(async () => 'x');
    const listBodies = vi.fn(async () => ({ rows: [], done: true }));
    const { dispatcher, dispatched } = fakeDispatcher('editing');
    const d = deps(source({ getBody, listBodies }));

    expect(await exportEntry(dispatcher, d, 'n1')).toBeNull();
    expect(getBody).not.toHaveBeenCalled();
    expect(listBodies).not.toHaveBeenCalled();
    expect(d.files).toHaveLength(0);
    expect(dispatched[0]).toMatchObject({ type: 'OP_FAILED' });
  });

  it('ready なら読んで書き出す', async () => {
    const { dispatcher } = fakeDispatcher('ready');
    const d = deps(source());
    expect(await exportEntry(dispatcher, d, 'n1')).toBe(1);
    expect(d.files[0]).toMatch(/\.pkc3\.zip$/);
  });
});

describe('削除と書出しの排他', () => {
  /** binder だけを立てて、削除 action の振る舞いを見る。 */
  function setup(services: BinderServices) {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="n1">' +
      '<button data-pkc-action="delete-entry">削除</button>' +
      '<button data-pkc-action="export-entry">書き出す</button>' +
      '</div>';
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'n1',
          title: 'ノート',
          archetype: 'text',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
        },
      ],
      relations: [],
    });
    const events: string[] = [];
    d.onEvent(() => {});
    const orig = d.dispatch.bind(d);
    d.dispatch = (a: Parameters<typeof orig>[0]) => {
      events.push(a.type);
      return orig(a);
    };
    bindActions(root, d, services);
    return { root, d, events };
  }

  it('🔴 書出しの実行中は削除を断る(走査の途中で対象が消えない)', () => {
    // 「書き出す」を押した直後に「削除」を押せると、走査中に entry が消えて
    // 書出しが失敗する ── user は書き出したつもりでファイルが 1 個も無い
    vi.stubGlobal('confirm', () => true);
    const { root, events } = setup({ busy: () => true });
    root.querySelector<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    expect(events).toContain('OP_FAILED');
    expect(events).not.toContain('DELETE_ENTRY');
    vi.unstubAllGlobals();
  });

  it('実行中でなければ削除できる', () => {
    vi.stubGlobal('confirm', () => true);
    const { root, events } = setup({ busy: () => false });
    root.querySelector<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    expect(events).toContain('DELETE_ENTRY');
    vi.unstubAllGlobals();
  });
});

describe('書き出す対象の解決', () => {
  it('🔴 行から closest で引く(削除と**同じ規則**)', () => {
    // 片方だけ selectedLid 固定だと、filer / sidebar の行に並べた瞬間に
    // 「A を書き出して B を削除する」が成立する
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="other"><button data-pkc-action="export-entry">書き出す</button></div>';
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const asked: string[] = [];
    bindActions(root, d, { exportEntry: (lid) => asked.push(lid) });
    root.querySelector<HTMLElement>('[data-pkc-action="export-entry"]')!.click();
    // selectedLid は null のまま ── closest を見ていなければ 1 件も来ない
    expect(asked).toEqual(['other']);
  });
});
