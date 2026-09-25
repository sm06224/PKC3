/** @vitest-environment happy-dom */
/**
 * 🔴 **音の切り出しの段取り**(#683 段②a。user 裁定 2026-09-14)。
 *
 * ⚠ 見るのは **user がどう受け取るか**:
 *   ①**元は残る**(裁定)②**黙って終わらない**(切り出せない形・中身が消えている・
 *   保存できない、どれも理由が出る)③**2 本同時に走らない**
 *   ④**成功したら印が消える**(同じ範囲をもう一度押して 2 つ作らせない)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createCaptureTrimmer } from '../../src/adapter/ui/actions/capture-trim';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import type { AudioTrimResult } from '../../src/adapter/platform/audio/audio-codec';
import type { AttachItem } from '../../src/adapter/ui/actions/attach';

const body = (name: string, mime: string): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 2048', 'attachment.asset_key: k-1', '---', ''].join('\n');

const ITEMS = (mime = 'audio/webm'): AppState['captureItems'] =>
  captureItemsFrom([{ lid: 'a', title: 'a', body: body('録音-2026-09-12-143000.webm', mime) }]);

/** 目録の 1 行(添付)。⚠ 中身は見ないので最小で足りる。 */
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

const cut = (): AudioTrimResult => ({
  ok: true,
  bytes: new Uint8Array([1, 2, 3, 4]).buffer,
  keptPackets: 20,
  codecDelayNs: 160_000_000,
  discardPaddingNs: 40_000_000,
  durationMs: 53_000,
  sourceBytes: 38_456,
});

function harness(
  over: Partial<Parameters<typeof createCaptureTrimmer>[0]> = {},
  stateOver: Partial<AppState> = {},
) {
  /**
   * ⚠ **`phase` を `ready` にしておく** ── 既定は `initializing` で、そこでは
   *   `CREATE_ENTRY` が**黙って捨てられる**(= 段取りが「編集を終えてから」と断る)。
   * 🔑 台が本物と違う状態を再現していると、**守っている物が別物になる**(§1)。
   */
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    // ⚠ **目録にも居させる** ── 居ないと `SELECT_ENTRY` も `START_EDIT` も黙って捨てられ、
    //   「選択を返す」「編集中は断る」を見る test が**前提ごと空振り**する
    entryMetas: new Map([['a', meta('a')]]),
    captureItems: ITEMS(),
    ...stateOver,
  } as AppState);
  const attached: AttachItem[] = [];
  const notes: string[] = [];
  const deps = {
    dispatcher,
    readBlob: vi.fn(async () => new Blob([new Uint8Array(16)], { type: 'audio/webm' })),
    trim: vi.fn(async () => cut()),
    attach: vi.fn(async (item: AttachItem) => {
      attached.push(item);
      return { lid: 'new', assetKey: 'k-2', mime: item.type, hash: 'h' };
    }),
    notify: (t: string) => void notes.push(t),
    ...over,
  };
  return { dispatcher, deps, attached, notes, trimmer: createCaptureTrimmer(deps) };
}

const error = (d: Dispatcher): string | null => d.getState().error;

