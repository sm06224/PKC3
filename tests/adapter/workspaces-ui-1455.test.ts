/** @vitest-environment happy-dom */
/**
 * 🔴 **ワークスペースの切り替え(画面側)**(#1455)。保存側は `workspaces-1455.test.ts`。
 *
 * 1. 係(`Workspaces`)が一覧を組み、切り替え・名前・削除・足すの結果を言う / 断る文は 1 か所
 * 2. 設定の「ワークスペース」の節が、係の表示を映す(使っている器には「切り替える」「削除」を出さない)
 * 3. 押し口が係に届く(実 DOM のクリック → 切り替えで書込の列 → 印 → 読み込み直し、の順)
 * 4. 配線が無い環境(可搬の単一 HTML)では節ごと隠す
 */
import { describe, expect, it } from 'vitest';
import {
  Workspaces,
  appWorkspaces,
  WORKSPACE_OPEN_ELSEWHERE_TEXT,
  WORKSPACE_OPEN_UNCHECKED_TEXT,
  type WorkspaceDeps,
} from '../../src/adapter/platform/storage/workspace-run';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { answerDialog, openDialog } from './dialog-helper';

function fake(over: Partial<WorkspaceDeps> = {}) {
  const calls: string[] = [];
  const table = [
    { cid: 'c1', title: '仕事用', createdAt: null, notes: 12 },
    { cid: 'c2', title: '個人用', createdAt: null, notes: 3 },
  ];
  let active = 'c1';
  const deps: WorkspaceDeps = {
    list: async () => ({ workspaces: table.map((w) => ({ ...w })), activeCid: active }),
    create: async (title) => {
      calls.push(`create:${title}`);
      table.push({ cid: `c${table.length + 1}`, title, createdAt: null, notes: 0 });
      return `c${table.length}`;
    },
    switchTo: async (cid) => {
      calls.push(`switch:${cid}`);
      active = cid;
    },
    rename: async (cid, title) => {
      calls.push(`rename:${cid}:${title}`);
      const w = table.find((x) => x.cid === cid);
      if (w) w.title = title;
    },
    remove: async (cid) => {
      calls.push(`remove:${cid}`);
      const i = table.findIndex((x) => x.cid === cid);
      const notes = table[i]?.notes ?? 0;
      table.splice(i, 1);
      return { removedNotes: notes };
    },
    run: async (job) => {
      calls.push('run');
      return job();
    },
    reload: () => {
      calls.push('reload');
    },
    ...over,
  };
  return { deps, calls, table };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('ワークスペースの係 #1455', () => {
  it('配線が無ければ attached=false(節ごと隠す)', () => {
    expect(new Workspaces().view().attached).toBe(false);
  });

  it('一覧を組む: 使用中の印は、このタブが開いている器', async () => {
    const f = fake();
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    expect(w.view().rows.map((r) => [r.title, r.notes, r.current])).toEqual([
      ['仕事用', 12, true],
      ['個人用', 3, false],
    ]);
  });

  it('切り替え: 書込の列に載せて印を書き、その後で読み込み直す(順番)', async () => {
    const f = fake();
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    const r = await w.switchTo('c2');
    expect(r.kind).toBe('done');
    expect(f.calls).toEqual(['run', 'switch:c2', 'reload']);
  });

  it('使っている器への切り替え・一覧に無い器・削除の断りは、書込に触れずに言う', async () => {
    const f = fake();
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    expect((await w.switchTo('c1')).kind).toBe('refused');
    expect((await w.switchTo('zzz')).kind).toBe('refused');
    expect((await w.remove('c1')).kind).toBe('refused');
    expect((await w.create('   ')).kind).toBe('refused');
    expect((await w.rename('c2', '')).kind).toBe('refused');
    expect(f.calls).toEqual([]);
  });

  it('足す・名前を直す・削除する: 一覧が読み直される / 切り替えはしない', async () => {
    const f = fake();
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    expect((await w.create('  新しい  束 ')).kind).toBe('done');
    expect(w.view().rows.map((r) => r.title)).toContain('新しい 束');
    expect(f.calls).not.toContain('reload');
    expect((await w.rename('c2', '私用')).kind).toBe('done');
    expect(w.view().rows.find((r) => r.cid === 'c2')?.title).toBe('私用');
    const del = await w.remove('c2');
    expect(del.kind).toBe('done');
    expect(del.text).toContain('3');
    expect(w.view().rows.some((r) => r.cid === 'c2')).toBe(false);
  });

  it('保存側が断ったら failed で、その文をそのまま言う / 失敗しても係は詰まらない', async () => {
    const f = fake({
      remove: async () => {
        throw new Error('使っているワークスペースは削除できません(先に別のワークスペースへ切り替えてください)');
      },
    });
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    const r = await w.remove('c2');
    expect(r).toEqual({
      kind: 'failed',
      text: '使っているワークスペースは削除できません(先に別のワークスペースへ切り替えてください)',
    });
    expect(w.view().busy).toBe(false);
    expect((await w.rename('c2', 'x')).kind).toBe('done');
  });

  it('動作中の 2 度押しは断る', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = fake({ run: async (job) => (await gate, job()) });
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    const first = w.rename('c2', 'a');
    const second = await w.rename('c2', 'b');
    expect(second.kind).toBe('refused');
    release();
    expect((await first).kind).toBe('done');
  });
});

