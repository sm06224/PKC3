/** @vitest-environment happy-dom */
/**
 * O3-b: 添付を **Office の別窓**で開く(#88)。
 *
 * 守りたい主張:
 *  ① 🔴 **窓は 1 つしか開かない** ── bytes が非同期なので、素直に書くと
 *     `open()` を 2 度呼んで**窓が 2 つ**になる(常駐 1.5GB)
 *  ② **押しても何も起きない、を作らない** ── 開けないときは必ず理由を返す
 *  ③ 窓を開くのは**同期のうち**(user gesture を切らない)
 *  ④ bytes の取得に失敗しても落ちない(窓は Start Center を出す)
 */
import { describe, expect, it, vi } from 'vitest';
import { createOfficeOpener, type OfficeTarget } from '../../src/adapter/platform/office/office-open';
import type { OfficeWindow } from '../../src/adapter/platform/office/office-window';
import type { OfficeCapability } from '../../src/features/office/office-entry';

const OK: OfficeCapability = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  jspi: true,
  decompressionStream: true,
};

const DOCX: OfficeTarget = {
  name: '報告書.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  assetKey: 'a1',
};

function fakeWindow(): OfficeWindow & {
  opens: { name?: string; expectDocument?: boolean; bytes?: Uint8Array }[];
  provided: { name: string; bytes: Uint8Array }[];
  alreadyOpen: boolean;
} {
  const opens: { name?: string; expectDocument?: boolean; bytes?: Uint8Array }[] = [];
  const provided: { name: string; bytes: Uint8Array }[] = [];
  const w = {
    opens,
    provided,
    alreadyOpen: false,
    open(opts: { name?: string; expectDocument?: boolean; bytes?: Uint8Array } = {}) {
      opens.push(opts);
      return { kind: w.alreadyOpen ? 'already-open' : 'opened' } as const;
    },
    provideDocument(name: string, bytes: Uint8Array) { provided.push({ name, bytes }); },
    requestClose() {},
    dispose() {},
    isProbablyOpen() { return w.alreadyOpen; },
    onEvent() { return () => {}; },
  };
  return w as unknown as ReturnType<typeof fakeWindow>;
}

function make(opts: {
  installed?: boolean;
  cap?: OfficeCapability;
  asset?: Uint8Array | null | 'throw';
} = {}) {
  const officeWindow = fakeWindow();
  const readAsset = vi.fn(async () => {
    if (opts.asset === 'throw') throw new Error('読めない');
    return opts.asset === undefined ? new Uint8Array([1, 2, 3]) : opts.asset;
  });
  const opener = createOfficeOpener({
    officeWindow,
    isPackInstalled: () => opts.installed ?? true,
    readAsset,
    capability: () => opts.cap ?? OK,
  });
  return { opener, officeWindow, readAsset };
}

describe('createOfficeOpener', () => {
  it('🔴 窓は 1 回しか開かない ── bytes は後渡しする', async () => {
    const { opener, officeWindow } = make();
    const r = opener.open(DOCX);
    expect(r.ok).toBe(true);
    expect(officeWindow.opens.length, '開くのは 1 回だけ').toBe(1);
    expect(officeWindow.opens[0]!.expectDocument, '後渡しを宣言している').toBe(true);
    expect(officeWindow.opens[0]!.bytes, '同期の時点で bytes は渡していない').toBeUndefined();
    await vi.waitFor(() => expect(officeWindow.provided.length).toBe(1));
    expect(officeWindow.opens.length, '後渡しでも 2 つ目を開かない').toBe(1);
    expect(officeWindow.provided[0]!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('🔴 窓を開くのは同期のうち(user gesture を切らない)', () => {
    const { opener, officeWindow, readAsset } = make();
    opener.open(DOCX);
    // ⚠ `open()` から戻った時点で**もう開いている**こと。await を挟んでいたらここは 0
    expect(officeWindow.opens.length).toBe(1);
    // 読み出しは走っているが、まだ待っていない
    expect(readAsset).toHaveBeenCalledTimes(1);
  });

  it('既に開いていれば reused を返す(開き直さない)', () => {
    const { opener, officeWindow } = make();
    officeWindow.alreadyOpen = true;
    const r = opener.open(DOCX);
    expect(r).toEqual({ ok: true, reused: true });
  });

  it('🔴 Office でない添付は理由を返す(窓を開かない)', () => {
    const { opener, officeWindow } = make();
    const r = opener.open({ name: 'a.png', mime: 'image/png', assetKey: 'x' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('not-office');
    expect(officeWindow.opens.length).toBe(0);
  });

  it('🔴 使えない環境は理由を返す(窓を開かない)', () => {
    const { opener, officeWindow } = make({ cap: { ...OK, jspi: false } });
    const r = opener.open(DOCX);
    expect(!r.ok && r.reason).toBe('unsupported');
    expect(!r.ok && r.message, '足りないものを名指しする').toContain('JSPI');
    expect(officeWindow.opens.length).toBe(0);
  });

  it('🔴 未配備は理由を返す(窓を開かない)', () => {
    const { opener, officeWindow } = make({ installed: false });
    const r = opener.open(DOCX);
    expect(!r.ok && r.reason).toBe('not-installed');
    expect(officeWindow.opens.length).toBe(0);
  });

  it('使えない環境は「未配備」より先に見る(77MB を無駄に取らせない)', () => {
    const { opener } = make({ installed: false, cap: { ...OK, jspi: false } });
    const r = opener.open(DOCX);
    expect(!r.ok && r.reason).toBe('unsupported');
  });

  it('bytes が読めなくても落ちない ── 窓は開いたまま(Start Center が出る)', async () => {
    const { opener, officeWindow, readAsset } = make({ asset: 'throw' });
    expect(opener.open(DOCX).ok).toBe(true);
    await readAsset.mock.results[0]!.value.catch(() => null);
    await Promise.resolve();
    expect(officeWindow.provided, '何も渡さない').toEqual([]);
  });

  it('🔴 空の添付を渡さない(Start Center を空で上書きしない)', async () => {
    // ⚠ **待ち方に穴があった**(変異試験で判明)。`opens.length === 1` は
    //    同期の時点で既に満たされるので、`provided` を見る前に**非同期の続きが
    //    走っていなかった** ── 空を渡す変異が素通りした。
    //    🔑 **読み出しが解決したこと**を待ってから見る。
    const { opener, officeWindow, readAsset } = make({ asset: new Uint8Array(0) });
    opener.open(DOCX);
    await readAsset.mock.results[0]!.value;
    await Promise.resolve();
    expect(officeWindow.provided, '空は渡さない').toEqual([]);
  });
});
