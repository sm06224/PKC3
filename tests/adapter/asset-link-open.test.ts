/** @vitest-environment happy-dom */
/**
 * 🔴 **本文に入れた添付のリンクを押したときの行き先**(#1163 依頼 55 の 1・2。Gemini の裁定 = 推薦どおり)。
 *
 * 直す前は、本文の `[契約書.pdf](asset:…)` を押すと、PDF も含めて**見る前に保存**されていた。いまは:
 * - 本文のリンク(`.pkc-asset-link`)は `openAssetLink` へ(PDF は別のウィンドウ / ほかは保存 / 保存名は添付のいまの名前)
 * - 添付のノートの「添付をダウンロード」ボタンは、同じ action でも**必ず保存**する(PDF を保存できる道を残す)
 *
 * ⚠ ここが見るのは**押した物の見分け**(binder の配線)。PDF かどうかと名前の引き方は main.ts の仕事で、
 *   どの test からも実行されない file なので、判断を書かない形にした(binder は押した物の class だけを見る)。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';

function setup(over: Partial<BinderServices> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const downloadAsset = vi.fn();
  const openAssetLink = vi.fn();
  bindActions(root, d, { downloadAsset, openAssetLink, ...over });
  const bodyLink = document.createElement('a');
  bodyLink.className = 'pkc-asset-link';
  bodyLink.setAttribute('data-pkc-action', 'download-asset');
  bodyLink.setAttribute('data-pkc-asset-key', 'ast-1');
  bodyLink.setAttribute('data-pkc-asset-name', '契約書.pdf');
  bodyLink.textContent = '契約書.pdf';
  const button = document.createElement('button');
  button.setAttribute('data-pkc-action', 'download-asset');
  button.setAttribute('data-pkc-asset-key', 'ast-1');
  button.setAttribute('data-pkc-asset-name', 'scan.pdf');
  button.textContent = '添付をダウンロード';
  root.append(bodyLink, button);
  return { bodyLink, button, downloadAsset, openAssetLink };
}

describe('本文の添付リンクを押す(#1163 依頼 55 の 1・2)', () => {
  it('🔴 本文のリンクは openAssetLink へ。リンクの字を運び、保存の口は呼ばない', () => {
    const { bodyLink, downloadAsset, openAssetLink } = setup();
    bodyLink.click();
    expect(openAssetLink).toHaveBeenCalledTimes(1);
    expect(openAssetLink.mock.calls[0]!.slice(0, 2), '鍵とリンクの字が運ばれていない').toEqual([
      'ast-1',
      '契約書.pdf',
    ]);
    expect(downloadAsset, 'リンクを押しただけで保存の口が呼ばれた').not.toHaveBeenCalled();
  });

  it('🔴 添付のノートの「添付をダウンロード」ボタンは、必ず保存する(PDF も)', () => {
    const { button, downloadAsset, openAssetLink } = setup();
    button.click();
    expect(downloadAsset).toHaveBeenCalledWith('ast-1', 'scan.pdf');
    expect(openAssetLink, 'ボタンが別のウィンドウの道へ入った').not.toHaveBeenCalled();
  });

  it('🔴 openAssetLink の無い配線では、本文のリンクも今までどおり保存へ落ちる(押して無反応にしない)', () => {
    const { bodyLink, downloadAsset } = setup({ openAssetLink: undefined });
    bodyLink.click();
    expect(downloadAsset).toHaveBeenCalledWith('ast-1', '契約書.pdf');
  });
});
