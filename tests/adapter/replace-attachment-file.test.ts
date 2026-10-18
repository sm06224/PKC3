/** @vitest-environment happy-dom */
/**
 * 🔴 **添付の「ファイルを差し替える」**(#1163 依頼 212。Gemini の裁定 = 要る)。
 *
 * 守る主張:
 * 1. 添付の画面に「ファイルを差し替える」が出て、押したボタンが差し替え先のノートを運ぶ(留めた枠でも、その枠のノート)
 * 2. 押すとファイルを選ぶ欄が開き、選んだら**差し替え先 + ファイル**がサービスへ渡る(選び直しのため欄は空に戻す)
 * 3. ファイルを選ばなかったとき・差し替え先が分からないときは何も撃たない
 * 4. 取込・整理の最中は断る(`BODY_WRITE_ACTIONS` の門)
 */
import { describe, expect, it, vi } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { ExtensionGrants } from '../../src/adapter/platform/extension-grants';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { TARGET_LID_ATTR } from '../../src/adapter/ui/render/target-lid';

const meta = (lid: string, archetype = 'attachment'): EntryMeta => ({
  lid,
  title: `t-${lid}`,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BODY = attachmentBody({ name: '契約書.pdf', mime: 'application/pdf', size: 3, assetKey: 'ast-1' });

async function setup(over: Partial<BinderServices> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const lender: AssetLender = { lend: async () => ({ url: 'blob:x', dispose: () => {} }), getBlob: async () => null };
  const detail = new DetailRenderer(
    regions.detail,
    lender,
    undefined,
    undefined,
    undefined,
    undefined,
    new ExtensionGrants(null),
  );
  d.onState((s) => detail.render(s));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => BODY,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1'), meta('t1', 'text')], relations: [] });
  const replaceAttachmentFile = vi.fn();
  bindActions(root, d, { replaceAttachmentFile, ...over });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
  await tick(20);
  const button = root.querySelector<HTMLButtonElement>('[data-pkc-action="replace-attachment-file"]');
  const input = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-input"]');
  return { root, d, button, input, replaceAttachmentFile };
}

describe('添付の「ファイルを差し替える」(依頼 212)', () => {
  it('🔴 添付の画面にボタンが出て、差し替え先のノートを持つ。ファイルを選ぶ欄は 1 つ(複数選べない)', async () => {
    const { button, input } = await setup();
    expect(button, 'ボタンが出ていない').not.toBeNull();
    expect(button!.textContent).toBe('ファイルを差し替える');
    expect(button!.getAttribute(TARGET_LID_ATTR), '差し替え先を持っていない').toBe('a1');
    expect(button!.title, '押す前に何が起きるか読めない').toContain('新しい版');
    expect(input?.type).toBe('file');
    expect(input?.multiple, '複数選べてしまう').toBe(false);
  });

  it('対照: 添付でないノートには出ない', async () => {
    const { root, d } = await setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 't1' });
    await tick(20);
    expect(root.querySelector('[data-pkc-action="replace-attachment-file"]')).toBeNull();
  });

  it('🔴 押すと欄が開き、選ぶと「差し替え先 + ファイル」が渡る。欄は空に戻る', async () => {
    const { button, input, replaceAttachmentFile } = await setup();
    const clicked = vi.fn();
    input!.addEventListener('click', clicked);
    button!.click();
    expect(clicked, '欄を開いていない').toHaveBeenCalledTimes(1);
    expect(input!.getAttribute('data-pkc-replace-lid'), '差し替え先を欄に控えていない').toBe('a1');
    const file = new File([new Uint8Array([1, 2, 3])], '新しい版.pdf');
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(replaceAttachmentFile).toHaveBeenCalledTimes(1);
    expect(replaceAttachmentFile.mock.calls[0]![0]).toBe('a1');
    expect(replaceAttachmentFile.mock.calls[0]![1]).toBe(file);
    expect(input!.hasAttribute('data-pkc-replace-lid'), '控えが残った(次の選び直しで別のノートに効く)').toBe(false);
  });

  it('🔴 ファイルを選ばずに閉じたら何も撃たない / 差し替え先の控えが無ければ撃たない', async () => {
    const { button, input, replaceAttachmentFile } = await setup();
    button!.click();
    Object.defineProperty(input!, 'files', { value: [], configurable: true });
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(replaceAttachmentFile).not.toHaveBeenCalled();
    // 控えが無い(別の道で欄が開いた)ときは、選ばれても撃たない
    input!.removeAttribute('data-pkc-replace-lid');
    Object.defineProperty(input!, 'files', { value: [new File([new Uint8Array([1])], 'x.pdf')], configurable: true });
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(replaceAttachmentFile).not.toHaveBeenCalled();
  });

  it('🔴 取込・整理の最中(書込の門が閉じている間)は押しても欄を開かず、理由が出る。門が開いていれば開く(対照)', async () => {
    let busy = true;
    const { button, input, d } = await setup({ busy: () => busy });
    const clicked = vi.fn();
    input!.addEventListener('click', clicked);
    const errors: Array<string | null> = [];
    d.onState((s) => errors.push(s.error));
    button!.click();
    expect(clicked, '門が閉じているのに欄を開いた').not.toHaveBeenCalled();
    expect(errors.at(-1) ?? '').toContain('実行中です');
    busy = false;
    button!.click();
    expect(clicked, '門が開いたのに欄を開かない').toHaveBeenCalledTimes(1);
  });
});
