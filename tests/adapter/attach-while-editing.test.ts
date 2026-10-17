/** @vitest-environment happy-dom */
/**
 * 🔴 **編集中に「添付」でファイルを選んだら、打っていた所(カーソルの位置)に入る**(#1163 依頼 55 の 3。Gemini の裁定 = 推薦どおり B)。
 *
 * 直す前は「編集中なのでまだ入れていません。編集を終えると本文のいちばん下に入れます」と預かり、
 * 貼り付けたスクリーンショットだけがカーソルの位置に入った(同じ「編集中に入れる」で、入る場所が入れ方で違った)。
 *
 * 対照群:編集中でなければ今までどおり添付(`attachFiles`)/ 差し込む口が無い環境も添付に落ちる。
 * ⚠ 入る参照の組み立て(画像は `![…]`、PDF は `[…]`)は main.ts の `pasteImages` で、どの test からも実行されない file ──
 *   ここでは「選んだ全ファイルが貼り付けと同じ道に渡り、返った参照がカーソルの位置に入る」ことを見る。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';

function setup(editing: boolean, over: Partial<BinderServices> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  if (editing) {
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: 'メモ', body: 'ab', edit: true });
  } else {
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: 'メモ', body: 'ab', edit: false });
  }
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'editor-body');
  ta.value = 'ab';
  ta.setSelectionRange(1, 1); // a|b ── カーソルは 1 文字目の後ろ
  root.querySelector('[data-pkc-region="detail"]')!.append(ta);
  const attachFiles = vi.fn();
  const pasteImages = vi.fn(async (files: readonly File[]) => files.map((f) => `[${f.name}](asset:k-${f.name})`));
  bindActions(root, d, { attachFiles, pasteImages, ...over });
  const input = root.querySelector<HTMLInputElement>('[data-pkc-field="attach-input"]')!;
  const choose = (files: File[]): void => {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { d, ta, attachFiles, pasteImages, choose };
}

const pdf = (name: string): File => new File(['%PDF'], name, { type: 'application/pdf' });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('編集中に「添付」でファイルを選ぶ(#1163 依頼 55 の 3)', () => {
  it('🔴 編集中: 選んだ全部が貼り付けと同じ道へ渡り、返った参照がカーソルの位置に入る(末尾ではない)', async () => {
    const { d, ta, attachFiles, pasteImages, choose } = setup(true);
    expect(d.getState().phase, '前提: 編集中になっていない').toBe('editing');
    choose([pdf('契約書.pdf'), pdf('見積書.pdf')]);
    await tick();
    expect(pasteImages).toHaveBeenCalledTimes(1);
    expect(pasteImages.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['契約書.pdf', '見積書.pdf']);
    expect(attachFiles, '編集中に預かる道へ入った').not.toHaveBeenCalled();
    expect(ta.value).toBe('a[契約書.pdf](asset:k-契約書.pdf)\n[見積書.pdf](asset:k-見積書.pdf)\nb');
  });

  it('🔴 編集中でなければ、今までどおり添付(貼り付けの道へは行かない)', async () => {
    const { d, attachFiles, pasteImages, choose } = setup(false);
    expect(d.getState().phase, '前提: 編集中になっている').toBe('ready');
    choose([pdf('契約書.pdf')]);
    await tick();
    expect(attachFiles).toHaveBeenCalledTimes(1);
    expect(pasteImages).not.toHaveBeenCalled();
  });

  it('🔴 差し込む口が無い環境では、編集中でも今までどおり添付へ落ちる(黙って消えない)', async () => {
    const { attachFiles, choose } = setup(true, { pasteImages: undefined });
    choose([pdf('契約書.pdf')]);
    await tick();
    expect(attachFiles).toHaveBeenCalledTimes(1);
  });
});
