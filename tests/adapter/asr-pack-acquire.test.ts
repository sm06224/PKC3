/** @vitest-environment happy-dom */
/**
 * 音声認識の部品の**取得**(#772 段②)。
 *
 * 守りたい主張:
 *  ① 🔴 **取得元は同一オリジンだけ**(別 origin は CORS で必ず失敗する ── 導線ごと作らない)
 *  ② 🔴 **目録が無いときは「まだ配っていません」と言い分ける**(取り直しでは直らない)
 *  ③ 🔴 **進み具合がバイト単位で出る**(157MB の 1 file が数十秒 ── 止まって見えない)
 *  ④ 🔴 **途中で止められる**。止めたら**何も返さない**(部分を残さない)
 *  ⑤ 🔴 **大きさ・中身が目録と違えば断る**(切れた物 / 古いキャッシュの残骸を「取れた」と言わない)
 */
import { describe, expect, it } from 'vitest';
import {
  AsrPackAborted,
  AsrPackError,
  SHA_VERIFY_MAX_BYTES,
  fetchAsrFiles,
  fetchAsrManifest,
  resolveAsrBase,
  type FetchLike,
} from '../../src/adapter/platform/asr/asr-pack-acquire';
import {
  ASR_PARTS,
  ASR_RUNTIME_FILES,
  asrModelDir,
  type AsrPackFile,
} from '../../src/features/asr/asr-parts';

/** happy-dom の既定の基点(`document.baseURI`)。⚠ 期待値の URL はここから組む(手で書かない)。 */
const here = (path: string): string => new URL(path, document.baseURI).href;

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function entry(path: string, bytes: Uint8Array): Promise<AsrPackFile> {
  return { path, bytes: bytes.byteLength, sha256: await sha256(bytes) };
}

/** `chunk` byte ずつ流す Response。⚠ 本物の fetch と同じく**流れる**(一括ではない)。 */
function streaming(bytes: Uint8Array, chunk: number, onCancel?: () => void): Response {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.byteLength) {
        c.close();
        return;
      }
      c.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: 200 });
}

const base = (): string => '/asr-pack/';

describe('取得元は同一オリジンだけ', () => {
  it('絶対 path は開いている場所の origin に解け、/PKC3/dev/ からでも同じ場所を指す', () => {
    expect(resolveAsrBase('/asr-pack/', 'https://app.example/PKC3/dev/')).toBe('https://app.example/asr-pack/');
    expect(resolveAsrBase('/asr-pack/', 'https://app.example/')).toBe('https://app.example/asr-pack/');
    expect(resolveAsrBase('/asr-pack', 'https://app.example/')).toBe('https://app.example/asr-pack/');
  });

  it('🔴 別 origin は理由つきで断る(CORS で必ず失敗する)', () => {
    const uri = 'https://app.example/PKC3/dev/';
    expect(() => resolveAsrBase('https://cdn.jsdelivr.net/npm/x/', uri)).toThrow(AsrPackError);
    expect(() => resolveAsrBase('https://cdn.jsdelivr.net/npm/x/', uri)).toThrow(/CORS/);
    expect(() => resolveAsrBase('//evil.example/a/', uri)).toThrow(AsrPackError);
  });

  it('🔴 目録・実体のどちらも、取る前に門を通る(別 origin の base では fetch が 1 回も呼ばれない)', async () => {
    let called = 0;
    const f: FetchLike = () => {
      called += 1;
      return Promise.resolve(new Response('{}'));
    };
    await expect(fetchAsrManifest('https://other.example/asr-pack/', f)).rejects.toBeInstanceOf(AsrPackError);
    const file: AsrPackFile = { path: 'runtime/a.bin', bytes: 1, sha256: 'a'.repeat(64) };
    await expect(fetchAsrFiles('https://other.example/asr-pack/', [file], f)).rejects.toBeInstanceOf(
      AsrPackError,
    );
    expect(called).toBe(0);
  });
});

