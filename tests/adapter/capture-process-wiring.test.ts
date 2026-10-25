/** @vitest-environment happy-dom */
/**
 * 🔴 **仕上げの配線と、重い仕事の排他・二重追記の防止**(#952 着地前レビュー 🔴1・⚠5・記録④)。
 *
 * - 🔴1 `lock`(別のタブの編集中のノートへ足さない)と `setWriting`(仕上げている間にタブを閉じる前に確認)を、
 *   `main.ts` が**必ず渡している**こと ── 関数に出して型で必須にし、`main.ts` がその関数を通っていることを source 読みで守る
 * - ④ 切り出し・取り出し・文字起こし・仕上げは**両方向に**断り合う
 * - ⚠5 預かり中の同じ `lid × 道具` は断る(同じ結果を 2 回足さない)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCaptureJobGate } from '../../src/adapter/ui/actions/capture-job-gate';
import { createWiredCaptureProcessor, PROCESS_WRITING_KEY } from '../../src/adapter/ui/actions/capture-process-wiring';
import type { ToolRunner } from '../../src/adapter/ui/actions/capture-process';
import { createCaptureTrimmer } from '../../src/adapter/ui/actions/capture-trim';
import { createCaptureExtractor } from '../../src/adapter/ui/actions/capture-extract';
import { createCaptureTranscriber } from '../../src/adapter/ui/actions/capture-transcribe';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { AttachItem, AttachedOne } from '../../src/adapter/ui/actions/attach';

const body = (name: string, mime: string): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 2048', 'attachment.asset_key: k-1', '---', ''].join('\n');

const meta = (lid: string): EntryMeta => ({
  lid,
  title: `${lid}.webm`,
  archetype: 'attachment',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const noteTool: ToolRunner = async () => ({ kind: 'note', heading: '## チャプター', text: '0:00 チャプター 1', summary: '1 件足しました' });
const attachTool: ToolRunner = async () => ({
  kind: 'attach',
  items: [{ tag: '雑音を減らした', blob: new Blob([new Uint8Array(4)], { type: 'audio/webm' }), mime: 'audio/webm', ext: 'webm' }],
  summary: '作りました',
});

function setup(over: { stateOver?: Partial<AppState>; lock?: Parameters<typeof createWiredCaptureProcessor>[0]['lock']; tools?: Record<string, ToolRunner> } = {}) {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([['a', meta('a')], ['b', meta('b')], ['v', meta('v')]]),
    captureItems: captureItemsFrom([
      { lid: 'a', title: 'a', body: body('録音-a.webm', 'audio/webm;codecs=opus') },
      { lid: 'b', title: 'b', body: body('録音-b.webm', 'audio/webm;codecs=opus') },
      { lid: 'v', title: 'v', body: body('画面録画.webm', 'video/webm;codecs=vp8,opus') },
    ]),
    ...over.stateOver,
  } as AppState);
  const appends: Array<{ lid: string; heading: string | null; text: string }> = [];
  dispatcher.onEvent((e) => {
    if (e.type !== 'REQUEST_APPEND') return;
    appends.push({ lid: e.lid, heading: e.heading, text: e.text });
    const { lid, gen } = e;
    queueMicrotask(() =>
      dispatcher.dispatch({ type: 'ENTRY_APPENDED', lid, gen, body: '本文', status: null, date: null, archived: false, inserted: null }),
    );
  });
  /** 断りの理由(`OP_FAILED`)を撃たれた順に控える ── state の error は同じ字だと変化が見えない。 */
  const failures: string[] = [];
  const rawDispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = (a: Parameters<typeof rawDispatch>[0]): void => {
    if (a.type === 'OP_FAILED') failures.push(a.error);
    rawDispatch(a);
  };
  const writing: Array<[boolean, string]> = [];
  const notes: string[] = [];
  const gate = createCaptureJobGate();
  const attached: AttachItem[] = [];
  const processor = createWiredCaptureProcessor({
    dispatcher,
    gate,
    lock: over.lock ?? {},
    setWriting: (a, k) => void writing.push([a, k]),
    readBlob: async () => new Blob([new Uint8Array(8)]),
    readBody: async () => null,
    tools: over.tools ?? { chapters: noteTool, denoise: attachTool },
    parentOf: () => null,
    attach: async (item): Promise<AttachedOne | null> => {
      attached.push(item);
      return { lid: 'new', assetKey: 'k2', mime: item.type, hash: 'h' };
    },
    notify: (t) => void notes.push(t),
  });
  return { dispatcher, appends, writing, notes, gate, processor, attached, failures };
}

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('🔴1 配線:lock と setWriting が効いている', () => {
  it('別のタブ・窓が編集中のノートへは足さず、理由を言う(lock が実際に渡っている)', async () => {
    const s = setup({ lock: { acquireEditLock: async () => 'denied' } });
    await s.processor.run('a', 'chapters');
    await settle();
    expect(s.appends, '別の窓が編集中なのに足した').toEqual([]);
    expect(s.notes.at(-1)).toMatch(/別のタブまたはウィンドウで編集中なので足していません/);
    // 対照:錠が取れれば足す
    const ok = setup({ lock: { acquireEditLock: async () => 'granted', releaseEditLock: () => {} } });
    await ok.processor.run('a', 'chapters');
    await settle();
    expect(ok.appends).toHaveLength(1);
  });

  it('仕上げている間は「離れますか」に数え(true)、終わったら解く(false)。添付を作る道も追記の道も', async () => {
    for (const tool of ['denoise', 'chapters'] as const) {
      const s = setup();
      await s.processor.run('a', tool);
      await settle();
      expect(s.writing, tool).toEqual([[true, PROCESS_WRITING_KEY], [false, PROCESS_WRITING_KEY]]);
    }
    expect(PROCESS_WRITING_KEY).toBe('process');
  });

  it('預かった結果が書かれるまでは数え続け(true のまま)、書かれたら 1 回だけ解く', async () => {
    const s = setup({ stateOver: { writeLock: { lid: 'other' } } as unknown as Partial<AppState> });
    await s.processor.run('a', 'chapters');
    await settle();
    expect(s.appends).toEqual([]);
    expect(s.writing, '預かっているのに解いた(閉じると結果が黙って消える)').toEqual([[true, PROCESS_WRITING_KEY]]);
    s.dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await settle();
    expect(s.appends).toHaveLength(1);
    expect(s.writing).toEqual([[true, PROCESS_WRITING_KEY], [false, PROCESS_WRITING_KEY]]);
  });

  it('main.ts は仕上げを createWiredCaptureProcessor 経由で作り、lock・setWriting・gate を渡している(source 読み)', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main, '素の createCaptureProcessor を main.ts が直に呼んでいる').not.toMatch(/\bcreateCaptureProcessor\(/);
    const at = main.indexOf('createWiredCaptureProcessor({');
    expect(at, 'main.ts が createWiredCaptureProcessor を呼んでいない').toBeGreaterThan(0);
    const block = main.slice(at, at + 900);
    expect(block).toMatch(/lock:\s*editLockPort/);
    expect(block).toMatch(/setWriting:[^\n]*unloadGuard\.setWriting\(/);
    expect(block).toMatch(/gate:\s*captureJobGate/);
  });

  it('main.ts は 4 つの重い仕事(切り出し・取り出し・仕上げ・文字起こし)に同じ門を渡している(source 読み)', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main.match(/gate:\s*captureJobGate/g) ?? []).toHaveLength(4);
    expect(main.match(/createCaptureJobGate\(\)/g) ?? [], '門が 2 つ以上ある(別々の門では排他にならない)').toHaveLength(1);
  });
});

