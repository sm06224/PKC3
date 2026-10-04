/** @vitest-environment happy-dom */
/**
 * 🔴 **録った音を文字にする段取り**(#772 段②。裁定 2026-10-01 ①②③)。
 *
 * ⚠ 見るのは **user がどう受け取るか**:
 *   ① **部品が無ければ取り込みへ案内する**(押して無言、を作らない。案内の字は画面から引く)
 *   ② **ノートの末尾に足すだけ**(本文を上書きしない / 空なら足さない)
 *   ③ **黙って終わらない**(読めない音・無音・メモリ不足・落ちた、どれも理由が出る)
 *   ④ **2 本同時に走らない** / 失敗しても次を断らない
 *   ⑤ **書けない間は預かる**(編集中・書込中に捨てない)
 *   ⑥ **走っている間は押した行に出る**(state の `captureTranscribeLid`)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  asrMissingText,
  asrReadyFrom,
  createCaptureTranscriber,
  preferredPart,
  type AsrReady,
} from '../../src/adapter/ui/actions/capture-transcribe';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, viewModeLabel, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import { ASR_LANGUAGE, ASR_PARTS } from '../../src/features/asr/asr-parts';
import { ASR_SECTION_LABEL, transcriptHeading } from '../../src/features/asr/asr-text';
import type { AsrJob, AsrJobResult } from '../../src/adapter/platform/asr/asr-run';

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

const NOW = new Date(2026, 9, 2, 12, 34, 56);
const light = ASR_PARTS[0]!;
const READY: AsrReady = { part: light, files: new Map([['runtime/x', new Blob(['x'])]]) };

function harness(
  over: Partial<Parameters<typeof createCaptureTranscriber>[0]> = {},
  stateOver: Partial<AppState> = {},
) {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([['a', meta('a')]]),
    captureItems: captureItemsFrom([{ lid: 'a', title: 'a', body: body('録音-2026-09-12-143000.webm', 'audio/webm') }]),
    ...stateOver,
  } as AppState);
  const appends: Array<{ lid: string; heading: string | null; text: string }> = [];
  dispatcher.onEvent((e) => {
    if (e.type === 'REQUEST_APPEND') appends.push({ lid: e.lid, heading: e.heading, text: e.text });
  });
  const notes: string[] = [];
  const lids: Array<string | null> = [];
  dispatcher.onState((s) => {
    if (lids.at(-1) !== s.captureTranscribeLid) lids.push(s.captureTranscribeLid);
  });
  const deps = {
    dispatcher,
    readBlob: vi.fn(async () => new Blob([new Uint8Array(16)], { type: 'audio/webm' })),
    decode: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
    ready: vi.fn(async (): Promise<AsrReady | null> => READY),
    transcribe: vi.fn(async (job: AsrJob): Promise<AsrJobResult> => {
      void job;
      return { text: ' こんにちは。\n今日は晴れです ', loadMs: 1, runMs: 2 };
    }),
    notify: (t: string) => void notes.push(t),
    now: () => NOW,
    ...over,
  };
  return { dispatcher, deps, appends, notes, lids, tr: createCaptureTranscriber(deps) };
}

const error = (d: Dispatcher): string | null => d.getState().error;

describe('文字にする(成功する道)', () => {
  it('🔴 録音のノートの末尾に、日時の見出しつきで足す(本文を上書きする口を使わない)', async () => {
    const h = harness();
    await h.tr.run('a');
    expect(h.appends).toEqual([
      { lid: 'a', heading: transcriptHeading(NOW), text: 'こんにちは。 今日は晴れです' },
    ]);
    expect(error(h.dispatcher), '成功したのに理由が出ている').toBeNull();
    expect(h.notes.at(-1)).toContain('文字起こしを足しました');
  });

  it('🔴 #1232 段 a: 時刻つきの区切りが在れば、1 行ずつ「時刻 字」で足す(見出しは同じ)', async () => {
    const h = harness({
      transcribe: vi.fn(async (): Promise<AsrJobResult> => ({
        text: 'こんにちは。 今日は晴れです',
        segments: [
          { startMs: 0, endMs: 2500, text: ' こんにちは。' },
          { startMs: 15_000, endMs: null, text: '今日は晴れです ' },
        ],
        loadMs: 1,
        runMs: 2,
      })),
    });
    await h.tr.run('a');
    expect(h.appends).toEqual([
      { lid: 'a', heading: transcriptHeading(NOW), text: '0:00 こんにちは。\n0:15 今日は晴れです' },
    ]);
  });

  it('#1232: 区切りが無い / 全部空なら、今までの 1 段落で足す(前の版の形)', async () => {
    const h = harness({
      transcribe: vi.fn(async (): Promise<AsrJobResult> => ({
        text: ' こんにちは。\n今日は晴れです ',
        segments: [{ startMs: 0, endMs: 1000, text: '  ' }],
        loadMs: 0,
        runMs: 0,
      })),
    });
    await h.tr.run('a');
    expect(h.appends.map((a) => a.text)).toEqual(['こんにちは。 今日は晴れです']);
  });

  it('部品へは「入っている部品の model」「決めた言語」「復号した PCM」を渡す', async () => {
    const h = harness();
    await h.tr.run('a');
    const job = vi.mocked(h.deps.transcribe).mock.calls[0]![0];
    expect(job.modelId).toBe(light.modelId);
    expect(job.language).toBe(ASR_LANGUAGE);
    expect(Array.from(job.pcm)).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
    expect(job.files.map(([p]) => p)).toEqual(['runtime/x']);
    // 元の bytes は 1 回だけ読んだ(書き戻す口を呼んでいない)
    expect(h.deps.readBlob).toHaveBeenCalledTimes(1);
    expect(h.deps.readBlob).toHaveBeenCalledWith('k-1');
  });

  it('🔴 ⑥ 走っている間だけ、その行の lid が state に居る(終わったら外れる)', async () => {
    const h = harness();
    await h.tr.run('a');
    expect(h.lids).toEqual(['a', null]);
    expect(h.dispatcher.getState().captureTranscribeLid).toBeNull();
  });

  it('走り出しを声に出す(押して無反応に見せない)', async () => {
    const h = harness();
    await h.tr.run('a');
    expect(h.notes[0]).toContain('文字にしています');
    expect(h.notes[0]).toContain(light.label);
  });
});

describe('① 部品が無いとき', () => {
  it('🔴 取り込みへ案内する ── 重い仕事は 1 つも始めない', async () => {
    const h = harness({ ready: vi.fn(async () => null) });
    await h.tr.run('a');
    expect(error(h.dispatcher)).toBe(asrMissingText());
    expect(h.deps.readBlob).not.toHaveBeenCalled();
    expect(h.deps.decode).not.toHaveBeenCalled();
    expect(h.deps.transcribe).not.toHaveBeenCalled();
    expect(h.appends).toEqual([]);
    expect(h.dispatcher.getState().captureTranscribeLid, '印が残った').toBeNull();
  });

  /**
   * 🔴 **案内の字は、画面に実在する名前から引く**(#996 / #1011 の作法)。
   * ⚠ 期待値を手で「システム → 音声認識」と書かない ── 入口の名前を変えた日に、
   *   実装も検査も古い字のまま緑になる。
   */
  it('🔴 案内の字は入口の名前(viewModeLabel)と節の見出し(ASR_SECTION_LABEL)から引ける', () => {
    const m = asrMissingText();
    expect(m).toContain(viewModeLabel('settings'));
    expect(m).toContain(ASR_SECTION_LABEL);
    // 入口 → 節の順に 1 本の道として書く(逆に読ませない)
    expect(m).toContain(`${viewModeLabel('settings')} → ${ASR_SECTION_LABEL}`);
  });

  it('壊れた部品は「入っていない」にせず、理由を出す(取り直せば直る)', async () => {
    const h = harness({
      ready: vi.fn(async () => {
        throw new Error('config.json の中身が記録と合いません(入れ直してください)');
      }),
    });
    await h.tr.run('a');
    expect(error(h.dispatcher)).toContain('入れ直してください');
    expect(error(h.dispatcher)).not.toBe(asrMissingText());
  });
});

