/**
 * 🔴 **Office の窓の「影」(編集中の文書の写し)を自前で書く**(#1228 段 1)。
 *
 * ⚠ `public/office/office-shadow.js` は **bundle されない素の JS**(`host.html` が `<script src>` で読む)。
 * `readFileSync` + `new Function` で**実 file を読んで**当てる(`office-unsaved.test.ts` と同じ形)。
 *
 * 🔴 守る主張:
 * 1. 差し替えの口 ── `begin()` 〜 `end()` の間**だけ** `fd_sync` が同期の 0 を返す。外では素の側
 *    (開いていない fd は EBADF = 元の `fd_sync` が返していた値)。重ねた `begin()` は断る
 * 2. 起動の import へ**包む**(`env` / `wasi_snapshot_preview1` の両方・当たらなければ空を返す)
 * 3. 契機 ── 打ち続けている間は書かない / 止まると 1 回 / 保存済みなら書かない / 同時に 2 本走らない
 * 4. 書き出し ── 差し替えは `storeToURL` の**間だけ**(投げても戻す)/ `.docx` は `FilterName` 明示 /
 *    測っていない形式は書かない / 開いた文書と同じ場所の物を優先 / 作った wrapper を全部解放
 * 5. 棚 ── 同じ asset は最新 1 つだけ残す(自分より新しい物は消さない)/ 刻んで書く / 書きかけを残さない
 * 6. 失敗は黙らない(理由は user の字・同じ理由は 1 度)/ 成功は言わない
 * 7. 放送の parity ── 実物の窓(host.html の行)が撃つ放送を、実物の `OfficeWindow` が受ける
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { localFileToken } from '../../src/features/office/office-launch';
import { OfficeWindow, shadowFailedNotice, type OfficeWindowEvent } from '../../src/adapter/platform/office/office-window';

interface Gate {
  fdSync(fd: number): number;
  wrapImports(imports: unknown): string[];
  begin(): void;
  end(): void;
  isActive(): boolean;
  counts(): { gated: number; passed: number; ebadf: number; unsyncedMount: number };
}
interface Api {
  QUIET_MS: number;
  SAVE_DEFER_MS: number;
  COMPOSING_MAX_MS: number;
  RETRY_BACKOFF_MS: number[];
  META_NAME: string;
  LOCAL_TOKEN_PREFIX: string;
  feedInput(q: Quiet, type: string, e: unknown, at: number): void;
  SHADOW_FILTERS: Record<string, string>;
  extOfName(name: string): string;
  filterFor(ext: string): string | null;
  createSyncGate(getFS: () => unknown): Gate;
  createQuiet(opts?: { quietMs?: number }): Quiet;
  storeShadowSync(lo: unknown, gate: Gate, opts?: { docPath?: string }): StoreResult;
  discardLocal(FS: unknown): number;
  safeId(token: string, fallback: string): string;
  shelve(d: ShelveDeps): Promise<{ at: number; name: string; meta: boolean }>;
  reasonOf(e: unknown): string;
  createWriter(d: WriterDeps): { tick(): Promise<string>; isBusy(): boolean };
  SHADOW_DIR: string;
  SHELF_DIR: string;
  CHUNK: number;
}
interface Quiet {
  typed(at: number): void; take(at: number): boolean; isDirty(): boolean;
  compositionStart(at: number): void; compositionEnd(at: number): void; isComposing(): boolean;
  defer(at: number, ms: number): void; retry(at: number, delayMs: number): void;
}
type StoreResult = { skipped: 'unmodified' | 'format'; ext?: string } | { ext: string; path: string; size: number };
interface ShelveDeps {
  storage: unknown; id: string; ext: string; size: number; now(): number;
  read(into: Uint8Array, wanted: number, position: number): number;
  origin?: { name: string; size: number } | null;
}
interface WriterDeps {
  now(): number; quiet: Quiet; isDead(): boolean; isModified(): Promise<boolean | null>;
  write(): StoreResult; shelve(info: StoreResult): Promise<unknown>; discard(): void;
  onWritten(at: number): void; onFailed(reason: string): void; log?(e: unknown): void;
}

function load(): Api {
  const src = readFileSync('public/office/office-shadow.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeShadow as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}
const api = load();

/** 開いている fd だけ stream を返す偽の FS。`syncfs` を持つ mount を差せる。 */
function fakeFS(open: readonly number[], syncfsMount = false) {
  return {
    getStream(fd: number) {
      if (!open.includes(fd)) return undefined;
      return { node: { mount: { type: syncfsMount ? { syncfs: () => undefined } : {} } } };
    },
  };
}

describe('🔴 fd_sync の差し替えの口(#1228 段 1)', () => {
  it('begin 〜 end の間だけ 0 を返す。外では素の側(開いていない fd は EBADF = 8)', () => {
    const g = api.createSyncGate(() => fakeFS([3]));
    // 外(既定): 素の側 ── 開いていない fd(99)は元の fd_sync と同じく 8 を返す
    expect(g.fdSync(99), '既定が素でない(開いていない fd が 0 になっている)').toBe(8);
    expect(g.fdSync(3)).toBe(0);
    g.begin();
    expect(g.isActive()).toBe(true);
    // 中: 同期の 0 ── **開いていない fd でも** 0(差し替えが効いている証拠。素の側なら 8)
    expect(g.fdSync(99), '影を書く間なのに素の側のまま').toBe(0);
    g.end();
    expect(g.isActive()).toBe(false);
    // 戻した後: 素へ戻る(戻し忘れの検出 ── ここで 0 のままなら差し替えが残っている)
    expect(g.fdSync(99), 'end の後も差し替えが残っている').toBe(8);
  });

  it('呼ぶ回数を数える(中 / 外 / EBADF)── どちらの側を通ったかが後から見える', () => {
    const g = api.createSyncGate(() => fakeFS([3]));
    g.fdSync(3); g.fdSync(99);
    g.begin(); g.fdSync(3); g.fdSync(4); g.fdSync(5); g.end();
    expect(g.counts()).toEqual({ gated: 3, passed: 2, ebadf: 1, unsyncedMount: 0 });
  });

  it('🔴 begin を重ねて呼ぶと断る(先の end で後の書き出しが SuspendError になるため)', () => {
    const g = api.createSyncGate(() => fakeFS([]));
    g.begin();
    expect(() => g.begin()).toThrow(/重なった/);
    // 断った後も、元の begin は有効なまま ── end で戻る
    expect(g.isActive()).toBe(true);
    g.end();
    expect(g.isActive()).toBe(false);
    // end は何度呼んでも安全(finally で必ず呼べる)
    expect(() => { g.end(); g.end(); }).not.toThrow();
    // 戻れば、もう一度 begin できる
    expect(() => { g.begin(); g.end(); }).not.toThrow();
  });

  it('FS がまだ無い(起動前)/ 例外を投げる FS でも、素の側は 0 を返し落ちない', () => {
    expect(api.createSyncGate(() => null).fdSync(3)).toBe(0);
    const g = api.createSyncGate(() => ({ getStream() { throw new Error('boom'); } }));
    expect(g.fdSync(3), 'getStream が例外のとき EBADF にしていない').toBe(8);
  });

  it('🔴 syncfs を持つ mount は、黙って 0 を返さず数える(この窓の MEMFS には無いので 0 件のはず)', () => {
    const g = api.createSyncGate(() => fakeFS([3], true));
    expect(g.fdSync(3)).toBe(0);
    expect(g.counts().unsyncedMount).toBe(1);
    const g2 = api.createSyncGate(() => fakeFS([3], false));
    g2.fdSync(3);
    expect(g2.counts().unsyncedMount, '対照群(syncfs 無し)で数えている').toBe(0);
  });

  it('起動の import へ包む: env / wasi_snapshot_preview1 のどちらにあっても、他の import は触らない', () => {
    const g = api.createSyncGate(() => null);
    const other = () => 1;
    const both = { env: { fd_sync: {}, fd_write: other }, wasi_snapshot_preview1: { fd_sync: {}, fd_read: other } };
    expect(g.wrapImports(both)).toEqual(['env', 'wasi_snapshot_preview1']);
    expect(both.env.fd_sync).toBe(g.fdSync);
    expect(both.wasi_snapshot_preview1.fd_sync).toBe(g.fdSync);
    expect(both.env.fd_write, '他の import を巻き込んだ').toBe(other);
    expect(both.wasi_snapshot_preview1.fd_read).toBe(other);
    // 片方だけ
    const one = { wasi_snapshot_preview1: { fd_sync: {} } };
    expect(g.wrapImports(one)).toEqual(['wasi_snapshot_preview1']);
    // 🔴 当たらないときは**空**を返す(呼び側が「影は書けない」と知る)── 空振りを true にしない
    expect(g.wrapImports({ env: { fd_write: other } })).toEqual([]);
    expect(g.wrapImports({})).toEqual([]);
    expect(g.wrapImports(null)).toEqual([]);
  });

  it('影を書ける形式は .odt / .docx だけ。.docx は FilterName を明示する(渡さないと ODF で書かれる)', () => {
    expect(api.filterFor('docx')).toBe('MS Word 2007 XML');
    expect(api.filterFor('DOCX')).toBe('MS Word 2007 XML');
    expect(api.filterFor('odt')).toBe('writer8');
    // 測っていない形式は書かない(null)
    for (const e of ['xlsx', 'pptx', 'ods', 'odp', 'rtf', 'doc', '', 'constructor', '__proto__']) {
      expect(api.filterFor(e), `${e} を書こうとしている`).toBeNull();
    }
    expect(api.extOfName('報告 書.DOCX')).toBe('docx');
    expect(api.extOfName('noext')).toBe('');
  });
});

