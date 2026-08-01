/**
 * P6a: PKC2 → PKC3 純変換 core の pin。
 * variant を必ず持つ(ゼロ件次元を作らない): legacy data 直埋め / legacy log id /
 * lid 衝突 / 未知 kind relation / system entries / revisions 捨て。
 */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import {
  convertPkc2Container,
  type Pkc2Container,
} from '../../src/features/import/pkc2-convert';

function opts(existing: string[] = []) {
  let lidN = 0;
  let keyN = 0;
  return {
    existingLids: new Set(existing),
    orderBase: existing.length,
    genLid: () => `new-${++lidN}`,
    genAssetKey: () => `ast-new-${++keyN}`,
  };
}

const FIXTURE: Pkc2Container = {
  meta: { entry_order: ['b-note', 'a-todo'] },
  entries: [
    { lid: 'a-todo', title: 'やること', archetype: 'todo',
      body: '{"status":"done","description":"買い物 ![p](asset:ast-old-1)","date":"2026-08-01"}' },
    { lid: 'b-note', title: 'ノート', archetype: 'text',
      body: '参照 [t](entry:c-log#log/log-123-4) と [a](asset:ast-old-1)' },
    { lid: 'c-log', title: 'ログ', archetype: 'textlog',
      body: '{"entries":[{"id":"log-123-4","text":"記録","createdAt":"2026-07-01T09:00:00","flags":[]}]}' },
    { lid: 'd-att', title: '添付', archetype: 'attachment',
      body: '{"name":"p.png","mime":"image/png","size":3,"asset_key":"ast-old-1","launcher_url":"https://x"}' },
    { lid: 'e-legacy', title: '旧添付', archetype: 'attachment',
      body: '{"name":"old.bin","mime":"application/zip","data":"QUJD"}' },
    { lid: '__flags__', title: '', archetype: 'system-flags', body: '{"values":{}}' },
    { lid: '__settings__', title: '', archetype: 'system-settings', body: '{}' },
  ],
  relations: [
    { id: 'r1', from: 'b-note', to: 'a-todo', kind: 'structural' },
    { id: 'r2', from: 'b-note', to: '__flags__', kind: 'semantic' }, // 端点除外
    { id: 'r3', from: 'b-note', to: 'a-todo', kind: 'weird-kind' }, // 未知 kind
  ],
  assets: { 'ast-old-1': 'UE5H' },
  revisions: [{ id: 'v1' }, { id: 'v2' }],
};

describe('convertPkc2Container (P6a)', () => {
  const r = convertPkc2Container(FIXTURE, opts());

  it('system entries を除外し、entry_order は meta.entry_order 優先で採番', () => {
    expect(r.entries.map((e) => e.lid)).toEqual([
      'b-note', 'a-todo', 'c-log', 'd-att', 'e-legacy', // order 指定 2 件が先頭
    ]);
    expect(r.entries.map((e) => e.entryOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it('JSON body が全て PKC-Markdown 化される(JSON 文字列 body を作らない)', () => {
    for (const e of r.entries) {
      expect(e.body.trimStart().startsWith('{')).toBe(false);
    }
    const todo = r.entries.find((e) => e.lid === 'a-todo')!;
    const fm = parseFrontmatter(todo.body);
    expect(fm.meta['status']).toBe('done');
    expect(fm.meta['date']).toBe('2026-08-01');
  });

  it('asset key は全再採番され、本文参照と attachment frontmatter の両方が追従', () => {
    expect(r.assets.map((a) => a.key)).toContain('ast-new-1');
    const todo = r.entries.find((e) => e.lid === 'a-todo')!;
    expect(todo.body).toContain('asset:ast-new-1');
    expect(todo.body).not.toContain('ast-old-1');
    const att = r.entries.find((e) => e.lid === 'd-att')!;
    const fm = parseFrontmatter(att.body);
    expect(fm.meta['attachment.asset_key']).toBe('ast-new-1');
    // mime は attachment body から回収される
    expect(r.assets.find((a) => a.key === 'ast-new-1')?.mime).toBe('image/png');
    // launcher_url 等の拡張 field は保全される
    expect(fm.meta['attachment.launcher_url']).toBe('https://x');
  });

  it('legacy 内蔵 data は asset へ externalize され bytes が正になる', () => {
    const legacy = r.entries.find((e) => e.lid === 'e-legacy')!;
    const fm = parseFrontmatter(legacy.body);
    const newKey = fm.meta['attachment.asset_key'];
    expect(typeof newKey).toBe('string');
    const asset = r.assets.find((a) => a.key === newKey)!;
    expect(asset.base64).toBe('QUJD');
    expect(asset.mime).toBe('application/zip');
    expect(legacy.body).not.toContain('QUJD'); // body に base64 を残さない
  });

  it('textlog permalink が変換後見出し slug へ書き換わる(legacy log id)', () => {
    const note = r.entries.find((e) => e.lid === 'b-note')!;
    expect(note.body).toContain('entry:c-log#2026-07-01-090000');
    expect(note.body).not.toContain('#log/');
  });

  it('relations: 端点不在・未知 kind は警告付きで除外', () => {
    expect(r.relations).toEqual([
      { id: 'r1', fromLid: 'b-note', toLid: 'a-todo', kind: 'structural' },
    ]);
    expect(r.warnings.some((w) => w.includes('r2'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('r3'))).toBe(true);
  });

  it('revisions は持ち込まず、件数を警告に出す', () => {
    expect(r.warnings.some((w) => w.includes('revisions 2 件'))).toBe(true);
  });

  it('lid 衝突は再採番され、entry: 参照と relations が追従する', () => {
    const r2 = convertPkc2Container(FIXTURE, opts(['a-todo']));
    const renamed = r2.entries.find((e) => e.title === 'やること')!;
    expect(renamed.lid).toBe('new-1');
    const note = r2.entries.find((e) => e.title === 'ノート')!;
    expect(note.body).not.toContain('entry:a-todo'); // 参照は残らない…そもそも無いが
    expect(r2.relations[0]).toMatchObject({ fromLid: 'b-note', toLid: 'new-1' });
    expect(r2.warnings.some((w) => w.includes('a-todo → new-1'))).toBe(true);
  });
});
