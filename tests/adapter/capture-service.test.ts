/** @vitest-environment happy-dom */
/**
 * 🔴 **録音・画面収録の段取り**(#413)。
 *
 * ## user の物語
 *
 * 会議メモを書いている → 「録音」を押す → 話す → 「止める」→
 * **さっきまで書いていたノートに音が入っている**。
 *
 * ## この test が守る主張
 *
 * ① 🔴 **開いていたノートへ参照が入る**(添付だけ増えて迷子にならない)
 * ② 🔴 **選択が戻る** ── 添付を作ると `CREATE_ENTRY` が選択を奪うので、
 *    戻さないと「止めたら別の物が開いている」になる
 *    (user 指示 2026-08-22「さっきまでやっていたことが消える」)
 * ③ 🔴 **入れられない回は黙らない**(ノート未選択 / 追記できない種類 / 書けない)
 *    ── ⚠ どの回も**収録は残っている**ので、そこまで言い切る
 * ④ 🔴 **同時に 1 本だけ** / 権限拒否は理由が出る
 * ⑤ 🔴 **捨てたら何も残らない**(添付にも本文にも触らない)
 * ⑥ 🔴 **帯は収録中だけ出て、止めたら畳まれる**(「録り続けている」に見せない)
 *
 * ⚠ 添付の口(`attach`)は**本物の意味論を真似る** ── 実物の `attachOne` は
 *   `CREATE_ENTRY` を撃つので、fake も撃つ。撃たない fake にすると
 *   **②の経路が 1 度も走らない**(CLAUDE.md §3「stub を本物より甘くしない」)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  createCaptureService,
  type CaptureServiceDeps,
} from '../../src/adapter/ui/actions/capture';
import {
  CaptureRefused,
  type CaptureEnd,
  type CaptureHandle,
  type CaptureKind,
} from '../../src/adapter/platform/media-capture';

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/**
 * 手で動かせる収録。⚠ 終わり方(`onEnd`)は**実物と同じ 5 値**を撃てる形にする。
 * 🔴 **切れた 1 本(`onPart`)も撃てる**(#771)── 撃てない fake にすると、
 *   「分かれた回にどう見えるか」を**この層では 1 度も通らない**ことになる。
 */
function fakeCapture(
  kind: CaptureKind,
  onEnd: (r: CaptureEnd) => void,
  onPart: ((b: Blob, n: number) => void) | undefined,
  blob: Blob | null,
) {
  let bytes = 0;
  let ms = 0;
  let stopped = 0;
  let discarded = 0;
  /** 🔑 実物と同じ ── **渡し終えた本数**(いま録っている 1 本は含まない)。 */
  let parts = 0;
  /**
   * 🔴 **終わりの合図は 1 回だけ**(実物の `finish` と同じ ── §3「stub を本物より
   *   甘くしない」)。⚠ 1 稿目は `stop()` が `onEnd` を**撃たなかった**ので、
   *   「止めたら `onEnd('stopped')` が返ってきて、受け側が二重に片付けかける」
   *   という**実物にだけ在る場面**が 1 度も通っていなかった(変異試験 D5)。
   */
  let ended = false;
  const finishOnce = (r: CaptureEnd): void => {
    if (ended) return;
    ended = true;
    onEnd(r);
  };
  const handle: CaptureHandle = {
    kind,
    bytes: () => bytes,
    parts: () => parts,
    elapsedMs: () => ms,
    stop: () => {
      stopped += 1;
      finishOnce('stopped');
      return Promise.resolve(blob);
    },
    discard: () => {
      discarded += 1;
      finishOnce('discarded');
    },
  };
  return {
    handle,
    grow: (n: number) => (bytes += n),
    advance: (n: number) => (ms += n),
    end: (r: CaptureEnd) => finishOnce(r),
    /** 1 本切れた。⚠ **本数も進める**(実物と同じ ── 進めないと名前の連番がずれる)。 */
    cut: (b: Blob) => {
      parts += 1;
      onPart?.(b, parts);
    },
    stops: () => stopped,
    discards: () => discarded,
  };
}

