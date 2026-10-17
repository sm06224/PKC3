/** @vitest-environment happy-dom */
/**
 * #1163 束 H1:右のペインの行(添付の大きさと種類 / フォルダの中身 / 見た目の字数 / タグの読み違え)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';

const META = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'e1',
  title: 'ノート',
  archetype: 'text',
  entryOrder: 0,
  createdAt: '2026-08-04 23:30:00',
  updatedAt: '2026-08-04 23:30:00',
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
  ...over,
});

function stateOf(metas: EntryMeta[], selected: string, openBody?: string, relations: AppState['relations'] = []): AppState {
  return {
    ...initialState,
    phase: 'ready',
    selectedLid: selected,
    entryMetas: new Map(metas.map((m) => [m.lid, m])),
    relations,
    openBody: openBody !== undefined ? { lid: selected, body: openBody } : null,
  } as AppState;
}

function paint(st: AppState): HTMLElement {
  document.body.innerHTML = '';
  const region = document.createElement('div');
  document.body.append(region);
  new InspectorRenderer(region).render(st);
  return region;
}

const cell = (region: HTMLElement, field: string): HTMLElement => {
  const el = region.querySelector<HTMLElement>(`[data-pkc-field="${field}"]`);
  if (!el) throw new Error(`field ${field} が見つからない`);
  return el;
};
const labelOf = (dd: HTMLElement): string => dd.previousElementSibling?.textContent ?? '';
const shown = (dd: HTMLElement): boolean => !dd.hidden && !(dd.previousElementSibling as HTMLElement).hidden;

describe('依頼 164:添付ノートは、字数のかわりに大きさと種類を出す', () => {
  const body = attachmentBody({ name: 'a.pdf', mime: 'application/pdf', size: 5 * 1024 * 1024, assetKey: 'k1' });
  const m = META({ archetype: 'attachment', bodyChars: body.length });

  it('🔴 「文字数」の行は出さず、「大きさ 5.0 MB」と「種類 添付 (PDF)」を出す', () => {
    const r = paint(stateOf([m], 'e1', body));
    expect(shown(cell(r, 'inspector-stats')), '設定の行の長さを文字数として出している').toBe(false);
    const size = cell(r, 'inspector-file-size');
    expect(shown(size)).toBe(true);
    expect(labelOf(size)).toBe('大きさ');
    expect(size.textContent).toBe('5.0 MB');
    expect(cell(r, 'inspector-kind').textContent).toBe('添付 (PDF)');
  });

  it('対照群: ふつうのノートには大きさの行も、種類の添え書きも出ない / 文字数は出る', () => {
    const r = paint(stateOf([META({ bodyChars: 12 })], 'e1', 'あいうえお'));
    expect(shown(cell(r, 'inspector-file-size'))).toBe(false);
    expect(cell(r, 'inspector-kind').textContent).toBe('ノート');
    expect(shown(cell(r, 'inspector-stats'))).toBe(true);
  });

  it('本文を開く前(設定が読めない間)は、大きさを出さない(嘘の 0 B を出さない)', () => {
    const r = paint(stateOf([m], 'e1'));
    expect(shown(cell(r, 'inspector-file-size'))).toBe(false);
    expect(cell(r, 'inspector-kind').textContent).toBe('添付');
  });
});

describe('依頼 168:フォルダは「中身 N 件」', () => {
  const folder = META({ lid: 'f1', archetype: 'folder', title: 'フォルダ' });
  const child = (lid: string): EntryMeta => META({ lid, title: lid, entryOrder: Number(lid.slice(1)) });
  const edge = (to: string): AppState['relations'][number] => ({
    id: 'r-' + to,
    fromLid: 'f1',
    toLid: to,
    kind: 'structural',
    createdAt: null,
    updatedAt: null,
  });

  it('🔴 直下の件数を出す(孫は数えない)', () => {
    const g = META({ lid: 'f2', archetype: 'folder', title: '子フォルダ' });
    const metas = [folder, child('c1'), child('c2'), g, child('c3')];
    const rel = [
      edge('c1'),
      edge('c2'),
      edge('f2'),
      { ...edge('c3'), id: 'r-c3', fromLid: 'f2' },
    ];
    const r = paint(stateOf(metas, 'f1', undefined, rel));
    const kids = cell(r, 'inspector-children');
    expect(shown(kids)).toBe(true);
    expect(labelOf(kids)).toBe('中身');
    expect(kids.textContent).toBe('3 件');
  });

  it('対照群: 空のフォルダは「0 件」/ ノートには行ごと出さない', () => {
    expect(cell(paint(stateOf([folder], 'f1')), 'inspector-children').textContent).toBe('0 件');
    expect(shown(cell(paint(stateOf([META()], 'e1')), 'inspector-children'))).toBe(false);
  });
});

describe('依頼 165 / 315:右のペインの字数は見た目の字数', () => {
  it('🔴 絵文字は 1 字(UTF-16 では 2)/ 行の名前は「全体の字数」', () => {
    const body = '😀😀😀';
    const r = paint(stateOf([META({ bodyChars: body.length })], 'e1', body));
    const stats = cell(r, 'inspector-stats');
    expect(labelOf(stats)).toBe('全体の字数');
    expect(stats.textContent).toBe('3 文字');
    expect(body.length, '前提:UTF-16 の長さは 6').toBe(6);
  });
});

describe('依頼 318:タグの書き方を読み違える本文では、言って、足す欄・外す × を畳む', () => {
  const body = '---\ntags: [a,\n  b]\n---\n本文\n';
  it('🔴 理由の 1 行が出て、タグを打つ欄は畳まれる', () => {
    const r = paint(stateOf([META()], 'e1', body));
    expect(cell(r, 'inspector-tags-problem').textContent).toContain('読めない書き方があります');
    const form = r.querySelector<HTMLElement>('[data-pkc-field="tag-add"]');
    expect(form?.hidden, 'タグを打つ欄が出たまま').toBe(true);
    expect(r.querySelector('[data-pkc-field="inspector-tag-off"]'), '外す × が出たまま').toBeNull();
  });
  it('対照群: 読める書き方では理由は出ず、打つ欄が出る', () => {
    const r = paint(stateOf([META()], 'e1', '---\ntags: [a, b]\n---\n本文\n'));
    expect(r.querySelector('[data-pkc-field="inspector-tags-problem"]')).toBeNull();
    expect(r.querySelector<HTMLElement>('[data-pkc-field="tag-add"]')?.hidden).toBe(false);
  });
});