/** `host.html` の**実行する行だけ**(解説コメントに満たされない。CLAUDE.md §1 の 5 度目)。 */
function hostCode(): string {
  return readFileSync('public/office/host.html', 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|<!--)/.test(l))
    .join('\n');
}

describe('🔴 host.html の配線(原文の pin ── host.html は bundle されず unit が届かない)', () => {
  const host = hostCode();
  it('script を読み、起動の import へ包む(instantiateStreaming より前・instantiateWasm の中)', () => {
    expect(host.length, '抜き出せていない ── 検査が空振りしている').toBeGreaterThan(1000);
    expect(host).toContain('<script src="office-shadow.js"></script>');
    const i = host.indexOf('instantiateWasm: function (imports, ok)');
    const j = host.indexOf('WebAssembly.instantiateStreaming(', i);
    const k = host.indexOf('shadowGate.wrapImports(imports)', i);
    expect(i, 'instantiateWasm を抜き出せていない').toBeGreaterThan(0);
    expect(k, '起動の import を包んでいない').toBeGreaterThan(i);
    expect(k, '包むのが instantiateStreaming より後(import は instantiate の時に決まる)').toBeLessThan(j);
  });
});


// ───────────────────────── 契機: 打ってから 3 秒止まった ─────────────────────────

describe('🔴 静止の判定(打ち続けている間は書かない / 止まると 1 回)', () => {
  it('3 秒(QUIET_MS)ちょうどで 1 回だけ true。下ろした後は、次に打つまで true を返さない', () => {
    expect(api.QUIET_MS, '裁定 A「打ってから 3 秒止まった」').toBe(3000);
    const q = api.createQuiet();
    expect(q.take(0), '打っていないのに書こうとしている').toBe(false);
    q.typed(1000);
    expect(q.take(3999), '3 秒に 1ms 足りない').toBe(false);
    expect(q.isDirty()).toBe(true);
    expect(q.take(4000)).toBe(true);
    expect(q.take(4001), '下ろしたのに続けて true').toBe(false);
    expect(q.take(60000), '打っていないのに 3 秒ごとに書く').toBe(false);
    expect(q.isDirty()).toBe(false);
  });

  it('打ち続けている間(200ms 間隔)は 1 度も true にならない。止まって初めて 1 回', () => {
    const q = api.createQuiet();
    let fired = 0;
    for (let t = 0; t <= 20000; t += 200) {
      q.typed(t);
      if (q.take(t + 100)) fired += 1;   // 打つ合間に見に行く
    }
    expect(fired, '打ち続けているのに書こうとしている').toBe(0);
    // 止まる(最後に打ったのは 20000)
    expect(q.take(22999)).toBe(false);
    expect(q.take(23000)).toBe(true);
  });
});

describe('🔴 変換中(IME)は書かない / Ctrl+S の直後は待つ', () => {
  it('変換中(compositionstart 〜 compositionend)は、3 秒止まっても書かない。確定してから 3 秒で 1 回', () => {
    const q = api.createQuiet();
    q.typed(0);
    q.compositionStart(100);
    expect(q.isComposing()).toBe(true);
    expect(q.take(10000), '変換の途中を書こうとしている').toBe(false);
    expect(q.take(50000), '変換が続いている間はいつまでも書かない').toBe(false);
    q.compositionEnd(60000);
    expect(q.isComposing()).toBe(false);
    expect(q.take(62999), '確定から 3 秒に 1ms 足りない').toBe(false);
    expect(q.take(63000)).toBe(true);
    expect(q.take(70000), '下ろした後は打つまで書かない').toBe(false);
  });

  it('compositionend が来ないまま(取りこぼし)でも、上限(COMPOSING_MAX_MS)で諦めて書く ── 永久に止めない', () => {
    const q = api.createQuiet();
    q.typed(0);
    q.compositionStart(1000);
    expect(q.take(1000 + api.COMPOSING_MAX_MS - 1)).toBe(false);
    expect(q.take(1000 + api.COMPOSING_MAX_MS)).toBe(true);
    expect(q.isComposing()).toBe(false);
  });

  it('feedInput: 変換の出入りで印が動く(compositionstart で変換中 / compositionend で確定 + 打った印)', () => {
    const q = api.createQuiet();
    api.feedInput(q, 'compositionstart', {}, 100);
    expect(q.isComposing()).toBe(true);
    expect(q.isDirty(), 'まだ何も打っていない').toBe(false);
    api.feedInput(q, 'keydown', { key: 'Process' }, 200);       // 変換中の keydown
    expect(q.take(9000), '変換中の keydown で書こうとしている').toBe(false);
    api.feedInput(q, 'compositionend', {}, 10000);
    expect(q.isComposing()).toBe(false);
    expect(q.isDirty()).toBe(true);
    expect(q.take(13000)).toBe(true);
  });

  it('🔴 Ctrl / Meta + S の keydown は打った印にせず、静止の起点を SAVE_DEFER_MS 後ろへ送る', () => {
    expect(api.SAVE_DEFER_MS).toBe(10000);
    const q = api.createQuiet();
    q.typed(1000);
    api.feedInput(q, 'keydown', { key: 's', ctrlKey: true }, 2000);
    expect(q.take(5000), '保存の確認が出ている間に書こうとしている').toBe(false);
    expect(q.take(14999)).toBe(false);
    expect(q.take(15000), '起点 + 10 秒 + 静止 3 秒').toBe(true);
    // Meta(mac)/ 大文字 S も同じ
    for (const ev of [{ key: 's', metaKey: true }, { key: 'S', ctrlKey: true }]) {
      const m = api.createQuiet();
      m.typed(0);
      api.feedInput(m, 'keydown', ev, 1000);
      expect(m.take(8000), JSON.stringify(ev)).toBe(false);
      expect(m.take(14000), JSON.stringify(ev)).toBe(true);
    }
    // 対照群: 修飾なしの `s` は普通の字(打った印)
    const plain = api.createQuiet();
    api.feedInput(plain, 'keydown', { key: 's' }, 1000);
    expect(plain.isDirty()).toBe(true);
    expect(plain.take(4000)).toBe(true);
    // 打っていないなら、Ctrl+S だけで印は立たない
    const idle = api.createQuiet();
    api.feedInput(idle, 'keydown', { key: 's', ctrlKey: true }, 1000);
    expect(idle.isDirty(), '押しただけで書こうとしている').toBe(false);
    // 送った起点を、その後の打鍵が縮めない(確認の「Enter」で 3 秒後に書き出さない)
    const k = api.createQuiet();
    k.typed(0);
    api.feedInput(k, 'keydown', { key: 's', ctrlKey: true }, 1000);
    api.feedInput(k, 'keydown', { key: 'Enter' }, 2000);
    expect(k.take(6000), '確認の Enter で起点が戻った').toBe(false);
    expect(k.take(14000)).toBe(true);
  });

  it('修飾キーだけの押下は印を立てない(Ctrl を押しただけで「打った」にしない)', () => {
    const q = api.createQuiet();
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) api.feedInput(q, 'keydown', { key }, 1000);
    expect(q.isDirty()).toBe(false);
    api.feedInput(q, 'paste', {}, 1000);
    expect(q.isDirty(), '対照群: 貼り付けは打った印').toBe(true);
  });

  it('retry: 印を戻し、delayMs 後に take が通る。その間に打たれていれば打った時刻のほうが後ならそちらを採る', () => {
    const q = api.createQuiet();
    q.typed(0);
    expect(q.take(3000)).toBe(true);
    q.retry(3000, 0);
    expect(q.isDirty()).toBe(true);
    expect(q.take(3000), '間 0 は直ちに').toBe(true);
    q.retry(3000, 30000);
    expect(q.take(32999)).toBe(false);
    expect(q.take(33000)).toBe(true);
    q.retry(33000, 0);
    q.typed(40000);
    expect(q.take(42999), '再試行が、後から打った分の静止を縮めた').toBe(false);
    expect(q.take(43000)).toBe(true);
  });
});

