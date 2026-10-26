/** @vitest-environment happy-dom */
/**
 * 🔴 **PC(パソコンのフォルダ)を別ウィンドウでも開ける**(#300)。
 *
 * 左の列のタブ「PC」(#215)と同じ中身を、中央の面(= 別ウィンドウの本体)にも描く。守る主張:
 * 1. 面に題が出て、中身(フォルダを選ぶボタン)が描かれる(空の器で終わらない)
 * 2. 使えないブラウザでは理由を言う(押せないボタンを置かない)
 * 3. 押し口(`pc-pick-folder`)は中央の面からも binder に届く
 * 4. 別窓が塞がれたときの退避先は左の「PC」タブ(中央を奪わない)
 * 5. 行を押してノートが開いたら、中央は本文へ退く(PC の面に居座らない)
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalFolder } from '../../src/adapter/platform/local-folder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { homeTabOf, hasPaneHome } from '../../src/adapter/ui/render/browse-mode';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';

function folder(over: Partial<ConstructorParameters<typeof LocalFolder>[0]> = {}): LocalFolder {
  return new LocalFolder({
    picker: async () => {
      throw new Error('使わない');
    },
    open: async () => {},
    fail: () => {},
    onChange: () => {},
    ...over,
  });
}

const pcState = (): AppState => ({ ...initialState, viewMode: 'pc' });

describe('PC を中央の面(別ウィンドウ)に描く(#300)', () => {
  it('🔴 題とフォルダを選ぶボタンが出る', () => {
    const host = document.createElement('div');
    document.body.append(host);
    new CenterRouter(host, undefined, undefined, undefined, undefined, undefined, undefined, undefined, folder()).render(
      pcState(),
    );
    const pane = host.querySelector<HTMLElement>('[data-pkc-view-pane="pc"]')!;
    expect(pane.hidden, 'PC の面が出ていない').toBe(false);
    expect(pane.querySelector('[data-pkc-field="pane-title"]')?.textContent).toContain('PC');
    expect(
      pane.querySelector('[data-pkc-action="pc-pick-folder"]'),
      'フォルダを選ぶボタンが描かれていない(器だけ)',
    ).not.toBeNull();
  });

  it('🔴 使えないブラウザでは理由を言う(押せないボタンを置かない)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    new CenterRouter(
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      folder({ picker: null }),
    ).render(pcState());
    const pane = host.querySelector<HTMLElement>('[data-pkc-view-pane="pc"]')!;
    expect(pane.textContent).toContain('このブラウザでは使えません');
    expect(pane.querySelector('[data-pkc-action="pc-pick-folder"]')).toBeNull();
  });

  it('🔴 押し口は中央の面からも binder に届く', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const pick = vi.fn(async () => {});
    const f = folder();
    const d = new Dispatcher();
    bindActions(root, d, { localFolder: { pick } as unknown as LocalFolder });
    new CenterRouter(
      regions.detail,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f,
    ).render(pcState());
    const btn = root.querySelector<HTMLButtonElement>('[data-pkc-view-pane="pc"] [data-pkc-action="pc-pick-folder"]');
    expect(btn, '中央の面にボタンが無い').not.toBeNull();
    btn!.click();
    expect(pick, '押しても binder に届かない').toHaveBeenCalledTimes(1);
  });

  it('🔴 別窓が塞がれたときの退避先は左の「PC」タブ', () => {
    expect(homeTabOf('pc')).toBe('pc');
    expect(hasPaneHome('pc')).toBe(true);
    // 対照群 ── 集計は左に置き場が無い(確認してから中央で開く)
    expect(hasPaneHome('query')).toBe(false);
  });

  it('🔴 ノートを選んだら、中央は本文へ退く', () => {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'x',
          title: 'x',
          archetype: 'text',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'pc' });
    expect(d.getState().viewMode).toBe('pc');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'x' });
    expect(d.getState().viewMode, 'PC の面に居座っている').toBe('detail');
  });
});