describe('④ 切り出し・取り出し・文字起こし・仕上げは両方向に断り合う', () => {
  /** 仕上げを「終わらない道具」で走らせたままにする。 */
  function slowProcess() {
    let release!: () => void;
    const slow: ToolRunner = () =>
      new Promise((res) => {
        release = () => res({ kind: 'refused', text: 'x' });
      });
    const s = setup({ tools: { denoise: slow } });
    return { s, release: () => release() };
  }

  const trimmerOf = (s: ReturnType<typeof setup>) =>
    createCaptureTrimmer({
      dispatcher: s.dispatcher,
      gate: s.gate,
      readBlob: async () => new Blob([]),
      trim: vi.fn(),
      scanVideo: vi.fn(),
      cutVideo: vi.fn(),
      confirm: vi.fn(),
      parentOf: () => null,
      attach: vi.fn(),
      notify: () => {},
    } as never);
  const extractorOf = (s: ReturnType<typeof setup>) =>
    createCaptureExtractor({
      dispatcher: s.dispatcher,
      gate: s.gate,
      readBlob: async () => new Blob([]),
      extractAudio: vi.fn(),
      extractPicture: vi.fn(),
      parentOf: () => null,
      attach: vi.fn(),
      notify: () => {},
    } as never);
  const transcriberOf = (s: ReturnType<typeof setup>) =>
    createCaptureTranscriber({
      dispatcher: s.dispatcher,
      gate: s.gate,
      readBlob: async () => new Blob([]),
      decode: vi.fn(),
      ready: vi.fn(async () => null),
      transcribe: vi.fn(),
      notify: () => {},
    } as never);

  it('🔴 仕上げが走っている間、切り出し・取り出し・文字起こしは理由つきで断る', async () => {
    const { s, release } = slowProcess();
    const running = s.processor.run('a', 'denoise');
    await settle();
    expect(s.gate.current).toBe('仕上げ');
    const refusal = 'いま仕上げをしています。終わるまで待ってください。';
    // 切り出しは (lid, 始まり, 終わり)、取り出しは (lid, 'audio')、文字起こしは (lid)
    await trimmerOf(s).run('a', 0, 1000);
    await extractorOf(s).run('v', 'audio');
    await transcriberOf(s).run('a');
    expect(s.failures, '仕上げが走っているのに通した').toEqual([refusal, refusal, refusal]);
    release();
    await running;
    expect(s.gate.current, '門が解けていない').toBeNull();
  });

  it('🔴 逆向き:切り出し・取り出し・文字起こしが走っている間、仕上げは断る(門を取った側が居る間)', async () => {
    const s = setup();
    for (const label of ['切り出し', '取り出し', '文字起こし']) {
      const leave = s.gate.tryEnter(label)!;
      expect(leave, `${label} の門が取れない`).not.toBeNull();
      await s.processor.run('a', 'denoise');
      expect(s.failures.at(-1)).toBe(`いま${label}をしています。終わるまで待ってください。`);
      expect(s.attached).toEqual([]);
      leave();
    }
    await s.processor.run('a', 'denoise');
    expect(s.attached, '門を解いたのに通らない').toHaveLength(1);
  });

  it('門を取ったまま断った回は残らない(検証で落ちた回は門を握らない)', async () => {
    const s = setup();
    await s.processor.run('missing', 'denoise');
    expect(s.gate.current).toBeNull();
    await s.processor.run('a', 'fix-speakers'); // 道具が配線されていない
    expect(s.gate.current).toBeNull();
  });

  it('門そのもの:2 つ目は取れず、解くのは 1 回だけ有効で、解けば取れる', () => {
    const g = createCaptureJobGate();
    const a = g.tryEnter('A')!;
    expect(g.tryEnter('B')).toBeNull();
    expect(g.current).toBe('A');
    a();
    a(); // 2 回呼んでも他の仕事の門を解かない
    const b = g.tryEnter('B')!;
    a();
    expect(g.current, '古い解除が新しい門を解いた').toBe('B');
    b();
    expect(g.current).toBeNull();
  });
});

