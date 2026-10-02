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
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createOfficeOpener, type OfficeTarget } from '../../src/adapter/platform/office/office-open';
import { OfficeWindow } from '../../src/adapter/platform/office/office-window';
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
  provided: { name: string; bytes: Uint8Array; token: string }[];
  alreadyOpen: boolean;
} {
  const opens: { name?: string; expectDocument?: boolean; bytes?: Uint8Array }[] = [];
  const provided: { name: string; bytes: Uint8Array; token: string }[] = [];
  const w = {
    opens,
    provided,
    alreadyOpen: false,
    open(opts: { name?: string; expectDocument?: boolean; bytes?: Uint8Array } = {}) {
      opens.push(opts);
      return { kind: w.alreadyOpen ? 'already-open' : 'opened' } as const;
    },
    // ⚠ **合言葉まで控える。** 2026-08-16 まで第 3 引数を捨てていたので、
    //    「lid を渡すのをやめる」変異が**全緑のまま通った**(= #205 が直した当の
    //    症状「上書き保存が新しいノートを増やす」が、誰にも守られていなかった)
    provideDocument(name: string, bytes: Uint8Array, token = '') {
      provided.push({ name, bytes, token });
    },
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

  /**
   * 🔴 **合言葉(lid)を窓へ預ける**(#205 / 着地前レビュー 2026-08-16)。
   *
   * ⚠ ここは**この経路にしか無い**。smoke(`office-host.smoke.spec.ts`)は
   * `document` の payload を**手で投げている**ので、この行を 1 度も通らない ──
   * `provideDocument` から第 3 引数を落とす変異が**全緑のまま通っていた**。
   * 実害は #205 が直した当の症状:上書き保存が元のノートを更新せず、
   * **新しい添付ノートを増やす**。
   */
  it('🔴 lid を持つ添付は、合言葉ごと窓へ預ける', async () => {
    const { opener, officeWindow } = make();
    opener.open({ ...DOCX, lid: 'lid-77' });
    await vi.waitFor(() => expect(officeWindow.provided.length).toBe(1));
    expect(
      officeWindow.provided[0]!.token,
      '合言葉が落ちている ── その窓の保存は元のノートを更新しない',
    ).toBe('lid-77');
  });

  it('lid が無ければ合言葉も無い(新規の添付ノートになる)', async () => {
    const { opener, officeWindow } = make();
    opener.open(DOCX);
    await vi.waitFor(() => expect(officeWindow.provided.length).toBe(1));
    expect(officeWindow.provided[0]!.token).toBe('');
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

/**
 * 🔴 **窓を「読み込み直す」と、保存済みの最新が開く**(#1228 穴①)。
 *
 * 🔑 **本物どうしを繋ぐ**(§7)── `OfficeWindow` の実物が組んだ封筒を読み、
 * 相手の窓役は何も組まない。上の `fakeWindow` は `provideDocument` の第 5 引数を捨てるので、
 * この繋ぎは別に要る。
 */
describe('窓が作り直されたとき(本物の OfficeWindow と繋ぐ)', () => {
  function wired(opts: { lid?: string; current: (lid: string) => Promise<string | null> }) {
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
        get onmessage() { return handler; },
        set onmessage(fn) { handler = fn; },
      }),
      baseUrl: 'https://app.example/',
    });
    const assets: Record<string, number[]> = { a1: [1], a2: [2] };
    const currentAssetKey = vi.fn((lid: string) => opts.current(lid));
    const opener = createOfficeOpener({
      officeWindow: ow,
      isPackInstalled: () => true,
      readAsset: async (k) => (assets[k] ? new Uint8Array(assets[k]!) : null),
      capability: () => OK,
      currentAssetKey,
    });
    const ready = (): void => {
      handler?.({ data: { pkc3Office: 'ready-for-document', payload: {} } } as MessageEvent);
    };
    const docs = () => sent.filter((x) => x.type === 'document');
    return { opener, ready, docs, currentAssetKey, target: { ...DOCX, ...(opts.lid ? { lid: opts.lid } : {}) } };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('🔴 2 回目の ready には、そのノートの「いま」の添付を送る(最初の key の古い版ではない)', async () => {
    const w = wired({ lid: 'L1', current: async () => 'a2' });
    w.opener.open(w.target);
    await tick();
    w.ready();
    expect(w.docs().length, '対照群: 1 回目は 1 通').toBe(1);
    expect(w.docs()[0]!.payload.bytes, '1 回目は開いた key').toEqual(new Uint8Array([1]));
    w.ready();
    await vi.waitFor(() => expect(w.docs().length).toBe(2));
    expect(w.docs()[1]!.payload.bytes, '保存で差し替わった key の版').toEqual(new Uint8Array([2]));
    expect(w.docs()[1]!.payload.token).toBe('L1');
    expect(w.currentAssetKey).toHaveBeenCalledWith('L1');
  });

  it('いまの key が引けなければ、開いた key で送り直す', async () => {
    const w = wired({ lid: 'L1', current: async () => null });
    w.opener.open(w.target);
    await tick();
    w.ready();
    w.ready();
    await vi.waitFor(() => expect(w.docs().length).toBe(2));
    expect(w.docs()[1]!.payload.bytes).toEqual(new Uint8Array([1]));
  });

  it('lid の無い添付(新規扱い)は、いまの key を聞かず、開いた key で送り直す', async () => {
    const w = wired({ current: async () => 'a2' });
    w.opener.open(w.target);
    await tick();
    w.ready();
    w.ready();
    await vi.waitFor(() => expect(w.docs().length).toBe(2));
    expect(w.currentAssetKey).not.toHaveBeenCalled();
    expect(w.docs()[1]!.payload.bytes).toEqual(new Uint8Array([1]));
  });
});

describe('main.ts の配線(#1228 原文 pin)', () => {
  const main = readFileSync('src/main.ts', 'utf-8');
  const start = main.indexOf('createOfficeOpener({');
  const call = main.slice(start, main.indexOf('  });\n', start));
  it('🔴 窓を読み直すための「いまの key」を渡し、保存の引き取りと同じ 1 本を使う', () => {
    expect(call).toContain('currentAssetKey: currentAttachmentKey');
    const sb = main.indexOf('createOfficeSaveBack({');
    expect(main.slice(sb, sb + 6000)).toContain('await currentAttachmentKey(lid)');
  });
});