describe('設定の節の描画と押し口 #1455(実 DOM)', () => {
  async function setup(attached = true) {
    resetAppDialogForTest();
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const host = document.createElement('div');
    root.append(host);
    const f = fake();
    // 押し口(binder)は共有の 1 個(`appWorkspaces`)を引く ── 配線ありの回はそれを使う
    const w = attached ? appWorkspaces : new Workspaces();
    if (attached) {
      w.attach(f.deps, 'c1');
      await w.refresh();
    }
    // 位置引数の末尾(ワークスペース)だけ差し替える ── 他は既定の共有ストア(`settings.ts` の constructor の戒め)
    const R = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
    const args: unknown[] = new Array(WORKSPACES_ARG_INDEX + 1).fill(undefined);
    args[0] = host;
    args[WORKSPACES_ARG_INDEX] = w;
    const view = new R(...args);
    view.render(initialState);
    const d = new Dispatcher();
    bindActions(root, d);
    return { root, host, f, w, d };
  }

  it('節が出て、使っている器には「使用中」だけ / 別の器には「切り替える」「削除」', async () => {
    const { host } = await setup();
    const box = host.querySelector<HTMLElement>('[data-pkc-region="workspaces"]')!;
    expect(box.hidden).toBe(false);
    const rows = [...box.querySelectorAll<HTMLElement>('[data-pkc-field="workspace-row"]')];
    expect(rows.map((r) => r.querySelector('[data-pkc-field="workspace-name"]')?.textContent)).toEqual([
      '仕事用(ノート 12 件)',
      '個人用(ノート 3 件)',
    ]);
    const acts = (r: HTMLElement): string[] =>
      [...r.querySelectorAll('button')].map((b) => b.getAttribute('data-pkc-action') ?? '');
    expect(rows[0]!.querySelector('[data-pkc-field="workspace-current"]')?.textContent).toBe('使用中');
    expect(acts(rows[0]!)).toEqual(['workspace-rename']);
    expect(acts(rows[1]!)).toEqual(['workspace-switch', 'workspace-rename', 'workspace-delete']);
  });

  it('配線が無ければ節ごと隠す', async () => {
    const { host } = await setup(false);
    expect(host.querySelector<HTMLElement>('[data-pkc-region="workspaces"]')!.hidden).toBe(true);
  });

  it('「切り替える」を押すと、書込の列 → 印 → 読み込み直しが走る', async () => {
    const { host, f } = await setup();
    host.querySelector<HTMLElement>('[data-pkc-action="workspace-switch"]')!.click();
    await flush();
    await flush();
    expect(f.calls).toEqual(['run', 'switch:c2', 'reload']);
  });

  it('「ワークスペースを作る」は欄の名前で足し、欄を空にする / 空のままなら何も書かない', async () => {
    const { host, f } = await setup();
    const input = host.querySelector<HTMLInputElement>('[data-pkc-field="workspace-new-name"]')!;
    host.querySelector<HTMLElement>('[data-pkc-action="workspace-create"]')!.click();
    await flush();
    expect(f.calls).toEqual([]);
    input.value = '勉強用';
    host.querySelector<HTMLElement>('[data-pkc-action="workspace-create"]')!.click();
    await flush();
    await flush();
    expect(f.calls).toEqual(['run', 'create:勉強用']);
    expect(input.value).toBe('');
    expect(host.querySelectorAll('[data-pkc-field="workspace-row"]').length).toBe(3);
  });

  it('「削除」は確認を挟み、やめれば何も消さない / 「削除する」で消える', async () => {
    const { host, f } = await setup();
    const del = (): HTMLElement => host.querySelector<HTMLElement>('[data-pkc-action="workspace-delete"]')!;
    del().click();
    await flush();
    const dlg = openDialog();
    expect(dlg?.textContent ?? '').toContain('個人用');
    await answerDialog('cancel');
    await flush();
    expect(f.calls).toEqual([]);
    del().click();
    await flush();
    await answerDialog('ok');
    await flush();
    await flush();
    expect(f.calls).toEqual(['run', 'remove:c2']);
  });

  it('名前の変更は小窓で聞く', async () => {
    const { host, f } = await setup();
    host.querySelectorAll<HTMLElement>('[data-pkc-action="workspace-rename"]')[1]!.click();
    await flush();
    const dlg = openDialog();
    const input = dlg?.querySelector<HTMLInputElement>('input');
    expect(input?.value).toBe('個人用');
    input!.value = '私用';
    await answerDialog('ok');
    await flush();
    await flush();
    expect(f.calls).toEqual(['run', 'rename:c2:私用']);
  });

});

