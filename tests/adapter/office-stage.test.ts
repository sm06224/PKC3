/**
 * 🔴 **置く側(素の JS)と引き取る側(TS)を、1 つの棚で突き合わせる**(#205 段 A/B)。
 *
 * ⚠ この 2 つは**別 realm・別 process** で動く ── 共有できるのは棚の名前と file の
 * 綴りだけである(CLAUDE.md §7「同じ値が複数の場所にある」)。だから:
 *
 * 1. **定数の一致を両方の file を読んで pin する**(片方だけ直す変異を殺す)
 * 2. **同じ偽 OPFS へ、置く側で置き、引き取る側で読む**(往復で当てる)
 *
 * 🔑 「置く側の unit」「引き取る側の unit」を別々に書くと、**綴りが食い違っても
 * 両方緑**になる ── それがこの型の欠陥そのものである。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OFFICE_STAGE_DIR,
  OFFICE_STAGE_META_VERSION,
  STAGE_ORPHAN_GRACE_MS,
  discardStaged,
  listStaged,
  readStaged,
  sweepStagedOrphans,
  type StageDir,
} from '@adapter/platform/office/office-stage';

// ── 置く側(素の JS)を読み込む ────────────────────────────────────────
interface StageApi {
  STAGE_DIR: string;
  STAGE_META_VERSION: number;
  CHUNK: number;
  makeKey(deps?: { uuid?: () => string; now?: () => number; seq?: () => number }): string;
  stageBytes(deps: {
    dir: unknown;
    size: number;
    read: (into: Uint8Array, wanted: number, position: number) => number;
    meta?: { name?: string; path?: string; token?: string; win?: string };
    key?: string;
    now?: () => number;
  }): Promise<{ key: string; name: string; size: number }>;
}

const STAGE_JS_PATH = 'public/office/office-save-stage.js';

function loadStageJs(): StageApi {
  const src = readFileSync(STAGE_JS_PATH, 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeStage as StageApi | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}

const stageJs = loadStageJs();

// ── 偽 OPFS ──────────────────────────────────────────────────────────
interface FakeEntry {
  bytes: Uint8Array;
  lastModified: number;
}

class FakeDir {
  readonly files = new Map<string, FakeEntry>();
  clock = 1000;

  getFileHandle = async (name: string, opts?: { create?: boolean }): Promise<unknown> => {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`);
      this.files.set(name, { bytes: new Uint8Array(0), lastModified: this.clock });
    }
    const files = this.files;
    const clockOf = (): number => this.clock;
    return {
      getFile: async () => {
        const e = files.get(name);
        if (!e) throw new Error(`NotFoundError: ${name}`);
        return {
          size: e.bytes.length,
          lastModified: e.lastModified,
          // ⚠ **複製を返す**(本物の File と同じ ── 中身を握らせない)
          arrayBuffer: async () => e.bytes.slice().buffer,
          text: async () => new TextDecoder().decode(e.bytes),
        };
      },
      createWritable: async () => {
        const parts: Uint8Array[] = [];
        return {
          write: async (chunk: Uint8Array | string) => {
            parts.push(
              typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk.slice(),
            );
          },
          close: async () => {
            let n = 0;
            for (const p of parts) n += p.length;
            const all = new Uint8Array(n);
            let o = 0;
            for (const p of parts) {
              all.set(p, o);
              o += p.length;
            }
            files.set(name, { bytes: all, lastModified: clockOf() });
          },
          abort: async () => {
            /* 何も残さない ── 書きかけは消す */
          },
        };
      },
    };
  };

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw new Error(`NotFoundError: ${name}`);
  }

  async *values(): AsyncIterable<{ kind: string; name: string }> {
    for (const name of [...this.files.keys()]) yield { kind: 'file', name };
  }
}

const asStageDir = (d: FakeDir): StageDir => d as unknown as StageDir;

/** 刻んで読む口。⚠ 呼ばれた回数と、渡された器の大きさを覚える(山の高さの観測点)。 */
function makeReader(doc: Uint8Array): {
  read: (into: Uint8Array, wanted: number, position: number) => number;
  calls: number[];
  maxBuffer: number;
} {
  const state = { calls: [] as number[], maxBuffer: 0 };
  return {
    calls: state.calls,
    get maxBuffer() {
      return state.maxBuffer;
    },
    read: (into, wanted, position) => {
      state.maxBuffer = Math.max(state.maxBuffer, into.length);
      const n = Math.min(wanted, doc.length - position);
      into.set(doc.subarray(position, position + n), 0);
      state.calls.push(n);
      return n;
    },
  };
}

