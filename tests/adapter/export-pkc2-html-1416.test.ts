/** @vitest-environment happy-dom */
/**
 * 🔴 **PKC2 のポータブル形式の HTML で書き出す**(台帳 #1416)── 実行部と入口。
 * 観測点: ① 押すと「元にする HTML を選ぶ」口が開き、選んだ file が実体へ渡る ② 書き出した Blob の中身(データだけ入れ替わる)
 * ③ 断り方(編集中 / PKC2 の HTML でない)④ やめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { exportPkc2Html } from '../../src/adapter/ui/actions/export-pkc2-html';
import type { ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import { COLLECTION_PANE_COMMANDS } from '../../src/adapter/ui/render/commands';
import { createCancelToken } from '../../src/features/job-cancel';
import type { JobControl } from '../../src/adapter/ui/actions/job-control';

const SHELL =
  '<!DOCTYPE html><html data-pkc-app="pkc2" data-pkc-schema="1"><head><title>PKC2</title></head><body>' +
  '<script id="pkc-data" type="application/json">{}</script>' +
  '<script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script></body></html>';

function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      { lid: 'n1', title: 'ノート', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null },
    ],
    relations: [],
  });
  return d;
}

function deps(over: Partial<ExportDeps> = {}) {
  const files: Array<{ name: string; blob: Blob }> = [];
  const said: string[] = [];
  const reports: string[][] = [];
  const base = {
    source: {
      cid: 'c1',
      title: '箱',
      listEntryMetas: async () => [
        { lid: 'n1', title: 'ノート', archetype: 'text', created_at: '2026-10-01 00:00:00', updated_at: null, entry_order: 1, status: null, date: null, archived: 0 },
      ],
      listBodies: async () => ({ rows: [{ lid: 'n1', body: '本文' }], done: true }),
      listRelations: async () => [],
      listAssetMetas: async () => [{ key: 'k1', mime: 'image/png', size: 3, hash: null }],
      getAssetBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    },
    download: (name: string, blob: Blob) => void files.push({ name, blob }),
    notify: (m: string) => void said.push(m),
    report: (n: readonly string[]) => void reports.push([...n]),
    settle: async () => {},
    now: () => new Date(2026, 9, 29, 12),
    ...over,
  } as unknown as ExportDeps;
  return { base, files, said, reports };
}

describe('実行部 (#1416)', () => {
  it('🔴 書き出した HTML は、元の前後を保ち、データがノートと添付(base64)に入れ替わる', async () => {
    const d = booted();
    const { base, files, said } = deps();
    expect(await exportPkc2Html(d, base, SHELL)).toBe(1);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('pkc2-箱-20261029.html');
    const text = await files[0]!.blob.text();
    expect(text.startsWith(SHELL.slice(0, SHELL.indexOf('{}')))).toBe(true);
    expect(text).toContain('"title": "ノート"');
    expect(text).toContain('"AQID"'); // 1,2,3 の base64
    expect(text.endsWith('</script></body></html>')).toBe(true);
    expect(said.at(-1)).toContain('PKC2 の HTML を書き出しました');
  });

  it('編集中は断る(元の HTML を読みに行かない)', async () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    const errors: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: Parameters<typeof orig>[0]) => {
      if (a.type === 'OP_FAILED') errors.push((a as { error: string }).error);
      return orig(a);
    }) as typeof d.dispatch;
    const { base, files } = deps();
    expect(await exportPkc2Html(d, base, SHELL)).toBeNull();
    expect(errors.join()).toContain('編集');
    expect(files).toHaveLength(0);
  });

  it('PKC2 の HTML でないものは理由を言って断る(何も作らない)', async () => {
    const d = booted();
    const errors: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: Parameters<typeof orig>[0]) => {
      if (a.type === 'OP_FAILED') errors.push((a as { error: string }).error);
      return orig(a);
    }) as typeof d.dispatch;
    const { base, files } = deps();
    expect(await exportPkc2Html(d, base, '<html><body>ふつうのページ</body></html>')).toBeNull();
    expect(errors.join()).toContain('PKC2 の HTML ではない');
    expect(files).toHaveLength(0);
  });

  it('🔴 やめたら、ダウンロードしない・失敗にしない・欄は片づく', async () => {
    const d = booted();
    const t = createCancelToken();
    t.cancel();
    const log: string[] = [];
    const job: JobControl = {
      start: () => (log.push('start'), t),
      finish: () => void log.push('finish'),
      cancelCurrent: () => false,
    };
    const { base, files, said } = deps({ job });
    expect(await exportPkc2Html(d, base, SHELL)).toBeNull();
    expect(files).toHaveLength(0);
    expect(said).toContain('書き出しをやめました(ファイルは作っていません)');
    expect(log).toEqual(['start', 'finish']);
  });
});

describe('入口 (#1416)', () => {
  it('🔴 書き出しの一覧に「PKC2 の HTML で書き出す」があり、PKC3 入り HTML と別の口である', () => {
    const a = COLLECTION_PANE_COMMANDS.find((c) => c.action === 'export-pkc2-html');
    expect(a?.label).toBe('PKC2 の HTML で書き出す');
    expect(a?.title).toContain('元の HTML は変えません');
  });

  it('🔴 押すと選ぶ口が開き(常設の 1 つを使い回す)、選んだ file が実体へ渡る', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const exportPkc2 = vi.fn();
    bindActions(root, new Dispatcher(), { exportPkc2Html: exportPkc2 });
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'export-pkc2-html');
    root.append(btn);
    const clicks: HTMLInputElement[] = [];
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      clicks.push(this);
    };
    try {
      btn.click();
      btn.click();
    } finally {
      HTMLInputElement.prototype.click = orig;
    }
    expect(clicks, '選ぶ口が開いていない').toHaveLength(2);
    expect(clicks[0], '押すたびに口を増やしている').toBe(clicks[1]);
    expect(root.querySelectorAll('[data-pkc-field="pkc2-html-input"]')).toHaveLength(1);
    const input = clicks[0]!;
    const f = new File([SHELL], 'pkc2.html', { type: 'text/html' });
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(exportPkc2).toHaveBeenCalledWith(f);
  });
});