describe('③ 黙って終わらない', () => {
  it('🔴 読めない音は理由を言い、部品へ渡さない', async () => {
    const h = harness({
      decode: vi.fn(async () => {
        throw new Error('EncodingError');
      }),
    });
    await h.tr.run('a');
    expect(error(h.dispatcher)).toMatch(/読み取れませんでした/);
    expect(h.deps.transcribe).not.toHaveBeenCalled();
    expect(h.appends).toEqual([]);
  });

  it('音が入っていない(長さ 0)ときも理由を言う', async () => {
    const h = harness({ decode: vi.fn(async () => new Float32Array(0)) });
    await h.tr.run('a');
    expect(error(h.dispatcher)).toMatch(/音が入っていません/);
    expect(h.deps.transcribe).not.toHaveBeenCalled();
  });

  it('🔴 字にならなかったら、ノートを変えずに言う(空の見出しを足さない)', async () => {
    const h = harness({ transcribe: vi.fn(async () => ({ text: '  \n ', loadMs: 0, runMs: 0 })) });
    await h.tr.run('a');
    expect(h.appends, '空の追記をした').toEqual([]);
    expect(h.notes.at(-1)).toMatch(/字になりませんでした/);
    expect(h.notes.at(-1)).toMatch(/ノートは変えていません/);
  });

  it('中身が消えた録音は理由を言う', async () => {
    const h = harness({ readBlob: vi.fn(async () => null) });
    await h.tr.run('a');
    expect(error(h.dispatcher)).toMatch(/中身が見つかりませんでした/);
    expect(h.deps.decode).not.toHaveBeenCalled();
  });

  it('一覧に無い録音は理由を言う(部品を呼ばない)', async () => {
    const h = harness();
    await h.tr.run('zzz');
    expect(error(h.dispatcher)).toMatch(/見つかりませんでした/);
    expect(h.deps.ready).not.toHaveBeenCalled();
  });

  it('🔴 メモリ不足は「足りなかった」と言い、軽い部品を案内する(別の理由まで言わない)', async () => {
    const oom = harness({
      transcribe: vi.fn(async () => {
        throw new RangeError('Array buffer allocation failed');
      }),
    });
    await oom.tr.run('a');
    expect(error(oom.dispatcher)).toMatch(/メモリが足りず/);
    expect(error(oom.dispatcher)).toContain(ASR_PARTS[0]!.label);
    // 対照群:別の失敗は「メモリ」と言わない
    const other = harness({
      transcribe: vi.fn(async () => {
        throw new Error('Unsupported model type');
      }),
    });
    await other.tr.run('a');
    expect(error(other.dispatcher)).not.toMatch(/メモリ/);
    expect(error(other.dispatcher)).toContain('Unsupported model type');
  });

  it('🔴 落ちた後も、印は外れ、次の押下が断られない', async () => {
    let n = 0;
    const h = harness({
      transcribe: vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return { text: 'あ', loadMs: 0, runMs: 0 };
      }),
    });
    await h.tr.run('a');
    expect(h.dispatcher.getState().captureTranscribeLid).toBeNull();
    expect(h.tr.busy).toBe(false);
    await h.tr.run('a');
    expect(h.appends).toHaveLength(1);
  });
});