/** 時計と部品を持つ writer の台。`modified` を差し替えて保存済み / 聞けなかったを作る。 */
function writerRig(opts: {
  modified?: boolean | null;
  write?: () => StoreResult;
  shelve?: () => Promise<unknown>;
  dead?: boolean;
} = {}) {
  const clock = { t: 0 };
  const quiet = api.createQuiet();
  const calls = { write: 0, shelve: 0, discard: 0, written: [] as number[], failed: [] as string[], logged: 0, asked: 0 };
  const state = { modified: opts.modified === undefined ? true : opts.modified, dead: opts.dead === true };
  const writer = api.createWriter({
    now: () => clock.t,
    quiet,
    isDead: () => state.dead,
    isModified: async () => { calls.asked += 1; return state.modified; },
    write: () => { calls.write += 1; return opts.write ? opts.write() : { ext: 'odt', path: '/tmp/pkc3-shadow/shadow.odt', size: 10 }; },
    shelve: async () => { calls.shelve += 1; return opts.shelve ? opts.shelve() : undefined; },
    discard: () => { calls.discard += 1; },
    onWritten: (at) => { calls.written.push(at); },
    onFailed: (r) => { calls.failed.push(r); },
    log: () => { calls.logged += 1; },
  });
  return { clock, quiet, calls, state, writer };
}

describe('🔴 書く流れ(静止 → 保存済みか確かめる → 書く → 棚へ)', () => {
  it('打ち続けている間は書かない。止まって 3 秒で 1 回だけ書き、成功した時刻を渡す', async () => {
    const r = writerRig();
    for (let t = 0; t <= 10000; t += 200) {
      r.clock.t = t; r.quiet.typed(t);
      expect(await r.writer.tick()).toBe('wait');
    }
    expect(r.calls.write, '打ち続けているのに書いた').toBe(0);
    r.clock.t = 13000;
    expect(await r.writer.tick()).toBe('written');
    expect(r.calls.write).toBe(1);
    expect(r.calls.shelve).toBe(1);
    expect(r.calls.written, '成功の時刻(本体が shadowAt に持つ)').toEqual([13000]);
    // 続けて見ても、もう書かない(打っていない)
    r.clock.t = 30000;
    expect(await r.writer.tick()).toBe('wait');
    expect(r.calls.write).toBe(1);
  });

  it('🔴 保存済み(isModified が false)なら書かない ── 聞くだけで書き出しは走らない', async () => {
    const r = writerRig({ modified: false });
    r.quiet.typed(0); r.clock.t = 5000;
    expect(await r.writer.tick()).toBe('clean');
    expect(r.calls.asked, '確かめていない').toBe(1);
    expect(r.calls.write, '保存済みなのに書いた').toBe(0);
    expect(r.calls.shelve).toBe(0);
    expect(r.calls.failed, '保存済みは失敗ではない').toEqual([]);
    // 対照群: 保存していない(true)なら書く ── 上の「書かない」が条件の効きで、tick が空だったのではないこと
    const r2 = writerRig({ modified: true });
    r2.quiet.typed(0); r2.clock.t = 5000;
    expect(await r2.writer.tick()).toBe('written');
  });

  it('LO に聞けなかった(null)は黙らない。理由は user の字で、同じ理由は続けて 1 度しか言わない', async () => {
    const r = writerRig({ modified: null });
    r.quiet.typed(1000);
    // 失敗のたびに印が戻るので、打ち直さなくても再試行される(間は伸びる ── 下の「再試行」)
    const at = [5000, 6000, 40000, 110000];
    for (const t of at) {
      r.clock.t = t;
      expect(await r.writer.tick(), `t=${t}`).toBe('failed');
    }
    expect(r.calls.failed, '同じ理由を毎回出している / 黙っている').toEqual(['編集の状態を Office に聞けませんでした']);
    expect(r.calls.write).toBe(0);
  });

  it('🔴 書き出しが落ちたら黙らない: 理由を user の字で渡し、原因を log へ。同じ理由は 1 度 / 成功を挟めば言い直す', async () => {
    let boom = true;
    const r = writerRig({ write: () => { if (boom) throw new Error('SuspendError: trying to suspend'); return { ext: 'odt', path: '/p', size: 1 }; } });
    r.quiet.typed(0); r.clock.t = 4000;
    expect(await r.writer.tick()).toBe('failed');
    expect(r.calls.failed).toEqual(['書き出せませんでした']);
    expect(r.calls.logged, '原因を console へ出していない').toBe(1);
    expect(r.calls.written, '失敗なのに成功の時刻を渡した').toEqual([]);
    // 画面の字に内部の語を出さない
    expect(r.calls.failed[0]).not.toMatch(/fd_sync|storeToURL|OPFS|Suspend|UNO/);
    // 同じ失敗がもう一度(次の見張りでの再試行)→ 言い直さない
    r.clock.t = 5000;
    expect(await r.writer.tick()).toBe('failed');
    expect(r.calls.failed).toHaveLength(1);
    // 成功すると言い直せる(2 回目の失敗の後は 30 秒あけて再試行 ── 打ち直さなくても書ける)
    boom = false;
    r.clock.t = 35000;
    expect(await r.writer.tick()).toBe('written');
    boom = true;
    r.quiet.typed(36000); r.clock.t = 40000;
    expect(await r.writer.tick()).toBe('failed');
    expect(r.calls.failed, '成功の後の失敗を言っていない').toHaveLength(2);
  });

  it('🔴 書けなかったら印を戻す: 打ち直さなくても次の見張りで再試行し、続けて失敗するほど間を伸ばす(上限つき)', async () => {
    const r = writerRig({ write: () => { throw new Error('boom'); } });
    r.quiet.typed(0);
    const attempts: number[] = [];
    for (let t = 3000; t <= 600000; t += 1000) {
      r.clock.t = t;
      const before = r.calls.write;
      await r.writer.tick();
      if (r.calls.write > before) attempts.push(t);
    }
    const gaps = attempts.slice(1).map((t, i) => t - attempts[i]!);
    expect(attempts[0], '最初は静止 3 秒の後').toBe(3000);
    expect(gaps.slice(0, 4), '1 秒後に 1 度 → 30 秒 → 60 秒 → 120 秒').toEqual([1000, 30000, 60000, 120000]);
    expect(gaps.slice(3), '上限(最後の間)で止まる').toEqual(gaps.slice(3).map(() => 120000));
    expect(api.RETRY_BACKOFF_MS).toEqual([0, 30000, 60000, 120000]);
  });

  it('再試行は、保存済み / 測っていない形式 / 成功 のあとは続けない(打つまで書かない)/ 間は成功で最初へ戻る', async () => {
    // 保存済み(clean)になったら、もう再試行しない
    const r = writerRig({ write: () => { throw new Error('boom'); } });
    r.quiet.typed(0); r.clock.t = 3000;
    expect(await r.writer.tick()).toBe('failed');
    r.state.modified = false;       // その間に user が保存した
    r.clock.t = 4000;
    expect(await r.writer.tick()).toBe('clean');
    r.clock.t = 100000;
    expect(await r.writer.tick(), '保存済みなのに再試行を続けている').toBe('wait');
    // 成功で間は最初へ戻る(失敗を挟んでも「30 秒」が引き継がれない)
    let boom = true;
    const r2 = writerRig({ write: () => { if (boom) throw new Error('boom'); return { ext: 'odt', path: '/p', size: 1 }; } });
    r2.quiet.typed(0); r2.clock.t = 3000; await r2.writer.tick();     // 失敗 1(間 0)
    r2.clock.t = 4000; await r2.writer.tick();                         // 失敗 2(間 30 秒)
    boom = false; r2.clock.t = 34000;
    expect(await r2.writer.tick()).toBe('written');
    boom = true; r2.quiet.typed(35000); r2.clock.t = 38000;
    expect(await r2.writer.tick()).toBe('failed');                     // 失敗 1 に戻る
    r2.clock.t = 39000;
    expect(await r2.writer.tick(), '成功の後なのに前の間が残っている').toBe('failed');
  });

  it('棚へ置けなかったときも黙らない(失敗は理由つき・writer は動き続ける)', async () => {
    const r = writerRig({ shelve: () => { throw Object.assign(new Error('x'), { name: 'QuotaExceededError' }); } });
    r.quiet.typed(0); r.clock.t = 4000;
    expect(await r.writer.tick()).toBe('failed');
    expect(r.calls.failed).toEqual(['保存領域の空きが足りません']);
    expect(r.writer.isBusy(), '失敗の後も busy のまま').toBe(false);
  });

  it('測っていない形式(skipped)は書かず、失敗とも言わない', async () => {
    const r = writerRig({ write: () => ({ skipped: 'format', ext: 'xlsx' }) });
    r.quiet.typed(0); r.clock.t = 4000;
    expect(await r.writer.tick()).toBe('skipped');
    expect(r.calls.shelve).toBe(0);
    expect(r.calls.failed).toEqual([]);
    expect(r.calls.written).toEqual([]);
  });

  it('🔴 書いている最中の tick は、もう 1 本走らせない(2 本の書き出しが重ならない)', async () => {
    let release: () => void = () => undefined;
    let hold = true;   // 最初の 1 本だけ待たせる(2 本目は素通り)
    const r = writerRig({ shelve: () => (hold ? new Promise<void>((res) => { release = res; }) : Promise.resolve()) });
    r.quiet.typed(0); r.clock.t = 4000;
    const first = r.writer.tick();
    await new Promise((res) => setTimeout(res, 0));   // 棚へ置く手前(shelve が呼ばれた)まで進める
    expect(r.calls.shelve, '空振り防止: 書いている最中まで進んでいない').toBe(1);
    expect(r.writer.isBusy()).toBe(true);
    r.quiet.typed(4001); r.clock.t = 9000;
    // ⚠ 門が無いと 2 本目も書き出しの待ちに入って返らない ── 時間で切って「busy でない」と落とす(test の timeout に頼らない)
    const second = await Promise.race([
      r.writer.tick(),
      new Promise<string>((res) => { setTimeout(() => res('返らない(別の tick が書き出しに入った)'), 100); }),
    ]);
    expect(second, '書いている最中に別の tick が走った').toBe('busy');
    expect(r.calls.write).toBe(1);
    hold = false;
    release();
    expect(await first).toBe('written');
    expect(r.writer.isBusy()).toBe(false);
    // busy の間に来た「打った」印は消費されていない ── 次の tick で書ける
    expect(await r.writer.tick()).toBe('written');
    expect(r.calls.write).toBe(2);
  });

  it('停止した窓(isDead)では何もしない。MEMFS の写しは書いた後も失敗した後も捨てる', async () => {
    const dead = writerRig({ dead: true });
    dead.quiet.typed(0); dead.clock.t = 4000;
    expect(await dead.writer.tick()).toBe('dead');
    expect(dead.calls.asked + dead.calls.write).toBe(0);

    const ok = writerRig();
    ok.quiet.typed(0); ok.clock.t = 4000;
    await ok.writer.tick();
    expect(ok.calls.discard, '書けた後に MEMFS の写しを捨てていない').toBe(1);
    const ng = writerRig({ write: () => { throw new Error('x'); } });
    ng.quiet.typed(0); ng.clock.t = 4000;
    await ng.writer.tick();
    expect(ng.calls.discard, '失敗した後に写しを捨てていない').toBe(1);
    // 待っている間は捨てる物が無い(毎秒 readdir しない)
    const idle = writerRig();
    await idle.writer.tick();
    expect(idle.calls.discard).toBe(0);
  });

  it('理由の字: 保存領域 / 差し替えが当たらない / 聞けない / 容量 / 既定。どれも内部の語を含まない', () => {
    const cases: [unknown, string][] = [
      [{ shadowReason: 'no-opfs' }, 'この端末の保存領域を使えません'],
      [{ shadowReason: 'no-gate' }, 'この版の Office では書けません'],
      [{ shadowReason: 'no-uno' }, '編集の状態を Office に聞けませんでした'],
      [{ name: 'QuotaExceededError' }, '保存領域の空きが足りません'],
      [new Error('whatever'), '書き出せませんでした'],
      [null, '書き出せませんでした'],
    ];
    for (const [e, want] of cases) {
      const got = api.reasonOf(e);
      expect(got).toBe(want);
      expect(got).not.toMatch(/fd_sync|storeToURL|OPFS|Suspend|UNO|壊れ/);
    }
  });
});

