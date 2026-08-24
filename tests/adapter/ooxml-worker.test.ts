/** @vitest-environment node */
/**
 * 🔴 **OOXML(Word / PowerPoint)の組み立てをワーカーで回す**(#187 段④・段⑤)。
 *
 * ⚠ **node 環境で回す** ── happy-dom は `self`(= window)を持っているので、
 * worker が `self.onmessage` に差した先が**こちらの偽物ではなく window** になり、
 * 口を叩けない(実際に踏んだ)。ワーカーの中に DOM は無いので node が正しい。
 *
 * 「worker の中だから unit では届かない」は誤り(CLAUDE.md 検証の規律)──
 * `self` を差して実物を dynamic import すれば node で回る。
 *
 * ⚠ ここが見るのは **2 つ**:
 * ① worker の口(id を返す / 失敗を返す / 中身が同じ)
 * ② **ワーカーが居ない環境でも同じ zip が出る**(落とし所)── ワーカーは
 *    速さの話であって正しさの話ではないので、食い違ったらどちらかが嘘になる。
 */
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { assembleOoxml, type OoxmlJob } from '../../src/adapter/platform/export/ooxml-assemble';
import { buildOoxmlFile, setOoxmlWorkerSpawn } from '../../src/adapter/platform/export/ooxml-client';
import type { DocxBlock } from '../../src/features/export/docx';
import { readZipDirectory, readZipText } from '../../src/features/import/zip-reader';

interface Ctx {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(msg: unknown): void;
}

const sent: unknown[] = [];
const ctx: Ctx = { onmessage: null, postMessage: (m) => sent.push(m) };

beforeAll(async () => {
  (globalThis as Record<string, unknown>).self = ctx;
  await import('../../src/adapter/platform/export/ooxml-worker');
});

beforeEach(() => {
  sent.length = 0;
});

const BLOCKS: DocxBlock[] = [
  { kind: 'h', level: 1, runs: [{ text: '題' }] },
  { kind: 'p', runs: [{ text: '本文' }] },
];
const JOB: OoxmlJob = {
  kind: 'docx',
  blocks: BLOCKS,
  title: 'ノート',
  iso: '2026-08-17T00:00:00.000Z',
  pageFormat: 'a4-portrait',
  media: [],
};

/** worker へ 1 件流して、返った応答を取る。 */
async function send(id: number, job: OoxmlJob = JOB): Promise<unknown> {
  // 🔴 **`WorkerLease` が包む形で叩く**(`{ id, payload }`)── 平らな形で叩くと、
  //    **実際には決して通らない形**を test していることになる(実際に踏んだ)
  ctx.onmessage!({ data: { id, payload: job } });
  // ⚠ 組み立ては非同期(zip の add が await)── 1 手番待ってから読む
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  return sent.at(-1);
}

describe('ooxml worker', () => {
  it('🔴 zip を返し、id をそのまま返す(応答の対応が崩れない)', async () => {
    const res = (await send(42)) as { id: number; ok: boolean; result: { blob: Blob } };
    expect(res.id).toBe(42);
    expect(res.ok).toBe(true);
    expect(res.result.blob.size, '空の zip が返っている').toBeGreaterThan(1000);
    expect((await res.result.blob.text()).slice(0, 2)).toBe('PK');
  });

  it('🔴 中身は同期経路と同じ(ワーカーは速さの話であって正しさの話ではない)', async () => {
    const res = (await send(1)) as { result: { blob: Blob } };
    const direct = await assembleOoxml(JOB);
    expect(await res.result.blob.text()).toBe(await direct.blob.text());
    expect(direct.counts.blocks).toBe(BLOCKS.length);
  });

  it('🔴 失敗は理由つきで返す(黙って返らないを作らない)', async () => {
    const res = (await send(7, {
      ...JOB,
      // ⚠ **実際に投げる入力**にする(壊れた塊は型の上でしか作れないうえ、
      //    組み立ては落ちずに素通りする)── bytes が無い media で zip が投げる
      media: [{ name: 'word/media/x.png', blob: null as unknown as Blob }],
    })) as { id: number; ok: boolean; error?: string };
    expect(res.id).toBe(7);
    expect(res.ok).toBe(false);
    expect(res.error ?? '', '理由が空').not.toBe('');
  });
});