describe('置く側と引き取る側の綴りが一致する', () => {
  it('🔴 棚の名前と meta の版が、2 つの file で同じ', () => {
    expect(stageJs.STAGE_DIR, '棚の名前が食い違うと、置いても誰も見つけられない').toBe(
      OFFICE_STAGE_DIR,
    );
    expect(stageJs.STAGE_META_VERSION).toBe(OFFICE_STAGE_META_VERSION);
  });

  it('🔴 素の JS 側が、棚の名前を**その綴りで**書いている(定数を経由している)', () => {
    // ⚠ 空振り防止 ── 上の一致は「両方 undefined」でも成り立ちうる
    expect(OFFICE_STAGE_DIR.length).toBeGreaterThan(4);
    expect(readFileSync(STAGE_JS_PATH, 'utf-8')).toContain(`'${OFFICE_STAGE_DIR}'`);
  });
});

describe('往復 ── 置いたものを引き取る', () => {
  it('🔴 置く → 一覧 → 読む → 捨てる が通る(名前は日本語・空白を保つ)', async () => {
    const dir = new FakeDir();
    const doc = new Uint8Array(5000).map((_, i) => i % 251);
    const r = makeReader(doc);
    const put = await stageJs.stageBytes({
      dir,
      size: doc.length,
      read: r.read,
      // ⚠ **窓の id も通す**(#220-4)── 通さないと「置く側が meta.win を書く」
      //    経路がこの fixture では 1 度も走らない(= 測っていない次元)。
      //    `record.win = String(meta.name)` のような取り違えは、名前と違う値を
      //    渡して初めて殺せる
      meta: { name: '無題 1.odt', path: '/home/web_user/無題 1.odt', win: 'win-XYZ' },
      now: () => 4242,
    });
    expect(put.size).toBe(doc.length);

    const list = await listStaged(asStageDir(dir));
    expect(list, '置いたのに一覧に出ない').toHaveLength(1);
    expect(list[0]!.name).toBe('無題 1.odt');
    expect(list[0]!.win, '窓の id が往復していない ── 同じ文書を束ねられない').toBe('win-XYZ');
    expect(list[0]!.at).toBe(4242);
    expect(list[0]!.key).toBe(put.key);
    expect(list[0]!.token, 'token を渡していないのに付いている').toBeUndefined();

    const bytes = await readStaged(asStageDir(dir), list[0]!);
    expect(bytes, 'bytes が読めない').not.toBeNull();
    expect(Array.from(bytes!)).toEqual(Array.from(doc));

    await discardStaged(asStageDir(dir), put.key);
    expect(await listStaged(asStageDir(dir))).toEqual([]);
    expect(dir.files.size, '.bin が残っている').toBe(0);
  });

  it('token を渡したら、引き取る側でそのまま読める', async () => {
    const dir = new FakeDir();
    const doc = new Uint8Array(10).fill(7);
    await stageJs.stageBytes({
      dir,
      size: doc.length,
      read: makeReader(doc).read,
      meta: { name: 'a.odt', token: 'lid1/ak9' },
    });
    const list = await listStaged(asStageDir(dir));
    expect(list[0]!.token, 'token が落ちている').toBe('lid1/ak9');
  });

  it('🔴 捨てるのは冪等(2 回呼んでも落ちない)', async () => {
    const dir = new FakeDir();
    await expect(discardStaged(asStageDir(dir), 'nope')).resolves.toBeUndefined();
    await expect(discardStaged(asStageDir(dir), 'nope')).resolves.toBeUndefined();
  });
});