// ───────────────────────── LO に書かせる(fake の UNO 橋) ─────────────────────────

interface FakeDocSpec { loc: string; modified: boolean | 'throws' }

/** 実測した橋の形の fake(`office-unsaved.test.ts` と同じ形 + `XStorable`)。wrapper の生成 / 解放を数える。 */
function fakeShadowLo(docs: readonly FakeDocSpec[], gate: Gate, opts: { storeThrows?: boolean; zeroSize?: boolean; stale?: readonly string[] } = {}) {
  const live = { created: 0, deleted: 0 };
  const wrap = <T extends object>(o: T): T & { delete(): void } => {
    live.created += 1;
    return Object.assign(o, { delete: () => { live.deleted += 1; } });
  };
  const files = new Map<string, number>();
  for (const f of opts.stale ?? []) files.set(f, 99);
  const dirs: string[] = [];
  const stores: { url: string; props: { Name: string; Value: { v: unknown } }[]; activeDuring: boolean; doc: string }[] = [];
  class Seq {
    items: { Name: string; Value: { v: unknown } }[] = [];
    constructor(readonly size: number, readonly from: unknown) { live.created += 1; }
    set(i: number, v: { Name: string; Value: { v: unknown } }) { this.items[i] = v; }
    delete() { live.deleted += 1; }
  }
  class Any {
    constructor(public t: unknown, public v: unknown) { live.created += 1; }
    delete() { live.deleted += 1; }
  }
  const lo = {
    uno_init: Promise.resolve(),
    uno: {
      com: { sun: { star: {
        frame: {
          XDesktop: {
            query: () => wrap({
              getComponents: () => wrap({
                createEnumeration: () => {
                  let i = 0;
                  return wrap({
                    hasMoreElements: () => i < docs.length,
                    nextElement: () => { const d = docs[i]!; i += 1; return wrap({ get: () => wrap({ ...d }) }); },
                  });
                },
              }),
            }),
          },
          XStorable: {
            query: (el: FakeDocSpec) => wrap({
              getLocation: () => el.loc,
              storeToURL: (url: string, seq: Seq) => {
                stores.push({ url, props: seq.items, activeDuring: gate.isActive(), doc: el.loc });
                if (opts.storeThrows) throw new Error('SuspendError: boom');
                files.set(url.replace('file://', ''), opts.zeroSize ? 0 : 1234);
              },
            }),
          },
        },
        util: {
          XModifiable: {
            query: (el: FakeDocSpec) => wrap({
              isModified: () => { if (el.modified === 'throws') throw new Error('no'); return el.modified ? 1 : 0; },
            }),
          },
        },
      } } },
    },
    getUnoComponentContext: () => wrap({ getValueByName: () => wrap({ get: () => wrap({}) }) }),
    FS: {
      mkdirTree: (p: string) => { dirs.push(p); },
      readdir: (p: string) => ['.', '..', ...[...files.keys()].filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1))],
      unlink: (p: string) => { files.delete(p); },
      stat: (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return { size: files.get(p)! }; },
    },
    'uno_Type_com$sun$star$beans$PropertyState': { DIRECT_VALUE: 0 },
    'uno_Sequence_com$sun$star$beans$PropertyValue': Seq,
    uno_Sequence: { FromSize: 1 },
    uno_Any: Any,
    uno_Type: { String: () => 'String', Boolean: () => 'Boolean' },
  };
  return { lo, live, files, dirs, stores };
}

