/**
 * ウィジェットの「このノートの添付から選ぶ」の候補(#2097)。
 * 🔴 鍵は親が読んだ**そのノートの本文**からだけ引く(他のノートの添付へ越境しない)。
 */
import { describe, expect, it } from 'vitest';
import {
  listWidgetNoteAssets,
  widgetAttachLanded,
  widgetNoteAssetKeys,
  WIDGET_NOTE_ASSET_LIMIT,
} from '../../src/adapter/platform/widget-note-assets';

const NOTE = '# メモ\n\n![図](asset:k-img)\n\n[表](asset:k-csv) と [もう一度](asset:k-img)\n\n`asset:k-code` はコード\n';
const ATTACH = '---\nattachment.name: 売上.csv\nattachment.mime: text/csv\nattachment.size: 3\nattachment.asset_key: k-own\n---\n説明 ![](asset:k-img)\n';

describe('🔴 このノートの添付の鍵', () => {
  it('本文が使っている添付を出てくる順に重複なく(コードの中の字は数えない)', () => {
    expect(widgetNoteAssetKeys(NOTE)).toEqual(['k-img', 'k-csv']);
  });
  it('添付ノートなら自分のファイルを先頭に', () => {
    expect(widgetNoteAssetKeys(ATTACH)).toEqual(['k-own', 'k-img']);
  });
  it('添付の無い本文は空 / 上限で切る', () => {
    expect(widgetNoteAssetKeys('ただの字')).toEqual([]);
    const many = Array.from({ length: WIDGET_NOTE_ASSET_LIMIT + 5 }, (_, i) => `[x](asset:k${String(i)})`).join('\n');
    expect(widgetNoteAssetKeys(many)).toHaveLength(WIDGET_NOTE_ASSET_LIMIT);
  });
});

describe('🔴 候補の一覧', () => {
  const blobs: Record<string, { size: number; type: string }> = {
    'k-img': { size: 10, type: 'image/png' },
    'k-csv': { size: 5, type: '' },
    'k-own': { size: 3, type: '' },
  };
  const deps = (bodies: Record<string, string>, read: string[] = []) => ({
    bodyOf: (lid: string) => {
      read.push(lid);
      return bodies[lid] ?? null;
    },
    nameOf: (key: string) => Promise.resolve(key === 'k-csv' ? '表.csv' : key === 'k-img' ? '図.png' : null),
    blobInfo: (key: string) => Promise.resolve(blobs[key] ?? null),
  });
  it('そのノートの本文だけを読み、名前・種類・大きさを返す(bytes は読まない)', async () => {
    const read: string[] = [];
    const got = await listWidgetNoteAssets(deps({ L1: NOTE, L2: '[秘密](asset:k-secret)' }, read), 'L1');
    expect(read).toEqual(['L1']);
    expect(got).toEqual([
      { key: 'k-img', name: '図.png', mime: 'image/png', size: 10 },
      { key: 'k-csv', name: '表.csv', mime: 'application/octet-stream', size: 5 },
    ]);
  });
  it('添付ノート自身のファイルは前書きの名前と種類を使う', async () => {
    const got = await listWidgetNoteAssets(deps({ A: ATTACH }), 'A');
    expect(got[0]).toEqual({ key: 'k-own', name: '売上.csv', mime: 'text/csv', size: 3 });
  });
  it('読めない本文は空・引けない添付は落とす・投げない', async () => {
    expect(await listWidgetNoteAssets(deps({}), 'none')).toEqual([]);
    const bad = { ...deps({ L1: NOTE }), nameOf: () => Promise.reject(new Error('x')) };
    expect(await listWidgetNoteAssets(bad, 'L1')).toEqual([]);
    const missing = await listWidgetNoteAssets(deps({ L1: '[a](asset:k-gone)' }), 'L1');
    expect(missing).toEqual([]);
  });
});

describe('🔴 「このノートへ添付」が効いたか(widgetAttachLanded)', () => {
  const before = new Set(['L1', 'A0']);
  const metas = (extra: Record<string, string>) =>
    new Map<string, { archetype: string }>([
      ['L1', { archetype: 'text' }],
      ['A0', { archetype: 'attachment' }],
      ...Object.entries(extra).map(([k, a]) => [k, { archetype: a }] as [string, { archetype: string }]),
    ]);
  it('新しい添付ノートができたら true', () => {
    expect(widgetAttachLanded(before, metas({ A1: 'attachment' }), 0, 0)).toBe(true);
  });
  it('🔴 何も増えなければ false(断られた・失敗した回に「添付できた」と返さない)', () => {
    expect(widgetAttachLanded(before, metas({}), 1, 1)).toBe(false);
    // 添付でない物が増えても数えない
    expect(widgetAttachLanded(before, metas({ T: 'text' }), 1, 1)).toBe(false);
  });
  it('同じ中身の添付を使い回した回は、本文の参照が増えたら true(本文が読めなければ false)', () => {
    expect(widgetAttachLanded(before, metas({}), 1, 2)).toBe(true);
    expect(widgetAttachLanded(before, metas({}), -1, 2)).toBe(false);
  });
});
