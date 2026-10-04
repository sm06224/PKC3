/** @vitest-environment happy-dom */
/**
 * 🔴 **Office の窓とクリップボードの橋**(#121 / #130)。
 *
 * `public/office/host.html` は bundle されない ── **どの unit も届かない** file である。
 * だから `office-save-watch` と同じ手で、**中身を取り出して実際に走らせる**。
 * ⚠ 字面 pin では足りない:2026-08-25 に、読む側の宣言を **object literal の中**へ
 * 置いて `var` を書き、**構文エラーの shim を worker へ配る**ところだった ──
 * その形は「文字列が在るか」を見る検査を**全部素通りする**。
 *
 * ## この file が守るもの
 *
 * | | 守ること |
 * |---|---|
 * | 構文 | 組み上がった shim が **`new Function` に通る**(壊れた shim を配らない) |
 * | 🔴 読む側 | 読めなければ **reject する**(空を返さない ── #121 の主眼) |
 * | 🔴 窓の側 | 読めなければ **画面に出す**(`setStatus`)+ 依頼へ理由を返す |
 * | 書く側 | `write` は今までどおり `Promise<void>`(返事の中身を漏らさない) |
 * | 🔴 窓の側(書き込み) | 標準の型だけを外へ書く(混在なら標準だけ)/ 標準が 0 件なら `write` を呼ばず(外は前の物のまま)**画面に言う** / 書けなかったときも**画面に言う**(#121) |
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const HOST = readFileSync('public/office/host.html', 'utf-8');

/**
 * `var WORKER_SHIMS = "…" + "…";` を**式ごと**取り出して評価する。
 *
 * ⚠ 空振り防止:取り出せていること・組み上がった長さが実のあるものかを、
 *   使う前に見る(取り出しが空でも `new Function('')` は通ってしまう)。
 */
function shimSource(): string {
  const head = 'var WORKER_SHIMS = ';
  const i = HOST.indexOf(head);
  const j = HOST.indexOf('+ "})();\\n";', i);
  expect(i, 'WORKER_SHIMS を取り出せていない').toBeGreaterThan(-1);
  expect(j, 'shim の終端を取り出せていない').toBeGreaterThan(i);
  const expr = `${HOST.slice(i + head.length, j)}+ "})();\\n"`;
  const src = new Function('CLIP_CHANNEL', `return (${expr})`)('pkc3-clipboard') as string;
  expect(src.length, '組み上がった shim が短すぎる').toBeGreaterThan(800);
  return src;
}

interface FakeClip {
  read(): Promise<{ types: string[]; getType(t: string): Promise<Blob> }[]>;
  readText(): Promise<string>;
  write(items: unknown[]): Promise<void>;
  writeText(s: string): Promise<void>;
}

/** shim を「`ClipboardItem` を持たない worker」の中で実際に走らせる。 */
function runShim(): {
  clip: FakeClip;
  sent: Record<string, unknown>[];
  reply: (d: Record<string, unknown>) => void;
} {
  const sent: Record<string, unknown>[] = [];
  let deliver: ((d: Record<string, unknown>) => void) | undefined;
  class FakeBC {
    public onmessage: ((e: { data: unknown }) => void) | null = null;
    public constructor(public name: string) {
      deliver = (d): void => this.onmessage?.({ data: d });
    }
    public postMessage(d: Record<string, unknown>): void {
      sent.push(d);
    }
  }
  const self = { navigator: {} } as unknown as { navigator: { clipboard?: FakeClip } };
  new Function('self', 'BroadcastChannel', 'ClipboardItem', shimSource())(self, FakeBC, undefined);
  const clip = self.navigator.clipboard;
  expect(clip, 'shim が navigator.clipboard を生やしていない').toBeTruthy();
  return { clip: clip!, sent, reply: (d): void => deliver?.(d) };
}

const bytes = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};

