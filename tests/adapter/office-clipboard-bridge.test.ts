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
    `${src}; return serveRead;`,
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