describe('ooxml client の落とし所', () => {
  it('🔴 ワーカーが無い環境でも、同じ zip が出る', async () => {
    // node には `Worker` が無い ── 既定でこの経路に落ちる
    const viaClient = await buildOoxmlFile(JOB);
    const direct = await assembleOoxml(JOB);
    expect(await viaClient.blob.text()).toBe(await direct.blob.text());
  });

  /**
   * 🔴 **ワーカーが事故っても書き出しは落ちない**(押しても何も落ちてこない、を作らない)。
   * ⚠ 起動に失敗する spawn を渡して、その場で組み直すことを見る。
   */
  it('🔴 ワーカーが失敗したら、その場で組み直す', async () => {
    setOoxmlWorkerSpawn(() => {
      throw new Error('spawn 失敗');
    });
    try {
      const res = await buildOoxmlFile(JOB);
      expect((await res.blob.text()).slice(0, 2)).toBe('PK');
    } finally {
      setOoxmlWorkerSpawn(null);
    }
  });
});

/**
 * 🔴 **client → lease → worker → client を通す**(#187 段④)。
 *
 * ⚠ ここまでの test は「worker の口を直に叩く」「落とし所へ落ちる」の 2 つで、
 * **client が実際にワーカーで組む道は 1 度も通っていなかった** ── しかも
 * 通らなくても zip は落ちてくる(落とし所が拾う)ので、**気づけない**。
 * 実際、`WorkerLease` が `{ id, payload }` で包むことを読み違えたまま
 * 「動いている」と見えていた(平らな形で叩く test しか無かったため)。
 */
describe('client からワーカーへ実際に流れる', () => {
  /** 本物と同じ口を持つ偽ワーカー(受けた job をその場で組んで返す)。 */
  class FakeWorker {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    onmessageerror: unknown = null;
    terminated = false;
    postMessage(msg: { id: number; payload: OoxmlJob }): void {
      void assembleOoxml(msg.payload).then((result) => {
        this.onmessage?.({ data: { id: msg.id, ok: true, result } });
      });
    }
    terminate(): void {
      this.terminated = true;
    }
  }

  it('🔴 ワーカーが組んだ zip がそのまま返る + ワーカーは使い回す', async () => {
    const made: FakeWorker[] = [];
    setOoxmlWorkerSpawn(() => {
      const w = new FakeWorker();
      made.push(w);
      return w as unknown as Worker;
    });
    try {
      const a = await buildOoxmlFile(JOB);
      const b = await buildOoxmlFile(JOB);
      const direct = await assembleOoxml(JOB);
      // ① ワーカー経由でも中身は同じ
      expect(await a.blob.text()).toBe(await direct.blob.text());
      expect(await b.blob.text()).toBe(await direct.blob.text());
      // ② 🔴 **2 回目で作り直さない**(遅延起動 + 使い回し ── 不可侵指示の規律)
      expect(made, 'ワーカーを毎回作り直している').toHaveLength(1);
      // ③ 空振り防止 ── 偽ワーカーが**本当に呼ばれた**(落とし所で組んでいない)
      expect(made[0]!.terminated).toBe(false);
    } finally {
      setOoxmlWorkerSpawn(null);
    }
  });

  it('⚠ ワーカーが黙って壊れた応答を返しても、書き出しは落ちない', async () => {
    setOoxmlWorkerSpawn(
      () =>
        ({
          onmessage: null,
          postMessage(msg: { id: number }) {
            (this as unknown as FakeWorker).onmessage?.({
              data: { id: msg.id, ok: false, error: '壊れた' },
            });
          },
          terminate() {},
        }) as unknown as Worker,
    );
    try {
      const res = await buildOoxmlFile(JOB);
      expect((await res.blob.text()).slice(0, 2)).toBe('PK');
    } finally {
      setOoxmlWorkerSpawn(null);
    }
  });
});