interface Bench {
  readonly d: Dispatcher;
  readonly events: DomainEvent[];
  readonly notices: string[];
  readonly lines: Array<string | null>;
  readonly attached: Array<{ name: string; type: string; size: number }>;
  readonly service: ReturnType<typeof createCaptureService>;
  /** 1 秒の刻みを**手で撃つ**(`setInterval` を待たない)。 */
  beat(): void;
  live(): ReturnType<typeof fakeCapture> | null;
  /** 握った添付の口を放す。 */
  release(): void;
  /** いま張っている見張りの本数。 */
  subs(): number;
}

function bench(
  opts: {
    archetype?: string;
    select?: boolean;
    blob?: Blob | null;
    refuse?: string;
    /** 添付が作れなかった(空き不足など)。 */
    attachFails?: boolean;
    /** 添付の口を**握る**(片付けの最中を観測するため)。 */
    holdAttach?: boolean;
    /** 書込の ack を返さない(`writeLock` が立ったままの状態を作る)。 */
    keepLock?: boolean;
    /**
     * 🔴 **動く時計**(#771)。⚠ 止まった時計では「**始めた時刻で名乗る**」を
     *   確かめられない(取り込む時刻で名乗っても同じ字が出る ── 変異試験 C6)。
     */
    clock?: { at: Date };
  } = {},
): Bench {
  const d = new Dispatcher();
  /**
   * ⚠ **見張りの本数を数える** ── 「外した」は state からは見えない。
   *   数えないと、外し忘れ(全 dispatch を通る常駐)が**誰にも見えない**。
   */
  let subs = 0;
  const realOnState = d.onState.bind(d);
  (d as unknown as { onState: Dispatcher['onState'] }).onState = (l) => {
    subs += 1;
    const off = realOnState(l);
    return () => {
      subs -= 1;
      off();
    };
  };
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', opts.archetype ?? 'text')],
    relations: [],
  });
  if (opts.select !== false) d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  /**
   * ⚠ **書込が着いたことにする**(`stub は本物の意味論を真似る` ── §3)。
   *   実物では effect 層が `ENTRY_APPENDED` を返して **`writeLock` が解ける**。
   *   返さない fake にすると、2 本目の追記も編集の再開も**永久に断られる**
   *   ── それは製品の話ではなく、この台の話である。
   */
  d.onEvent((e) => {
    if (e.type !== 'REQUEST_APPEND' || opts.keepLock === true) return;
    const { lid, gen } = e;
    queueMicrotask(() =>
      d.dispatch({
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
  const notices: string[] = [];
  const lines: Array<string | null> = [];
  const attached: Array<{ name: string; type: string; size: number }> = [];
  let beats: Array<() => void> = [];
  let live: ReturnType<typeof fakeCapture> | null = null;

  let releaseAttach: (() => void) | null = null;
  const deps: CaptureServiceDeps = {
    dispatcher: d,
    attach: async (item) => {
      attached.push({ name: item.name, type: item.type, size: item.size });
      if (opts.holdAttach === true) {
        await new Promise<void>((r) => {
          releaseAttach = r;
        });
      }
      if (opts.attachFails === true) return null;
      const lid = 'att' + String(attached.length);
      // ⚠ **本物と同じ**(選択を奪う)── 奪わない fake にすると②が空振りする
      d.dispatch({
        type: 'CREATE_ENTRY',
        archetype: 'attachment',
        lid,
        title: item.name,
        body: `# ${item.name}\n`,
        edit: false,
      });
      /**
       * 🔴 **本物より甘くしない**(CLAUDE.md §3)。実物の `attachOne` は
       *   `CREATE_ENTRY` の**あとで `entryMetas` を見て**、作れていなければ
       *   `null` を返す ── reducer は `phase !== 'ready'` を黙って捨てるので、
       *   **編集中は必ず `null`** である。⚠ 1 稿目の fake はここを見ておらず、
       *   「編集中に収録が終わると全部消える」という穴を隠していた。
       */
      if (!d.getState().entryMetas.has(lid)) return null;
      return { lid, assetKey: 'ast-k' + String(attached.length), mime: item.type, hash: null };
    },
    onChange: (line) => lines.push(line),
    notify: (t) => notices.push(t),
    now: () => opts.clock?.at ?? new Date(2026, 7, 27, 3, 1, 2),
    tick: (fn) => {
      beats.push(fn);
      return () => {
        beats = beats.filter((f) => f !== fn);
      };
    },
    start: (kind, _capture, o) => {
      if (opts.refuse !== undefined) return Promise.reject(new CaptureRefused(opts.refuse));
      live = fakeCapture(
        kind,
        o.onEnd ?? (() => {}),
        o.onPart,
        opts.blob === undefined ? new Blob(['xy']) : opts.blob,
      );
      return Promise.resolve(live.handle);
    },
  };
  return {
    d,
    events,
    notices,
    lines,
    attached,
    service: createCaptureService(deps),
    beat: () => beats.forEach((f) => f()),
    live: () => live,
    release: () => releaseAttach?.(),
    subs: () => subs,
  };
}

const appends = (events: DomainEvent[]): Array<{ lid: string; text: string }> =>
  events.flatMap((e) => (e.type === 'REQUEST_APPEND' ? [{ lid: e.lid, text: e.text }] : []));

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

describe('録音を止めると、開いていたノートに入る(#413)', () => {
  it('🔴 ① 参照が本文へ入る / ② 選択が戻る', async () => {
    const b = bench();
    await b.service.start('audio');
    b.service.stop();
    await tick();

    // ① **その参照が入っている**(名前と鍵の両方 ── 片方だけだと取り違えを見逃す)
    expect(appends(b.events), '本文へ入っていない').toEqual([
      { lid: 'a', text: '[録音-2026-08-27-030102.webm](asset:ast-k1)' },
    ]);
    // ② 🔴 **本丸** ── 添付が奪った選択が戻っている
    expect(b.d.getState().selectedLid, '止めたら別の物が開いている').toBe('a');
    expect(b.notices.some((n) => n.includes('本文のいちばん下に入れました')), '入れたことを言っていない').toBe(true);
  });

  it('⚠ 添付にも渡している(名前・種類・大きさ)', async () => {
    const b = bench({ blob: new Blob(['abcde'], { type: 'audio/webm;codecs=opus' }) });
    await b.service.start('audio');
    b.service.stop();
    await tick();
    // 🔴 **`;codecs=opus` を落としている** ── 付いたままだと拡張子の逆引きに
    //    当たらず、書き出しの名前が `.bin` になる(#205 と同じ形)
    expect(b.attached).toEqual([
      { name: '録音-2026-08-27-030102.webm', type: 'audio/webm', size: 5 },
    ]);
  });

  it('🔴 ⑥ 帯は収録中だけ出て、止めたら畳まれる', async () => {
    const b = bench();
    await b.service.start('audio');
    expect(b.service.line(), '押しても帯が出ない').toMatch(/^録音中 0:00/);
    b.live()!.advance(65_000);
    b.live()!.grow(2048);
    b.beat();
    expect(b.lines.at(-1), '1 秒ごとに書き替わっていない').toBe(
      '録音中 1:05(約 2.0 KB・残り 11:58:55)',
    );
    b.service.stop();
    await tick();
    expect(b.service.line(), '止めたのに帯が残っている').toBeNull();
    expect(b.lines.at(-1), '帯を畳んでいない').toBeNull();
    // ⚠ **刻みを外している**(収録していない間も 1 秒ごとに描き直さない)
    const before = b.lines.length;
    b.beat();
    expect(b.lines.length, '止めたのに刻みが生きている').toBe(before);
  });

  it('🔴 帯は「押した時」に畳む ── 添付を書き終わるのを待たない', async () => {
    /**
     * ⚠ 添付の口を**握って**、片付けの途中を観測する。
     * 🔴 収録が長いほど添付の書込は長い ── そこまで帯を出したままにすると、
     *   user は**まだ録っている**と読む(止めたのに止まっていないように見える)。
     */
    const b = bench({ holdAttach: true });
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(b.attached.length, '片付けに入っていない(前提が崩れている)').toBe(1);
    expect(b.service.line(), '添付を書き終わるまで帯が出たままになっている').toBeNull();
    expect(b.lines.at(-1), '帯を畳んでいない').toBeNull();
    // ⚠ **対照群** ── 放せば片付けは最後まで進む(畳んだせいで止まっていない)
    b.release();
    await tick();
    expect(appends(b.events).length, '片付けが終わっていない').toBe(1);
  });
});

describe('🔴 ③ 入れられない回は黙らない(#413)', () => {
  it('ノートを開いていないとき', async () => {
    const b = bench({ select: false });
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(appends(b.events), '開いていないのに本文を書いた').toEqual([]);
    expect(b.notices.join(''), '理由を言っていない').toMatch(/ノートを開いていない/);
    // ⚠ **収録は残っている**(添付にはなっている)
    expect(b.attached.length, '収録ごと捨てた').toBe(1);
  });

  it('追記できない種類を開いているとき', async () => {
    const b = bench({ archetype: 'attachment' });
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(appends(b.events), '追記できない種類の本文を書いた').toEqual([]);
    // ⚠ #668 A で字が変わった ── 開いている物の種類を名指し、何なら入るかを言う
    expect(b.notices.join(''), '理由を言っていない').toMatch(/『添付』なので、本文には入れていません/);
    expect(b.attached.length, '収録ごと捨てた').toBe(1);
  });

  /**
   * 🔴 **書込が飛んでいる間は「預かる」。捨てない。**
   *
   * ⚠ 直す前はここで**捨てて**いた ── 添付だけ残り、本文には永久に入らない。
   *   `writeLock` は**一瞬しか立たない**(effect 層が `ENTRY_APPENDED` を返せば解ける)
   *   ので、**数ミリ秒待てば書ける物を捨てて**いたことになる。
   *
   * ⚠ **この test は 1 稿目では捨てても預かっても通っていた** ── 台が
   *   `keepLock: true` で**錠を永久に握る**ので、どちらでも「追記は飛ばない」
   *   「理由を言う」が成り立つ。🔑 だから**錠を解いて、入ることまで見る**
   *   (CLAUDE.md §1「空振りを直したら、今度は何に救われていないかを問う」)。
   */
  it('🔴 書込が飛んでいる間は預かり、書けるようになったら入る', async () => {
    const b = bench({ keepLock: true });
    await b.service.start('audio');
    // ⚠ 追記を 1 本撃つと `writeLock` が立つ(台が ack を返さないので解けない)
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '先の追記', heading: null, target: null });
    expect(b.d.getState().writeLock, '書込中になっていない(前提が崩れている)').not.toBeNull();
    const before = appends(b.events).length;
    b.service.stop();
    await tick();

    // ① まだ入らない(書けないので)── ⚠ ただし**捨ててはいない**
    expect(appends(b.events).length, '書込中なのに重ねて撃った').toBe(before);
    expect(b.notices.join(''), '理由を言っていない').toMatch(/本文を書けない/);
    expect(b.attached.length, '収録ごと捨てた').toBe(1);

    /**
     * ② 🔴 **錠を解くと入る** ── ここが「捨てた」と「預かった」を分ける唯一の観測点。
     * ⚠ 台は ack を返さないので、**こちらで返す**(実物の effect 層と同じ形)。
     */
    const req = b.events.find((e) => e.type === 'REQUEST_APPEND');
    expect(req, '追記の要求が出ていない(前提が崩れている)').toBeDefined();
    const { lid, gen } = req as Extract<DomainEvent, { type: 'REQUEST_APPEND' }>;
    b.d.dispatch({
      type: 'ENTRY_APPENDED',
      lid,
      gen,
      body: '本文',
      status: null,
      date: null,
      archived: false,
      inserted: null,
    });
    await tick();

    const landed = appends(b.events).filter((a) => a.text.includes('録音-'));
    expect(landed, '錠が解けても本文に入らない(預からずに捨てている)').toHaveLength(1);
    expect(b.notices.join(''), '入れたことを言っていない').toMatch(/本文のいちばん下に入れました/);
  });

  it('⚠ 添付にできなかった回も、黙らない', async () => {
    const b = bench({ attachFails: true });
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(appends(b.events), '添付が無いのに参照を書いた').toEqual([]);
    expect(b.notices.join(''), '取り込めなかったことを言っていない').toMatch(/取り込めませんでした/);
  });

  it('⚠ 1 バイトも録れていないときは、添付も作らない', async () => {
    const b = bench({ blob: null });
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(b.attached, '空の添付を作った').toEqual([]);
    expect(b.d.getState().error, '理由を出していない').toMatch(/録れていません/);
  });

});

/**
 * 🔴 **編集している最中に収録が終わる**(2026-08-27)。
 *
 * ⚠ `CREATE_ENTRY` は **`phase !== 'ready'` を黙って捨てる**ので、編集中は
 *   **添付が 1 件も作れない**。1 稿目はここで `null` を受けて**何も言わずに終わって**
 *   おり、⚠ **収録が丸ごと消えていた**(PKC2 の全損と同じ結果)。
 *   露見したのは、fake を実物と同じ厳しさにしたときである(§3)。
 */
describe('🔴 編集中に終わっても、収録を失わない(#413)', () => {
  /** 編集に入る。⚠ `openBody` が先に要る(reducer の門)。 */
  function edit(b: Bench): void {
    b.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    b.d.dispatch({ type: 'START_EDIT' });
    expect(b.d.getState().phase, '編集に入っていない(前提が崩れている)').toBe('editing');
  }

  it('🔴 「止める」は断る ── 収録は続いている(押させて失わせない)', async () => {
    const b = bench();
    await b.service.start('audio');
    edit(b);
    b.service.stop();
    await tick();
    expect(b.d.getState().error, '断らずに黙って止めた').toMatch(/編集中は取り込めません/);
    expect(b.attached, '編集中なのに取り込もうとした').toEqual([]);
    // 🔴 **まだ録っている**(押しても失われない)
    expect(b.service.line(), '断ったのに収録が止まっている').toMatch(/^録音中/);
  });

  it('🔴 上限や共有停止で強制的に終わったら、預かって、編集を終えたら入れる', async () => {
    const b = bench();
    await b.service.start('audio');
    edit(b);
    // ⚠ ここは user が押したのではない ── 止まるのを止められない
    b.live()!.end('shared-ended');
    await tick();
    expect(b.attached, '編集中に取り込もうとした(捨てられる側)').toEqual([]);
    expect(b.notices.join(''), '預かったことを言っていない').toMatch(/預かりました/);
    expect(b.service.line(), '終わったのに帯が残っている').toBeNull();

    // 🔴 **編集を終えると入る**(ここが本丸 ── 直す前は消えていた)
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    expect(b.attached.length, '編集を終えても取り込まれない').toBe(1);
    expect(appends(b.events), '本文へ入っていない').toEqual([
      { lid: 'a', text: '[録音-2026-08-27-030102.webm](asset:ast-k1)' },
    ]);
    expect(b.d.getState().selectedLid, '選択が戻っていない').toBe('a');
  });

  it('🔴 見張りは 1 本だけ張って、取り込んだら外す', async () => {
    const b = bench();
    expect(b.subs(), '始める前から見張っている').toBe(0);
    await b.service.start('audio');
    edit(b);
    b.live()!.end('too-long');
    await tick();
    expect(b.subs(), '預かったのに見張っていない').toBe(1);

    // ⚠ 編集の最中に**もう 1 本**録って、それも強制的に終わる
    await b.service.start('audio');
    b.live()!.end('shared-ended');
    await tick();
    expect(b.subs(), '預かるたびに見張りを増やしている').toBe(1);

    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    // 🔴 **2 本とも入る**(先に預かったほうが黙って消えない)
    expect(b.attached.length, '預かった収録が消えた').toBe(2);
    expect(appends(b.events).length, '本文へ入っていない').toBe(2);
    expect(b.subs(), '取り込んだのに見張りが残っている').toBe(0);
  });

  it('⚠ 預かりは取り込んだら空になる(次の預かりで前のが甦らない)', async () => {
    const b = bench();
    await b.service.start('audio');
    edit(b);
    b.live()!.end('too-long');
    await tick();
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    expect(b.attached.length, '前提が崩れている').toBe(1);

    // ⚠ もう一度、編集中に強制終了 ── **入るのは 2 本目だけ**
    await b.service.start('audio');
    edit(b);
    b.live()!.end('too-long');
    await tick();
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    expect(b.attached.length, '前に取り込んだ収録をもう一度取り込んだ').toBe(2);
  });
});

describe('🔴 ④⑤ 断る / 捨てる(#413)', () => {
  it('同時に 2 本は録らない', async () => {
    const b = bench();
    await b.service.start('audio');
    await b.service.start('screen');
    expect(b.d.getState().error, '2 本目を黙って捨てた').toMatch(/すでに収録しています/);
    expect(b.service.line(), '2 本目が 1 本目を置き換えた').toMatch(/^録音中/);
  });

  it('権限を断られたら、理由が出る(帯は出ない)', async () => {
    const b = bench({ refuse: 'マイクの許可がありません' });
    await b.service.start('audio');
    expect(b.d.getState().error).toBe('マイクの許可がありません');
    expect(b.service.line(), '始まっていないのに帯が出ている').toBeNull();
  });

  it('🔴 捨てたら、添付にも本文にも触らない', async () => {
    const b = bench();
    await b.service.start('audio');
    b.service.discard();
    await tick();
    expect(b.live()!.discards(), '捨てていない').toBe(1);
    expect(b.live()!.stops(), '捨てたのに保存の口を通った').toBe(0);
    expect(b.attached, '捨てたのに添付を作った').toEqual([]);
    expect(appends(b.events), '捨てたのに本文を書いた').toEqual([]);
    expect(b.service.line(), '捨てたのに帯が残っている').toBeNull();
    expect(b.notices.join(''), '捨てたことを言っていない').toMatch(/捨てました/);
  });
});

describe('🔴 黙って終わらない(#413)', () => {
  it('12 時間に達して自動で止まったら、理由が出て、それまでの分は残る', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.end('too-long');
    await tick();
    // 🔴 **理由と結果は同じ 1 行**(別々に出すと、後の 1 行が前の 1 行を消す)
    expect(b.notices.at(-1), '上限で止まった理由が出ていない').toMatch(
      /^録音が上限\(12:00:00\)に達したので止めました。/,
    );
    expect(b.notices.at(-1), '結果が同じ行に載っていない').toMatch(/本文のいちばん下に入れました$/);
    expect(b.d.getState().error, '知らせをエラーの行に出した').toBeNull();
    // 🔴 **落ちて全損だけは繰り返さない** ── 添付にも本文にも入っている
    expect(b.attached.length, '上限で止まったら収録が消えた').toBe(1);
    expect(appends(b.events).length, '上限で止まった回だけ本文へ入らない').toBe(1);
  });

  it('🔴 符号化が死んだ回も、理由が出て、それまでの分は残る(#771)', async () => {
    const b = bench();
    await b.service.start('screen');
    b.live()!.end('failed');
    await tick();
    // 🔴 直す前は**受け口が 0 件**で、帯だけ伸び続けて誰も何も言わなかった
    expect(b.notices.at(-1), '死んだ理由が出ていない').toMatch(
      /^画面収録を続けられなくなったので止めました\(ブラウザが収録を止めました\)。/,
    );
    expect(b.attached.length, 'そこまでの分が消えた').toBe(1);
  });

  it('ブラウザ側の「共有を停止」でも終わり、そう言う', async () => {
    const b = bench();
    await b.service.start('screen');
    b.live()!.end('shared-ended');
    await tick();
    expect(b.notices.join(''), '共有が終わったことを言っていない').toMatch(/共有が終わった/);
    expect(appends(b.events).length, '共有停止の回だけ本文へ入らない').toBe(1);
    expect(b.service.line(), '終わったのに帯が残っている').toBeNull();
  });

  it('⚠ 「止める」と自動停止が重なっても、1 回しか片付けない', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.end('shared-ended');
    b.service.stop();
    await tick();
    expect(b.attached.length, '2 回取り込んだ').toBe(1);
    expect(appends(b.events).length, '2 回追記した').toBe(1);
  });
});