describe('🔴 LO に影を書かせる(差し替えは storeToURL の間だけ)', () => {
  it('.docx: FilterName = MS Word 2007 XML を明示し、差し替えは書く間だけ有効、戻した後は素へ', () => {
    const g = api.createSyncGate(() => null);
    const f = fakeShadowLo([{ loc: 'file:///work/seed.docx', modified: true }], g);
    const r = api.storeShadowSync(f.lo, g, { docPath: '/work/seed.docx' });
    expect(r).toEqual({ ext: 'docx', path: '/tmp/pkc3-shadow/shadow.docx', size: 1234 });
    expect(f.stores).toHaveLength(1);
    expect(f.stores[0]!.url).toBe('file:///tmp/pkc3-shadow/shadow.docx');
    expect(f.stores[0]!.props.map((p) => [p.Name, p.Value.v]), '.docx に FilterName を渡していない(渡さないと ODF で書かれる)')
      .toEqual([['FilterName', 'MS Word 2007 XML']]);
    expect(f.stores[0]!.activeDuring, 'storeToURL の間に差し替えが効いていない').toBe(true);
    expect(g.isActive(), '書いた後も差し替えが残っている').toBe(false);
    expect(f.dirs, '置き場を作っていない').toContain('/tmp/pkc3-shadow');
  });

  it('.odt: writer8。宛先は /work の入れ子ではない(保存の見張りに拾われない場所)', () => {
    const g = api.createSyncGate(() => null);
    const f = fakeShadowLo([{ loc: 'file:///work/seed.odt', modified: true }], g);
    const r = api.storeShadowSync(f.lo, g, { docPath: '/work/seed.odt' }) as { path: string };
    expect(f.stores[0]!.props[0]!.Value.v).toBe('writer8');
    expect(r.path.startsWith('/work/'), '見張りの対象(/work 直下)の下に書いている').toBe(false);
    expect(api.SHADOW_DIR).toBe('/tmp/pkc3-shadow');
  });

  it('🔴 書き出しが投げても差し替えを戻す(戻し忘れると LO 自身の保存が壊れる)/ wrapper を全部解放する', () => {
    const g = api.createSyncGate(() => null);
    const f = fakeShadowLo([{ loc: 'file:///work/seed.docx', modified: true }], g, { storeThrows: true });
    expect(() => api.storeShadowSync(f.lo, g, { docPath: '/work/seed.docx' })).toThrow(/SuspendError/);
    expect(f.stores[0]!.activeDuring).toBe(true);
    expect(g.isActive(), '投げた後に差し替えが残っている').toBe(false);
    expect(f.live.created, '空振り防止: wrapper を 1 つも作っていない').toBeGreaterThan(5);
    expect(f.live.deleted, '投げた経路で解放し忘れている').toBe(f.live.created);
  });

  it('成功した経路でも wrapper を全部解放する(呼ぶたびに積まない)', () => {
    const g = api.createSyncGate(() => null);
    const f = fakeShadowLo([
      { loc: 'file:///work/a.odt', modified: false },
      { loc: 'file:///work/seed.odt', modified: true },
      { loc: 'file:///work/c.odt', modified: 'throws' },
    ], g);
    api.storeShadowSync(f.lo, g, { docPath: '/work/seed.odt' });
    expect(f.live.created).toBeGreaterThan(5);
    expect(f.live.deleted).toBe(f.live.created);
  });

  it('保存していない文書が無ければ書かない(対照群: 在れば書く)', () => {
    const g = api.createSyncGate(() => null);
    const none = fakeShadowLo([{ loc: 'file:///work/a.odt', modified: false }], g);
    expect(api.storeShadowSync(none.lo, g, { docPath: '/work/a.odt' })).toEqual({ skipped: 'unmodified' });
    expect(none.stores, '保存済みなのに書いた').toHaveLength(0);
    const some = fakeShadowLo([{ loc: 'file:///work/a.odt', modified: true }], g);
    expect(api.storeShadowSync(some.lo, g, { docPath: '/work/a.odt' })).toMatchObject({ ext: 'odt' });
  });

  it('測っていない形式(.xlsx など)は書かない', () => {
    const g = api.createSyncGate(() => null);
    const f = fakeShadowLo([{ loc: 'file:///work/book.xlsx', modified: true }], g);
    expect(api.storeShadowSync(f.lo, g, { docPath: '/work/book.xlsx' })).toEqual({ skipped: 'format', ext: 'xlsx' });
    expect(f.stores).toHaveLength(0);
    // 場所の無い(まだ保存していない新規の)文書も書かない
    const fresh = fakeShadowLo([{ loc: '', modified: true }], g);
    expect(api.storeShadowSync(fresh.lo, g, {})).toMatchObject({ skipped: 'format' });
  });

  it('窓が開いた文書と同じ場所の物を優先する(別の文書を先に列挙されても)/ 無ければ最初の 1 件', () => {
    const g = api.createSyncGate(() => null);
    const f = fakeShadowLo([
      { loc: 'file:///work/other.odt', modified: true },
      { loc: 'file:///work/%E5%A0%B1%E5%91%8A.docx', modified: true },   // 日本語名(URL エンコード)
    ], g);
    const r = api.storeShadowSync(f.lo, g, { docPath: '/work/報告.docx' });
    expect(f.stores[0]!.doc, '窓の文書でない物を書いた').toContain('%E5%A0%B1');
    expect(r).toMatchObject({ ext: 'docx' });
    const g2 = api.createSyncGate(() => null);
    const f2 = fakeShadowLo([
      { loc: 'file:///work/first.odt', modified: true },
      { loc: 'file:///work/second.odt', modified: true },
    ], g2);
    api.storeShadowSync(f2.lo, g2, { docPath: '/work/gone.odt' });
    expect(f2.stores[0]!.doc).toBe('file:///work/first.odt');
  });

  it('🔴 書けない形式が先に来ても、後ろの書ける文書の影を取りこぼさない(書ける形式を先に選ぶ)', () => {
    const g = api.createSyncGate(() => null);
    // 窓の文書(.xlsx。書けない)が最初 / 2 つ目は別の .docx
    const f = fakeShadowLo([
      { loc: 'file:///work/book.xlsx', modified: true },
      { loc: 'file:///work/other.docx', modified: true },
    ], g);
    expect(api.storeShadowSync(f.lo, g, { docPath: '/work/book.xlsx' })).toMatchObject({ ext: 'docx' });
    expect(f.stores.map((x) => x.doc), '書けない形式を選んで .docx の影が出ない').toEqual(['file:///work/other.docx']);
    // 場所の無い新規文書が先でも同じ
    const g2 = api.createSyncGate(() => null);
    const f2 = fakeShadowLo([
      { loc: '', modified: true },
      { loc: 'file:///work/note.odt', modified: true },
    ], g2);
    expect(api.storeShadowSync(f2.lo, g2, {})).toMatchObject({ ext: 'odt' });
    // 書ける同士なら、窓の文書と同じ場所を優先(順番に依らない)
    const g3 = api.createSyncGate(() => null);
    const f3 = fakeShadowLo([
      { loc: 'file:///work/a.docx', modified: true },
      { loc: 'file:///work/b.docx', modified: true },
    ], g3);
    api.storeShadowSync(f3.lo, g3, { docPath: '/work/b.docx' });
    expect(f3.stores[0]!.doc).toBe('file:///work/b.docx');
    // 書ける文書が 1 つも無ければ従来どおり skipped(format)
    const g4 = api.createSyncGate(() => null);
    const f4 = fakeShadowLo([{ loc: 'file:///work/a.xlsx', modified: true }, { loc: 'file:///work/b.pptx', modified: true }], g4);
    expect(api.storeShadowSync(f4.lo, g4, {})).toMatchObject({ skipped: 'format' });
  });

  it('書く前に置き場の古い物(LO が横に残す lu*.tmp を含む)を捨てる。空の影は成功にしない', () => {
    const g = api.createSyncGate(() => null);
    const f = fakeShadowLo([{ loc: 'file:///work/seed.odt', modified: true }], g, {
      stale: ['/tmp/pkc3-shadow/lu1abc.tmp', '/tmp/pkc3-shadow/shadow.odt'],
    });
    api.storeShadowSync(f.lo, g, { docPath: '/work/seed.odt' });
    expect([...f.files.keys()].filter((k) => k.endsWith('.tmp')), '古い temp が残っている').toEqual([]);
    // 対照群: 置き場の外の file は触らない
    const f2 = fakeShadowLo([{ loc: 'file:///work/seed.odt', modified: true }], g, { stale: ['/work/seed.odt'] });
    api.storeShadowSync(f2.lo, g, { docPath: '/work/seed.odt' });
    expect(f2.files.has('/work/seed.odt'), '置き場の外を消した').toBe(true);
    // 空の影
    const z = fakeShadowLo([{ loc: 'file:///work/seed.odt', modified: true }], g, { zeroSize: true });
    expect(() => api.storeShadowSync(z.lo, g, { docPath: '/work/seed.odt' })).toThrow(/空の影/);
    expect(g.isActive()).toBe(false);
  });

  it('discardLocal は置き場の中身だけを全部消し、消した数を返す', () => {
    const files = new Map<string, number>([['/tmp/pkc3-shadow/a', 1], ['/tmp/pkc3-shadow/lu.tmp', 1], ['/work/x', 1]]);
    const FS = {
      readdir: () => ['.', '..', 'a', 'lu.tmp'],
      unlink: (p: string) => { files.delete(p); },
    };
    expect(api.discardLocal(FS)).toBe(2);
    expect([...files.keys()]).toEqual(['/work/x']);
    // 置き場が無くても落ちない
    expect(api.discardLocal({ readdir: () => { throw new Error('ENOENT'); }, unlink: () => undefined })).toBe(0);
  });
});

// ───────────────────────── OPFS の棚 ─────────────────────────

/** OPFS の直下だけを模す(`createWritable` は close で確定 / abort で捨てる。file は作った時点で在る = 本物と同じ)。 */
class FakeFile { data = new Uint8Array(0); }
class FakeDir {
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();
  failWriteAt: number | null = null;
  constructor(private readonly root?: FakeDir) {}
  private get r(): FakeDir { return this.root ?? this; }
  async getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(n);
    if (!d) { if (!o?.create) throw new Error('NotFound'); d = new FakeDir(this.r); this.dirs.set(n, d); }
    return d;
  }
  async getFileHandle(n: string, o?: { create?: boolean }) {
    let f = this.files.get(n);
    if (!f) { if (!o?.create) throw new Error('NotFound'); f = new FakeFile(); this.files.set(n, f); }
    const file = f;
    const failAt = (): number | null => this.r.failWriteAt;
    return {
      async createWritable() {
        const chunks: Uint8Array[] = [];
        let written = 0;
        return {
          async write(c: Uint8Array) {
            const lim = failAt();
            if (lim !== null && written >= lim) throw new Error('disk');
            chunks.push(c.slice()); written += c.length;
          },
          async close() {
            const all = new Uint8Array(written);
            let o2 = 0; for (const c of chunks) { all.set(c, o2); o2 += c.length; }
            file.data = all;
          },
          async abort() { chunks.length = 0; },
        };
      },
    };
  }
  async removeEntry(n: string) {
    if (!this.files.delete(n) && !this.dirs.delete(n)) throw new Error('NotFound');
  }
  async *keys() { for (const k of [...this.files.keys(), ...this.dirs.keys()]) yield k; }
  async getDirectory() { return this; }
}