/**
 * 🔴 **bytes は rels が指す先に入る**(#187 段⑤)。
 *
 * ⚠ ここまで、この対は **2 つの file に分かれて**いた ── 指す先を書くのは
 * `docx.ts` / `pptx.ts`(純関数)、bytes を置くのは呼び側だった。
 * つまり**片方だけ直すと「rels は在るのに絵が出ない」**という、
 * 開くまで分からない形で壊れる(CLAUDE.md §7)。
 * 🔑 いまは置く場所を `ooxml-assemble.ts` が決めるので、**ここで対を検める**。
 */
describe('宣言されて・実在して・指されて(bytes まで)', () => {
  const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
  const WITH_IMAGE: DocxBlock[] = [
    { kind: 'h', level: 1, runs: [{ text: '章' }] },
    { kind: 'p', runs: [{ text: '本文' }] },
    { kind: 'image', media: 'media/image1.png', widthPx: 100, heightPx: 50, alt: '絵' },
  ];

  /** zip の中の名前を全部。 */
  const namesOf = async (blob: Blob): Promise<Set<string>> =>
    new Set((await readZipDirectory(blob)).map((e) => e.name));

  /** `a/_rels/b.xml.rels` の中の相対 Target を、zip の名前へ畳む。 */
  const resolve = (relsName: string, target: string): string => {
    const base = relsName.replace(/_rels\/[^/]+$/, '');
    return (base + target)
      .split('/')
      .reduce<string[]>((acc, seg) => {
        if (seg === '..') acc.pop();
        else if (seg !== '' && seg !== '.') acc.push(seg);
        return acc;
      }, [])
      .join('/');
  };

  for (const [kind, root] of [
    ['docx', 'word'],
    ['pptx', 'ppt'],
  ] as const) {
    it(`🔴 ${kind}: rels が指す先が zip に実在する(画像も含めて)`, async () => {
      const job: OoxmlJob =
        kind === 'docx'
          ? {
              kind: 'docx',
              blocks: WITH_IMAGE,
              title: 'ノート',
              iso: '2026-08-24T00:00:00.000Z',
              pageFormat: 'a4-portrait',
              media: [{ name: 'media/image1.png', blob: PNG }],
            }
          : {
              kind: 'pptx',
              blocks: WITH_IMAGE,
              title: 'ノート',
              media: [{ name: 'media/image1.png', blob: PNG }],
            };
      const { blob } = await assembleOoxml(job);
      const entries = await readZipDirectory(blob);
      const names = await namesOf(blob);
      // ⚠ 空振り防止 ── bytes が本当に入っていること
      expect(names.has(`${root}/media/image1.png`), 'bytes が入っていない').toBe(true);
      let checkedImages = 0;
      for (const e of entries) {
        if (!e.name.endsWith('.rels')) continue;
        const text = await readZipText(blob, e);
        for (const m of text.matchAll(/Type="([^"]+)"\s+Target="([^"]+)"/g)) {
          const [, type, target] = m;
          if (/^https?:/.test(target!)) continue;
          const joined = resolve(e.name, target!);
          expect(names.has(joined), `rels が指す先が無い: ${joined}(${e.name})`).toBe(true);
          if (type!.endsWith('/image')) checkedImages += 1;
        }
      }
      // 🔴 **画像の rels を 1 件も見ずに「全部通った」と言わない**
      expect(checkedImages, '画像の関係を 1 件も検めていない').toBe(1);
    });
  }

  it('🔴 pptx も同じ道を通る(ワーカーの落とし所も同じ zip を返す)', async () => {
    const job: OoxmlJob = { kind: 'pptx', blocks: BLOCKS, title: 'ノート', media: [] };
    const viaClient = await buildOoxmlFile(job);
    const direct = await assembleOoxml(job);
    expect(await viaClient.blob.text()).toBe(await direct.blob.text());
    // ⚠ 空振り防止 ── pptx の部品が本当に入っていること
    expect(await namesOf(viaClient.blob)).toContain('ppt/slides/slide1.xml');
  });
});
