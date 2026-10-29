// @vitest-environment node
/**
 * 🔴 **分離モデルを公開の配布元から取る**(#674 / #949)。
 *
 * 見るのは「取れなかったとき、利用者に何と言うか」と「取れた物を正しく通す / 取り違えを止める」:
 *  ① 取れた ONNX は Blob のまま返る(heap に載せない継ぎ足し)/ 進み具合が流れる
 *  ② 🔴 最初の取得元が駄目でも、次の取得元を試す。**全部駄目なら、ホストごとの理由**が並ぶ
 *     (つながらない / HTTP の状態 / 途中で切れた / 小さすぎる / ONNX ではない)
 *  ③ 中断は失敗ではなく「取得をやめました」
 *  ④ 外へ出る道はモデルの URL の GET だけ(録音の音を送る口は無い ── fetch の引数は URL と signal のみ)
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchStemModel, looksLikeOnnx } from '../../src/adapter/platform/stems/stem-fetch';
import type { StemModel } from '../../src/features/audio/stem-model';
import { buildIdentityOnnx } from '../helpers/identity-onnx';

const model = (over: Partial<StemModel> = {}): StemModel => ({
  id: 't',
  label: '歌声と楽器',
  urls: ['https://a.example/m.onnx', 'https://b.example/m.onnx'],
  approxBytes: 1000,
  minBytes: 500,
  sha256: null,
  stft: { nFft: 96, hop: 16, dimF: 49, dimT: 33 },
  zeroBins: 0,
  primary: 'vocals',
  ...over,
});

const good = (): Uint8Array => buildIdentityOnnx([1, 4, 8, 8], 2000);

function streamOf(bytes: Uint8Array, chunk = 700): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

const respond = (bytes: Uint8Array, init: { status?: number; length?: boolean } = {}): Response =>
  new Response(streamOf(bytes), {
    status: init.status ?? 200,
    headers: init.length === false ? {} : { 'content-length': String(bytes.length) },
  });

describe('取れたとき', () => {
  it('🔴 ONNX を Blob で返し、取れた byte が進み具合に流れる(全体の大きさつき)', async () => {
    const bytes = good();
    const seen: Array<[number, number, string]> = [];
    const r = await fetchStemModel(model(), async () => respond(bytes), { onProgress: (g, t, h) => seen.push([g, t, h]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blob.size).toBe(bytes.length);
    expect(r.url).toBe('https://a.example/m.onnx');
    expect(seen.length).toBeGreaterThan(2); // 空振り防止: 複数回に分かれて流れた
    expect(seen.at(-1)).toEqual([bytes.length, bytes.length, 'a.example']);
    expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(bytes);
  });

  it('渡すのは URL と signal だけ(録音の音を載せる口が無い)', async () => {
    const calls: unknown[][] = [];
    await fetchStemModel(model(), async (...a) => {
      calls.push(a);
      return respond(good());
    });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]![1] as object)).toEqual(['signal']);
  });
});

describe('🔴 取れなかったとき ── どこがなぜ駄目だったかを言う', () => {
  it('最初が駄目でも次の取得元を試す(ホストが変わって成功する)', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.includes('a.example') ? new Response('nope', { status: 404 }) : respond(good())));
    const r = await fetchStemModel(model(), fetchFn);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://b.example/m.onnx');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('全部駄目なら、ホストごとの理由が並ぶ(つながらない / HTTP / 小さすぎる / ONNX ではない)', async () => {
    const r1 = await fetchStemModel(model(), async (url) => {
      if (url.includes('a.example')) throw new TypeError('Failed to fetch');
      return new Response('x', { status: 503 });
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.why).toContain('歌声と楽器を分けるモデルを取得できませんでした');
      expect(r1.why).toContain('a.example につながりませんでした');
      expect(r1.why).toContain('b.example が HTTP 503 を返しました');
    }
    const r2 = await fetchStemModel(model(), async (url) =>
      url.includes('a.example') ? respond(new Uint8Array([8, 1, 2, 3]).slice(0, 4)) : respond(new Uint8Array(2000).fill(60)),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.why).toContain('a.example から取れた物が小さすぎます');
      expect(r2.why).toContain('b.example から取れた物はモデルの形式(ONNX)ではありません');
    }
  });

  it('途中で切れた取得は、取れた byte まで言って次へ進む', async () => {
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        if (pulls === 1) c.enqueue(new Uint8Array(100));
        else c.error(new Error('reset'));
      },
    });
    const r = await fetchStemModel(model({ urls: ['https://a.example/m.onnx'] }), async () => new Response(broken, { status: 200 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('a.example からの取得が途中で止まりました(100 byte まで)');
  });

  it('sha256 を固定したモデルは、中身が違えば断る。対照群: 合えば通る', async () => {
    const bytes = good();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const ok = await fetchStemModel(model({ sha256: digest, urls: ['https://a.example/m'] }), async () => respond(bytes));
    expect(ok.ok).toBe(true);
    const ng = await fetchStemModel(model({ sha256: 'a'.repeat(64), urls: ['https://a.example/m'] }), async () => respond(bytes));
    expect(ng.ok).toBe(false);
    if (!ng.ok) expect(ng.why).toContain('想定しているモデルと違います');
  });
});

describe('中断', () => {
  it('signal を中断すると「取得をやめました」(失敗の理由の列には並べない)', async () => {
    const ac = new AbortController();
    const fetchFn = vi.fn(async () => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const r = await fetchStemModel(model(), fetchFn, { signal: ac.signal });
    expect(r).toEqual({ ok: false, why: '取得をやめました' });
    expect(fetchFn, '中断したのに次の取得元を試した').toHaveBeenCalledTimes(1);
  });
});

describe('looksLikeOnnx', () => {
  it('先頭が ir_version の tag(0x08)で、十分な長さ。HTML・JSON・短すぎる物は違う', async () => {
    expect(await looksLikeOnnx(new Blob([good() as BlobPart]))).toBe(true);
    expect(await looksLikeOnnx(new Blob(['<!doctype html><html></html>']))).toBe(false);
    expect(await looksLikeOnnx(new Blob(['{"error":"not found"}']))).toBe(false);
    expect(await looksLikeOnnx(new Blob([new Uint8Array([8, 1])]))).toBe(false);
  });
});
