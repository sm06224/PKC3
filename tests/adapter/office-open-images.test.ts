/** @vitest-environment happy-dom */
/**
 * 🔴 Office「挿入 → 画像」に並べる添付を、**文書と同じ封筒で窓へ渡す**(#146 裁定 A)── PKC の側。
 *
 * 守る主張:
 *  ① 画像だけを選ぶ(docx / zip を渡さない)/ 元の名前で渡す
 *  ② 上限(64 MB)を超えたら**大きい順に渡さず**、外した件数を **1 度だけ**言う
 *  ③ 0 件なら**何も渡さない**(今までの封筒と 1 バイトも変わらない)
 *  ④ **封筒は 1 つ**:画像は `document` の payload に乗る(別の種別を作らない)
 *  ⑤ 画像の取得が落ちても文書は開く(投げない)
 *  ⑥ 引く元は 文書のノート + いま開いているノート + その文書を本文に載せたノート
 *  ⑦ `main.ts` が 3 つの口(一覧 / いま開いているノート / 言う出口)を渡している(原文 pin ──
 *     `main.ts` は原文を読む test しか無い面で、渡し忘れても tsc は黙る: 3 つとも optional)
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOfficeOpener, type OfficeTarget } from '../../src/adapter/platform/office/office-open';
import { OfficeWindow, type OfficeImagePayload } from '../../src/adapter/platform/office/office-window';
import { OFFICE_IMAGE_BUDGET_BYTES, type OfficeImageCandidate } from '../../src/features/office/office-images';
import type { OfficeCapability } from '../../src/features/office/office-entry';
import { humanBytes } from '../../src/features/human-bytes';

const OK: OfficeCapability = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  jspi: true,
  decompressionStream: true,
};
const MB = 1024 * 1024;
const DOCX: OfficeTarget = {
  name: '報告書.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  assetKey: 'doc-key',
  lid: 'note-doc',
};

/** 本物の `OfficeWindow` に偽の放送を繋ぐ ── 封筒の組み立てまで本物を通す。 */
function realWindow() {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  let handler: ((ev: MessageEvent) => void) | null = null;
  const ow = new OfficeWindow({
    openWindow: () => {},
    makeChannel: () => ({
      postMessage(d: unknown) {
        const m = d as { pkc3Office: string; payload?: Record<string, unknown> };
        sent.push({ type: m.pkc3Office, payload: m.payload ?? {} });
      },
      close() {},
      get onmessage() {
        return handler;
      },
      set onmessage(fn) {
        handler = fn;
      },
    }),
    baseUrl: 'https://app.example/',
  });
  return {
    ow,
    sent,
    ready: () => handler?.({ data: { pkc3Office: 'ready-for-document', payload: {} } } as MessageEvent),
    docs: () => sent.filter((s) => s.type === 'document'),
  };
}

const cand = (key: string, size: number, mime = 'image/png', name = `${key}.png`): OfficeImageCandidate => ({
  key,
  name,
  mime,
  size,
});

function make(opts: {
  candidates?: OfficeImageCandidate[];
  assets?: Record<string, Uint8Array | null | 'throw'>;
  listThrows?: boolean;
  openNote?: string | null;
  withLister?: boolean;
  users?: string[] | 'throw';
} = {}) {
  const w = realWindow();
  const notify = vi.fn<(t: string) => void>();
  const listNoteImages = vi.fn<(lids: readonly string[]) => Promise<OfficeImageCandidate[]>>(async () => {
    if (opts.listThrows) throw new Error('一覧が取れない');
    return opts.candidates ?? [];
  });
  const readAsset = vi.fn(async (key: string) => {
    const v = opts.assets?.[key];
    if (v === 'throw') throw new Error('読めない');
    if (v !== undefined) return v;
    return key === 'doc-key' ? new Uint8Array([1, 2, 3]) : new Uint8Array([9, 9]);
  });
  const usersOfAsset = vi.fn<(assetKey: string) => Promise<string[]>>(async () => {
    if (opts.users === 'throw') throw new Error('検索が落ちた');
    return opts.users ?? [];
  });
  const opener = createOfficeOpener({
    officeWindow: w.ow,
    isPackInstalled: () => true,
    readAsset,
    capability: () => OK,
    ...(opts.withLister === false ? {} : { listNoteImages }),
    openNoteLid: () => (opts.openNote === undefined ? null : opts.openNote),
    usersOfAsset: usersOfAsset,
    notify,
  });
  return { ...w, opener, notify, listNoteImages, readAsset, usersOfAsset };
}