function shelveDeps(root: FakeDir, over: Partial<ShelveDeps> & { reads?: number[] } = {}): ShelveDeps {
  const { reads, ...rest } = over;
  return {
    storage: root,
    id: 'lid-1',
    ext: 'odt',
    size: 10,
    now: () => 1_000_000_000_000,
    read: (into, wanted, pos) => {
      reads?.push(wanted);
      for (let i = 0; i < wanted; i += 1) into[i] = (pos + i) % 251;
      return wanted;
    },
    ...rest,
  };
}
const shelfOf = (root: FakeDir, id = 'lid-1') => root.dirs.get('pkc3-office-shadow')?.dirs.get(id);
/** 棚の影の名前だけ(`meta.json` は影ではない)。 */
const shadowsOf = (root: FakeDir, id = 'lid-1'): string[] => [...(shelfOf(root, id)?.files.keys() ?? [])].filter((k) => k !== 'meta.json');

describe('🔴 OPFS の棚(同じ asset は最新 1 つだけ)', () => {
  it('<棚>/<id>/<13桁の時刻>.<拡張子> へ置く。⚠ 取り込みの棚(pkc3-office-stage)とは別の名前', async () => {
    const root = new FakeDir();
    const r = await api.shelve(shelveDeps(root, { size: 7, ext: 'docx' }));
    expect(api.SHELF_DIR).toBe('pkc3-office-shadow');
    expect(api.SHELF_DIR).not.toBe('pkc3-office-stage');
    expect(r.name).toBe('1000000000000.docx');
    const dir = shelfOf(root)!;
    expect(shadowsOf(root)).toEqual(['1000000000000.docx']);
    expect([...dir.files.get(r.name)!.data]).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('🔴 2 回置くと、古い影は消えて最新 1 つだけ残る(拡張子が違っても)', async () => {
    const root = new FakeDir();
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_000_000, ext: 'odt' }));
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_005_000, ext: 'docx' }));
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_009_000, ext: 'docx' }));
    expect(shadowsOf(root), '古い影が残っている').toEqual(['1000000009000.docx']);
  });

  it('自分より新しい名前(別の窓が同じ asset へ書いた分)は消さない。別の asset の棚も触らない', async () => {
    const root = new FakeDir();
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_009_000 }));
    await api.shelve(shelveDeps(root, { id: 'lid-2', now: () => 1_000_000_001_000 }));
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_001_000 }));   // 時計の遅れた窓
    expect(shadowsOf(root, 'lid-1').sort(), '新しい影を消した').toEqual(['1000000001000.odt', '1000000009000.odt']);
    expect(shadowsOf(root, 'lid-2'), '別の asset の影を消した').toEqual(['1000000001000.odt']);
  });

  it('刻んで書く(1MiB ずつ)。丸ごと 1 本の複製を作らず、中身が欠けない', async () => {
    const root = new FakeDir();
    const reads: number[] = [];
    const size = api.CHUNK * 2 + 5;
    const r = await api.shelve(shelveDeps(root, { size, reads }));
    expect(reads, '刻んでいない').toEqual([api.CHUNK, api.CHUNK, 5]);
    const data = shelfOf(root)!.files.get(r.name)!.data;
    expect(data.length).toBe(size);
    expect(data[0]).toBe(0);
    expect(data[api.CHUNK]).toBe(api.CHUNK % 251);
    expect(data[size - 1]).toBe((size - 1) % 251);
  });

  it('🔴 書いている途中で失敗したら、書きかけを残さず、前の影も消さない', async () => {
    const root = new FakeDir();
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_000_000 }));
    root.failWriteAt = 0;
    await expect(api.shelve(shelveDeps(root, { now: () => 1_000_000_005_000 }))).rejects.toThrow(/disk/);
    expect(shadowsOf(root), '書きかけの名前が残った / 前の影が消えた').toEqual(['1000000000000.odt']);
  });

  it('読めなくなったら(read が 0)置かずに失敗する / 空は置かない / OPFS が無い環境は理由つきで落とす', async () => {
    const root = new FakeDir();
    await expect(api.shelve(shelveDeps(root, { size: 10, read: () => 0 }))).rejects.toThrow(/読めなくなった/);
    expect([...(shelfOf(root)?.files.keys() ?? [])]).toEqual([]);
    await expect(api.shelve(shelveDeps(root, { size: 0 }))).rejects.toThrow(/空は置かない/);
    const e = await api.shelve(shelveDeps(root, { storage: null })).catch((x: unknown) => x);
    expect((e as { shadowReason?: string }).shadowReason).toBe('no-opfs');
    expect(api.reasonOf(e)).toBe('この端末の保存領域を使えません');
  });

  it('棚の名前: 合言葉(ノートの lid)をそのまま使い、無ければ窓ごとの名前。path を壊す字は潰す', () => {
    expect(api.safeId('lid-abc_1', 'w-x')).toBe('lid-abc_1');
    expect(api.safeId('', 'w-uuid-1')).toBe('w-uuid-1');
    expect(api.safeId('../../etc', 'w-x'), 'path の区切りが残っている').toBe('______etc');
    expect(api.safeId('', '')).toBe('unnamed');
    expect(api.safeId('x'.repeat(200), 'w').length).toBe(80);
  });

  it('🔴 手元の file の合言葉(local:N)は棚の名前にしない ── 窓ごとの名前を使う(別の file の唯一の影を消さない)', () => {
    // 前置きは本体(localFileToken)と同じ字(食い違うと local: が素通りして別の file の棚と衝突する)
    expect(api.LOCAL_TOKEN_PREFIX).toBe(localFileToken(''));
    const t1 = localFileToken('1');
    const t2 = localFileToken('2');
    expect(api.safeId(t1, 'w-A'), 'local: がそのまま棚の名前になっている').toBe('w-A');
    expect(api.safeId(t1, 'w-A')).not.toBe(api.safeId(t1, 'w-B'));
    expect(api.safeId(t2, 'w-A')).toBe('w-A');
    // 対照群: ノートの lid は従来どおり(ノートごとの棚)
    expect(api.safeId('lid-9', 'w-A')).toBe('lid-9');
    // 'local:' に似ているだけの lid は巻き込まない
    expect(api.safeId('localnote', 'w-A')).toBe('localnote');
  });

  it('🔴 同じ local:1 を持つ 2 つの窓の棚が、消し合わない。同じ窓の 2 回目は古い影を消す(対照群)', async () => {
    const root = new FakeDir();
    const id = (win: string) => api.safeId(localFileToken('1'), win);
    await api.shelve(shelveDeps(root, { id: id('w-A'), now: () => 1_000_000_000_000 }));
    await api.shelve(shelveDeps(root, { id: id('w-B'), now: () => 1_000_000_005_000 }));
    expect(shadowsOf(root, 'w-A'), 'B が A の影を消した').toEqual(['1000000000000.odt']);
    expect(shadowsOf(root, 'w-B')).toEqual(['1000000005000.odt']);
    await api.shelve(shelveDeps(root, { id: id('w-A'), now: () => 1_000_000_009_000 }));
    expect(shadowsOf(root, 'w-A'), '同じ窓の古い影が残っている').toEqual(['1000000009000.odt']);
    expect(shadowsOf(root, 'w-B'), 'A の 2 回目が B を消した').toEqual(['1000000005000.odt']);
  });

  it('棚へ元の文書の記録(meta.json)を添える: 名前・大きさ・時刻・拡張子だけ。本文は入れない。影の整理で消えない', async () => {
    const root = new FakeDir();
    const dec = (d: FakeDir) => JSON.parse(new TextDecoder().decode(d.files.get('meta.json')!.data)) as Record<string, unknown>;
    const r1 = await api.shelve(shelveDeps(root, { ext: 'docx', origin: { name: '報告 書.docx', size: 4321 }, now: () => 1_000_000_000_000 }));
    expect(r1.meta).toBe(true);
    expect(api.META_NAME).toBe('meta.json');
    expect(dec(shelfOf(root)!)).toEqual({ v: 1, name: '報告 書.docx', size: 4321, at: 1_000_000_000_000, ext: 'docx' });
    // 2 回目(古い影が消える回)でも meta.json は残り、最新の記録になる
    await api.shelve(shelveDeps(root, { ext: 'docx', origin: { name: '報告 書.docx', size: 4400 }, now: () => 1_000_000_005_000 }));
    expect(shelfOf(root)!.files.has('meta.json'), '影の整理が meta.json を消した').toBe(true);
    expect(dec(shelfOf(root)!).size).toBe(4400);
    expect(shadowsOf(root)).toEqual(['1000000005000.docx']);
    // 元の文書が分からなくても影は置く(名前は空・大きさは null)
    const root2 = new FakeDir();
    await api.shelve(shelveDeps(root2));
    expect(dec(shelfOf(root2)!)).toMatchObject({ name: '', size: null });
  });

  it('影の整理は影の名前(13 桁の時刻 + 拡張子)だけを消す ── 棚に居る別の物(名前が影より前に並ぶ物)は消さない', async () => {
    const root = new FakeDir();
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_000_000 }));
    const dir = shelfOf(root)!;
    dir.files.set('0-keep.txt', new FakeFile());
    dir.files.set('.keep', new FakeFile());
    await api.shelve(shelveDeps(root, { now: () => 1_000_000_005_000 }));
    expect([...dir.files.keys()].sort(), '影でない物を消した / 古い影が残った').toEqual(['.keep', '0-keep.txt', '1000000005000.odt', 'meta.json']);
  });

  it('記録(meta.json)を書けなくても影は成功(meta: false)── 影が本体', async () => {
    const root = new FakeDir();
    const dir0 = await ((await root.getDirectoryHandle('pkc3-office-shadow', { create: true })).getDirectoryHandle('lid-1', { create: true }));
    // meta.json の書き込みだけ失敗させる
    const orig = dir0.getFileHandle.bind(dir0);
    dir0.getFileHandle = (async (n: string, o?: { create?: boolean }) => {
      if (n === 'meta.json') throw new Error('quota');
      return orig(n, o);
    }) as typeof dir0.getFileHandle;
    const r = await api.shelve(shelveDeps(root, { origin: { name: 'a.odt', size: 1 } }));
    expect(r.meta).toBe(false);
    expect(shadowsOf(root)).toEqual(['1000000000000.odt']);
  });
});