describe('切り出す(成功する道)', () => {
  it('🔴 新しい添付が 1 件できる ── 名前は元 + 範囲、形は元のまま', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.attached).toHaveLength(1);
    expect(h.attached[0]!.name).toBe('録音-2026-09-12-143000 (0:12〜1:05).webm');
    // 🔑 **元と同じ形**(裁定)── 入れ物も codec も変えないので mime も変えない
    expect(h.attached[0]!.type).toBe('audio/webm');
    expect(h.attached[0]!.size).toBe(4);
    expect(error(h.dispatcher), '成功したのに理由が出ている').toBeNull();
  });

  it('🔴 元は触らない(消しにも書きにも行かない)', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_000, 65_000);
    // ⚠ 元のノートは一覧に残ったまま
    expect(h.dispatcher.getState().captureItems?.map((i) => i.lid)).toEqual(['a']);
    // ⚠ 読んだのは 1 回だけ(書き戻す口を呼んでいない)
    expect(h.deps.readBlob).toHaveBeenCalledTimes(1);
    expect(h.deps.readBlob).toHaveBeenCalledWith('k-1');
  });

  it('🔴 済んだら印が消える(同じ範囲で 2 つ作らせない)', async () => {
    const h = harness();
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: 'a' });
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 12_000 });
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: 65_000 });
    expect(h.dispatcher.getState().captureTrim).not.toBeNull();
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.dispatcher.getState().captureTrim, '印が残っている').toBeNull();
  });

  it('⚠ 走っている間も、終わりも、声に出す', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.notes[0]).toContain('切り出しています');
    expect(h.notes[1]).toContain('切り出しました');
    expect(h.notes[1]).toContain('(0:53)');
  });

  it('🔴 範囲はそのままワーカーへ渡る(丸めていない)', async () => {
    const h = harness();
    await h.trimmer.run('a', 12_345, 65_678);
    expect(h.deps.trim).toHaveBeenCalledWith(expect.any(Blob), 12_345, 65_678);
  });
});

describe('断る道 ── どれも黙って終わらない', () => {
  it('🔴 切り出せない形なら、その理由が出る', async () => {
    const h = harness({ trim: vi.fn(async () => ({ ok: false as const, reason: 'lacing' as const })) });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toBe('この録音は切り出しに対応していない詰め方です。');
    expect(h.deps.attach, '断ったのに添付を作っている').not.toHaveBeenCalled();
  });

  it('🔴 中身が消えていたら、そう言う', async () => {
    const h = harness({ readBlob: vi.fn(async () => null) });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('中身が見つかりません');
  });

  it('🔴 保存できなかったら、そう言う(黙って消さない)', async () => {
    const h = harness({ attach: vi.fn(async () => null) });
    // 🔴 **印を先に付ける** ── 付けずに「印が消えていない」を見ると、
    //   もともと `null` なので**消しても消さなくても緑**になる(§1 空振り)
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: 'a' });
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 0 });
    h.dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'end', ms: 1000 });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('保存できませんでした');
    expect(
      h.dispatcher.getState().captureTrim,
      '失敗したのに印を消している ── やり直せなくなる',
    ).toEqual({ lid: 'a', startMs: 0, endMs: 1000 });
  });

  it('🔴 居ない録音を指されたら、そう言う', async () => {
    const h = harness();
    await h.trimmer.run('zzz', 0, 1000);
    expect(error(h.dispatcher)).toContain('見つかりませんでした');
  });

  it('🔴 範囲が決まっていなければ、決めろと言う', async () => {
    const h = harness();
    await h.trimmer.run('a', 1000, 1000);
    expect(error(h.dispatcher)).toContain('ここを始まりにする');
    expect(h.deps.trim).not.toHaveBeenCalled();
  });

  it('🔴 途中で例外が飛んでも、黙らない', async () => {
    const h = harness({
      trim: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('切り出せませんでした');
  });

  /**
   * 🔴 **2 本同時に走らせない** ── 12 時間の録音を 2 本ほどくと箱が詰まる。
   * ⚠ そして**2 本目は断る**(黙って無視すると、押したのに何も起きないのと同じ)。
   */
  it('🔴 走っている最中の 2 本目は断る', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      trim: vi.fn(async () => {
        await gate;
        return cut();
      }),
    });
    const first = h.trimmer.run('a', 0, 1000);
    expect(h.trimmer.busy).toBe(true);
    await h.trimmer.run('a', 0, 1000);
    expect(error(h.dispatcher)).toContain('待ってください');
    release();
    await first;
    expect(h.trimmer.busy, '終わったのに錠が残っている').toBe(false);
  });

  /** 🔴 **1 度失敗しただけで、以後ずっと断るようにならない**(`finally` が効いている)。 */
  it('🔴 失敗した後も、次は走る', async () => {
    let fail = true;
    const h = harness({
      trim: vi.fn(async () => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return cut();
      }),
    });
    await h.trimmer.run('a', 0, 1000);
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.attached, '2 回目が走っていない').toHaveLength(1);
  });
});