/** 窓が「ちょうだい」と言い、非同期の受け渡しが終わるまで待つ。 */
async function settle(h: ReturnType<typeof make>): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  h.ready();
}

describe('文書の封筒に画像が乗る', () => {
  it('🔴 画像だけが、元の名前で、文書と同じ封筒(document)の payload に乗る', async () => {
    const h = make({
      candidates: [
        cand('i1', 100, 'image/png', '猫.png'),
        cand('z1', 100, 'application/zip', 'x.zip'),
        cand('i2', 50, 'image/jpeg', '月.jpg'),
      ],
    });
    h.opener.open(DOCX);
    await settle(h);
    expect(h.docs().length, '文書の封筒が 1 通だけ出る(画像用の別の封筒は無い)').toBe(1);
    const images = h.docs()[0]!.payload.images as OfficeImagePayload[];
    expect(images.map((i) => i.name), '空振り防止(件数 > 0)').toEqual(['猫.png', '月.jpg']);
    expect(Array.from(images[0]!.bytes)).toEqual([9, 9]);
    // 文書そのものは今までどおり
    expect(h.docs()[0]!.payload).toMatchObject({ name: '報告書.docx', token: 'note-doc' });
    expect(Array.from(h.docs()[0]!.payload.bytes as Uint8Array)).toEqual([1, 2, 3]);
    expect(h.sent.filter((s) => s.type !== 'document' && s.type !== 'focus-request')).toEqual([]);
  });

  it('🔴 引く元は、文書のノートと、いま開いているノート', async () => {
    const h = make({ candidates: [cand('i1', 10)], openNote: 'note-main' });
    h.opener.open(DOCX);
    await settle(h);
    expect(h.listNoteImages).toHaveBeenCalledWith(['note-doc', 'note-main']);
  });

  it('🔴 その文書を本文に載せたノートからも引く(いちばん普通の動線: ノートに画像と docx を貼って docx を開く)', async () => {
    const h = make({ candidates: [cand('i1', 10)], openNote: 'note-doc', users: ['note-text', 'note-doc'] });
    h.opener.open(DOCX);
    await settle(h);
    expect(h.usersOfAsset).toHaveBeenCalledWith('doc-key');
    // 重複は引く側で 1 件にする ── ここは順番だけ(文書のノート → いま開いている → 載せたノート)
    expect(h.listNoteImages).toHaveBeenCalledWith(['note-doc', 'note-doc', 'note-text', 'note-doc']);
    expect((h.docs()[0]!.payload.images as unknown[]).length, '空振り防止(件数 > 0)').toBe(1);
  });

  it('その文書を使うノートの検索が落ちても、残りの元からは引く(文書も開く)', async () => {
    const h = make({ candidates: [cand('i1', 10)], openNote: 'note-main', users: 'throw' });
    h.opener.open(DOCX);
    await settle(h);
    expect(h.listNoteImages).toHaveBeenCalledWith(['note-doc', 'note-main']);
    expect(h.docs().length).toBe(1);
  });

  it('文書のノートが分からなくても、いま開いているノートから引く', async () => {
    const h = make({ candidates: [cand('i1', 10)], openNote: 'note-main' });
    h.opener.open({ ...DOCX, lid: '' });
    await settle(h);
    expect(h.listNoteImages).toHaveBeenCalledWith(['note-main']);
  });

  it('🔴 0 件なら、封筒に images を載せない(今までと同じ形)', async () => {
    const h = make({ candidates: [] });
    h.opener.open(DOCX);
    await settle(h);
    expect(h.docs().length).toBe(1);
    expect('images' in h.docs()[0]!.payload, '空の images まで載せている').toBe(false);
  });

  it('画像でない添付しか無いノートでも、載せない', async () => {
    const h = make({ candidates: [cand('z1', 10, 'application/zip', 'a.zip')] });
    h.opener.open(DOCX);
    await settle(h);
    expect('images' in h.docs()[0]!.payload).toBe(false);
    expect(h.notify, '画像でない物は「並べなかった」に数えない').not.toHaveBeenCalled();
  });

  it('一覧の口を渡されていなければ、今までと同じ(何も渡さない)', async () => {
    const h = make({ withLister: false, candidates: [cand('i1', 10)] });
    h.opener.open(DOCX);
    await settle(h);
    expect('images' in h.docs()[0]!.payload).toBe(false);
  });
});