// ───────────────────────── host.html の配線(実行行の原文 pin)+ 放送の parity ─────────────────────────

describe('🔴 host.html の影の配線', () => {
  const host = hostCode();
  it('打った印の種類(変換の出入りを含む)を feedInput へ渡し、Ctrl 英字の握り潰しより前に登録する', () => {
    // 種類の一覧は**実行行の配列そのもの**を評価して見る(別の行の同じ字に満たされない)
    const m = /var SHADOW_INPUTS = (\[[^\]]*\]);/.exec(host);
    expect(m, 'SHADOW_INPUTS を抜き出せていない').not.toBeNull();
    const kinds = new Function(`return ${m![1]}`)() as string[];
    expect([...kinds].sort()).toEqual(['beforeinput', 'compositionend', 'compositionstart', 'cut', 'drop', 'keydown', 'paste']);
    expect(host).toContain('window.PKC3OfficeShadow.feedInput(shadowQuiet, t, e, Date.now());');
    const reg = host.indexOf('SHADOW_INPUTS.forEach(');
    const mac = host.indexOf('e.stopImmediatePropagation()');
    expect(reg, '登録を抜き出せていない').toBeGreaterThan(0);
    expect(reg, '握り潰しの後に登録している(mac の Ctrl 英字で印が立たない)').toBeLessThan(mac);
  });

  it('保存の見張りの直後に積み、1 秒ごとに tick する。閉じるとき止める', () => {
    const a = host.indexOf('armSaveWatch(FS, docToken);');
    const b = host.indexOf('armShadow(FS, function () { return docToken; }, function () { return { name: docName, size: docBytes ? docBytes.length : 0 }; });');
    expect(a).toBeGreaterThan(0);
    expect(b, '影の見張りを積んでいない').toBeGreaterThan(a);
    expect(host).toContain('shadowTimer = setInterval(function () { void writer.tick(); }, 1000);');
    const ph = host.slice(host.lastIndexOf("window.addEventListener('pagehide'"));
    expect(ph, '閉じるとき影の timer を止めていない').toContain('stopShadow();');
  });

  it('置けたら MEMFS の写しを捨て、失敗は放送し(黙らない)、成功は時刻だけを静かに放送する', () => {
    expect(host).toContain('discard: function () { SH.discardLocal(FS); }');
    expect(host).toContain("onFailed: function (reason) { say('shadow-failed', { reason: reason }); }");
    expect(host).toContain("onWritten: function (at) { say('shadow-written', { at: at }); }");
    // 差し替えが当たっていない一式では書こうとせず理由を言う
    expect(host).toContain("e.shadowReason = 'no-gate'");
    // 影の宛先は MEMFS → 棚へ刻んで読む(FS.readFile で丸ごと複製しない)
    const sh = host.slice(host.indexOf('shelve: function (info)'), host.indexOf('discard: function ()'));
    expect(sh.length, 'shelve を抜き出せていない').toBeGreaterThan(100);
    expect(sh).toContain('FS.read(stream, into, 0, wanted, position)');
    expect(sh).not.toContain('readFile');
  });
});

/**
 * 🔴 **host.html の影の配線を、実行する行そのままで動かす**(`var shadowQuiet` 〜 `armShadow` の塊を切り出して評価)。
 * 窓(`window`)・LO・FS・OPFS は偽だが、**配線(どの印をどう渡すか / 棚の名前 / 門)は host.html の行**で、
 * 判断は**実物の office-shadow.js**。⚠ 字面の `toContain` は、別の行の同じ字に満たされる(`SHADOW_INPUTS` の件)。
 */
function bootHostShadow(o: {
  uuid: string;
  token: string;
  patched: string[];
  storage: FakeDir;
  docs?: readonly FakeDocSpec[];
  storeThrows?: boolean;
  doc?: { name: string; size: number };
}) {
  const raw = readFileSync('public/office/host.html', 'utf-8');
  const a = raw.indexOf('var shadowQuiet = ');
  const b = raw.indexOf('// ── Ctrl + 英字が本文に混入');
  expect(a, '塊の始まりを抜き出せていない').toBeGreaterThan(0);
  expect(b, '塊の終わりを抜き出せていない').toBeGreaterThan(a);
  const gate = api.createSyncGate(() => null);
  const f = fakeShadowLo(o.docs ?? [{ loc: 'file:///work/a.docx', modified: true }], gate, { storeThrows: o.storeThrows });
  // 影の MEMFS を読む口(shelve が FS.open / read / close で刻んで読む)
  Object.assign(f.lo.FS, {
    open: (path: string) => ({ path }),
    read: (_st: unknown, into: Uint8Array, _off: number, wanted: number, pos: number) => {
      for (let i = 0; i < wanted; i += 1) into[i] = (pos + i) % 251;
      return wanted;
    },
    close: () => undefined,
  });
  const handlers: Record<string, (e: unknown) => void> = {};
  const intervals: (() => void)[] = [];
  const said: { type: string; payload: Record<string, unknown> }[] = [];
  const win = {
    PKC3OfficeShadow: (api as unknown),
    PKC3OfficeUnsaved: { anyModified: async () => true },
    __lo: f.lo,
    __loDocPath: '/work/a.docx',
    addEventListener: (t: string, fn: (e: unknown) => void) => { handlers[t] = fn; },
  };
  const self = { crypto: { randomUUID: () => o.uuid } };
  const boot = new Function(
    'window', 'self', 'say', 'dead', 'shadowPatched', 'shadowGate', 'navigator', 'setInterval', 'clearInterval', 'console',
    `${raw.slice(a, b)}\n;return { armShadow: armShadow, shadowQuiet: shadowQuiet };`,
  );
  const host = boot(
    win, self,
    (type: string, payload: Record<string, unknown>) => { said.push({ type, payload }); },
    false, o.patched, gate, { storage: o.storage },
    (fn: () => void) => { intervals.push(fn); return 1; }, () => undefined, { warn: () => undefined },
  ) as { armShadow(FS: unknown, getToken: () => string, getDoc: () => unknown): void; shadowQuiet: Quiet };
  host.armShadow(f.lo.FS, () => o.token, () => o.doc ?? { name: 'a.docx', size: 1234 });
  expect(intervals, '1 秒ごとの見張りを積んでいない').toHaveLength(1);
  return {
    f, said, handlers, quiet: host.shadowQuiet,
    /** 1 回見張って、書き出し・棚への置き込みが終わるまで待つ。 */
    async tick(): Promise<void> { intervals[0]!(); await new Promise((r) => setTimeout(r, 0)); },
  };
}

