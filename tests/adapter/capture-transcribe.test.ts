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
import { ASR_SECTION_LABEL, STORAGE_SECTION_LABEL, transcriptHeading } from '../../src/features/asr/asr-text';
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
  /**
   * ⚠ **書込が着いたことにする**(本物の worker の ack。§3「stub は本物の意味論を真似る」)── 「足しました」は
   *   disk に着いてから言うので、ack が来ない台では永遠に言わない。`ackOn.fail` で「保存で落ちる」台も作れる。
   */
  const ackOn: { v: boolean; fail: string | null } = { v: true, fail: null };
  dispatcher.onEvent((e) => {
    if (e.type !== 'REQUEST_APPEND' || !ackOn.v) return;
    const { lid, gen } = e;
    if (ackOn.fail !== null) {
      const error = ackOn.fail;
      queueMicrotask(() => dispatcher.dispatch({ type: 'APPEND_FAILED', lid, gen, error }));
      return;
    }
    queueMicrotask(() =>
      dispatcher.dispatch({
        type: 'ENTRY_APPENDED',
        lid,
        gen,
        body: '本文',
        status: null,
        date: null,
        archived: false,
        inserted: null,
      }),
    );
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
  const real = createCaptureTranscriber(deps);
  /** ⚠ 預かりの書込は `run` の外で終わる ── 結末まで待ってから返す。 */
  const tr = Object.create(real, {
    run: {
      value: async (lid: string) => {
        await real.run(lid);
        await new Promise((r) => setTimeout(r, 0));
      },
    },
  }) as typeof real;
  return { dispatcher, deps, appends, notes, lids, ackOn, tr };
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

  it('🔴 足したら一覧を集め直す(波形の目盛りは一覧が持つ)', async () => {
    const h = harness();
    const scans: string[] = [];
    h.dispatcher.onEvent((e) => {
      if (e.type === 'REQUEST_CAPTURE_ITEMS') scans.push(e.type);
    });
    await h.tr.run('a');
    expect(h.appends.length, '前提: 足していない').toBe(1);
    expect(scans.length, '足したのに一覧の目盛りが古いまま').toBe(1);
  });

  it('🔴 #1232 段 a: 時刻つきの区切りが在れば、1 行ずつ「時刻 字」(終わりがあれば「始まり 〜終わり 字」)で足す(見出しは同じ)', async () => {
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
      { lid: 'a', heading: transcriptHeading(NOW), text: '0:00 〜0:02 こんにちは。\n0:15 今日は晴れです' },
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
   * ⚠ 期待値を手で「システム → 保存領域 → 音声認識」と書かない ── 入口の名前を変えた日に、
   *   実装も検査も古い字のまま緑になる。
   */
  it('🔴 案内の字は入口の名前(viewModeLabel)と節の見出し(ASR_SECTION_LABEL)から引ける', () => {
    const m = asrMissingText();
    expect(m).toContain(viewModeLabel('settings'));
    expect(m).toContain(ASR_SECTION_LABEL);
    // 入口 → 保存領域 → 節の順に 1 本の道として書く(逆に読ませない)
    expect(m).toContain(
      `${viewModeLabel('settings')} → ${STORAGE_SECTION_LABEL} → ${ASR_SECTION_LABEL}`,
    );
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

  /**
   * 🔴 **ほぼ無音は認識に渡さない**(#1446 B)── whisper は無音に `you you you` を出す(2026-10-08 の実測)。
   * 🔑 対照群 = 閾値のすぐ上(−76 dBFS 相当)は**渡す**(音声を 1 件も切らない側の値であること)。
   */
  it('🔴 ほぼ無音(RMS < 1e-4)は理由を言って認識に渡さない / すぐ上の小さい音は渡す', async () => {
    const quiet = new Float32Array(16_000).fill(5e-5); // −86 dBFS 相当(実測で崩れた側)
    const h = harness({ decode: vi.fn(async () => quiet) });
    await h.tr.run('a');
    expect(error(h.dispatcher)).toMatch(/音が入っていません/);
    expect(error(h.dispatcher), 'ほぼ無音だと言っていない').toMatch(/ほぼ無音/);
    expect(h.deps.transcribe, 'ほぼ無音を認識に渡した').not.toHaveBeenCalled();
    const faint = new Float32Array(16_000).fill(1.6e-4); // −76 dBFS 相当(実測で字になった側)
    const h2 = harness({ decode: vi.fn(async () => faint) });
    await h2.tr.run('a');
    expect(h2.deps.transcribe, '小さい声を切った(閾値が高すぎる)').toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **小さな雑音 + 同じ語のくり返し は出力ごと捨てる**(#1446)。対照群 = 同じ出力でも普通の声(RMS 1e-2 以上)なら足す。
   */
  it('🔴 小さな雑音に「you you you …」が出たら、足さずに言う / 普通の声の同じ出力は足す', async () => {
    const noise = new Float32Array(16_000).fill(3.9e-3); // −48 dBFS(ほぼ無音の足切りは越える)
    const repeat = vi.fn(async (): Promise<AsrJobResult> => ({ text: ' you you you you you ', loadMs: 0, runMs: 0 }));
    const h = harness({ decode: vi.fn(async () => noise), transcribe: repeat });
    await h.tr.run('a');
    expect(h.appends, '幻覚を足した').toEqual([]);
    expect(h.notes.at(-1)).toBe(
      '「録音-2026-09-12-143000.webm」からは字になりませんでした(小さな雑音だけで、同じ語のくり返ししか聞き取れませんでした)。ノートは変えていません',
    );
    const voice = new Float32Array(16_000).fill(0.05);
    const h2 = harness({ decode: vi.fn(async () => voice), transcribe: repeat });
    await h2.tr.run('a');
    expect(h2.appends.map((a) => a.text), '普通の声のくり返しまで捨てた').toEqual(['you you you you you']);
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

describe('走っている間はタブを閉じる確認に数える(onActive)', () => {
  it('🔴 走り出しで true、終わりで false(失敗でも閉じる / 断られた 2 本目では動かない)', async () => {
    const seen: boolean[] = [];
    let release: (r: AsrJobResult) => void = () => {};
    const h = harness({
      onActive: (a: boolean) => void seen.push(a),
      transcribe: vi.fn(
        () =>
          new Promise<AsrJobResult>((res) => {
            release = res;
          }),
      ),
    });
    const first = h.tr.run('a');
    await vi.waitFor(() => expect(h.deps.transcribe).toHaveBeenCalled());
    expect(seen, '走っているのに true が来ていない').toEqual([true]);
    await h.tr.run('a'); // 2 本目は断られる
    expect(seen, '断られた 2 本目が通知を動かした').toEqual([true]);
    release({ text: 'あ', loadMs: 0, runMs: 0 });
    await first;
    expect(seen).toEqual([true, false]);
    const seen2: boolean[] = [];
    const h2 = harness({
      onActive: (a: boolean) => void seen2.push(a),
      transcribe: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await h2.tr.run('a');
    expect(seen2).toEqual([true, false]);
  });
});

describe('🔴 小さな雑音のくり返しの判定は、ワーカーへ渡す前の音の大きさで行う', () => {
  const transferring = (text: string) =>
    vi.fn(async (job: AsrJob): Promise<AsrJobResult> => {
      // 本物(asr-client)と同じく pcm を transfer する ── 渡した側は長さ 0 になる
      structuredClone(job.pcm, { transfer: [job.pcm.buffer] });
      return { text, loadMs: 1, runMs: 2 };
    });

  it('大きな声の「テスト、テスト、…」は捨てない(transfer 後の長さ 0 で RMS が 0 に化けない)', async () => {
    const h = harness({
      decode: vi.fn(async () => new Float32Array(16000).fill(0.2)),
      transcribe: transferring('テスト、テスト、テスト、テスト、テスト、テスト'),
    });
    await h.tr.run('a');
    expect(h.appends, '大きな声なのに繰り返しとして捨てた').toHaveLength(1);
  });

  it('対照群:小さな雑音のくり返しは捨てる', async () => {
    const h = harness({
      decode: vi.fn(async () => new Float32Array(16000).fill(0.0015)),
      transcribe: transferring('テスト、テスト、テスト、テスト、テスト、テスト'),
    });
    await h.tr.run('a');
    expect(h.appends).toEqual([]);
    expect(h.notes.at(-1)).toMatch(/小さな雑音/);
  });
});

describe('🔴 預かった結果が書かれるまで、タブを閉じる確認に数える(onActive)', () => {
  const held = (seen: boolean[]) =>
    harness({ onActive: (a: boolean) => void seen.push(a) }, { writeLock: { lid: 'other' } } as Partial<AppState>);

  it('預かっている間は true のまま、書かれたら 1 回だけ false', async () => {
    const seen: boolean[] = [];
    const h = held(seen);
    await h.tr.run('a');
    expect(h.notes.at(-1), '前提: 預かっていない').toMatch(/まだ足していません/);
    expect(seen, '預かっているのに解いた(閉じると結果が黙って消える)').toEqual([true]);
    h.dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.appends).toHaveLength(1);
    expect(seen).toEqual([true, false]);
  });

  it('預かった書込が捨てられた(ノートが消えた)回も、1 回だけ解く', async () => {
    const seen: boolean[] = [];
    const h = held(seen);
    await h.tr.run('a');
    h.dispatcher.dispatch({ type: 'DELETE_ENTRY', lid: 'a' });
    h.dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.appends, '前提: 消えたノートへ足している').toEqual([]);
    expect(seen).toEqual([true, false]);
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
  it('🔴 文字にしている間にノートが消えたら、「足しました」と言わず、足していないと言う(#1087)', async () => {
    const ref: { d: Dispatcher | null } = { d: null };
    const h = harness({
      transcribe: vi.fn(async (): Promise<AsrJobResult> => {
        ref.d!.dispatch({ type: 'DELETE_ENTRY', lid: 'a' });
        return { text: 'こんにちは', loadMs: 1, runMs: 2 };
      }),
    });
    ref.d = h.dispatcher;
    await h.tr.run('a');
    expect(h.appends, '消えたノートへ足す依頼が出ている').toEqual([]);
    expect(h.notes.some((t) => t.includes('文字起こしを足しました')), '足していないのに「足しました」').toBe(false);
    expect(h.notes.at(-1)).toMatch(/ノートが見つからなかったので足していません/);
  });

  it('🔴 書込中(錠が立っている)は捨てずに預かり、そう言い、解けたら足す', async () => {
    const h = harness({}, { writeLock: { lid: 'other' } } as Partial<AppState>);
    await h.tr.run('a');
    expect(h.appends, '書けないのに足した').toEqual([]);
    expect(h.notes.at(-1)).toMatch(/まだ足していません/);
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
describe('「足しました」は、着いてから言う(#1087)', () => {
  it('🔴 受けた後に保存で落ちた回は、「足しました」と言わず、足せなかったと理由を言う', async () => {
    const h = harness();
    h.ackOn.fail = '保存先が一杯です';
    await h.tr.run('a');
    expect(h.appends, '前提が崩れている ── 書きに行っていない').toHaveLength(1);
    expect(h.notes.some((t) => t.includes('文字起こしを足しました')), '落ちたのに「足しました」').toBe(false);
    expect(h.notes.at(-1)).toMatch(/足せませんでした.*保存先が一杯です/);
  });

  it('対照群:着いた回は「足しました」を 1 回だけ言う', async () => {
    const h = harness();
    await h.tr.run('a');
    expect(h.notes.filter((t) => t.includes('文字起こしを足しました'))).toHaveLength(1);
  });
});

describe('進行中の字の後始末(#1017 C5)', () => {
  it.each([
    ['読めない音', { decode: vi.fn(async () => Promise.reject(new Error('EncodingError'))) }],
    ['音が入っていない', { decode: vi.fn(async () => new Float32Array(0)) }],
    ['ほぼ無音', { decode: vi.fn(async () => new Float32Array(16_000)) }],
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

/**
 * 🔴 **別のタブ・窓が編集中のノートへは、文字起こしを足さない**(#1087。追記・PDF の引用と同じ門)。
 * ⚠ reducer の赤い字は出ない経路なので、**ここで理由を言わないと黙って消える**。
 */
describe('別のタブ・窓が編集中のノート(#1087)', () => {
  it('🔴 断られたら、足さず、「足しました」とも言わず、理由を言う', async () => {
    const h = harness({ lock: { acquireEditLock: async () => 'denied' } });
    await h.tr.run('a');
    expect(h.appends, '別の窓が編集中なのに足した').toEqual([]);
    expect(h.notes.some((t) => t.includes('文字起こしを足しました')), '足していないのに「足しました」').toBe(false);
    expect(h.notes.at(-1)).toMatch(/別のタブまたはウィンドウで編集中なので足していません/);
  });

  it('⚠ 対照群 ── 錠が取れたら足す', async () => {
    const h = harness({ lock: { acquireEditLock: async () => 'granted', releaseEditLock: () => {} } });
    await h.tr.run('a');
    expect(h.appends).toHaveLength(1);
    expect(h.notes.at(-1)).toContain('文字起こしを足しました');
  });
});

/**
 * 🔴 **長い録音は、区切りながら文字にする**(台帳 #1852 束 O1 / 依頼 149。Gemini 回答 = 推薦どおり ③)。
 *
 * 直す前: 録音全体を 1 本の PCM にして、認識のワーカーへ一度に渡していた。数時間の録音では端末によってはタブが落ちる可能性があった。
 * ⚠ 区切る条件は test が小さい値を渡す(実際は 20 分を超えたら約 10 分ずつ ── 本物の 20 分の PCM を確保しない)。
 */
describe('長い録音の区切り(台帳 #1852 O1 / 依頼 149 ③)', () => {
  const SR = 16_000;
  /** 3.5 秒の PCM(区切りの目標 1 秒 / 2 秒を超えたら区切る)。 */
  const long = (): Float32Array => new Float32Array(Math.floor(SR * 3.5)).fill(0.1);
  const chunking = { afterSec: 2, chunkSec: 1, minTailSec: 0.2, searchSec: 0.1 };

  it('🔴 区切りの数だけ別々に渡し、時刻は録音の頭からの値に直し、1 回の文字起こしとして足す', async () => {
    const seen: number[] = [];
    const transcribe = vi.fn(async (job: AsrJob): Promise<AsrJobResult> => {
      seen.push(job.pcm.length);
      const n = seen.length;
      return {
        text: `区切り${String(n)}`,
        segments: [{ startMs: 500, endMs: 900, text: `区切り${String(n)}の声` }],
        loadMs: 1,
        runMs: 1,
      };
    });
    const h = harness({ decode: vi.fn(async () => long()), transcribe, chunking });
    await h.tr.run('a');
    expect(seen.length, '区切らずに 1 本で渡した').toBeGreaterThan(2);
    expect(seen.reduce((a, b) => a + b, 0), '区切りで音が欠けた / 重なった').toBe(long().length);
    expect(h.appends, '足すのは 1 回だけ').toHaveLength(1);
    const text = h.appends[0]!.text;
    // 各区切りの先頭は、前の区切りまでの長さぶん後ろへずれる(同じ時刻に重ならない)
    const stamps = text.split('\n').map((l) => l.split(' ')[0]!);
    expect(new Set(stamps).size, '区切りごとの時刻が同じのまま重なっている').toBe(stamps.length);
    expect(text).toContain('区切り1の声');
    expect(text).toContain(`区切り${String(seen.length)}の声`);
    // 進行中の字が「N / M」で進む
    expect(h.notes.some((t) => t.includes(`1 / ${String(seen.length)}`)), '区切りの進み具合を言っていない').toBe(true);
  });

  it('⚠ 対照群 ── 短い録音は今までどおり 1 本で渡す', async () => {
    const transcribe = vi.fn(async (): Promise<AsrJobResult> => ({ text: 'こんにちは', loadMs: 0, runMs: 0 }));
    const h = harness({ transcribe, chunking });
    await h.tr.run('a');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('🔴 途中の 1 本が落ちたら、全体を失敗にして何も足さない(半分だけを「足しました」と言わない)', async () => {
    let n = 0;
    const transcribe = vi.fn(async (): Promise<AsrJobResult> => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return { text: `区切り${String(n)}`, loadMs: 0, runMs: 0 };
    });
    const h = harness({ decode: vi.fn(async () => long()), transcribe, chunking });
    await h.tr.run('a');
    expect(h.appends).toEqual([]);
    expect(h.dispatcher.getState().error ?? '').toContain('文字にできませんでした');
  });

  it('時刻を返さない区切りが混じったら、時刻つきにせず字だけを足す(ずれた時刻を混ぜない)', async () => {
    let n = 0;
    const transcribe = vi.fn(async (): Promise<AsrJobResult> => {
      n += 1;
      return n === 1
        ? { text: '一', segments: [{ startMs: 0, endMs: 100, text: '一' }], loadMs: 0, runMs: 0 }
        : { text: `続き${String(n)}`, loadMs: 0, runMs: 0 };
    });
    const h = harness({ decode: vi.fn(async () => long()), transcribe, chunking });
    await h.tr.run('a');
    expect(h.appends).toHaveLength(1);
    expect(h.appends[0]!.text).not.toMatch(/^\d+:\d\d /m);
    expect(h.appends[0]!.text).toContain('続き2');
  });
});

/**
 * 🔴 **途中の長い無音は、認識に渡さず切り、時刻は元の録音へ戻す**(#1446 ①)。
 * 対照群: 無音の無い録音は PCM を変えない。
 */
describe('途中の長い無音の切り落とし(#1446)', () => {
  const RATE = 16_000;
  const tone = (sec: number, amp: number): Float32Array => {
    const a = new Float32Array(sec * RATE);
    for (let i = 0; i < a.length; i++) a[i] = i % 2 === 0 ? amp : -amp;
    return a;
  };
  const withGap = (): Float32Array => {
    const parts = [tone(3, 0.2), tone(20, 0), tone(3, 0.2)];
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  it('認識に渡す PCM は短くなり、後ろの声の時刻は元の録音の時刻(約 23 秒)へ戻る', async () => {
    const transcribe = vi.fn(async (job: AsrJob): Promise<AsrJobResult> => {
      void job;
      return {
        text: '前 後',
        segments: [
          { startMs: 0, endMs: 2000, text: '前' },
          { startMs: 4000, endMs: 6000, text: '後' }, // 切ったあとの録音で 4.0 秒 = 元では約 23 秒
        ],
        loadMs: 0,
        runMs: 0,
      };
    });
    const h = harness({ decode: vi.fn(async () => withGap()), transcribe });
    await h.tr.run('a');
    const sent = transcribe.mock.calls[0]![0].pcm.length;
    expect(sent, '無音を切っていない').toBeLessThan(11 * RATE);
    expect(h.appends[0]!.text).toMatch(/^0:00 〜0:02 前$/m);
    expect(h.appends[0]!.text).toMatch(/^0:2[2-4] 〜0:2[4-6] 後$/m);
    expect(h.notes.at(-1)).toContain('途中の長い無音');
  });

  it('対照群:無音の無い録音は PCM をそのまま渡し、無音の知らせも出ない', async () => {
    const pcm = tone(10, 0.2);
    const transcribe = vi.fn(async (job: AsrJob): Promise<AsrJobResult> => {
      void job;
      return { text: 'こんにちは', loadMs: 0, runMs: 0 };
    });
    const h = harness({ decode: vi.fn(async () => pcm), transcribe });
    await h.tr.run('a');
    expect(transcribe.mock.calls[0]![0].pcm.length).toBe(10 * RATE);
    expect(h.notes.at(-1)).not.toContain('途中の長い無音');
  });
});

/**
 * 🔴 レビュー指摘: gpu は fp16 の重みがあるときだけ / 実際の実行器を言う / 暴走の除去は小さな入力だけ / 終わりの時刻の変換。
 */
describe('高精度(gpu)・暴走の除去・終わりの時刻(レビュー指摘)', () => {
  const turbo = ASR_PARTS[2]!;
  const readyWith = (keys: string[]): AsrReady => ({ part: turbo, files: new Map(keys.map((k) => [k, new Blob(['x'])] as const)) });
  const FP16 = 'models/openai/whisper-large-v3-turbo/onnx/encoder_model_fp16.onnx';
  const JSEP = ['runtime/ort-wasm-jsep.mjs', 'runtime/ort-wasm-jsep.wasm'];
  const Q8 = 'models/openai/whisper-large-v3-turbo/onnx/encoder_model_quantized.onnx';
  const jobs: AsrJob[] = [];
  const echo = (device?: 'webgpu' | 'wasm') =>
    vi.fn(async (job: AsrJob): Promise<AsrJobResult> => {
      jobs.push(job);
      return { text: 'ok', loadMs: 0, runMs: 0, ...(device === undefined ? {} : { device }) };
    });

  it('🔴 fp16 の重みがあるときだけ gpu で渡す。無ければ gpu を付けない(毎回 1 度失敗させない)', async () => {
    jobs.length = 0;
    const a = harness({ ready: vi.fn(async () => readyWith([FP16, Q8, ...JSEP])), transcribe: echo('webgpu') });
    await a.tr.run('a');
    expect(jobs[0]!.gpu).toBe(true);
    const b = harness({ ready: vi.fn(async () => readyWith([Q8])), transcribe: echo('wasm') });
    await b.tr.run('a');
    expect(jobs[1]!.gpu, 'fp16 が無いのに gpu で渡した').toBeUndefined();
    expect(b.notes.at(-1), 'gpu でないのに実行器を言った').not.toContain('WebGPU');
    // 🔴 fp16 があっても、実行の部品が WebGPU 非対応(JSEP 版なし)なら gpu で渡さない
    const c = harness({ ready: vi.fn(async () => readyWith([FP16, Q8])), transcribe: echo('wasm') });
    await c.tr.run('a');
    expect(jobs[2]!.gpu, '実行の部品が非対応なのに gpu で渡した').toBeUndefined();
  });

  it('🔴 終わりの知らせに実際の実行器を言う(WebGPU / CPU に戻った)', async () => {
    const on = harness({ ready: vi.fn(async () => readyWith([FP16, ...JSEP])), transcribe: echo('webgpu') });
    await on.tr.run('a');
    expect(on.notes.at(-1)).toContain('WebGPU で実行しました');
    const back = harness({ ready: vi.fn(async () => readyWith([FP16, ...JSEP])), transcribe: echo('wasm') });
    await back.tr.run('a');
    expect(back.notes.at(-1)).toContain('WebGPU を使えなかったため CPU で実行しました');
  });

  const LOOP = 'la '.repeat(30);
  const quietPcm = (): Float32Array => new Float32Array(16_000).fill(0.005); // RMS 5e-3 < 1e-2
  const loudPcm = (): Float32Array => new Float32Array(16_000).fill(0.2);

  it('🔴 暴走の除去は小さな入力のときだけ: 小さい→畳む / 通常の音量→「la la …」はそのまま残る', async () => {
    const out = (text: string) => vi.fn(async (): Promise<AsrJobResult> => ({ text: `前 ${text} 後`, loadMs: 0, runMs: 0 }));
    const quiet = harness({ decode: vi.fn(async () => quietPcm()), transcribe: out(`あ${'ああ'.repeat(30)}`) });
    await quiet.tr.run('a');
    expect(quiet.appends[0]?.text, '小さな入力で畳まれていない').toBe('前 あああ 後');
    const loud = harness({ decode: vi.fn(async () => loudPcm()), transcribe: out(LOOP.trim()) });
    await loud.tr.run('a');
    expect(loud.appends[0]?.text, '通常の音量なのに畳んだ').toBe(`前 ${LOOP.trim()} 後`);
  });

  it('🔴 通常の音量の同じ内容の行 6 連打(はい)は、そのまま残る', async () => {
    const segs = Array.from({ length: 6 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 500, text: 'はい' }));
    const h = harness({ decode: vi.fn(async () => loudPcm()), transcribe: vi.fn(async (): Promise<AsrJobResult> => ({ text: 'はい', segments: segs, loadMs: 0, runMs: 0 })) });
    await h.tr.run('a');
    expect(h.appends[0]!.text.split('\n')).toHaveLength(6);
  });

  it('🔴 切った無音をまたぐ区間の終わりは、前の範囲の末尾へ寄る(無音を丸ごとまたいで長く見えない)', async () => {
    const RATE = 16_000;
    const tone = (sec: number, amp: number): Float32Array => {
      const a = new Float32Array(sec * RATE);
      for (let i = 0; i < a.length; i++) a[i] = i % 2 === 0 ? amp : -amp;
      return a;
    };
    const parts = [tone(3, 0.2), tone(20, 0), tone(3, 0.2)];
    const pcm = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) {
      pcm.set(p, at);
      at += p.length;
    }
    // 切ったあとの録音で 0 〜 3.5 秒(前の範囲の末尾 = 切り目)の区間
    const h = harness({
      decode: vi.fn(async () => pcm),
      transcribe: vi.fn(async (): Promise<AsrJobResult> => ({ text: '前', segments: [{ startMs: 0, endMs: 3500, text: '前' }], loadMs: 0, runMs: 0 })),
    });
    await h.tr.run('a');
    expect(h.appends[0]!.text).toMatch(/^0:00 〜0:03 前$/m); // 3.5 秒(0:03)。次の範囲の頭(23.5 秒 = 0:23)へは飛ばない
  });
});
