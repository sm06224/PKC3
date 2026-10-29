/** @vitest-environment happy-dom */
/**
 * 🔴 **「やめる」を .md / 連絡先 / 予定 / pptx の取り込みと、PKC3 入り HTML の書き出しにも付ける**(台帳 #1852 束 F2・依頼 253 の残り)。
 *
 * 観測点: ① やめたとき書き込み(`bulkUpsertEntries` / `download`)が**1 回も呼ばれない** ② 「やめました」と言う(失敗の `OP_FAILED` にしない)
 * ③ 印を渡さない配線(従来)は今までどおり最後まで走る(対照群)④ 入口(`importFiles`)が仕事の始まりと終わりを `JobControl` に渡す。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importMarkdownFiles, type MarkdownImportDeps } from '../../src/adapter/ui/actions/import-markdown';
import { importVcfFiles } from '../../src/adapter/ui/actions/import-vcf';
import { importIcsFiles } from '../../src/adapter/ui/actions/import-ics';
import { importPptxFiles } from '../../src/adapter/ui/actions/import-pptx';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import { exportPortable, type PortableExportDeps } from '../../src/adapter/ui/actions/export-portable';
import { IMPORT_CANCELLED_NOTE, type JobControl } from '../../src/adapter/ui/actions/job-control';
import { createCancelToken, OperationCancelled, type CancelToken } from '../../src/features/job-cancel';

function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      { lid: 'n1', title: 'ノート', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null },
    ],
    relations: [],
  });
  return d;
}

function importDeps() {
  const said: string[] = [];
  const written: unknown[][] = [];
  const failures: string[] = [];
  const deps: MarkdownImportDeps = {
    orderBase: () => 0,
    genLid: (() => {
      let n = 0;
      return () => `x${++n}`;
    })(),
    bulkUpsertEntries: async (rows) => {
      written.push([...rows]);
    },
    reload: async () => {},
    notify: (m) => said.push(m),
    reportFailure: (m) => failures.push(m),
  };
  return { deps, said, written, failures };
}

/** N 回目の区切りで `OperationCancelled` を投げる印(読みの途中でやめた形)。 */
function cancelOnNth(n: number): CancelToken {
  let calls = 0;
  return {
    cancelled: false,
    cancel() {},
    throwIfCancelled() {
      calls += 1;
      if (calls >= n) throw new OperationCancelled();
    },
  };
}

/** 区切りでは投げないが、書く直前には立っている印(書く前がやめられる最後の区切り)。 */
const cancelledBeforeWrite: CancelToken = { cancelled: true, cancel() {}, throwIfCancelled() {} };

const md = (name: string): File => new File(['# 見出し\n本文'], name, { type: 'text/markdown' });
const vcf = (name: string): File =>
  new File(['BEGIN:VCARD\nVERSION:3.0\nFN:山田 太郎\nTEL:03-1234-5678\nEND:VCARD\n'], name, { type: 'text/vcard' });
const ics = (name: string): File =>
  new File(
    ['BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:1\nDTSTART:20261020T140000\nSUMMARY:会議\nEND:VEVENT\nEND:VCALENDAR\n'],
    name,
    { type: 'text/calendar' },
  );
const pptx = (name: string): File => new File([new Uint8Array([0x50, 0x4b, 3, 4])], name);

type Runner = (d: Dispatcher, deps: MarkdownImportDeps, files: File[], token?: CancelToken) => Promise<number | null>;
const CASES: Array<[string, Runner, () => File[]]> = [
  ['.md', (d, deps, f, t) => importMarkdownFiles(d, deps, f, t), () => [md('a.md'), md('b.md')]],
  ['連絡先(.vcf)', (d, deps, f, t) => importVcfFiles(d, deps, f, t), () => [vcf('a.vcf'), vcf('b.vcf')]],
  ['予定(.ics)', (d, deps, f, t) => importIcsFiles(d, deps, f, t), () => [ics('a.ics'), ics('b.ics')]],
  ['PowerPoint(.pptx)', (d, deps, f, t) => importPptxFiles(d, deps, f, t), () => [pptx('a.pptx')]],
];

