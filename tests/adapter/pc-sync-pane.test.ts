/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import { PcFolderRenderer } from '../../src/adapter/ui/render/pc-folder';
import { LocalFolder } from '../../src/adapter/platform/local-folder';
import type { FolderSync, FolderSyncView } from '../../src/adapter/platform/folder-sync';

/**
 * PC タブの「フォルダと同期」の欄(#1455 の後半)。描画器は `FolderSync.view()` を映すだけ ── 見え方を差し込んで見る。
 */
const view = (over: Partial<FolderSyncView> = {}): FolderSyncView => ({
  version: 1,
  phase: 'idle',
  folderName: 'sync',
  minutes: 5,
  lastText: null,
  lastAt: null,
  message: null,
  gone: [],
  detached: [],
  ...over,
});

function setup(initial: FolderSyncView) {
  let v = initial;
  const sync = { view: () => v } as unknown as FolderSync;
  const folder = new LocalFolder({ picker: null, open: async () => {}, fail: () => {}, onChange: () => {} });
  const host = document.createElement('div');
  document.body.append(host);
  const r = new PcFolderRenderer(host, folder, sync);
  r.render();
  return {
    host,
    set: (next: Partial<FolderSyncView>) => {
      v = { ...v, ...next, version: v.version + 1 };
      r.render();
    },
    q: (sel: string) => host.querySelector<HTMLElement>(sel),
    all: (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)],
  };
}

describe('同期の欄', () => {
  it('🔴 選べないブラウザ: 理由を言い、押せるボタンを置かない', () => {
    const p = setup(view({ phase: 'unsupported', message: 'このブラウザでは使えません' }));
    expect(p.q('[data-pkc-field="pc-sync-note"]')!.textContent).toContain('使えません');
    expect(p.all('[data-pkc-field="pc-sync"] button').length).toBe(0);
    expect(p.q('[data-pkc-field="pc-sync-interval"]')!.hidden).toBe(true);
  });

  it('🔴 つなぐ前は「フォルダを選んで同期…」だけ。つなぐと 間隔・今すぐ・やめる(片道にしない)', () => {
    const p = setup(view({ phase: 'none', folderName: null }));
    expect(p.all('[data-pkc-field="pc-sync"] button').map((b) => b.getAttribute('data-pkc-action'))).toEqual(['pc-sync-pick']);
    p.set({ phase: 'idle', folderName: 'sync' });
    expect(p.all('[data-pkc-field="pc-sync"] button').map((b) => b.getAttribute('data-pkc-action'))).toEqual([
      'pc-sync-now',
      'pc-sync-stop',
    ]);
    expect(p.q('[data-pkc-field="pc-sync-interval"]')!.hidden).toBe(false);
  });

  it('🔴 間隔の選択は、同期が走って欄が描き直されても同じ要素のまま(開いた一覧が閉じない)', () => {
    const p = setup(view());
    const sel = p.q('[data-pkc-field="pc-sync-interval"]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['1', '5', '15', '60']);
    sel.value = '15';
    p.set({ phase: 'running' });
    expect(p.q('[data-pkc-field="pc-sync-interval"]'), '描き直しで select が作り直された').toBe(sel);
    expect(p.q('[data-pkc-field="pc-sync"]')!.contains(sel)).toBe(true);
    p.set({ phase: 'idle', lastText: '変更はありませんでした', lastAt: '13:05' });
    expect(p.q('[data-pkc-field="pc-sync-interval"]')).toBe(sel);
    expect(p.q('[data-pkc-field="pc-sync-last"]')!.textContent).toBe('13:05 変更はありませんでした');
  });

  it('🔴 フォルダで消えたノート: 行ごとに「書き戻す / 同期から外す」(lid つき)。外したノートには「同期に戻す」', () => {
    const p = setup(view({ gone: [{ lid: 'a', title: 'あ' }, { lid: 'b', title: 'い' }], detached: [{ lid: 'c', title: 'う' }] }));
    const gone = p.q('[data-pkc-field="pc-sync-gone"]')!;
    expect([...gone.querySelectorAll('button')].map((b) => `${b.getAttribute('data-pkc-action')}:${b.getAttribute('data-pkc-sync-lid')}`)).toEqual([
      'pc-sync-restore:a',
      'pc-sync-detach:a',
      'pc-sync-restore:b',
      'pc-sync-detach:b',
    ]);
    expect(gone.textContent).toContain('あ');
    const det = p.q('[data-pkc-field="pc-sync-detached"]')!;
    expect([...det.querySelectorAll('button')].map((b) => `${b.getAttribute('data-pkc-action')}:${b.getAttribute('data-pkc-sync-lid')}`)).toEqual([
      'pc-sync-attach:c',
    ]);
    expect(p.host.textContent).toContain('フォルダで消えたノート 2 件');
    // 空にすれば欄ごと消える(出しっぱなしにしない)
    p.set({ gone: [], detached: [] });
    expect(p.q('[data-pkc-field="pc-sync-gone"]')).toBeNull();
    expect(p.q('[data-pkc-field="pc-sync-detached"]')).toBeNull();
  });

  it('止まったとき(許可切れ・記録の問題)は、理由と「選び直す」「やめる」', () => {
    const p = setup(view({ phase: 'lost', message: '許可が切れました' }));
    expect(p.host.textContent).toContain('許可が切れました');
    expect(p.all('[data-pkc-field="pc-sync"] button').map((b) => b.getAttribute('data-pkc-action'))).toEqual([
      'pc-sync-pick',
      'pc-sync-stop',
    ]);
    expect(p.q('[data-pkc-field="pc-sync-interval"]')!.hidden).toBe(true);
  });

  it('フォルダの一覧の版が変わっても、同期の欄(と select)は作り直さない', () => {
    const p = setup(view());
    const sec = p.q('[data-pkc-field="pc-sync"]');
    const sel = p.q('[data-pkc-field="pc-sync-interval"]');
    p.host.querySelector('[data-pkc-field="pc-folder-box"]')!.textContent = 'x';
    expect(p.q('[data-pkc-field="pc-sync"]')).toBe(sec);
    expect(p.q('[data-pkc-field="pc-sync-interval"]')).toBe(sel);
  });
});
