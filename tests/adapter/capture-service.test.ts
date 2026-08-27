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

/** 手で動かせる収録。⚠ 終わり方(`onEnd`)は**実物と同じ 4 値**を撃てる形にする。 */
function fakeCapture(kind: CaptureKind, onEnd: (r: CaptureEnd) => void, blob: Blob | null) {
  let bytes = 0;
  let ms = 0;
  let stopped = 0;
  let discarded = 0;
  const handle: CaptureHandle = {
    kind,
    bytes: () => bytes,
    elapsedMs: () => ms,
    stop: () => {
      stopped += 1;
      return Promise.resolve(blob);
    },
    discard: () => {
      discarded += 1;
      onEnd('discarded');
    },
  };
  return {
    handle,
    grow: (n: number) => (bytes += n),
    advance: (n: number) => (ms += n),
    end: (r: CaptureEnd) => onEnd(r),
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
    now: () => new Date(2026, 7, 27, 3, 1, 2),
    tick: (fn) => {
      beats.push(fn);
      return () => {
        beats = beats.filter((f) => f !== fn);
      };
    },
    start: (kind, _capture, o) => {
      if (opts.refuse !== undefined) return Promise.reject(new CaptureRefused(opts.refuse));
      live = fakeCapture(kind, o.onEnd ?? (() => {}), opts.blob === undefined ? new Blob(['xy']) : opts.blob);
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
    expect(b.notices.some((n) => n.includes('本文に入れました')), '入れたことを言っていない').toBe(true);
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
    expect(b.lines.at(-1), '1 秒ごとに書き替わっていない').toBe('録音中 1:05(約 2KB)');
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
    expect(b.notices.join(''), '理由を言っていない').toMatch(/追記できない種類/);
    expect(b.attached.length, '収録ごと捨てた').toBe(1);
  });

  it('書込が飛んでいるとき(本文だけ入らない)', async () => {
    const b = bench({ keepLock: true });
    await b.service.start('audio');
    // ⚠ 追記を 1 本撃つと `writeLock` が立つ(effect を繋いでいないので解けない)
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '先の追記', heading: null, target: null });
    expect(b.d.getState().writeLock, '書込中になっていない(前提が崩れている)').not.toBeNull();
    const before = appends(b.events).length;
    b.service.stop();
    await tick();
    expect(appends(b.events).length, '書込中なのに重ねて撃った').toBe(before);
    expect(b.notices.join(''), '理由を言っていない').toMatch(/本文を書けない/);
    expect(b.attached.length, '収録ごと捨てた').toBe(1);
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
    b.live()!.end('too-large');
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
    b.live()!.end('too-large');
    await tick();
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    expect(b.attached.length, '前提が崩れている').toBe(1);

    // ⚠ もう一度、編集中に強制終了 ── **入るのは 2 本目だけ**
    await b.service.start('audio');
    edit(b);
    b.live()!.end('too-large');
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
  it('上限に当たって自動で止まったら、理由が出て、それまでの分は残る', async () => {
    const b = bench();
    await b.service.start('audio');
    b.live()!.end('too-large');
    await tick();
    // 🔴 **理由と結果は同じ 1 行**(別々に出すと、後の 1 行が前の 1 行を消す)
    expect(b.notices.at(-1), '上限で止まった理由が出ていない').toMatch(/^録音が上限\(250\.0MB\)に達したので止めました。/);
    expect(b.notices.at(-1), '結果が同じ行に載っていない').toMatch(/本文に入れました$/);
    expect(b.d.getState().error, '知らせをエラーの行に出した').toBeNull();
    // 🔴 **落ちて全損だけは繰り返さない** ── 添付にも本文にも入っている
    expect(b.attached.length, '上限で止まったら収録が消えた').toBe(1);
    expect(appends(b.events).length, '上限で止まった回だけ本文へ入らない').toBe(1);
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
