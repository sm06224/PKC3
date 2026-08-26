/** @vitest-environment happy-dom */
/**
 * 🔴 **何が容量を食っているか**(#415)── 画面の側。
 *
 * 数える側は `tests/adapter/storage-worker.test.ts`(実物の worker)、
 * 並べ方は `tests/features/storage-profile.test.ts` が見る。
 * ここで見るのは配線:**押したら出るか / 行から飛べるか / 失敗を黙らせないか**。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { buildSettingsCommands } from '../../src/adapter/ui/render/commands';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { StorageProfileResult } from '../../src/features/storage/storage-profile';

const meta = (lid: string, title: string): EntryMeta =>
  ({
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  }) as EntryMeta;

const SET = [meta('a', '写真たくさん'), meta('b', '軽いノート')];

function mount(profile?: () => Promise<StorageProfileResult>) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  root.append(buildSettingsCommands());
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: SET, relations: [] });
  bindActions(root, d, profile === undefined ? {} : { storageProfile: profile });
  return {
    root,
    d,
    run: root.querySelector<HTMLButtonElement>('[data-pkc-field="storage-profile-run"]')!,
    rows: () =>
      [...root.querySelectorAll('[data-pkc-field="storage-profile-list"] button')].map(
        (b) => b.textContent,
      ),
    summary: () =>
      root.querySelector('[data-pkc-field="storage-profile-summary"]')?.textContent ?? '',
    shared: () => root.querySelector<HTMLElement>('[data-pkc-field="storage-profile-shared"]')!,
  };
}

const result = (over: Partial<StorageProfileResult> = {}): StorageProfileResult => ({
  rows: [
    { lid: 'a', assetBytes: 5_000_000, bodyChars: 10, sharedAssets: 0 },
    { lid: 'b', assetBytes: 1024, bodyChars: 3, sharedAssets: 0 },
  ],
  totalAssetBytes: 5_001_024,
  orphanBytes: 0,
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('押したとき', () => {
  it('🔴 重い順に並ぶ', async () => {
    const m = mount(async () => result());
    m.run.click();
    await vi0();
    expect(m.rows()).toHaveLength(2);
    expect(m.rows()[0], '重い順になっていない').toContain('写真たくさん');
    expect(m.rows()[0]).toContain('4.8 MB');
  });

  it('🔴 **行からそのノートへ飛べる**(見えても辿り着けない、を作らない)', async () => {
    const m = mount(async () => result());
    m.run.click();
    await vi0();
    const first = m.root.querySelector<HTMLElement>(
      '[data-pkc-field="storage-profile-list"] button',
    )!;
    expect(first.getAttribute('data-pkc-action'), '押しても飛べない行').toBe('select-entry');
    first.click();
    expect(m.d.getState().selectedLid, 'そのノートが選ばれていない').toBe('a');
  });

  it('🔴 合計は「何を数えているか」を言う(ブラウザの使用量と混同させない)', async () => {
    const m = mount(async () => result());
    m.run.click();
    await vi0();
    expect(m.summary()).toContain('数え方が違います');
  });

  it('孤児が在れば、片づけられることまで言う', async () => {
    const m = mount(async () => result({ orphanBytes: 2048 }));
    m.run.click();
    await vi0();
    expect(m.summary()).toContain('使っていない添付を消す');
  });

  it('⚠ 共有が無ければ但し書きを出さない', async () => {
    const m = mount(async () => result());
    m.run.click();
    await vi0();
    expect(m.shared().hidden, '要らない注意書きが出ている').toBe(true);
  });

  it('🔴 共有が在れば「消しても減らない」と出す', async () => {
    const m = mount(async () =>
      result({ rows: [{ lid: 'a', assetBytes: 100, bodyChars: 1, sharedAssets: 2 }] }),
    );
    m.run.click();
    await vi0();
    expect(m.shared().hidden).toBe(false);
    expect(m.shared().textContent).toContain('減りません');
  });

  it('⚠ 重いノートが 1 件も無くても、黙って空にしない', async () => {
    const m = mount(async () => result({ rows: [], totalAssetBytes: 0 }));
    m.run.click();
    await vi0();
    expect(m.rows()).toHaveLength(0);
    expect(m.summary(), '空の画面で終わっている').toContain('ありません');
  });
});

describe('うまくいかないとき', () => {
  it('🔴 配線が無ければ**断る**(「調べています…」で止めない)', () => {
    const m = mount(undefined);
    m.run.click();
    expect(m.d.getState().error, '無言で止まっている').toContain('数えられません');
  });

  it('🔴 失敗したら理由を出して、途中の字を残さない', async () => {
    const m = mount(async () => {
      throw new Error('boom');
    });
    m.run.click();
    await vi0();
    expect(m.summary(), '「調べています…」のまま残っている').not.toContain('調べています');
    expect(m.d.getState().error).toContain('数えられませんでした');
  });
});

/** microtask を 2 回流す(`.then` の中でさらに DOM を触るため)。 */
async function vi0(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
