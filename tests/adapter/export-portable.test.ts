/** @vitest-environment happy-dom */
/**
 * 🔴 **可搬単一 HTML の書き出し**(#400 段④)の断り方と手順。
 *
 * ⚠ ここが守るのは「**押しても何も起きない**を作らない」である ──
 * 雛形は同じ origin からしか取れないので、可搬バンドルの中では**必ず**失敗する。
 * 黙って失敗させると `fetch` が 1 往復して「書き出しに失敗しました」とだけ出る
 * (#180 の dead click と同じ形)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { exportPortable, type PortableExportDeps } from '../../src/adapter/ui/actions/export-portable';
import { parseBundleTag } from '../../src/features/portable/bundle';

const TEMPLATE =
  `<!doctype html><html><head>` +
  `<script type="application/json" data-pkc-bundle>{"id":"pkcb-template","exportedAt":0}</script>` +
  `</head><body><div data-pkc-slot="root"></div></body></html>`;

function booted(): { d: Dispatcher; errors: string[] } {
  const d = new Dispatcher();
  /**
   * ⚠ **居る lid を入れる** ── reducer は知らない lid の `START_EDIT` を
   *   何もせず落とすので、空の metas で編集中を作ったつもりになると
   *   **その test は空振りする**(この file を書いていて実際に踏んだ)。
   */
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      {
        lid: 'n1',
        title: 'ノート',
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
  const errors: string[] = [];
  const orig = d.dispatch.bind(d);
  d.dispatch = (a: Parameters<typeof orig>[0]) => {
    if (a.type === 'OP_FAILED') errors.push((a as { error: string }).error);
    return orig(a);
  };
  return { d, errors };
}

function deps(over: Partial<PortableExportDeps> = {}) {
  const order: string[] = [];
  const files: Array<{ name: string; blob: Blob }> = [];
  const notes: string[][] = [];
  const said: string[] = [];
  const base: PortableExportDeps & {
    order: string[];
    files: typeof files;
    notes: typeof notes;
    said: string[];
  } = {
    title: '器',
    fetchTemplate: async () => {
      order.push('template');
      return TEMPLATE;
    },
    exportImage: async () => {
      order.push('image');
      return new Uint8Array([1, 2, 3, 4]);
    },
    listAssets: async () => [],
    getAsset: async () => null,
    download: (name, blob) => {
      order.push('download');
      files.push({ name, blob });
    },
    notify: (m) => said.push(m),
    report: (n) => notes.push([...n]),
    settle: async () => {
      order.push('settle');
    },
    insideBundle: () => false,
    now: () => new Date(Date.UTC(2026, 7, 25, 12)),
    mintId: () => 'pkcb-aabbccddeeff0011',
    order,
    files,
    notes,
    said,
    ...over,
  };
  return base;
}

describe('断る場面', () => {
  it('編集中は断る ── 🔴 雛形を取りに行かない(30MB 読んでから断らない)', async () => {
    const { d, errors } = booted();
    // ⚠ 編集に入れるのは「本文が読めている選択中のノート」だけ ── 3 手要る
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '編集中にできていない(前提が崩れた)').toBe('editing');
    const dp = deps();
    expect(await exportPortable(d, dp)).toBeNull();
    expect(errors.join()).toContain('編集を終了してから');
    expect(dp.order, '断ったのに読みに行っている').toEqual([]);
  });

  it('🔴 可搬バンドルの中では、なぜ押せないかを言う(黙って失敗させない)', async () => {
    const { d, errors } = booted();
    const dp = deps({ insideBundle: () => true });
    expect(await exportPortable(d, dp)).toBeNull();
    // ⚠ 「失敗しました」では足りない ── **何をすればよいか**まで言う
    expect(errors[0]).toContain('配られた 1 枚');
    expect(errors[0]).toContain('ブラウザで開いた PKC3 から');
    expect(dp.order, '取りに行こうとしている').toEqual([]);
  });

  it('中身が空なら断る(空の 1 枚を配らない)', async () => {
    const { d, errors } = booted();
    const dp = deps({ exportImage: async () => new Uint8Array(0) });
    expect(await exportPortable(d, dp)).toBeNull();
    expect(errors.join()).toContain('空');
    expect(dp.files).toHaveLength(0);
  });

  it('雛形が取れなければ、その理由をそのまま出す', async () => {
    const { d, errors } = booted();
    const dp = deps({
      fetchTemplate: async () => {
        throw new Error('HTTP 404');
      },
    });
    expect(await exportPortable(d, dp)).toBeNull();
    expect(errors.join()).toContain('HTTP 404');
  });
});

describe('書き出す', () => {
  it('🔴 保存が着地してから読む(読みは書込の chain の外に居る)', async () => {
    const { d } = booted();
    const dp = deps();
    await exportPortable(d, dp);
    expect(dp.order.indexOf('settle')).toBeLessThan(dp.order.indexOf('image'));
  });

  it('新しい器の印を焼く(雛形のままにしない)', async () => {
    const { d } = booted();
    const dp = deps();
    expect(await exportPortable(d, dp)).toBe(0);
    const html = await dp.files[0]!.blob.text();
    expect(parseBundleTag(html.match(/data-pkc-bundle>([^<]*)</)![1]!)).toEqual({
      id: 'pkcb-aabbccddeeff0011',
      exportedAt: Date.UTC(2026, 7, 25, 12),
    });
    expect(dp.files[0]!.name).toBe('器-20260825.pkc3.html');
  });

  it('🔴 添付の中身が見つからなければ名指しで注意する(黙って欠かさない)', async () => {
    const { d } = booted();
    const dp = deps({
      listAssets: async () => [
        { key: 'ast-ok', mime: 'image/png' },
        { key: 'ast-gone', mime: 'image/png' },
      ],
      getAsset: async (key) => (key === 'ast-ok' ? new Blob([new Uint8Array([7])]) : null),
    });
    expect(await exportPortable(d, dp), '在るほうまで落としている').toBe(1);
    expect(dp.notes[0]!.join()).toContain('ast-gone');
    // 🔑 書き出しは続く(1 件欠けたぶんで全部を失わせない)
    expect(dp.files).toHaveLength(1);
    expect(dp.said.join()).toContain('注意 1 件');
  });

  it('⚠ 注意が無ければ「注意」と言わない', async () => {
    const { d } = booted();
    const dp = deps();
    await exportPortable(d, dp);
    expect(dp.said.join()).not.toContain('注意');
    expect(dp.notes, '注意が無いのに報告している').toHaveLength(0);
  });
});