describe('④ 2 本同時に走らない', () => {
  it('🔴 走っている間の 2 本目は断る(1.65〜3.6GB を重ねない)', async () => {
    let release: (r: AsrJobResult) => void = () => {};
    const h = harness({
      transcribe: vi.fn(() => new Promise<AsrJobResult>((r) => (release = r))),
    });
    const first = h.tr.run('a');
    await vi.waitFor(() => expect(h.deps.transcribe).toHaveBeenCalled());
    expect(h.tr.busy).toBe(true);
    await h.tr.run('a');
    expect(error(h.dispatcher)).toMatch(/別の録音を文字にしています/);
    expect(h.deps.transcribe).toHaveBeenCalledTimes(1);
    release({ text: 'あ', loadMs: 0, runMs: 0 });
    await first;
    expect(h.appends).toHaveLength(1);
  });
});

describe('⑤ 書けない間は預かる', () => {
  it('🔴 書込中(錠が立っている)は捨てずに預かり、そう言い、解けたら足す', async () => {
    const h = harness({}, { writeLock: { lid: 'other' } } as Partial<AppState>);
    await h.tr.run('a');
    expect(h.appends, '書けないのに足した').toEqual([]);
    expect(h.notes.at(-1)).toMatch(/預かりました/);
    h.dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.appends, '解けても足されない(預かりを捨てた)').toHaveLength(1);
    expect(h.appends[0]!.lid).toBe('a');
  });
});