describe('🔴 host.html の影の配線を実行する行のまま動かす(印 / 棚の名前 / 差し替えの門)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const at = (ms: number) => { vi.setSystemTime(ms); };
  const T0 = 1_700_000_000_000;

  it('keydown を撃つと印が立ち、3 秒止まると 1 回書く(印の種類から keydown を外すと窓の打鍵が届かない)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const root = new FakeDir();
    const h = bootHostShadow({ uuid: 'A', token: 'lid-1', patched: ['env'], storage: root });
    at(T0);
    expect(h.handlers.keydown, 'keydown の listener が登録されていない').toBeTypeOf('function');
    h.handlers.keydown!({ key: 'a' });
    expect(h.quiet.isDirty(), 'keydown で印が立たない').toBe(true);
    at(T0 + 3000);
    await h.tick();
    expect(h.f.stores).toHaveLength(1);
    expect(shadowsOf(root, 'lid-1')).toHaveLength(1);
    expect(h.said.map((x) => x.type)).toEqual(['shadow-written']);
  });

  it('変換中は書かず、確定してから 3 秒で書く / Ctrl+S の直後は待つ(host の listener を通して)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const root = new FakeDir();
    const h = bootHostShadow({ uuid: 'A', token: 'lid-1', patched: ['env'], storage: root });
    at(T0);
    h.handlers.keydown!({ key: 'a' });
    h.handlers.compositionstart!({});
    at(T0 + 20000);
    await h.tick();
    expect(h.f.stores, '変換の途中を書いた').toHaveLength(0);
    h.handlers.compositionend!({});
    at(T0 + 23000);
    await h.tick();
    expect(h.f.stores, '確定から 3 秒で書いていない').toHaveLength(1);
    // Ctrl+S の直後
    at(T0 + 30000);
    h.handlers.keydown!({ key: 'a' });
    at(T0 + 31000);
    h.handlers.keydown!({ key: 's', ctrlKey: true });
    at(T0 + 36000);
    await h.tick();
    expect(h.f.stores, '保存の確認が出ている間に書いた').toHaveLength(1);
    at(T0 + 44000);
    await h.tick();
    expect(h.f.stores, 'Ctrl+S の 10 秒後 + 3 秒には書く').toHaveLength(2);
  });

  it('🔴 同じ local:1 の 2 つの窓は別の棚へ書く(窓ごとの名前)。棚へ元の file 名を書き添える', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const root = new FakeDir();
    const tok = localFileToken('1');
    const A = bootHostShadow({ uuid: 'A', token: tok, patched: ['env'], storage: root, doc: { name: '請求書.docx', size: 111 } });
    const B = bootHostShadow({ uuid: 'B', token: tok, patched: ['env'], storage: root, doc: { name: '議事録.docx', size: 222 } });
    at(T0); A.handlers.keydown!({ key: 'a' }); at(T0 + 3000); await A.tick();
    at(T0 + 4000); B.handlers.keydown!({ key: 'a' }); at(T0 + 7000); await B.tick();
    expect(shadowsOf(root, 'w-A'), 'B が A の影を消した').toHaveLength(1);
    expect(shadowsOf(root, 'w-B')).toHaveLength(1);
    const meta = (id: string) => JSON.parse(new TextDecoder().decode(shelfOf(root, id)!.files.get('meta.json')!.data)) as { name: string; size: number };
    expect(meta('w-A')).toMatchObject({ name: '請求書.docx', size: 111 });
    expect(meta('w-B')).toMatchObject({ name: '議事録.docx', size: 222 });
    // 同じ窓の 2 回目は古い影を消す(対照群)
    at(T0 + 10000); A.handlers.keydown!({ key: 'b' }); at(T0 + 13000); await A.tick();
    expect(shadowsOf(root, 'w-A'), '同じ窓の古い影が残っている').toHaveLength(1);
    expect(shadowsOf(root, 'w-B')).toHaveLength(1);
    // 対照群: ノートの lid が在る窓はその lid の棚(段 2 がノートから探せる)
    const C = bootHostShadow({ uuid: 'C', token: 'lid-note', patched: ['env'], storage: root });
    at(T0 + 20000); C.handlers.keydown!({ key: 'a' }); at(T0 + 23000); await C.tick();
    expect(shadowsOf(root, 'lid-note')).toHaveLength(1);
  });

  it('🔴 差し替えが当たっていない一式(patched が空)は、書き出しを打たず「この版の Office では書けません」を言う', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const root = new FakeDir();
    // 門が無いと storeToURL が SuspendError で落ちる(本物と同じ)── 偽の LO にそれを再現させる
    const h = bootHostShadow({ uuid: 'A', token: 'lid-1', patched: [], storage: root, storeThrows: true });
    at(T0); h.handlers.keydown!({ key: 'a' }); at(T0 + 3000);
    await h.tick();
    expect(h.f.stores, '門が無いので storeToURL まで行った(SuspendError の生の失敗)').toHaveLength(0);
    expect(h.said).toEqual([{ type: 'shadow-failed', payload: { reason: 'この版の Office では書けません' } }]);
    // 対照群: 当たっている一式は書く
    const ok = bootHostShadow({ uuid: 'B', token: 'lid-2', patched: ['env'], storage: new FakeDir() });
    at(T0 + 10000); ok.handlers.keydown!({ key: 'a' }); at(T0 + 13000);
    await ok.tick();
    expect(ok.f.stores).toHaveLength(1);
  });
});

describe('🔴 放送の parity ── 実物の窓(host.html の行)が撃つ放送を、実物の OfficeWindow が受ける', () => {
  it('shadow-written は shadowAt に静かに残り(user へは言わない)、shadow-failed は理由つきで届く', async () => {
    // A: host.html の onWritten / onFailed の**行そのもの**を取り出し、実物の writer へ差す
    const host = hostCode();
    const blockStart = host.indexOf('onWritten: function');
    const blockEnd = host.indexOf('log: function');
    expect(blockStart, 'host の放送の行を抜き出せていない').toBeGreaterThan(0);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const posted: unknown[] = [];
    const say = (type: string, payload?: unknown) => { posted.push({ pkc3Office: type, payload: payload ?? {} }); };
    const hostPart = new Function('say', `return { ${host.slice(blockStart, blockEnd)} };`)(say) as Pick<WriterDeps, 'onWritten' | 'onFailed'>;
    const clock = { t: 5_000 };
    const quiet = api.createQuiet();
    let mode: 'ok' | 'ng' = 'ok';
    const writer = api.createWriter({
      now: () => clock.t, quiet, isDead: () => false, isModified: async () => true,
      write: () => { if (mode === 'ng') throw new Error('x'); return { ext: 'odt', path: '/p', size: 1 }; },
      shelve: async () => undefined, discard: () => undefined,
      ...hostPart,
    });
    // B: 実物の OfficeWindow(放送だけ偽物)
    let handler: ((ev: MessageEvent) => void) | null = null;
    const ow = new OfficeWindow({
      openWindow: () => undefined, baseUrl: 'https://app.example/pkc3/', now: () => clock.t,
      makeChannel: () => ({ postMessage: () => undefined, close: () => undefined, get onmessage() { return handler; }, set onmessage(f) { handler = f; } }),
    });
    const seen: OfficeWindowEvent[] = [];
    ow.onEvent((e) => seen.push(e));
    const deliver = () => { for (const m of posted.splice(0)) handler!({ data: m } as MessageEvent); };

    expect(ow.shadowAt(), '書く前は null').toBeNull();
    quiet.typed(0); clock.t = 9_000;
    expect(await writer.tick()).toBe('written');
    deliver();
    expect(seen.map((e) => e.type), '成功の放送を本体が受けていない').toEqual(['shadow-written']);
    expect(ow.shadowAt(), '書いた時刻を本体が持っていない').toBe(9_000);

    mode = 'ng';
    quiet.typed(10_000); clock.t = 14_000;
    expect(await writer.tick()).toBe('failed');
    deliver();
    const failed = seen.find((e) => e.type === 'shadow-failed') as { reason: string } | undefined;
    expect(failed, '失敗の放送を本体が受けていない').toBeTruthy();
    expect(failed!.reason).toBe('書き出せませんでした');
    expect(ow.shadowAt(), '失敗で時刻が動いた').toBe(9_000);
    // 窓が閉じても shadowAt は残す(段 2 が棚の影の材料にする)
    handler!({ data: { pkc3Office: 'closed', payload: {} } } as MessageEvent);
    expect(ow.shadowAt()).toBe(9_000);
  });

  it('壊れた shadow-written(時刻が無い / 0 / 数でない)は捨てる。shadowAt を偽らない', () => {
    let handler: ((ev: MessageEvent) => void) | null = null;
    const ow = new OfficeWindow({
      openWindow: () => undefined, baseUrl: 'https://app.example/pkc3/',
      makeChannel: () => ({ postMessage: () => undefined, close: () => undefined, get onmessage() { return handler; }, set onmessage(f) { handler = f; } }),
    });
    const seen: OfficeWindowEvent[] = [];
    ow.onEvent((e) => seen.push(e));
    for (const payload of [{}, { at: 0 }, { at: -5 }, { at: '1' }, { at: Number.NaN }]) {
      handler!({ data: { pkc3Office: 'shadow-written', payload } } as MessageEvent);
    }
    expect(seen).toEqual([]);
    expect(ow.shadowAt()).toBeNull();
  });

  it('本体の字: 「編集の控えを書けませんでした(理由)」。理由が空なら括弧を付けない。main.ts が状態の行へ出す', () => {
    expect(shadowFailedNotice('保存領域の空きが足りません')).toBe('編集の控えを書けませんでした(保存領域の空きが足りません)');
    expect(shadowFailedNotice('')).toBe('編集の控えを書けませんでした');
    expect(shadowFailedNotice('  ')).toBe('編集の控えを書けませんでした');
    expect(shadowFailedNotice('x')).not.toMatch(/壊れ|fd_sync|storeToURL|OPFS/);
    const main = readFileSync('src/main.ts', 'utf-8');
    const i = main.indexOf("ev.type === 'shadow-failed'");
    expect(i, '本体が失敗を受けていない').toBeGreaterThan(0);
    expect(main.slice(i, i + 600)).toContain('showStatus(shadowFailedNotice(ev.reason))');
    // 成功は言わない: shadow-written で showStatus を呼ぶ枝が無い
    const officeBlock = main.slice(main.indexOf('officeWindow.onEvent('), main.indexOf('officeWindow.onEvent(') + 4000);
    expect(officeBlock, '成功を user へ言っている(うるさい)').not.toContain("'shadow-written'");
  });
});