describe('刻んで運ぶ(山を高くしない)', () => {
  it('🔴 器は CHUNK を超えない / 大きい文書は複数回に分けて読む', async () => {
    const dir = new FakeDir();
    const size = stageJs.CHUNK * 2 + 13;
    // ⚠ 実バイトは作らず、読み口だけを本物にする(2MB の配列を test で作らない)
    const state = { calls: 0, maxBuffer: 0 };
    await stageJs.stageBytes({
      dir,
      size,
      read: (into, wanted) => {
        state.calls += 1;
        state.maxBuffer = Math.max(state.maxBuffer, into.length);
        return wanted;
      },
      meta: { name: 'big.odt' },
    });
    expect(state.maxBuffer, '器が CHUNK より大きい ── 刻む意味が消えている').toBeLessThanOrEqual(
      stageJs.CHUNK,
    );
    expect(state.calls, '1 回で読み切っている(刻んでいない)').toBe(3);
    expect(dir.files.get([...dir.files.keys()].find((k) => k.endsWith('.bin'))!)!.bytes.length)
      .toBe(size);
  });

  it('小さい文書では、器を文書より大きく取らない', async () => {
    const dir = new FakeDir();
    const doc = new Uint8Array(64);
    const r = makeReader(doc);
    await stageJs.stageBytes({ dir, size: doc.length, read: r.read, meta: { name: 's.odt' } });
    expect(r.maxBuffer).toBe(64);
  });

  it('🔴 途中で読めなくなったら `.json` を置かない(半端な添付を作らない)', async () => {
    const dir = new FakeDir();
    await expect(
      stageJs.stageBytes({
        dir,
        size: 100,
        read: (into, wanted, position) => (position === 0 ? 0 : wanted),
        meta: { name: 'x.odt' },
      }),
    ).rejects.toThrow();
    expect(await listStaged(asStageDir(dir)), '半端なものが一覧に出た').toEqual([]);
  });

  it('空は置かない', async () => {
    const dir = new FakeDir();
    await expect(
      stageJs.stageBytes({ dir, size: 0, read: () => 0, meta: { name: 'x.odt' } }),
    ).rejects.toThrow();
  });
});