/** `SettingsRenderer` の `workspaces` の位置(末尾の引数。位置引数の並びは `settings.ts` が持つ)。 */
const WORKSPACES_ARG_INDEX = 26;

describe('ほかのタブが開いている器の削除(#1455 レビュー ⚠3)', () => {
  it('🔴 ほかのタブが開いている器は削除を断り、保存側へ削除を打たない', async () => {
    const f = fake({ isOpenElsewhere: async (cid) => cid === 'c2' });
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    const r = await w.remove('c2');
    expect(r).toEqual({ kind: 'failed', text: WORKSPACE_OPEN_ELSEWHERE_TEXT });
    expect(f.calls.filter((c) => c.startsWith('remove')), '断ったのに削除を打った').toEqual([]);
    expect(f.table.some((t) => t.cid === 'c2')).toBe(true);
  });

  it('対照群: 開いているタブが居なければ削除できる', async () => {
    const f = fake({ isOpenElsewhere: async () => false });
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    expect((await w.remove('c2')).kind).toBe('done');
    expect(f.calls).toContain('remove:c2');
  });

  it('確かめる手段が無い環境では canCheckOpen=false(確認の文に一文を添える材料)', async () => {
    const f = fake();
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    expect(w.view().canCheckOpen).toBe(false);
    const g = fake({ isOpenElsewhere: async () => false });
    const w2 = new Workspaces();
    w2.attach(g.deps, 'c1');
    expect(w2.view().canCheckOpen).toBe(true);
  });

  it('🔴 確かめられない環境の削除の確認には「ほかのタブで開いていないこと」を出し、確かめられる環境には出さない', async () => {
    resetAppDialogForTest();
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const host = document.createElement('div');
    root.append(host);
    const f = fake(); // isOpenElsewhere なし
    appWorkspaces.attach(f.deps, 'c1');
    await appWorkspaces.refresh();
    const R = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
    const args: unknown[] = new Array(WORKSPACES_ARG_INDEX + 1).fill(undefined);
    args[0] = host;
    new R(...args).render(initialState);
    bindActions(root, new Dispatcher());
    host.querySelector<HTMLElement>('[data-pkc-action="workspace-delete"]')!.click();
    await flush();
    expect(openDialog()?.textContent ?? '').toContain(WORKSPACE_OPEN_UNCHECKED_TEXT);
    await answerDialog('cancel');
    await flush();

    const g = fake({ isOpenElsewhere: async () => false });
    appWorkspaces.attach(g.deps, 'c1');
    await appWorkspaces.refresh();
    host.querySelector<HTMLElement>('[data-pkc-action="workspace-delete"]')!.click();
    await flush();
    expect(openDialog()?.textContent ?? '').not.toContain(WORKSPACE_OPEN_UNCHECKED_TEXT);
    await answerDialog('cancel');
  });
});