describe.each(CASES)('%s の取り込みは、読んでいる途中でやめられる', (_label, run, files) => {
  it('🔴 最初の区切りでやめたら、何も書かず「やめました」と言う(失敗にしない)', async () => {
    const d = booted();
    const { deps, said, written, failures } = importDeps();
    const errors: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: Parameters<typeof orig>[0]) => {
      if (a.type === 'OP_FAILED') errors.push((a as { error: string }).error);
      return orig(a);
    }) as typeof d.dispatch;
    const t = createCancelToken();
    t.cancel();
    expect(await run(d, deps, files(), t)).toBeNull();
    expect(written, 'やめたのに書き込んだ').toHaveLength(0);
    expect(said).toContain(IMPORT_CANCELLED_NOTE);
    expect(errors, 'やめたことを失敗として出した').toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe('.md の取り込み ── 区切りの位置', () => {
  it('🔴 2 本目を読む前の区切りでやめても、1 本目の分を書かない(半端なノートを残さない)', async () => {
    const d = booted();
    const { deps, said, written } = importDeps();
    expect(await importMarkdownFiles(d, deps, [md('a.md'), md('b.md')], cancelOnNth(2))).toBeNull();
    expect(written).toHaveLength(0);
    expect(said).toEqual([IMPORT_CANCELLED_NOTE]);
  });

  it('🔴 読み終えた後・書く直前にやめても、書かない', async () => {
    const d = booted();
    const { deps, said, written } = importDeps();
    expect(await importMarkdownFiles(d, deps, [md('a.md')], cancelledBeforeWrite)).toBeNull();
    expect(written).toHaveLength(0);
    expect(said).toEqual([IMPORT_CANCELLED_NOTE]);
  });

  it('対照群: 印を渡さない(従来の配線)/ 立てない印は、最後まで走って書く', async () => {
    for (const token of [undefined, createCancelToken()]) {
      const d = booted();
      const { deps, said, written } = importDeps();
      expect(await importMarkdownFiles(d, deps, [md('a.md'), md('b.md')], token)).toBe(2);
      expect(written).toHaveLength(1);
      expect(said.join()).toContain('取り込み完了');
    }
  });
});

describe('入口(importFiles)が仕事の始まりと終わりを JobControl に渡す', () => {
  function fakeJob() {
    const log: string[] = [];
    const token = createCancelToken();
    const job: JobControl = {
      start: (kind) => {
        log.push(`start:${kind}`);
        return token;
      },
      finish: (t) => {
        log.push(t === token ? 'finish' : 'finish:other');
      },
      cancelCurrent: () => token.cancelled === false && (token.cancel(), true),
    };
    return { job, log, token };
  }

  it('🔴 .md / .vcf / .ics / .pptx のどれも、始めて必ず終える。成功した回も終える', async () => {
    for (const files of [[md('a.md')], [vcf('a.vcf')], [ics('a.ics')]]) {
      const d = booted();
      const { deps } = importDeps();
      const { job, log } = fakeJob();
      await importFiles(d, { ...deps, job } as never, files);
      expect(log, '始めて終えていない').toEqual(['start:import', 'finish']);
    }
    // pptx は読めない中身で失敗するが、失敗した回も終える(欄を残さない)
    const d = booted();
    const { deps } = importDeps();
    const { job, log } = fakeJob();
    await importFiles(d, { ...deps, job } as never, [pptx('a.pptx')]);
    expect(log).toEqual(['start:import', 'finish']);
  });

  it('🔴 欄の「やめる」(印が立つ)と、読みがそこで止まる ── 入口から読み口まで 1 本で繋がっている', async () => {
    const d = booted();
    const { deps, said, written } = importDeps();
    const { job, token } = fakeJob();
    token.cancel(); // user が押した
    await importFiles(d, { ...deps, job } as never, [md('a.md')]);
    expect(written).toHaveLength(0);
    expect(said).toContain(IMPORT_CANCELLED_NOTE);
  });

  it('対照群: JobControl が無い配線は、これまでどおり書く', async () => {
    const d = booted();
    const { deps, written } = importDeps();
    await importFiles(d, deps as never, [md('a.md')]);
    expect(written).toHaveLength(1);
  });
});

describe('PKC3 入り HTML の書き出しも、途中でやめられる', () => {
  const TEMPLATE =
    '<!doctype html><html><head><script type="application/json" data-pkc-bundle>{"id":"pkcb-template","exportedAt":0}</script></head><body></body></html>';

  function portableDeps(over: Partial<PortableExportDeps> = {}) {
    const order: string[] = [];
    const said: string[] = [];
    const base: PortableExportDeps = {
      title: '器',
      fetchTemplate: async () => {
        order.push('template');
        return TEMPLATE;
      },
      exportImage: async () => {
        order.push('image');
        return new Uint8Array([1, 2, 3, 4]);
      },
      listAssets: async () => [{ key: 'k1', mime: 'image/png' }, { key: 'k2', mime: 'image/png' }],
      getAsset: async () => {
        order.push('asset');
        return new Blob([new Uint8Array([1])], { type: 'image/png' });
      },
      download: () => order.push('download'),
      notify: (m) => said.push(m),
      report: () => {},
      settle: async () => {},
      insideBundle: () => false,
      now: () => new Date(Date.UTC(2026, 9, 29, 12)),
      mintId: () => 'pkcb-aabbccddeeff0011',
      ...over,
    };
    return { base, order, said };
  }

  function fakeJob(token: CancelToken) {
    const log: string[] = [];
    const job: JobControl = {
      start: (kind) => {
        log.push(`start:${kind}`);
        return token;
      },
      finish: () => log.push('finish'),
      cancelCurrent: () => false,
    };
    return { job, log };
  }

  it('🔴 始めた直後にやめたら、ダウンロードしない・「やめました」と言う・失敗にしない・欄は片づく', async () => {
    const d = booted();
    const errors: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: Parameters<typeof orig>[0]) => {
      if (a.type === 'OP_FAILED') errors.push((a as { error: string }).error);
      return orig(a);
    }) as typeof d.dispatch;
    const t = createCancelToken();
    t.cancel();
    const { job, log } = fakeJob(t);
    const { base, order, said } = portableDeps({ job });
    expect(await exportPortable(d, base)).toBeNull();
    expect(order, 'やめたのにダウンロードした').not.toContain('download');
    expect(said).toContain('書き出しをやめました(ファイルは作っていません)');
    expect(errors).toEqual([]);
    expect(log).toEqual(['start:export', 'finish']);
  });

  it('🔴 添付を焼いている途中の区切りでやめても、ダウンロードしない', async () => {
    const d = booted();
    let n = 0;
    const t: CancelToken = {
      cancelled: false,
      cancel() {},
      throwIfCancelled() {
        n += 1;
        // settle 後・image 前・image 後・template 後(= 4 回)を通し、最初の添付の手前(5 回目)でやめる
        if (n >= 5) throw new OperationCancelled();
      },
    };
    const { job } = fakeJob(t);
    const { base, order, said } = portableDeps({ job });
    expect(await exportPortable(d, base)).toBeNull();
    expect(order, '添付を 1 件も読む前にやめた形になっていない(前提)').toContain('template');
    expect(order).not.toContain('download');
    expect(said).toContain('書き出しをやめました(ファイルは作っていません)');
  });

  it('対照群: JobControl が無い配線は、これまでどおりダウンロードまで走る', async () => {
    const d = booted();
    const { base, order } = portableDeps();
    expect(await exportPortable(d, base)).toBe(2);
    expect(order).toContain('download');
  });

  it('対照群: やめない仕事も、終わったら欄を片づける(成功の出口)', async () => {
    const d = booted();
    const t = createCancelToken();
    const { job, log } = fakeJob(t);
    const { base, order } = portableDeps({ job });
    await exportPortable(d, base);
    expect(order).toContain('download');
    expect(log).toEqual(['start:export', 'finish']);
  });
});

describe('main.ts の配線(原文 pin)', () => {
  it('🔴 PKC3 入り HTML の書き出しも jobs を受ける', async () => {
    const { readFileSync } = await import('node:fs');
    const MAIN = readFileSync('src/main.ts', 'utf8');
    const at = MAIN.indexOf('const runExportPortable');
    expect(at, '前提が崩れている').toBeGreaterThan(0);
    const body = MAIN.slice(at, MAIN.indexOf('const runExport =', at));
    expect(body).toContain('job: jobs,');
  });
});

// 未使用警告を避ける(vi は他の test で使うため import している)
void vi;