describe('部品の選び方', () => {
  it('両方入っていれば当たりやすい方(定数の並びの後ろ)を使う', () => {
    expect(preferredPart(new Set(['light', 'accurate']))?.id).toBe('accurate');
    expect(preferredPart(new Set(['light']))?.id).toBe('light');
    expect(preferredPart(new Set())).toBeNull();
    expect(preferredPart(new Set(['nope']))).toBeNull();
  });

  it('asrReadyFrom:入っていれば部品と file、無ければ null、壊れていれば投げる', async () => {
    const files = new Map([['a', new Blob(['x'])]]);
    const okStore = {
      readInstalled: async () => ({ parts: { light: {} } }),
      readFilesFor: vi.fn(async () => files),
    };
    const r = await asrReadyFrom(okStore)();
    expect(r?.part.id).toBe('light');
    expect(r?.files).toBe(files);
    expect(okStore.readFilesFor).toHaveBeenCalledWith('light');

    const none = { readInstalled: async () => ({ parts: {} }), readFilesFor: vi.fn(async () => null) };
    expect(await asrReadyFrom(none)()).toBeNull();
    expect(none.readFilesFor, '入っていないのに読みに行った').not.toHaveBeenCalled();

    const broken = {
      readInstalled: async () => ({ parts: { light: {} } }),
      readFilesFor: async () => {
        throw new Error('入れ直してください');
      },
    };
    await expect(asrReadyFrom(broken)()).rejects.toThrow(/入れ直してください/);
    // 保管が読めないときは「入っていない」へ倒す(安全側)
    const unreadable = {
      readInstalled: async () => {
        throw new Error('idb');
      },
      readFilesFor: async () => files,
    };
    expect(await asrReadyFrom(unreadable)()).toBeNull();
  });
});

/**
 * 🔴 **失敗したら、進行中の字(「文字にしています…」)を消す**(#1017 C5)。
 *
 * ⚠ 直す前は、音を読めなかった・メモリが足りなかった等の失敗で進行中の字が画面下に**残った**。
 *   進行中の字を出す**前**に断る枝(部品が無い / 中身が消えた / 一覧に無い)は、出していない字を
 *   消す字も撃たない(別の知らせを巻き込まない)。進行中のあとに**言う字**(字にならなかった / 預かった)は
 *   それが進行中の字を置き換えるので、消す字は撃たない。
 */
describe('進行中の字の後始末(#1017 C5)', () => {
  it.each([
    ['読めない音', { decode: vi.fn(async () => Promise.reject(new Error('EncodingError'))) }],
    ['音が入っていない', { decode: vi.fn(async () => new Float32Array(0)) }],
    ['メモリ不足', { transcribe: vi.fn(async () => Promise.reject(new RangeError('Array buffer allocation failed'))) }],
    ['別の例外', { transcribe: vi.fn(async () => Promise.reject(new Error('boom'))) }],
  ] as const)('🔴 %s: 失敗したら最後は消す字になる', async (_label, over) => {
    const h = harness(over);
    await h.tr.run('a');
    expect(h.notes[0], '前提が崩れた(進行中の字が先に出ていない)').toContain('文字にしています');
    expect(h.notes.at(-1), '失敗したのに進行中の字が残る').toBe('');
  });

  it.each([
    ['部品が無い', { ready: vi.fn(async () => null) }],
    ['中身が消えた録音', { readBlob: vi.fn(async () => null) }],
  ] as const)('🔴 進行中の字を出す前の断り(%s)は、消す字も撃たない', async (_label, over) => {
    const h = harness(over);
    await h.tr.run('a');
    expect(h.notes, '出していない進行中の字を消す字を撃った').toEqual([]);
  });

  it('対照群:成功 / 字にならなかった / 預かった は、最後がそれぞれの字で、消す字は撃たない', async () => {
    const ok = harness();
    await ok.tr.run('a');
    expect(ok.notes.at(-1)).toContain('文字起こしを足しました');
    expect(ok.notes).not.toContain('');

    const empty = harness({ transcribe: vi.fn(async () => ({ text: '  ', loadMs: 0, runMs: 0 })) });
    await empty.tr.run('a');
    expect(empty.notes.at(-1)).toMatch(/字になりませんでした/);
    expect(empty.notes).not.toContain('');
  });
});
