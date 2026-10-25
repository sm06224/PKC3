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
import { exportPortable, fetchPortableTemplate, type PortableExportDeps } from '../../src/adapter/ui/actions/export-portable';
import { createStatusNotices } from '../../src/adapter/ui/render/status-lifetime';
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
    expect(errors.join()).toContain('編集を保存するか、編集をやめてから');
    expect(dp.order, '断ったのに読みに行っている').toEqual([]);
  });

  it('🔴 可搬バンドルの中では、なぜ押せないかを言う(黙って失敗させない)', async () => {
    const { d, errors } = booted();
    const dp = deps({ insideBundle: () => true });
    expect(await exportPortable(d, dp)).toBeNull();
    // ⚠ 「失敗しました」では足りない ── **何をすればよいか**まで言う
    expect(errors[0]).toContain('PKC3 入り HTML');
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

describe('選んだ N 件だけ書き出す(#1038 A2)', () => {
  const closure = {
    lids: ['n1', 'f0'],
    assetKeys: ['k1'],
    selected: 1,
    referenced: 0,
    ancestors: 1,
    droppedRelations: 2,
    title: '選んだ甲',
    warnings: ['選んだノートの外へ向かうつながり 2 件は含まれません(つなぐ先のノートが入らないため)'],
  };

  it('🔴 閉包を画像の口へ渡し、閉包の添付だけを焼き、題名・注意・件数が選んだ分になる', async () => {
    const { d } = booted();
    let gotOnly: unknown;
    const read: string[] = [];
    const dp = deps({
      closure: async (sel) => {
        expect(sel).toEqual(['n1']);
        return closure;
      },
      exportImage: async (only) => {
        gotOnly = only;
        return new Uint8Array([1, 2, 3, 4]);
      },
      listAssets: async () => [
        { key: 'k1', mime: 'image/png' },
        { key: 'other', mime: 'image/png' },
      ],
      getAsset: async (key) => {
        read.push(key);
        return new Blob(['x']);
      },
    });
    expect(await exportPortable(d, dp, ['n1'])).toBe(1);
    expect(gotOnly).toEqual({ lids: ['n1', 'f0'], assetKeys: ['k1'] });
    expect(read, '閉包に無い添付を読んでいる').toEqual(['k1']);
    expect(dp.files[0]!.name).toMatch(/^選んだ甲-\d{8}\.pkc3\.html$/);
    expect(dp.notes[0]!.join()).toContain('2 件は含まれません');
    expect(dp.said.at(-1)).toContain('選んだ 1 件 + 参照先 0 件 + 祖先フォルダ 1 件');
  });

  it('対照:全件のときは only を渡さず、題名は器のまま', async () => {
    const { d } = booted();
    let gotOnly: unknown = 'unset';
    const dp = deps({
      exportImage: async (only) => {
        gotOnly = only;
        return new Uint8Array([1, 2, 3, 4]);
      },
    });
    await exportPortable(d, dp);
    expect(gotOnly).toBeUndefined();
    expect(dp.files[0]!.name).toMatch(/^器-/);
  });

  it('閉包が空(選んだ lid が居ない)なら断り、画像も雛形も取りに行かない', async () => {
    const { d, errors } = booted();
    const { EmptyClosureError } = await import('../../src/features/export/portable-closure');
    const dp = deps({
      closure: async () => {
        throw new EmptyClosureError();
      },
    });
    expect(await exportPortable(d, dp, ['zzz'])).toBeNull();
    expect(errors.join()).toContain('見つかりません');
    expect(dp.order).toEqual(['settle']);
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

  it('🔴 添付の中身が見つからなければ、件数を 1 行で注意する(黙って欠かさない・内部の id は出さない)', async () => {
    const { d } = booted();
    const dp = deps({
      listAssets: async () => [
        { key: 'ast-ok', mime: 'image/png' },
        { key: 'ast-gone', mime: 'image/png' },
        { key: 'ast-gone2', mime: 'image/png' },
      ],
      getAsset: async (key) => (key === 'ast-ok' ? new Blob([new Uint8Array([7])]) : null),
    });
    expect(await exportPortable(d, dp), '在るほうまで落としている').toBe(1);
    expect(dp.notes[0], '2 件欠けたのに 1 行にまとまっていない').toEqual([
      '添付 2 件の中身が見つからず、PKC3 入り HTML には入れられませんでした',
    ]);
    expect(dp.notes[0]!.join(), '内部の id が画面の字に出ている').not.toContain('ast-gone');
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

/**
 * 🔴 **失敗したら、進行中の字(「可搬 HTML を書き出しています…」)を消す**(#1017 C5)。
 * ⚠ 出す前の断り(配られた 1 枚の中 / 編集中)は進行中の字を出していないので、消す字も撃たない。
 */
describe('進行中の字の後始末(#1017 C5)', () => {
  it.each([
    ['雛形が取れない', { fetchTemplate: async () => Promise.reject(new Error('HTTP 404')) }],
    ['中身が空', { exportImage: async () => new Uint8Array(0) }],
  ] as const)('🔴 失敗(%s)したら、最後は消す字で、完了の字は出ない', async (_label, over) => {
    const { d } = booted();
    const dp = deps(over);
    expect(await exportPortable(d, dp), '前提が崩れた(失敗していない)').toBeNull();
    expect(dp.said[0], '前提が崩れた(進行中の字が先に出ていない)').toContain('書き出しています…');
    expect(dp.said.at(-1), '失敗したのに進行中の字が残る').toBe('');
    expect(dp.said.join(), '失敗なのに完了と言った').not.toContain('書き出しました');
  });

  it('対照群:成功した回は最後が完了の字で、消す字は撃たない', async () => {
    const { d } = booted();
    const dp = deps();
    await exportPortable(d, dp);
    expect(dp.said.at(-1)).toContain('書き出しました');
    expect(dp.said, '成功なのに消す字を撃った').not.toContain('');
  });

  /**
   * 🔴 **成功の枝は消す字を撃たない ── それでも「…しています…」が居座らない**(#1305 の着地後レビュー)。
   * ⚠ 上の「対照群」は出す側が撃たないことしか見ない。ここは**本物の知らせの置き場**
   *   (`createStatusNotices`)を出す側の `notify` へ繋ぎ、**画面に残る進行中の欄**まで通す。
   *   直す前は成功しても `progressLine()` が「…しています…」のまま残った。
   */
  it('🔴 成功したら、結果の知らせが出た時点で進行中の欄は空(実物の置き場を通す)', async () => {
    const { d } = booted();
    const sink = createStatusNotices({
      post: () => {},
      paint: () => {},
      paintActions: () => false,
      expire: () => {},
    });
    const seen: string[] = [];
    const dp = deps({
      notify: (m) => {
        sink.show(m);
        seen.push(sink.progressLine());
      },
    });
    expect(await exportPortable(d, dp)).toBe(0);
    expect(seen[0], '前提が崩れた(進行中の字が先に出ていない)').toContain('書き出しています…');
    expect(sink.noticeLine()).toContain('書き出しました');
    expect(sink.progressLine(), '成功したのに「…しています…」が居座った').toBe('');
  });

  it('🔴 出す前の断り(配られた 1 枚の中)は、消す字も撃たない(別の知らせを巻き込まない)', async () => {
    const { d } = booted();
    const dp = deps({ insideBundle: () => true });
    expect(await exportPortable(d, dp)).toBeNull();
    expect(dp.said, '出していない進行中の字を消す字を撃った').toEqual([]);
  });
});

describe('雛形の取得の失敗(#1087)', () => {
  const res = (status: number) => async () => ({ ok: status < 400, status, text: async () => 'T' });

  it('🔴 404 は、次にすること(公開版を開く)を言い、HTTP の番号を見せない', async () => {
    const e = await fetchPortableTemplate(res(404), 'https://x.test/').catch((x: Error) => x);
    expect((e as Error).message).toContain('この PKC3 には入っていません');
    expect((e as Error).message).toContain('公開版を開いて');
    expect((e as Error).message).not.toContain('HTTP');
  });

  it('対照群: 404 以外の失敗は番号を残し、成功は本文を返す', async () => {
    await expect(fetchPortableTemplate(res(500), 'https://x.test/')).rejects.toThrow('HTTP 500');
    expect(await fetchPortableTemplate(res(200), 'https://x.test/')).toBe('T');
  });

  it('🔴 通信が無い(Failed to fetch)は、画面の字では日本語になる', async () => {
    const { d, errors } = booted();
    const dp = deps({
      fetchTemplate: () =>
        fetchPortableTemplate(() => Promise.reject(new TypeError('Failed to fetch')), 'https://x.test/'),
    });
    expect(await exportPortable(d, dp)).toBeNull();
    expect(errors.join()).toContain('ネットワークに接続できませんでした');
  });
});