describe('🔴 長い収録は分けて入れる(#771)', () => {
  /** 追記に載った印(#668 C)。⚠ 「元に戻す」1 回でまとめて消えるための鍵。 */
  const batches = (events: DomainEvent[]): Array<string | undefined> =>
    events.flatMap((e) => (e.type === 'REQUEST_APPEND' ? [e.batch] : []));

  it('🔴 切れた 1 本は、その場で添付になって本文へ入る(止まらない)', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.cut(new Blob(['part-one']));
    await tick();
    expect(b.attached.length, '切れた本が取り込まれていない').toBe(1);
    expect(appends(b.events).length, '切れた本が本文へ入っていない').toBe(1);
    // 🔴 **まだ録っている** ── user の言葉は「途中終了はしてほしくない」
    expect(b.service.line(), '切っただけで帯が消えた').not.toBeNull();
  });

  it('🔴 分かれた本には連番が付き、時刻は「始めた時刻」で揃う', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.cut(new Blob(['a']));
    await tick();
    b.service.stop();
    await tick();
    expect(b.attached.map((a) => a.name)).toEqual([
      '録音-2026-08-27-030102-1.webm',
      '録音-2026-08-27-030102-2.webm',
    ]);
  });

  it('🔴 分かれた本は「始めた時刻」で名乗る(取り込んだ時刻ではない)', async () => {
    // ⚠ 時計を**動かす** ── 止めておくと、どちらで名乗っても同じ字になる
    const clock = { at: new Date(2026, 7, 27, 3, 1, 2) };
    const b = bench({ clock });
    await b.service.start('audio');
    b.live()!.cut(new Blob(['a']));
    await tick();
    // 🔴 4 時間経ってから止める(分かれた 2 本が別々の時刻を名乗ると、一覧で離れる)
    clock.at = new Date(2026, 7, 27, 7, 30, 45);
    b.service.stop();
    await tick();
    expect(b.attached.map((a) => a.name), '2 本目が別の時刻を名乗っている').toEqual([
      '録音-2026-08-27-030102-1.webm',
      '録音-2026-08-27-030102-2.webm',
    ]);
  });

  it('⚠ 対照群 ── 1 本で収まった回は連番が付かない', async () => {
    const b = bench();
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(b.attached.map((a) => a.name)).toEqual(['録音-2026-08-27-030102.webm']);
  });

  it('🔴 分かれた行は同じ印で入る(「元に戻す」1 回でまとめて消える)', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.cut(new Blob(['a']));
    await tick();
    b.service.stop();
    await tick();
    const tags = batches(b.events);
    expect(tags.length, '2 行入っていない').toBe(2);
    expect(tags[0], '印が付いていない').toBeDefined();
    expect(tags[1], '分かれた行の印が違う ── 元に戻すが 2 回になる').toBe(tags[0]);
  });

  it('⚠ 対照群 ── 1 本で収まった回に印は付けない(元から 1 手である)', async () => {
    const b = bench();
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(batches(b.events)).toEqual([undefined]);
  });

  it('🔴 切れた本が編集中に落ちても、捨てずに預かる', async () => {
    const b = bench();
    await b.service.start('audio');
    // ⚠ `BODY_LOADED` が先に要る(reducer の門)── 前提が崩れたらここで落ちる
    b.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    b.d.dispatch({ type: 'START_EDIT' });
    expect(b.d.getState().phase, '編集に入っていない(前提が崩れている)').toBe('editing');
    b.live()!.cut(new Blob(['a']));
    await tick();
    expect(b.attached, '編集中に取り込もうとしている').toEqual([]);
    expect(b.notices.join(''), '預かったことを言っていない').toMatch(/預かりました/);
    // 🔑 編集を終えたら入る(捨てていない)
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    await tick();
    expect(b.attached.length, '編集を終えても入らない').toBe(1);
  });

  it('🔴 最後の 1 本が空でも、切れた本が在れば「録れていません」と言わない', async () => {
    const b = bench({ blob: null });
    await b.service.start('audio');
    b.live()!.cut(new Blob(['a']));
    await tick();
    b.service.stop();
    await tick();
    expect(b.d.getState().error, '入っているのに失敗と言った').toBeNull();
    expect(b.notices.at(-1), '何本入ったのかを言っていない').toMatch(/1 本に分けて入れました$/);
  });

  it('⚠ 対照群 ── 1 本も切れておらず空なら、これは本当に失敗である', async () => {
    const b = bench({ blob: null });
    await b.service.start('audio');
    b.service.stop();
    await tick();
    expect(b.d.getState().error, '何も残っていないのに黙っている').toMatch(/1 バイトも録れていません/);
  });

  it('🔴 置き場に入らなかったら、録るのをやめる(250MB ごとに同じ断りを繰り返さない)', async () => {
    const b = bench({ attachFails: true });
    await b.service.start('audio');
    b.live()!.cut(new Blob(['a']));
    await tick();
    await tick();
    // 🔴 **録り続けない** ── 続けても次の 1 本も入らず、最後には 1 本も残らない
    expect(b.service.line(), '入らないのに録り続けている').toBeNull();
    expect(b.notices.at(-1), '止めた理由を言っていない').toMatch(/^置き場に空きが無いので録音を止めました/);
  });

  it('🔴 預かった本が入らなかったときも、録るのをやめる', async () => {
    const b = bench({ attachFails: true });
    await b.service.start('audio');
    // ⚠ `BODY_LOADED` が先に要る(reducer の門)── 前提が崩れたらここで落ちる
    b.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    b.d.dispatch({ type: 'START_EDIT' });
    expect(b.d.getState().phase, '編集に入っていない(前提が崩れている)').toBe('editing');
    b.live()!.cut(new Blob(['a']));
    await tick();
    // ⚠ ここでは**まだ止まらない**(預かっただけ ── 入らないとは限らない)
    expect(b.service.line(), '預かった時点で止めている').not.toBeNull();
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    await tick();
    expect(b.service.line(), '預かった本が入らなかったのに録り続けている').toBeNull();
    expect(b.notices.at(-1), '止めた理由を言っていない').toMatch(/^置き場に空きが無いので録音を止めました/);
  });

  it('⚠ 対照群 ── 入った回は録り続ける(止めるのは「入らなかったとき」だけ)', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.cut(new Blob(['a']));
    await tick();
    await tick();
    expect(b.service.line(), '入ったのに止まった').not.toBeNull();
    expect(b.notices.join(''), '入ったのに置き場の話をしている').not.toMatch(/置き場に空きが無い/);
  });

  it('🔴 帯に「残り」と「何本目か」が出る', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.advance(5_000);
    b.beat();
    expect(b.lines.at(-1), '残りが出ていない').toMatch(/残り 11:59:55/);
    expect(b.lines.at(-1), '1 本目に「本目」を出している').not.toMatch(/本目/);
    b.live()!.cut(new Blob(['a']));
    await tick();
    b.beat();
    expect(b.lines.at(-1), '切った後に何本目かを出していない').toMatch(/2 本目/);
  });
});