describe('合計の上限', () => {
  it('🔴 超えたら大きい順に渡さず、外した件数を 1 度だけ言う', async () => {
    const h = make({
      candidates: [
        cand('s1', 10 * MB),
        cand('big', 60 * MB),
        cand('s2', 20 * MB),
        cand('s3', 10 * MB),
      ],
    });
    h.opener.open(DOCX);
    await settle(h);
    const images = h.docs()[0]!.payload.images as OfficeImagePayload[];
    expect(images.map((i) => i.name)).toEqual(['s1.png', 's2.png', 's3.png']);
    // 外した物の bytes は**読みにも行かない**(常駐させない)
    expect(h.readAsset.mock.calls.map((c) => c[0]).sort()).toEqual(['doc-key', 's1', 's2', 's3']);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toContain('1 件');
    expect(h.notify.mock.calls[0]![0]).toContain(humanBytes(OFFICE_IMAGE_BUDGET_BYTES));
  });

  it('🔴 対照群:上限に収まるなら、何も言わない', async () => {
    const h = make({ candidates: [cand('a', 10 * MB), cand('b', 10 * MB)] });
    h.opener.open(DOCX);
    await settle(h);
    expect((h.docs()[0]!.payload.images as unknown[]).length).toBe(2);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('🔴 選んだのに読めなかった添付は、黙って消さず件数で言う(上限の話とは別の文)', async () => {
    const h = make({
      candidates: [cand('ok', 10), cand('gone', 10)],
      assets: { gone: null },
    });
    h.opener.open(DOCX);
    await settle(h);
    expect((h.docs()[0]!.payload.images as OfficeImagePayload[]).map((i) => i.name)).toEqual(['ok.png']);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toContain('読めなかった');
    expect(h.notify.mock.calls[0]![0]).not.toContain('MB');
  });
});

describe('画像のしくじりで文書を止めない', () => {
  it('一覧が投げても、文書は(画像なしで)渡る', async () => {
    const h = make({ listThrows: true });
    h.opener.open(DOCX);
    await settle(h);
    expect(h.docs().length, '文書が開かなくなった').toBe(1);
    expect('images' in h.docs()[0]!.payload).toBe(false);
  });

  it('画像の bytes が投げても、文書は渡り、残りの画像も渡る', async () => {
    const h = make({
      candidates: [cand('bad', 10), cand('ok', 10)],
      assets: { bad: 'throw' },
    });
    h.opener.open(DOCX);
    await settle(h);
    expect((h.docs()[0]!.payload.images as OfficeImagePayload[]).map((i) => i.name)).toEqual(['ok.png']);
  });

  it('文書の bytes が読めなければ、今までどおり何も渡さない(画像だけ渡さない)', async () => {
    const h = make({ candidates: [cand('i1', 10)], assets: { 'doc-key': null } });
    h.opener.open(DOCX);
    await settle(h);
    expect(h.docs()).toEqual([]);
  });
});

describe('main.ts の配線(原文 pin)', () => {
  const main = readFileSync('src/main.ts', 'utf-8');
  const start = main.indexOf('createOfficeOpener({');
  // ⚠ 呼び出しの塊だけを見る(file 全体だと別の所の同じ字に満たされる)
  const call = main.slice(start, main.indexOf('  });\n', start));

  it('🔴 一覧 / いま開いているノート / 言う出口の 3 つを渡している(optional なので tsc は黙る)', () => {
    expect(start, 'createOfficeOpener の呼び出しが見つからない').toBeGreaterThan(0);
    expect(call).toContain('listNoteImages: (lids) =>');
    expect(call).toContain('openNoteLid: () => dispatcher.getState().selectedLid');
    // 🔑 その文書を本文に載せたノートは、既存の全文検索で引く(新しい口を作らない)
    expect(call).toContain('usersOfAsset: async (assetKey) =>');
    expect(call).toContain("op: 'searchEntries', cid, query: assetKey, limit: 8");
    expect(call).toContain('notify: (text) => showStatus(text)');
  });

  it('一覧の道具は bytes を読まず、持ち主の逆引きは findAssetOwner を使う', () => {
    expect(call).toContain("op: 'findAssetOwner'");
    expect(call).toContain('size: blob.size, type: blob.type');
    expect(call, '一覧のために bytes(arrayBuffer)を読んでいる').not.toMatch(
      /blobInfo:[\s\S]*arrayBuffer/,
    );
  });
});