describe('目録', () => {
  const okManifest = (): string =>
    JSON.stringify({
      version: 'v1',
      runtime: ASR_RUNTIME_FILES.map((p) => ({
        path: p,
        bytes: p.endsWith('.wasm') ? 14_000_000 : 600_000,
        sha256: 'b'.repeat(64),
      })),
      models: {},
    });

  it('🔴 404 は「まだ配っていません」と言い分け、HTTP の数字を見せない', async () => {
    const f: FetchLike = () => Promise.resolve(new Response('nf', { status: 404 }));
    const err = await fetchAsrManifest('/asr-pack/', f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AsrPackError);
    expect((err as Error).message).toMatch(/まだ配布していません/);
    expect((err as Error).message).not.toMatch(/404/);
    // 対照群:ほかの失敗は HTTP の数字つきで言う(取り直しで直るかもしれない)
    const f500: FetchLike = () => Promise.resolve(new Response('x', { status: 500 }));
    await expect(fetchAsrManifest('/asr-pack/', f500)).rejects.toThrow(/500/);
    // 対照群:通る目録は通る
    const fOk: FetchLike = () => Promise.resolve(new Response(okManifest()));
    await expect(fetchAsrManifest('/asr-pack/', fOk)).resolves.toMatchObject({ version: 'v1' });
  });

  it('🔴 目録は base の下の pack.json を取る', async () => {
    const urls: string[] = [];
    const f: FetchLike = (u) => {
      urls.push(u);
      return Promise.resolve(new Response(okManifest()));
    };
    await fetchAsrManifest('/asr-pack/', f);
    expect(urls).toEqual([here('/asr-pack/pack.json')]);
  });

  it('JSON でない・形の違う目録は理由つきで断る(404 の HTML を目録と読まない)', async () => {
    const f: FetchLike = () => Promise.resolve(new Response('<!doctype html>'));
    await expect(fetchAsrManifest('/asr-pack/', f)).rejects.toThrow(/ファイル一覧/);
  });
});