describe('worker 側の shim', () => {
  it('組み上がった shim は構文として通る(壊れたものを配らない)', () => {
    expect(() => new Function(shimSource())).not.toThrow();
  });

  it('🔴 読めなければ reject する ── 空文字を返さない(#121)', async () => {
    const h = runShim();
    const p = h.clip.readText();
    // 対照群:依頼が本当に出ている(出ていなければ、下の reject は別の理由になる)
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ clip: 'read', kind: 'readText' });

    h.reply({ reply: true, id: h.sent[0]!['id'], error: 'NotAllowedError' });
    await expect(p).rejects.toMatchObject({ name: 'NotAllowedError' });
    await p.catch((e: Error) => {
      expect(e.message, '理由が message に出ていない').toContain('NotAllowedError');
    });
  });

  it('読めたらその文字が返る(対照群 ── 拒むだけの実装では通らない)', async () => {
    const h = runShim();
    const p = h.clip.readText();
    h.reply({
      reply: true,
      id: h.sent[0]!['id'],
      parts: [{ type: 'text/plain', buf: bytes('貼る字') }],
    });
    await expect(p).resolves.toBe('貼る字');
  });

  it('🔴 text/plain が無ければ reject する(空文字へ落とさない)', async () => {
    const h = runShim();
    const p = h.clip.readText();
    h.reply({ reply: true, id: h.sent[0]!['id'], parts: [{ type: 'image/png', buf: bytes('x') }] });
    await expect(p).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('read() は ClipboardItem を返す(本物と同じ形)', async () => {
    const h = runShim();
    const p = h.clip.read();
    h.reply({
      reply: true,
      id: h.sent[0]!['id'],
      parts: [{ type: 'text/plain', buf: bytes('中身') }],
    });
    const items = await p;
    expect(items).toHaveLength(1);
    expect(items[0]!.types).toEqual(['text/plain']);
    expect(await (await items[0]!.getType('text/plain')).text()).toBe('中身');
  });

  it('🔴 返事が来なければ、待ち続けずに reject する', async () => {
    vi.useFakeTimers();
    try {
      const h = runShim();
      const p = h.clip.readText();
      const seen = p.catch((e: Error) => e.name);
      await vi.advanceTimersByTimeAsync(5001);
      await expect(seen).resolves.toBe('NotAllowedError');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ⚠ 読む側を足すとき、返事の中身を待ち手へ渡す形へ変えた(`w()` → `w(d)`)。
   * 書く側は `Promise<void>` のままでなければならない ── 本物がそうだからである。
   */
  it('書く側は今までどおり void で解決する', async () => {
    const h = runShim();
    const p = h.clip.writeText('書く字');
    expect(h.sent[0]).toMatchObject({ clip: 'write' });
    h.reply({ reply: true, id: h.sent[0]!['id'] });
    await expect(p).resolves.toBeUndefined();
  });
});

/**
 * 型名の判定(`clipToBrowser` / `clipWhy`)と `serveClipboard` の原文。
 * ⚠ 空振り防止:取り出せていることを使う前に見る。
 */
function clipSource(): string {
  const i = HOST.indexOf('var CLIP_STD = ');
  const j = HOST.indexOf('\n  serveClipboard();', i);
  expect(i, 'CLIP_STD を取り出せていない').toBeGreaterThan(-1);
  expect(j, 'serveClipboard の終端を取り出せていない').toBeGreaterThan(i);
  const src = HOST.slice(i, j);
  for (const name of ['function clipToBrowser(', 'function clipWhy(', 'function serveClipboard(']) {
    expect(src, `${name} を取り出せていない`).toContain(name);
  }
  return src;
}

/** `serveRead(ch, d)` を host.html から取り出して走らせる。 */
function runServeRead(clipboard: Partial<FakeClip>, d: Record<string, unknown>): {
  replies: Record<string, unknown>[];
  status: string[];
  warned: unknown[][];
} {
  const head = 'function serveRead(ch, d) {';
  const i = HOST.indexOf(head);
  expect(i, 'serveRead を取り出せていない').toBeGreaterThan(-1);
  const j = HOST.indexOf('\n  }\n', i);
  expect(j, 'serveRead の終端を取り出せていない').toBeGreaterThan(i);
  const src = HOST.slice(i, j + 4);
  const replies: Record<string, unknown>[] = [];
  const status: string[] = [];
  const warned: unknown[][] = [];
  const fn = new Function(
    'setStatus',
    'navigator',
    'console',
    `${clipSource()}\n${src}; return serveRead;`,
  )(
    (s: string) => void status.push(s),
    { clipboard },
    { warn: (...a: unknown[]): void => void warned.push(a) },
  ) as (ch: { postMessage(m: Record<string, unknown>): void }, d: unknown) => void;
  fn({ postMessage: (m): void => void replies.push(m) }, d);
  return { replies, status, warned };
}

describe('窓の側(serveRead)', () => {
  it('🔴 読めなかったら画面に出し、理由を返す(黙って空を返さない)', async () => {
    const r = runServeRead(
      { readText: () => Promise.reject(new DOMException('no', 'NotAllowedError')) },
      { clip: 'read', id: 7, kind: 'readText' },
    );
    await vi.waitFor(() => expect(r.replies).toHaveLength(1));
    expect(r.replies[0]).toEqual({ reply: true, id: 7, error: 'NotAllowedError' });
    // 🔑 **#121 の主眼はここ** ── user に見える面へ理由が出る
    expect(r.status.join('\n')).toContain('読めませんでした');
    expect(r.status.join('\n')).toContain('NotAllowedError');
  });

  it('読めたら中身を返す(対照群)', async () => {
    const r = runServeRead(
      { readText: () => Promise.resolve('本物') },
      { clip: 'read', id: 8, kind: 'readText' },
    );
    await vi.waitFor(() => expect(r.replies).toHaveLength(1));
    const parts = r.replies[0]!['parts'] as { type: string; buf: ArrayBuffer }[];
    expect(parts[0]!.type).toBe('text/plain');
    expect(new TextDecoder().decode(parts[0]!.buf)).toBe('本物');
    expect(r.status, '読めたのに断り文を出している').toEqual([]);
  });

  /**
   * 🔑 **呼ばれること自体が報せである。** 今日の LO は 1 度も呼ばないので、
   * ここが鳴ったら上流が変わった合図 ── だから**消えたら落ちる**ようにしておく
   * (診断は、誰も見ていないと静かに消える)。
   */
  it('🔴 読み出しを求められたこと自体を残す(今日は 0 回のはず)', async () => {
    const r = runServeRead(
      { readText: () => Promise.resolve('x') },
      { clip: 'read', id: 10, kind: 'readText' },
    );
    await vi.waitFor(() => expect(r.replies).toHaveLength(1));
    expect(r.warned.flat().join(' ')).toContain('#121');
    expect(r.warned.flat()).toContain('readText');
  });

  it('kind を書かなければ read() の側を使う', async () => {
    const item = {
      types: ['text/plain'],
      getType: (): Promise<Blob> => Promise.resolve(new Blob(['両方'])),
    };
    const r = runServeRead({ read: () => Promise.resolve([item]) }, { clip: 'read', id: 9 });
    await vi.waitFor(() => expect(r.replies).toHaveLength(1));
    const parts = r.replies[0]!['parts'] as { type: string; buf: ArrayBuffer }[];
    expect(new TextDecoder().decode(parts[0]!.buf)).toBe('両方');
  });
});

/**
 * 🔴 **書く側**(#121)。実測(Chromium 141、2026-10-04): ブラウザは標準 4 つしか受けず、LO が
 * 画像で渡す型(下の SVXB)があると `write` ごと拒む。`web ` 付きの独自の型は書けるが、書くと
 * 外のクリップボードが**空になり**、Office の中へも貼り戻せなかったので、書かない。
 */
const SVXB = 'application/x-openoffice-svxb;windows_formatname="SVXB (StarView Bitmap/Animation)"';
/** 断りの字は host.html から引く(手書きの期待値を 2 か所に置かない ── 字を変えた日に両方そのままで緑になる)。 */
const SAY_NO_IMAGE = ((): string => {
  const m = /var CLIP_SAY_NO_STD = '([^']+)';/.exec(HOST);
  expect(m, 'CLIP_SAY_NO_STD を host.html から引けていない').toBeTruthy();
  return m![1]!;
})();

interface Fns {
  clipToBrowser(t: string): string | null;
  clipWhy(e: unknown): string;
  serveClipboard(): void;
}

/** 判定の関数と `serveClipboard` を、外の道具(放送 / クリップボード / 状態の行)を差して走らせる。 */
function runHost(
  clipboard: { write(items: unknown[]): Promise<void> } | undefined,
  opts: { initialStatus?: string; statusThrows?: boolean } = {},
): {
  fns: Fns;
  send: (d: Record<string, unknown>) => void;
  replies: Record<string, unknown>[];
  status: string[];
  statusEl: { textContent: string };
  written: { types: string[]; blobs: Record<string, Blob> }[];
} {
  const replies: Record<string, unknown>[] = [];
  const status: string[] = [];
  const written: { types: string[]; blobs: Record<string, Blob> }[] = [];
  let handler: ((e: { data: unknown }) => void) | null = null;
  class FakeBC {
    public constructor(_name: string) {
      void _name;
    }
    public set onmessage(f: ((e: { data: unknown }) => void) | null) {
      handler = f;
    }
    public postMessage(d: Record<string, unknown>): void {
      replies.push(d);
    }
  }
  class FakeItem {
    public types: string[];
    public constructor(public items: Record<string, Blob>) {
      if (Object.keys(items).length === 0) throw new TypeError('empty');
      this.types = Object.keys(items);
      written.push({ types: this.types, blobs: items });
    }
  }
  // 状態の行の器 ── `setStatus` が書き、`clipSay` / `clipUnsay` が読む(host.html と同じ関係)
  const statusEl = { textContent: opts.initialStatus ?? '表示中 (3.7 秒)' };
  const fns = new Function(
    'CLIP_CHANNEL',
    'BroadcastChannel',
    'ClipboardItem',
    'navigator',
    'setStatus',
    'statusEl',
    'console',
    `${clipSource()}\nreturn { clipToBrowser, clipWhy, serveClipboard };`,
  )(
    'pkc3-clipboard',
    FakeBC,
    FakeItem,
    { clipboard },
    (s: string) => {
      if (opts.statusThrows) throw new Error('status が落ちた');
      statusEl.textContent = s;
      status.push(s);
    },
    statusEl,
    { warn: (): void => undefined },
  ) as Fns;
  fns.serveClipboard();
  expect(handler, 'serveClipboard が放送を聞いていない').toBeTruthy();
  const send = (d: Record<string, unknown>): void => {
    (handler as unknown as (e: { data: unknown }) => void)({ data: d });
  };
  return { fns, send, replies, status, statusEl, written };
}

describe('型の判定(clipToBrowser)', () => {
  it('標準の 4 つはそのまま、標準でない型は null(書かない)', () => {
    const h = runHost(undefined);
    for (const t of ['text/plain', 'text/html', 'image/png', 'image/svg+xml']) {
      expect(h.fns.clipToBrowser(t), t).toBe(t);
    }
    expect(h.fns.clipToBrowser(SVXB)).toBeNull();
    expect(h.fns.clipToBrowser('application/x-foo')).toBeNull();
    // ⚠ image は png だけ(Chromium 141 の ClipboardItem.supports で実測: jpeg / gif / webp / uri-list / rtf は false)
    for (const t of ['image/jpeg', 'image/gif', 'image/webp', 'text/uri-list', 'text/rtf']) {
      expect(h.fns.clipToBrowser(t), `${t} を標準として通している`).toBeNull();
    }
    // 大文字・前後の空白はブラウザも拒む ── 揃えてから引く
    expect(h.fns.clipToBrowser(' Text/Plain ')).toBe('text/plain');
    // 🔴 `web ` 付きの独自の型へは変えない(書くと外が空になる ── 実測)
    expect(h.fns.clipToBrowser('web application/x-foo')).toBeNull();
  });

  it('標準の型にパラメータが付いて来たら、標準の名前で書く(ブラウザはパラメータ付きを拒む)', () => {
    const h = runHost(undefined);
    expect(h.fns.clipToBrowser('text/plain;charset=utf-8')).toBe('text/plain');
    expect(h.fns.clipToBrowser('image/png;x=y')).toBe('image/png');
  });

  it('理由は name と message の短いほう', () => {
    const h = runHost(undefined);
    expect(h.fns.clipWhy({ name: 'NotAllowedError', message: "Failed to execute 'write' on 'Clipboard'" })).toBe('NotAllowedError');
    expect(h.fns.clipWhy({ name: 'TypeError', message: 'bad' })).toBe('bad');
    expect(h.fns.clipWhy(undefined)).toBe('理由不明');
  });
});

describe('窓の側(serveClipboard の書き込み)', () => {
  const part = (type: string): { type: string; buf: ArrayBuffer } => ({ type, buf: bytes('中身') });
  const ok = (): Promise<void> => Promise.resolve();

  it('標準の型が書けたら何も言わない(今までどおり)', async () => {
    const h = runHost({ write: ok });
    h.send({ clip: 'write', id: 1, parts: [part('text/plain')] });
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    expect(h.replies[0]).toEqual({ reply: true, id: 1 });
    expect(h.written[0]!.types).toEqual(['text/plain']);
    expect(h.written[0]!.blobs['text/plain']!.type).toBe('text/plain');
    expect(h.status, '書けたのに断り文を出している').toEqual([]);
  });

  it('🔴 標準が 0 件なら write を呼ばず(外は前の物のまま)、画面に言い、返事を返す', async () => {
    const write = vi.fn(ok);
    const h = runHost({ write });
    h.send({ clip: 'write', id: 2, parts: [part(SVXB)] });
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    expect(write, '標準が無いのに write を呼んでいる(外が空になる)').not.toHaveBeenCalled();
    expect(h.written, 'ClipboardItem も作らない').toEqual([]);
    expect(h.status).toEqual([SAY_NO_IMAGE]);
    expect(h.replies).toEqual([{ reply: true, id: 2 }]);
  });

  it('🔴 混在なら標準だけを write に渡す(非標準の型は item に無い)・言わない', async () => {
    const h = runHost({ write: ok });
    h.send({ clip: 'write', id: 3, parts: [part(SVXB), part('text/plain'), part('text/html;charset=utf-8')] });
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    expect(h.written).toHaveLength(1);
    expect([...h.written[0]!.types].sort()).toEqual(['text/html', 'text/plain']);
    expect(h.status, '標準が書けたのに言っている').toEqual([]);
  });

  /**
   * 🔴 **0 byte の部品は書かない**(#121)。LO の `retrieveData` は取り出しに失敗すると
   * `catch (...)` で**黙って空を返す**ので、PNG を取れなかった回は 0 byte の `image/png` が届く。
   * 書くと外のクリップボードに**中身の無い画像**が載り、前にコピーした物が消える。
   */
  it('🔴 0 byte の標準の型は item に入れない(中身の在る型だけ書く)', async () => {
    const write = vi.fn(ok);
    const h = runHost({ write });
    const empty = { type: 'image/png', buf: new ArrayBuffer(0) };
    h.send({ clip: 'write', id: 6, parts: [empty, part('text/plain')] });
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    // 対照群: 中身の在る型は今までどおり書く(0 byte だけを飛ばしている ── 全部を飛ばしていない)
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.types, '0 byte の image/png を item に入れている').toEqual(['text/plain']);
    expect(h.status, '書けたのに言っている').toEqual([]);
  });

  it('🔴 標準の型が全部 0 byte なら write を呼ばず、画面に言い、返事を返す', async () => {
    const write = vi.fn(ok);
    const h = runHost({ write });
    h.send({
      clip: 'write',
      id: 7,
      parts: [
        { type: 'image/png', buf: new ArrayBuffer(0) },
        { type: 'text/plain', buf: new ArrayBuffer(0) },
      ],
    });
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    expect(write, '0 byte だけなのに write を呼んでいる(外が空の画像で上書きされる)').not.toHaveBeenCalled();
    expect(h.written, 'ClipboardItem も作らない').toEqual([]);
    expect(h.status).toEqual([SAY_NO_IMAGE]);
    expect(h.replies).toEqual([{ reply: true, id: 7 }]);
  });

  it('🔴 同じ型の 0 byte が先に来ても、後ろの中身の在る部品は書く(0 byte が席を取らない)', async () => {
    const h = runHost({ write: ok });
    h.send({
      clip: 'write',
      id: 8,
      parts: [{ type: 'image/png', buf: new ArrayBuffer(0) }, part('image/png;x=y')],
    });
    await vi.waitFor(() => expect(h.replies).toHaveLength(1));
    expect(h.written[0]!.types).toEqual(['image/png']);
    expect(await h.written[0]!.blobs['image/png']!.text()).toBe('中身');
  });

  it('🔴 write が落ちたら、落ちたことを画面に言い、返事は必ず返す', async () => {
    const h = runHost({
      write: () => Promise.reject(new DOMException('Failed to execute write', 'NotAllowedError')),
    });
    h.send({ clip: 'write', id: 4, parts: [part('text/plain')] });
    await vi.waitFor(() => expect(h.status).toHaveLength(1));
    expect(h.status[0]).toBe('クリップボード:書けませんでした(NotAllowedError)');
    expect(h.replies, '落ちた枝でも返事を返す(返さないと worker が 5 秒待つ)').toEqual([{ reply: true, id: 4 }]);
  });

  it('同期で投げられたときも、言って、返事を返す', () => {
    // clipboard 自体が無い(`navigator.clipboard.write` を呼べない)端末
    const h = runHost(undefined);
    h.send({ clip: 'write', id: 5, parts: [part('text/plain')] });
    expect(h.status).toHaveLength(1);
    expect(h.status[0]).toMatch(/^クリップボード:書けませんでした\(.+\)$/);
    expect(h.replies).toEqual([{ reply: true, id: 5 }]);
  });

  it('⚠ 画面に言う側が落ちても、返事は先に返っている(言う前に done)', () => {
    const h = runHost(undefined, { statusThrows: true });
    expect(() => h.send({ clip: 'write', id: 8, parts: [part(SVXB)] })).toThrow();
    expect(h.replies, '標準 0 件の枝で、言う前に返事していない').toEqual([{ reply: true, id: 8 }]);
    const h2 = runHost(undefined, { statusThrows: true });
    expect(() => h2.send({ clip: 'write', id: 9, parts: [part('text/plain')] })).toThrow();
    expect(h2.replies, '落ちた枝で、言う前に返事していない').toEqual([{ reply: true, id: 9 }]);
  });

  it('部品が 1 つも無い依頼は、言わずに返事だけ返す(「画像は…」と言う根拠が無い)', () => {
    const write = vi.fn(ok);
    const h = runHost({ write });
    h.send({ clip: 'write', id: 10, parts: [] });
    expect(write).not.toHaveBeenCalled();
    expect(h.status).toEqual([]);
    expect(h.replies).toEqual([{ reply: true, id: 10 }]);
  });

  /**
   * 🔴 失敗の字は次の `setStatus` まで残る ── その後に字のコピーが**通った**のに、画面が失敗のままになる。
   * 通ったら、まだ自分の字が出ていれば元の字へ戻す。
   */
  it('🔴 画像で断った後に字のコピーが通ったら、上の行は元の字へ戻る(失敗の字が居座らない)', async () => {
    const h = runHost({ write: ok }, { initialStatus: '表示中 (3.7 秒)' });
    h.send({ clip: 'write', id: 11, parts: [part(SVXB)] });
    expect(h.statusEl.textContent).toBe(SAY_NO_IMAGE);
    h.send({ clip: 'write', id: 12, parts: [part('text/plain')] });
    await vi.waitFor(() => expect(h.replies).toHaveLength(2));
    await vi.waitFor(() => expect(h.statusEl.textContent).toBe('表示中 (3.7 秒)'));
    // 対照群 ── 間に別の字が出ていたら(他の状態遷移)、それは消さない
    const h2 = runHost({ write: ok }, { initialStatus: '表示中' });
    h2.send({ clip: 'write', id: 13, parts: [part(SVXB)] });
    h2.statusEl.textContent = '停止';
    h2.send({ clip: 'write', id: 14, parts: [part('text/plain')] });
    await vi.waitFor(() => expect(h2.replies).toHaveLength(2));
    expect(h2.statusEl.textContent, '自分の字でない物を消した').toBe('停止');
  });

  it('読み出し(read)の型名は、変えずに LO へ返す(今日は誰も呼ばないが、書く側が名前を変えなくなった)', async () => {
    // ⚠ 正規化しても同じになる `text/plain` では「変えていない」を言えない ── 標準でない型とパラメータ付きで見る
    const item = {
      types: ['text/plain;charset=utf-8', 'application/x-foo'],
      getType: (): Promise<Blob> => Promise.resolve(new Blob(['x'])),
    };
    const r = runServeRead({ read: () => Promise.resolve([item]) }, { clip: 'read', id: 7 });
    await vi.waitFor(() => expect(r.replies).toHaveLength(1));
    const parts = r.replies[0]!['parts'] as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text/plain;charset=utf-8', 'application/x-foo']);
  });
});
