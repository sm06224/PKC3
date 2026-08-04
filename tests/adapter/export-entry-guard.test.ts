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

/**
 * P8 段㉑: 🔴 **本文を書き換える入口を、まとめて止める**。
 *
 * 🔴 直す前この判定は `delete-entry` **1 か所だけ**にあった。書出しは本文を
 * 4MB ずつページングして(`await` を跨ぐ)、そのあとで履歴の鎖を引くので、
 * バッチの隙間に保存が割り込むと **本文は旧版・鎖の頭は新 tip 基準**という
 * 噛み合わないアーカイブができる。取り込み直すと「履歴が噛み合いません」だけが
 * 出て、そのノートの履歴が丸ごと落ちる(title / status は検査が無いので黙って旧値)。
 * 「削除は止めるのに保存は止めない」= 同じ危険に入口ごとに別の答えを出していた。
 *
 * ⚠ 観測点は**入口ごと**。1 つでも素通しなら、そこから壊れる。
 */
describe('書出し中に本文を書き換えられない', () => {
  /** 本文を書き換える入口を**全部**並べた root を作る。 */
  function setupAll(busy: boolean) {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="n1">' +
      '<button data-pkc-action="start-edit">編集</button>' +
      '<button data-pkc-action="commit-edit">保存</button>' +
      '<button data-pkc-action="append-entry">追記</button>' +
      '<button data-pkc-action="toggle-todo">済</button>' +
      '<button data-pkc-action="delete-entry">削除</button>' +
      '<button data-pkc-action="restore-trash" data-pkc-rev-id="r1" data-pkc-trash-lid="n1">復元</button>' +
      '<button data-pkc-action="purge-trash">空にする</button>' +
      '</div>';
    document.body.append(root);
    const d = new Dispatcher();
    const events: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = (a: Parameters<typeof orig>[0]) => {
      events.push(a.type);
      return orig(a);
    };
    bindActions(root, d, { busy: () => busy });
    return { root, events };
  }

  const ENTRIES = [
    'start-edit',
    'commit-edit',
    'append-entry',
    'toggle-todo',
    'delete-entry',
    'restore-trash',
    'purge-trash',
  ];

  it.each(ENTRIES)('🔴 書出しの実行中は「%s」を可視に断る', (action) => {
    vi.stubGlobal('confirm', () => true);
    const { root, events } = setupAll(true);
    root.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`)!.click();
    expect(events, `${action} が無言で素通りしている`).toContain('OP_FAILED');
    vi.unstubAllGlobals();
  });

  /**
   * ⚠ **空振り防止** ── 常時 OP_FAILED を出す実装でも上は通る。
   * 実行中でなければ**同じ押し方で通る**ことを見る。
   */
  it('⚠ 実行中でなければ、同じ入口が通る', () => {
    vi.stubGlobal('confirm', () => true);
    const { root, events } = setupAll(false);
    root.querySelector<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    expect(events, '実行中でないのに断っている').not.toContain('OP_FAILED');
    expect(events).toContain('START_EDIT');
    vi.unstubAllGlobals();
  });
});
