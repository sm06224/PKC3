/** @vitest-environment happy-dom */
/**
 * 🔴 **同じファイルを 2 回添付したとき、1 回目の種類が不明なら 2 回目で直す**(#1163 依頼 290 = A)。
 *
 * 直す前は、拡張子の無い `voice` を添付してから中身が同じ `voice.m4a` を添付しても、登録の種類は 1 回目の
 * 「不明」のまま ── 添付のノートには再生ボタンが出るのに、本文の `[voice](asset:…)` は再生ボタンが出なかった
 * (本文の音・動画は登録の種類で決まる)。
 *
 * 守る主張:
 * - 不明 → 分かった: 登録を書き直す
 * - 分かっている → 分かった(別の拡張子): 触らない(初回の種類を保つ ── 「初回 file のまま」の約束)
 * - 不明 → 不明: 書かない / 登録行が無い: 書く(今までどおり)
 */
import { describe, expect, it } from 'vitest';
import { isUnknownMime, storeAsset, type AttachDeps } from '../../src/adapter/ui/actions/attach';

const bytes = (): Blob => new Blob([new Uint8Array([1, 2, 3, 4])]);

function deps(metas: ReadonlyMap<string, string>): { d: AttachDeps; metaWrites: Array<{ key: string; mime: string }> } {
  const metaWrites: Array<{ key: string; mime: string }> = [];
  const d: AttachDeps = {
    gate: (run) => run(),
    putBlob: async () => {},
    putMeta: async (m) => {
      metaWrites.push({ key: m.key, mime: m.mime });
    },
    listStoredBlobKeys: async () => [],
    listMetaMimes: async () => metas,
    hashBlob: async () => 'a'.repeat(64),
  };
  return { d, metaWrites };
}

/** 2 回目の添付 ── 中身が同じ(`known` に鍵が載っている)。 */
async function second(name: string, had: string | undefined): Promise<Array<{ key: string; mime: string }>> {
  // 鍵は identify の結果 ── 1 回目に何が入ったかを知るため、先に 1 度流して鍵を取る
  const probe = deps(new Map());
  const first = await storeAsset(probe.d, { name: 'x', type: '', size: 4, blob: bytes() }, new Set());
  const metas = new Map<string, string>(had === undefined ? [] : [[first.assetKey, had]]);
  const { d, metaWrites } = deps(metas);
  const got = await storeAsset(d, { name, type: '', size: 4, blob: bytes() }, new Set([first.assetKey]));
  expect(got.already, '前提: 2 回目として扱われている').toBe(true);
  return metaWrites;
}

describe('同じ中身の 2 回目の添付(依頼 290 = A)', () => {
  it('🔴 1 回目が不明(octet-stream)で、2 回目は分かる(.m4a)なら、登録を書き直す', async () => {
    const w = await second('voice.m4a', 'application/octet-stream');
    expect(w).toHaveLength(1);
    expect(w[0]!.mime, '分かった種類で書いていない').toBe('audio/mp4');
  });

  it('🔴 1 回目が空の種類でも直す', async () => {
    const w = await second('voice.m4a', '');
    expect(w.map((x) => x.mime)).toEqual(['audio/mp4']);
  });

  it('対照: 1 回目の種類が分かっているなら触らない(初回の種類を保つ)', async () => {
    expect(await second('voice.mp3', 'audio/mp4')).toEqual([]);
  });

  it('対照: 2 回目も不明なら書かない', async () => {
    expect(await second('voice', 'application/octet-stream')).toEqual([]);
  });

  it('対照: 登録行が無いときは書く(今までどおり)', async () => {
    const w = await second('voice.m4a', undefined);
    expect(w.map((x) => x.mime)).toEqual(['audio/mp4']);
  });

  it('不明の判定は 1 本: 空と一般の種類だけが不明', () => {
    expect(isUnknownMime('')).toBe(true);
    expect(isUnknownMime('application/octet-stream')).toBe(true);
    expect(isUnknownMime('audio/mp4')).toBe(false);
  });
});
