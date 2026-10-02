/** @vitest-environment happy-dom */
/**
 * 「別のウィンドウで見る」を押したとき、**押した添付のノート**が受け手へ運ばれる(#275 段①)。
 *
 * 🔴 PDF を PKC の画面で読む窓は「ノートへ引く」の起点にこの lid を使う。押した瞬間の**選択**を読むと、
 *   留めた枠(横に並べた枠)では押していないノートへ引いてしまう ── だから押した要素の
 *   `data-pkc-target-lid` を先に見て、無いときだけ選択へ落とす(他の口と同じ作法)。
 */
import { describe, expect, it, vi } from 'vitest';
import { bindActions } from '@adapter/ui/actions/binder';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { initialState } from '@adapter/state/app-state';

function press(attrs: Record<string, string>, selectedLid: string | null) {
  document.body.textContent = '';
  const host = document.createElement('div');
  document.body.append(host);
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', 'view-asset');
  for (const [k, v] of Object.entries(attrs)) btn.setAttribute(k, v);
  host.append(btn);
  const viewAsset = vi.fn();
  bindActions(
    host,
    { dispatch: vi.fn(), getState: () => ({ ...initialState, selectedLid }) } as unknown as Dispatcher,
    { viewAsset },
  );
  btn.click();
  return viewAsset;
}

const base = {
  'data-pkc-asset-key': 'k1',
  'data-pkc-asset-name': '見積.pdf',
  'data-pkc-asset-mime': 'application/pdf',
};

describe('view-asset が lid を運ぶ', () => {
  it('押した要素が持つ lid を、選択より先に使う(留めた枠で押していないノートへ行かない)', () => {
    const f = press({ ...base, 'data-pkc-target-lid': 'pinned' }, 'selected-other');
    expect(f).toHaveBeenCalledWith('k1', '見積.pdf', 'application/pdf', 'pinned');
  });

  it('対照群: 属性が無い古い DOM は、選択へ落ちる', () => {
    const f = press(base, 'sel');
    expect(f).toHaveBeenCalledWith('k1', '見積.pdf', 'application/pdf', 'sel');
  });

  it('属性も選択も無ければ lid なし(受け手は引く先を断る)', () => {
    const f = press(base, null);
    expect(f).toHaveBeenCalledWith('k1', '見積.pdf', 'application/pdf', undefined);
  });
});
