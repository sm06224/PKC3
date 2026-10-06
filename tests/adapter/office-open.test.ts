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
import { SHADOW_GONE_NOTICE, SHADOW_OPENED_NOTICE } from '../../src/features/office/office-shadow';

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
  provided: { name: string; bytes: Uint8Array; token: string; fromShadow: boolean }[];
  alreadyOpen: boolean;
} {
  const opens: { name?: string; expectDocument?: boolean; bytes?: Uint8Array }[] = [];
  const provided: { name: string; bytes: Uint8Array; token: string; fromShadow: boolean }[] = [];
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
    provideDocument(
      name: string,
      bytes: Uint8Array,
      token = '',
      _images?: unknown,
      _refresh?: unknown,
      fromShadow = false,
    ) {
      provided.push({ name, bytes, token, fromShadow });
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
describe('窓が作り直されたとき(本物の OfficeWindow とつなぐ)', () => {
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

/**
 * 🔴 **保存していない編集の控え(影)が在れば、開く前に訊く**(#1228 段 2、裁定 Q1 = A / Q2 = A)。
 *
 * 守る主張:
 * ① 控えが無い(`mayHave` が偽)ときは**今までどおり同期で開く**(ポップアップ遮断に当たらない・訊かない)
 * ② 在るときは**答えが出るまで窓を開かない**。「一時保存した内容で開く」→ 控えの bytes を `fromShadow` つきで渡す /
 *    「保存済みの版で開く」→ **控えを消してから**開く / やめる → 何も開かず何も消さない
 * ③ 開いている窓へ頼むときは訊かない(その窓が自分で訊く)/ lid の無い添付は訊かない
 * ④ 確認が出せない・控えが消えた、でも開けなくしない
 */
describe('編集の控え(影)の確認(#1228 段 2)', () => {
  const SAVED = new Uint8Array([1, 2, 3]);
  const SHADOW = new Uint8Array([9, 9]);
  const NOTE = { ...DOCX, lid: 'L1' };

  function makeShadow(over: {
    mayHave?: boolean;
    offer?: { at: number; ext: string } | null;
    answer?: 'shadow' | 'saved' | null | 'throw' | 'wait';
    bytes?: Uint8Array | null;
  } = {}) {
    const log: string[] = [];
    let release: (v: 'shadow' | 'saved' | null) => void = () => undefined;
    const port = {
      mayHave: vi.fn(() => over.mayHave ?? true),
      find: vi.fn(async () => {
        log.push('find');
        return over.offer === undefined ? { at: 1000, ext: 'docx' } : over.offer;
      }),
      readBytes: vi.fn(async () => (over.bytes === undefined ? SHADOW : over.bytes)),
      discard: vi.fn(async () => { log.push('discard'); }),
      ask: vi.fn(() => {
        log.push('ask');
        if (over.answer === 'throw') return Promise.reject(new Error('dialog'));
        if (over.answer === 'wait') return new Promise<'shadow' | 'saved' | null>((r) => { release = r; });
        return Promise.resolve(over.answer === undefined ? 'shadow' : over.answer);
      }),
    };
    const officeWindow = fakeWindow();
    const origOpen = officeWindow.open.bind(officeWindow);
    officeWindow.open = ((o: { name?: string; expectDocument?: boolean }) => { log.push('open'); return origOpen(o); }) as typeof officeWindow.open;
    const notes: string[] = [];
    const opener = createOfficeOpener({
      officeWindow,
      isPackInstalled: () => true,
      readAsset: async () => SAVED,
      capability: () => OK,
      shadow: port,
      notify: (t) => notes.push(t),
    });
    return { opener, officeWindow, port, log, notes, release: (v: 'shadow' | 'saved' | null) => release(v) };
  }
  const settle = async (r: ReturnType<ReturnType<typeof makeShadow>['opener']['open']>) => {
    expect(r.ok && r.settled, '訊く経路なのに settled が無い').toBeTruthy();
    return r.ok ? r.settled! : r;
  };

  it('🔴 ① 控えが無ければ今までどおり: 同期で開き、訊かず、探しもしない(対照群)', async () => {
    const m = makeShadow({ mayHave: false });
    const r = m.opener.open(NOTE);
    expect(m.officeWindow.opens, '同期のうちに開いていない').toHaveLength(1);
    expect(r).toEqual({ ok: true, reused: false });
    expect(m.port.find).not.toHaveBeenCalled();
    expect(m.port.ask).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(m.officeWindow.provided).toHaveLength(1));
    expect(m.officeWindow.provided[0]).toMatchObject({ bytes: SAVED, token: 'L1', fromShadow: false });
    expect(m.notes).toEqual([]);
  });

  it('🔴 ② 在るかもしれないが探したら無かった: 訊かずに開く(1 回の非同期の後)', async () => {
    const m = makeShadow({ offer: null });
    const r = m.opener.open(NOTE);
    expect(m.officeWindow.opens, '探している間に開いた(この経路は見つけてから開く)').toHaveLength(0);
    expect(await settle(r)).toEqual({ ok: true, reused: false });
    expect(m.officeWindow.opens).toHaveLength(1);
    expect(m.port.ask).not.toHaveBeenCalled();
  });

  it('🔴 ② 「一時保存した内容で開く」: 答えが出るまで開かない / 控えの bytes を fromShadow つきで渡す / 控えは消さない', async () => {
    const m = makeShadow({ answer: 'wait' });
    const done = settle(m.opener.open(NOTE));
    await vi.waitFor(() => expect(m.port.ask).toHaveBeenCalledTimes(1));
    expect(m.port.ask).toHaveBeenCalledWith({ at: 1000, ext: 'docx' });
    expect(m.officeWindow.opens, '答えが出る前に窓を開いた').toHaveLength(0);
    m.release('shadow');
    await done;
    expect(m.officeWindow.opens).toHaveLength(1);
    await vi.waitFor(() => expect(m.officeWindow.provided).toHaveLength(1));
    expect(m.officeWindow.provided[0]).toMatchObject({ bytes: SHADOW, token: 'L1', fromShadow: true });
    expect(m.port.discard, '控えの版で開くのに控えを消した').not.toHaveBeenCalled();
    expect(m.notes).toEqual([SHADOW_OPENED_NOTICE]);
  });

  it('🔴 ② 「保存済みの版で開く」: 控えを消してから開く(順番)/ 保存済みの bytes・fromShadow なし', async () => {
    const m = makeShadow({ answer: 'saved' });
    await settle(m.opener.open(NOTE));
    expect(m.log, '消してから開く').toEqual(['find', 'ask', 'discard', 'open']);
    expect(m.port.discard).toHaveBeenCalledWith('L1');
    await vi.waitFor(() => expect(m.officeWindow.provided).toHaveLength(1));
    expect(m.officeWindow.provided[0]).toMatchObject({ bytes: SAVED, token: 'L1', fromShadow: false });
    expect(m.notes).toEqual([]);
  });

  it('🔴 ② やめる: 何も開かず、何も消さず、cancelled を返す', async () => {
    const m = makeShadow({ answer: null });
    const res = await settle(m.opener.open(NOTE));
    expect(res).toEqual({ ok: true, reused: false, cancelled: true });
    expect(m.officeWindow.opens).toHaveLength(0);
    expect(m.port.discard, 'やめたのに控えを消した').not.toHaveBeenCalled();
    expect(m.port.readBytes).not.toHaveBeenCalled();
  });

  it('🔴 ③ 開いている窓へ頼むときは訊かない(窓が自分の未保存を訊く)/ lid の無い添付も訊かない', async () => {
    const a = makeShadow();
    a.officeWindow.alreadyOpen = true;
    const r = a.opener.open(NOTE);
    expect(r).toEqual({ ok: true, reused: true });
    expect(a.port.mayHave).not.toHaveBeenCalled();
    expect(a.port.ask).not.toHaveBeenCalled();
    const b = makeShadow();
    expect(b.opener.open(DOCX)).toEqual({ ok: true, reused: false });
    expect(b.port.mayHave).not.toHaveBeenCalled();
    expect(b.officeWindow.opens, '同期で開いていない').toHaveLength(1);
  });

  it('③ 開けない添付(Office でない / 使えない環境)は訊く前に理由を返す', () => {
    const m = makeShadow();
    const r = m.opener.open({ name: 'a.png', mime: 'image/png', assetKey: 'x', lid: 'L1' });
    expect(r.ok).toBe(false);
    expect(m.port.mayHave).not.toHaveBeenCalled();
  });

  it('同じノートの確認が出ている間の 2 回目の押しは、確認を重ねない(1 つ目の答えが開く)。答えが出たらまた訊ける', async () => {
    const m = makeShadow({ answer: 'wait' });
    const first = settle(m.opener.open(NOTE));
    await vi.waitFor(() => expect(m.port.ask).toHaveBeenCalledTimes(1));
    const second = m.opener.open(NOTE);
    expect(second).toEqual({ ok: true, reused: false, cancelled: true });
    expect(m.port.ask, '確認を重ねた').toHaveBeenCalledTimes(1);
    m.release('shadow');
    await first;
    expect(m.officeWindow.opens, '窓が 2 つ開いた').toHaveLength(1);
    // 答えが出た後は、また訊ける
    const third = m.opener.open(NOTE);
    expect(third.ok && third.settled, '答えの後に訊けない').toBeTruthy();
    await vi.waitFor(() => expect(m.port.ask).toHaveBeenCalledTimes(2));
    m.release('shadow');
  });

  it('🔴 ④ 確認を出せなかったら、控えには触れず保存済みの版で開く(開けなくしない)', async () => {
    const m = makeShadow({ answer: 'throw' });
    const res = await settle(m.opener.open(NOTE));
    expect(res).toEqual({ ok: true, reused: false });
    expect(m.port.discard, '確認を出せなかったのに控えを消した').not.toHaveBeenCalled();
    await vi.waitFor(() => expect(m.officeWindow.provided).toHaveLength(1));
    expect(m.officeWindow.provided[0]).toMatchObject({ bytes: SAVED, fromShadow: false });
  });

  it('🔴 ④ 控えの版を選んだ後で控えが読めなくなっていたら、保存済みの版で開き、そう言う(黙って別の版にしない)', async () => {
    const m = makeShadow({ answer: 'shadow', bytes: null });
    await settle(m.opener.open(NOTE));
    await vi.waitFor(() => expect(m.officeWindow.provided).toHaveLength(1));
    expect(m.officeWindow.provided[0]).toMatchObject({ bytes: SAVED, fromShadow: false });
    expect(m.notes).toEqual([SHADOW_GONE_NOTICE]);
  });

  it('確認のために探す・訊く口を省いた呼び側(deps.shadow なし)は今までと 1 バイトも変わらない', () => {
    const { opener, officeWindow } = make();
    expect(opener.open({ ...DOCX, lid: 'L1' })).toEqual({ ok: true, reused: false });
    expect(officeWindow.opens).toHaveLength(1);
  });
});

/**
 * 🔴 **本物の OfficeWindow と繋ぐ**(§7)── 封筒に `fromShadow` が載り、窓が作り直されて文書を求め直したときも
 * **控えの版**が(控えがまだ在れば)送られる。偽の窓は第 6 引数を覚えているだけなので、この繋ぎは別に要る。
 */
describe('編集の控えの版で開いた窓が、作り直されたとき(本物の OfficeWindow とつなぐ)', () => {
  function wired(shadow: { bytes: () => Uint8Array | null }) {
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
    const opener = createOfficeOpener({
      officeWindow: ow,
      isPackInstalled: () => true,
      readAsset: async () => new Uint8Array([1]),
      capability: () => OK,
      currentAssetKey: async () => null,
      shadow: {
        mayHave: () => true,
        find: async () => ({ at: 1, ext: 'docx' }),
        readBytes: async () => shadow.bytes(),
        discard: async () => undefined,
        ask: async () => 'shadow',
      },
    });
    const ready = (): void => { handler?.({ data: { pkc3Office: 'ready-for-document', payload: {} } } as MessageEvent); };
    const docs = () => sent.filter((x) => x.type === 'document');
    return { opener, ready, docs };
  }

  it('🔴 封筒に fromShadow が載る(控えの版のときだけ)。保存済みの版の封筒には載せない', async () => {
    const w = wired({ bytes: () => new Uint8Array([7]) });
    const r = w.opener.open({ ...DOCX, lid: 'L1' });
    await (r.ok ? r.settled! : Promise.resolve());
    await new Promise((res) => setTimeout(res, 0));
    w.ready();
    expect(w.docs()).toHaveLength(1);
    expect(w.docs()[0]!.payload).toMatchObject({ token: 'L1', bytes: new Uint8Array([7]), fromShadow: true });
  });

  it('🔴 読み込み直しの 2 回目の求めには、控えがまだ在れば控え(最新)を fromShadow つきで送る', async () => {
    let cur: Uint8Array | null = new Uint8Array([7]);
    const w = wired({ bytes: () => cur });
    const r = w.opener.open({ ...DOCX, lid: 'L1' });
    await (r.ok ? r.settled! : Promise.resolve());
    await new Promise((res) => setTimeout(res, 0));
    w.ready();
    cur = new Uint8Array([8]);                  // 窓が控えを書き直した(最新)
    w.ready();
    await vi.waitFor(() => expect(w.docs()).toHaveLength(2));
    expect(w.docs()[1]!.payload).toMatchObject({ bytes: new Uint8Array([8]), fromShadow: true });
  });

  it('控えが消えていたら、読み込み直しは保存済みの最新を送る(fromShadow なし)', async () => {
    let cur: Uint8Array | null = new Uint8Array([7]);
    const w = wired({ bytes: () => cur });
    const r = w.opener.open({ ...DOCX, lid: 'L1' });
    await (r.ok ? r.settled! : Promise.resolve());
    await new Promise((res) => setTimeout(res, 0));
    w.ready();
    cur = null;
    w.ready();
    await vi.waitFor(() => expect(w.docs()).toHaveLength(2));
    expect(w.docs()[1]!.payload.bytes).toEqual(new Uint8Array([1]));
    expect('fromShadow' in w.docs()[1]!.payload, '保存済みの版に fromShadow が載った').toBe(false);
  });
});

describe('main.ts の配線(#1228 段 2 の原文 pin)', () => {
  const main = readFileSync('src/main.ts', 'utf-8');
  it('🔴 控えの口を opener へ渡し、確認は app-dialog の 1 本。「在るかもしれない」を窓の放送で保つ。起動時に掃除する', () => {
    const start = main.indexOf('createOfficeOpener({');
    const call = main.slice(start, main.indexOf('    currentAssetKey', start));
    expect(call).toContain('shadow: { ...officeShadows, ask: (offer) => pickOfficeShadowInApp(root, offer.at) }');
    // 窓の放送のたびに読み直す(3 種類とも)── 偽陰性は控えを黙って見逃す
    const ev = main.split('\n').find((l) => l.includes("ev.type === 'shadow-written'") && l.includes('refresh'));
    expect(ev, '放送で棚を読み直していない').toBeTruthy();
    for (const t of ["'shadow-written'", "'saved'", "'closed'"]) expect(ev).toContain(t);
    expect(main).toContain('void officeShadows.sweep();');
    // 結果の受け方: settled を待って、もう一度同じ報告に通す(失敗の理由・開いている窓への一言を落とさない)
    expect(main).toContain('else if (r.settled !== undefined) void r.settled.then(report);');
  });
});