describe('切り替え前の打ちかけの確認(#1455 レビュー ⚠5)', () => {
  async function setup(over: Partial<WorkspaceDeps>) {
    const f = fake(over);
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    return { f, w };
  }
  it('🔴 編集中で「やめる」なら、何も変えず読み込み直しもしない', async () => {
    let asked = 0;
    const { f, w } = await setup({
      isEditing: () => true,
      confirmDiscard: async () => {
        asked += 1;
        return false;
      },
    });
    const r = await w.switchTo('c2');
    expect(r.kind).toBe('cancelled');
    expect(asked).toBe(1);
    expect(f.calls, '断られたのに印を書いた / 読み込み直した').toEqual([]);
  });
  it('編集中で「切り替える」なら進む / 編集中でなければ聞かない', async () => {
    let asked = 0;
    const a = await setup({
      isEditing: () => true,
      confirmDiscard: async () => {
        asked += 1;
        return true;
      },
    });
    expect((await a.w.switchTo('c2')).kind).toBe('done');
    expect(a.f.calls).toEqual(['run', 'switch:c2', 'reload']);
    const b = await setup({
      isEditing: () => false,
      confirmDiscard: async () => {
        asked += 1;
        return false;
      },
    });
    expect((await b.w.switchTo('c2')).kind).toBe('done');
    expect(asked, '編集中でないのに聞いた').toBe(1);
  });
});

describe('current と next が食い違う行(#1455 レビュー テストの穴 C)', () => {
  /** 別のタブで切り替えた後: 開いている器(c1)と、次に開く器(c2)が違う。 */
  async function skewed(over: Partial<WorkspaceDeps> = {}) {
    const f = fake({ ...over });
    f.table.push({ cid: 'c3', title: '三つ目', createdAt: null, notes: 0 });
    await f.deps.switchTo('c2'); // 印だけ c2 へ(このタブは c1 を開いたまま)
    f.calls.length = 0;
    const w = new Workspaces();
    w.attach(f.deps, 'c1');
    await w.refresh();
    return { f, w };
  }
  it('開いている器(current)も、次に開く器(next)も削除できない / どちらでもない器は削除できる', async () => {
    const { f, w } = await skewed();
    expect(w.view().rows.map((r) => [r.cid, r.current, r.next])).toEqual([
      ['c1', true, false],
      ['c2', false, true],
      ['c3', false, false],
    ]);
    expect((await w.remove('c1')).kind, '開いている器を削除できる').toBe('refused');
    expect((await w.remove('c2')).kind, '次に開く器を削除できる').toBe('refused');
    expect(f.calls.filter((c) => c.startsWith('remove'))).toEqual([]);
    expect((await w.remove('c3')).kind).toBe('done');
  });
  it('画面: current の行は「切り替える」「削除」なし、next の行は「切り替える」あり・「削除」なし、残りの行は両方あり', async () => {
    resetAppDialogForTest();
    document.body.textContent = '';
    const host = document.createElement('div');
    document.body.append(host);
    const f = fake();
    f.table.push({ cid: 'c3', title: '三つ目', createdAt: null, notes: 0 });
    await f.deps.switchTo('c2');
    appWorkspaces.attach(f.deps, 'c1');
    await appWorkspaces.refresh();
    const R = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
    const args: unknown[] = new Array(WORKSPACES_ARG_INDEX + 1).fill(undefined);
    args[0] = host;
    new R(...args).render(initialState);
    const acts = (cid: string): string[] =>
      [...host.querySelectorAll<HTMLElement>(`[data-pkc-field="workspace-row"][data-pkc-cid="${cid}"] button`)].map(
        (b) => b.getAttribute('data-pkc-action') ?? '',
      );
    expect(acts('c1')).toEqual(['workspace-rename']);
    expect(acts('c2')).toEqual(['workspace-switch', 'workspace-rename']);
    expect(acts('c3')).toEqual(['workspace-switch', 'workspace-rename', 'workspace-delete']);
  });
});