describe('実体の取得', () => {
  it('🔴 進み具合がバイト単位で、取るにつれて増えていく', async () => {
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const f = await entry('runtime/a.bin', bytes);
    const seen: Array<[number, number, string]> = [];
    const fetchFn: FetchLike = () => Promise.resolve(streaming(bytes, 100));
    const out = await fetchAsrFiles(base(), [f], fetchFn, {
      onProgress: (d, t, n) => seen.push([d, t, n]),
    });
    expect(out.get('runtime/a.bin')?.size).toBe(1000);
    const dones = seen.map((s) => s[0]);
    // 1 file の中で刻まれる(最初の 0 と最後の 1000 の間に、途中の値がある)
    expect(dones[0]).toBe(0);
    expect(dones.at(-1)).toBe(1000);
    const mid = dones.filter((d) => d > 0 && d < 1000);
    expect(mid.length, '途中の値が出ていない(進みが file 単位になっている)').toBeGreaterThanOrEqual(5);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones); // 戻らない
    expect(seen.every((s) => s[1] === 1000)).toBe(true);
  });

  it('2 file 目の進みは 1 file 目の分を引き継ぐ(全体の何バイトか)', async () => {
    const a = new Uint8Array(300).fill(1);
    const b = new Uint8Array(700).fill(2);
    const files = [await entry('runtime/a.bin', a), await entry('runtime/b.bin', b)];
    const seen: number[] = [];
    const fetchFn: FetchLike = (url) =>
      Promise.resolve(streaming(url.endsWith('a.bin') ? a : b, 100));
    await fetchAsrFiles(base(), files, fetchFn, { onProgress: (d) => seen.push(d) });
    expect(seen.some((d) => d > 300 && d < 1000), '2 file 目の途中が全体の値で出ていない').toBe(true);
    expect(seen.at(-1)).toBe(1000);
  });

  it('🔴 大きさが目録と違えば断る(切れた物を「取れた」と言わない)', async () => {
    const bytes = new Uint8Array(500).fill(7);
    const f = { ...(await entry('runtime/a.bin', bytes)), bytes: 600 };
    const fetchFn: FetchLike = () => Promise.resolve(streaming(bytes, 100));
    await expect(fetchAsrFiles(base(), [f], fetchFn)).rejects.toThrow(/大きさがファイル一覧と違います/);
  });

  it('🔴 大きさが合っても中身が違えば断る(小さい file は sha256 で照合する)', async () => {
    const bytes = new Uint8Array(500).fill(7);
    const f = { ...(await entry('runtime/a.bin', bytes)), sha256: 'c'.repeat(64) };
    const fetchFn: FetchLike = () => Promise.resolve(streaming(bytes, 100));
    await expect(fetchAsrFiles(base(), [f], fetchFn)).rejects.toThrow(/中身がファイル一覧と違います/);
  });

  it('⚠ 大物は大きさだけで見る(sha256 は heap に 1 度全部載せるので照合しない ── 守っていない物として pin)', async () => {
    const big = new Uint8Array(SHA_VERIFY_MAX_BYTES + 1);
    const f: AsrPackFile = { path: 'runtime/big.bin', bytes: big.byteLength, sha256: 'd'.repeat(64) };
    const fetchFn: FetchLike = () => Promise.resolve(streaming(big, 4 * 1024 * 1024));
    // 中身の指紋が違っていても通る(= 大きさしか見ていない)。通ることを pin しておく
    const out = await fetchAsrFiles(base(), [f], fetchFn);
    expect(out.get('runtime/big.bin')?.size).toBe(big.byteLength);
  });

  it('🔴 HTTP の失敗は黙って成功にしない(404 の HTML を掴まない)', async () => {
    const f = await entry('runtime/a.bin', new Uint8Array(10));
    const fetchFn: FetchLike = () => Promise.resolve(new Response('<html>', { status: 404 }));
    await expect(fetchAsrFiles(base(), [f], fetchFn)).rejects.toThrow(/取得できません/);
  });

  it('🔴 途中で止められる ── 止めたら、読みかけを手放し、何も返さない', async () => {
    const bytes = new Uint8Array(100_000).fill(3);
    const f = await entry('runtime/a.bin', bytes);
    const ac = new AbortController();
    let cancelled = 0;
    let pulled = 0;
    const fetchFn: FetchLike = () => {
      const r = streaming(bytes, 1000, () => {
        cancelled += 1;
      });
      return Promise.resolve(r);
    };
    const err = await fetchAsrFiles(base(), [f], fetchFn, {
      signal: ac.signal,
      onProgress: (d) => {
        pulled = d;
        if (d >= 5000) ac.abort();
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AsrPackAborted);
    expect(pulled, '止める前にある程度進んでいる(対照群)').toBeGreaterThanOrEqual(5000);
    expect(pulled, '止めた後も取り続けた').toBeLessThan(100_000);
    expect(cancelled, '読みかけの流れを閉じていない').toBe(1);
  });

  it('止めた後は 2 file 目に進まない', async () => {
    const a = new Uint8Array(100).fill(1);
    const files = [await entry('runtime/a.bin', a), await entry('runtime/b.bin', a)];
    const ac = new AbortController();
    const urls: string[] = [];
    const fetchFn: FetchLike = (url) => {
      urls.push(url);
      ac.abort();
      return Promise.resolve(streaming(a, 10));
    };
    await expect(fetchAsrFiles(base(), files, fetchFn, { signal: ac.signal })).rejects.toBeInstanceOf(
      AsrPackAborted,
    );
    expect(urls).toHaveLength(1);
  });

  it('取り先の URL は base の下で、model の置き場の file も取れる', async () => {
    const p = ASR_PARTS[0]!;
    const path = `${asrModelDir(p)}onnx/a b.onnx`;
    const bytes = new Uint8Array(20).fill(5);
    const f = await entry(path, bytes);
    const urls: string[] = [];
    const fetchFn: FetchLike = (url) => {
      urls.push(url);
      return Promise.resolve(streaming(bytes, 7));
    };
    await fetchAsrFiles(base(), [f], fetchFn);
    expect(urls).toEqual([here(`/asr-pack/${asrModelDir(p)}onnx/a%20b.onnx`)]);
  });
});