describe('⚠5 預かり中の同じ lid × 道具は断る(二重追記を防ぐ)', () => {
  it('🔴 預かっている間に同じ道具をもう一度押すと断り、解けたあとに足されるのは 1 回だけ', async () => {
    const s = setup({ stateOver: { writeLock: { lid: 'other' } } as unknown as Partial<AppState> });
    await s.processor.run('a', 'chapters');
    expect(s.failures).toEqual([]);
    await s.processor.run('a', 'chapters');
    expect(s.failures.at(-1)).toContain('保留しています');
    s.dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await settle();
    expect(s.appends, '同じ結果が 2 回足された').toHaveLength(1);
    // 解けたあとは同じ道具をもう一度押せる(別の結果として)
    await s.processor.run('a', 'chapters');
    await settle();
    expect(s.appends).toHaveLength(2);
  });

  it('別のノート・別の道具は断らない(同じ lid × 道具だけ)', async () => {
    const s = setup({ stateOver: { writeLock: { lid: 'other' } } as unknown as Partial<AppState> });
    await s.processor.run('a', 'chapters');
    await s.processor.run('b', 'chapters');
    expect(s.failures, '別のノートまで断った').toEqual([]);
    s.dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await settle();
    expect(s.appends.map((a) => a.lid).sort()).toEqual(['a', 'b']);
  });
});