describe('壊れたもの・食い違うものを引き取らない', () => {
  it('🔴 大きさが meta と食い違う `.bin` は読まない(書きかけで上書きしない)', async () => {
    const dir = new FakeDir();
    const doc = new Uint8Array(100).fill(3);
    const put = await stageJs.stageBytes({
      dir,
      size: doc.length,
      read: makeReader(doc).read,
      meta: { name: 'x.odt' },
    });
    // 書きかけを模す(bytes だけ短くする)
    const bin = dir.files.get(`${put.key}.bin`)!;
    dir.files.set(`${put.key}.bin`, { ...bin, bytes: bin.bytes.subarray(0, 40) });
    const list = await listStaged(asStageDir(dir));
    expect(await readStaged(asStageDir(dir), list[0]!), '半端な bytes を通した').toBeNull();
  });

  it('知らない版の meta は読まない', async () => {
    const dir = new FakeDir();
    dir.files.set('o1.json', {
      bytes: new TextEncoder().encode(
        JSON.stringify({ v: OFFICE_STAGE_META_VERSION + 1, key: 'o1', name: 'a', size: 1 }),
      ),
      lastModified: 0,
    });
    expect(await listStaged(asStageDir(dir))).toEqual([]);
  });

  it('鍵と file 名が食い違う meta は触らない', async () => {
    const dir = new FakeDir();
    dir.files.set('o1.json', {
      bytes: new TextEncoder().encode(
        JSON.stringify({ v: OFFICE_STAGE_META_VERSION, key: 'o2', name: 'a', size: 1 }),
      ),
      lastModified: 0,
    });
    expect(await listStaged(asStageDir(dir))).toEqual([]);
  });

  it('古い順に並ぶ(先に保存したものから戻す)', async () => {
    const dir = new FakeDir();
    const doc = new Uint8Array(8).fill(1);
    await stageJs.stageBytes({
      dir, size: 8, read: makeReader(doc).read, key: 'ob', meta: { name: 'b' }, now: () => 200,
    });
    await stageJs.stageBytes({
      dir, size: 8, read: makeReader(doc).read, key: 'oa', meta: { name: 'a' }, now: () => 100,
    });
    expect((await listStaged(asStageDir(dir))).map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('掃除 ── 消してよいのは書きかけの残骸だけ', () => {
  it('🔴 揃っているものは掃除で消さない(引き取り損ねた保存を消さない)', async () => {
    const dir = new FakeDir();
    const doc = new Uint8Array(8).fill(1);
    dir.clock = 0;
    await stageJs.stageBytes({ dir, size: 8, read: makeReader(doc).read, meta: { name: 'a' } });
    const removed = await sweepStagedOrphans(asStageDir(dir), {
      now: () => STAGE_ORPHAN_GRACE_MS * 100,
    });
    expect(removed, '揃っているものを消した').toBe(0);
    expect(await listStaged(asStageDir(dir))).toHaveLength(1);
  });

  it('🔴 `.bin` だけの残骸は、猶予を過ぎたら消す', async () => {
    const dir = new FakeDir();
    dir.files.set('o9.bin', { bytes: new Uint8Array(4), lastModified: 0 });
    expect(await sweepStagedOrphans(asStageDir(dir), { now: () => STAGE_ORPHAN_GRACE_MS * 2 }))
      .toBe(1);
    expect(dir.files.size).toBe(0);
  });

  it('🔴 いま書いている最中の `.bin` は消さない(猶予の中)', async () => {
    const dir = new FakeDir();
    dir.files.set('o9.bin', { bytes: new Uint8Array(4), lastModified: 1000 });
    expect(
      await sweepStagedOrphans(asStageDir(dir), { now: () => 1000 + STAGE_ORPHAN_GRACE_MS - 1 }),
      '書いている最中の bin を消した ── 保存が壊れる',
    ).toBe(0);
    expect(dir.files.size).toBe(1);
  });
});

describe('鍵', () => {
  it('uuid があればそれを使い、無ければ時刻と連番で作る', () => {
    expect(stageJs.makeKey({ uuid: () => 'aa-bb-cc' })).toBe('oaabbcc');
    let n = 0;
    const mk = (): string => stageJs.makeKey({ now: () => 5, seq: () => (n += 1) });
    expect(mk()).not.toBe(mk());
  });

  it('🔴 鍵は file 名になるので ASCII だけ', () => {
    expect(stageJs.makeKey({ uuid: () => '1-2-3' })).toMatch(/^[\x21-\x7e]+$/);
  });
});

/**
 * 🔴 **OPFS から引き取る bytes は `Uint8Array` に落としてから渡す**(#211)。
 *
 * ⚠ これは「1 コピー減らせる」と**最適化して壊す**箇所である。IDB へ `Blob` を書くと、
 * `tx.oncomplete` が返っても **bytes が耐久化した証拠にはならない** ── `Blob` は
 * 発行した realm が生きている間しか換金できない借用証書で、実測では
 * **32MiB を書いた直後に発行元の窓を閉じると 7/7 で読めなくなった**
 * (`ERR_SOURCE_DIED_IN_TRANSIT` / `NotReadableError`。⚠ 256,000 B 以下は
 * IPC 同梱なので**小さい添付では再現しない**)。
 *
 * 🔑 だからここは **OPFS の `File` をそのまま返さない**。
 * ⚠ 注記だけでは守れない(コメントは実行されない)ので、**返る型で pin する**。
 */
describe('引き取る bytes の形(#211)', () => {
  it('🔴 `File` / `Blob` ではなく `Uint8Array` を返す(別 realm の借用証書を渡さない)', async () => {
    const dir = new FakeDir();
    const doc = new Uint8Array(64).map((_, i) => i);
    await stageJs.stageBytes({
      dir,
      size: doc.length,
      read: makeReader(doc).read,
      meta: { name: 'あ.docx', path: '/home/web_user/あ.docx' },
      now: () => 1,
    });
    const [meta] = await listStaged(asStageDir(dir));
    expect(meta, '置いたものが一覧に出ない').toBeDefined();
    const got = await readStaged(asStageDir(dir), meta!);
    expect(got, '読めていない').not.toBeNull();
    // 🔴 ここが本体 ── `Blob`(= `File` も含む)を返し始めたら落とす
    expect(got instanceof Uint8Array, '`Uint8Array` ではないものを返している').toBe(true);
    expect(got instanceof Blob, '`Blob` を返している(#211 の罠)').toBe(false);
    expect(Array.from(got!), '中身が違う').toEqual(Array.from(doc));
  });
});