/**
 * 🔴 **着地前レビューが出した 4 件**(2026-09-14)。
 * ⚠ どれも「切り出し自体は成功しているのに、**画面がそう見えない**」型である。
 */
describe('レビューで出た 4 件(#683 段②a)', () => {
  it('🔴 さっきまで見ていたノートを退かさない(#300 / #666 と同じ)', async () => {
    const h = harness();
    h.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(h.dispatcher.getState().selectedLid, '前提が崩れている').toBe('a');
    await h.trimmer.run('a', 12_000, 65_000);
    // ⚠ `CREATE_ENTRY` は選択を**作った添付へ移す**ので、返さないと中央が化ける
    expect(
      h.dispatcher.getState().selectedLid,
      '切り出したら、読んでいたノートが画面から消えた',
    ).toBe('a');
  });

  it('🔴 何も開いていなかったなら、何も開いていない所へ返す', async () => {
    const h = harness();
    expect(h.dispatcher.getState().selectedLid, '前提が崩れている').toBeNull();
    await h.trimmer.run('a', 12_000, 65_000);
    expect(
      h.dispatcher.getState().selectedLid,
      '何も開いていなかったのに、切り出したものが中央に出た',
    ).toBeNull();
  });

  /**
   * 🔴 **一覧を集め直す** ── この面は**タブを開いた瞬間に 1 度**集めるだけなので、
   *   頼まないと**切り出したものが一覧に出ない**(実ブラウザ smoke が拾った)。
   */
  it('🔴 切り出したら、一覧を集め直す', async () => {
    const h = harness();
    const events: string[] = [];
    h.dispatcher.onEvent((e) => void events.push(e.type));
    await h.trimmer.run('a', 12_000, 65_000);
    expect(events, '一覧を集め直していない ── 押したのに何も起きなく見える').toContain(
      'REQUEST_CAPTURE_ITEMS',
    );
  });

  it('⚠ 失敗した回は集め直さない(空振り防止 ── いつでも撃っていないこと)', async () => {
    const h = harness({ attach: vi.fn(async () => null) });
    const events: string[] = [];
    h.dispatcher.onEvent((e) => void events.push(e.type));
    await h.trimmer.run('a', 0, 1000);
    expect(events).not.toContain('REQUEST_CAPTURE_ITEMS');
  });

  /**
   * 🔴 **編集している最中は、原因を言う** ── `CREATE_ENTRY` は `phase !== 'ready'` を
   *   **黙って捨てる**ので、直す前は必ず「保存できませんでした」になっていた。
   *   ⚠ その字は「録音の処理が壊れた」と読めるので、user は原因に気づけない。
   */
  it('🔴 編集中は「編集を終えてから」と言い、重い仕事を始めない', async () => {
    // ⚠ 編集の入り方は `START_EDIT` の前提(`openBody`)が要るので、**状態で置く**
    const h = harness({}, { phase: 'editing' });
    expect(h.dispatcher.getState().phase, '前提が崩れている').toBe('editing');
    await h.trimmer.run('a', 12_000, 65_000);
    // ⚠ **「編集中」と言い切らない** ── 同じ門は追記の短い錠でも閉じる(レビュー 2-A)
    expect(error(h.dispatcher)).toContain('編集を終えるか少し待って');
    expect(error(h.dispatcher), 'やり直せることを言っていない').toContain('選んだ範囲は残しています');
    // 🔑 **切る前に断る** ── 数秒かけて切ってから捨てない
    expect(h.deps.trim, '編集中なのに切り始めている').not.toHaveBeenCalled();
  });

  it('🔴 編集を終えれば、同じ印のまま切り出せる(やり直せる)', async () => {
    // ⚠ `CANCEL_EDIT` で本当に抜けられる形にする(`openBody` が要る)
    const h = harness(
      {},
      {
        phase: 'editing',
        selectedLid: 'a',
        openBody: { lid: 'a', body: '本文', baseline: '本文', persisted: '本文', diskAhead: false },
      } as Partial<AppState>,
    );
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.attached, '編集中なのに作っている').toHaveLength(0);
    h.dispatcher.dispatch({ type: 'CANCEL_EDIT' });
    expect(h.dispatcher.getState().phase, '編集から戻れていない').toBe('ready');
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.attached, '編集を終えても切り出せない').toHaveLength(1);
  });

  /** 🔴 **走っている間は画面に出す**(押した所が語らないと「効かなかった」と読まれる)。 */
  it('🔴 走っている間だけ busy が立ち、終わったら必ず下りる', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      trim: vi.fn(async () => {
        await gate;
        return cut();
      }),
    });
    expect(h.dispatcher.getState().captureTrimBusy).toBe(false);
    const first = h.trimmer.run('a', 0, 1000);
    expect(h.dispatcher.getState().captureTrimBusy, '走っているのに画面へ出していない').toBe(true);
    release();
    await first;
    expect(h.dispatcher.getState().captureTrimBusy, '終わったのに出たまま').toBe(false);
  });

  /**
   * 🔴 **`attachOne` が先に置いた理由を消さない**(着地前レビュー 1-A)。
   *
   * ⚠ 台が本物より甘いと、この穴は見えない ── 本物の `attachOne` は空き容量不足で
   *   **自分で `OP_FAILED` を撃ってから** `null` を返す。⚠ 台がそれを真似ていないと、
   *   「汎用の字で塗り潰す」実装でも緑になる(CLAUDE.md §3「stub は本物の意味論を真似る」)。
   */
  it('🔴 保存の具体的な理由が出ていたら、汎用の字で塗り潰さない', async () => {
    const h = harness({
      attach: vi.fn(async () => {
        // ⚠ 本物と同じ順番 ── 理由を撃ってから null を返す
        hRef.dispatcher.dispatch({
          type: 'OP_FAILED',
          error: '添付を保存する空き容量が不足しています: 録音.webm',
        });
        return null;
      }),
    });
    const hRef = h;
    await h.trimmer.run('a', 12_000, 65_000);
    expect(error(h.dispatcher), '具体的な理由が汎用の字に塗り潰された').toContain('空き容量');
  });

  it('⚠ 対照群 ── 理由が出ていなければ、こちらが言う', async () => {
    const h = harness({ attach: vi.fn(async () => null) });
    await h.trimmer.run('a', 12_000, 65_000);
    expect(error(h.dispatcher)).toContain('保存できませんでした');
  });

  /**
   * 🔴 **`;codecs=opus` を落とす**(着地前レビュー 2-B)── 引数のまま持ち回ると、
   *   拡張子の逆引きに当たらず**書き出しの名前が `.bin` になる**(#205 と同じ形)。
   */
  it('🔴 mime の引数は落としてから添付にする', async () => {
    const h = harness();
    h.dispatcher.dispatch({
      type: 'SET_CAPTURE_ITEMS',
      items: captureItemsFrom([
        {
          lid: 'a',
          title: 'a',
          body: body('録音.webm', 'audio/webm;codecs=opus'),
        },
      ]),
    });
    await h.trimmer.run('a', 12_000, 65_000);
    expect(h.attached[0]!.type, '引数が付いたまま次の添付へ伝わっている').toBe('audio/webm');
    expect(h.attached[0]!.blob.type).toBe('audio/webm');
  });

  it('🔴 失敗しても busy は下りる(押せなくなったままにしない)', async () => {
    const h = harness({
      trim: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await h.trimmer.run('a', 0, 1000);
    expect(h.dispatcher.getState().captureTrimBusy).toBe(false);
  });
});
