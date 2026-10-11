/** @vitest-environment node */
/**
 * 窓で編集した PDF が、新しい添付になるまでの鎖(#275 段②-1b)── 置く側(`public/pdf/edit-stage.js`)と
 * 引き取る側(`save-edited.ts`)を、**1 つの偽 OPFS で突き合わせる**。
 *
 * 🔴 守るもの:
 * 1. 棚の名前と meta の版が 2 つの file で同じ(片方だけ直すと、置いても誰も見つけられない)。
 *    ⚠ 棚は **Office の棚とは別** ── 取り違えると、Office の保存の引き取りが PDF を拾ってしまう。
 * 2. 往復: 窓が置いた bytes を、本体がそのまま(1 バイトも違えず)新しい添付の元にする。
 * 3. **元の添付と同じフォルダ**に置く(ID を `parentOf` で解く)/ 置いた後は棚を空にする(断った回も)。
 * 4. 書けないタブ・編集の途中・棚に無い鍵では**作らない**(窓へ理由を返す)。
 * 5. 掃除: 書きかけの残骸と、引き取られないまま 1 時間を過ぎた置き物は消す ── 今の鍵は消さない。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFICE_STAGE_DIR, OFFICE_STAGE_META_VERSION, type StageDir } from '@adapter/platform/office/office-stage';
import {
  PDF_STAGE_DIR,
  PDF_STAGE_STALE_MS,
  SAVE_BUSY,
  SAVE_NOT_HOLDER,
  SAVE_NO_STAGE,
  createSaveEdited,
  openPdfStageDir,
  type SaveEditedDeps,
} from '@adapter/platform/pdf/save-edited';
import type { PdfSession } from '@adapter/platform/pdf/pdf-window';

// ── 置く側(素の JS)を原文から読む ──
interface StageApi {
  STAGE_DIR: string;
  META_VERSION: number;
  CHUNK: number;
  makeKey(): string;
  stageBytes(deps: { dir: unknown; bytes: Uint8Array; name: string; key?: string; now?: () => number }): Promise<{
    key: string;
    name: string;
    size: number;
  }>;
}
function loadStage(): StageApi {
  const root: { PkcPdfEditStage?: StageApi } = {};
  new Function('self', readFileSync('public/pdf/edit-stage.js', 'utf-8'))(root);
  expect(root.PkcPdfEditStage, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfEditStage as StageApi;
}
const stageJs = loadStage();

// ── 偽 OPFS ──
class FakeDir {
  readonly files = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  clock = 1_000_000;
  writes = 0;
  /** 1 回の write の最大の大きさ(刻んで書いているかの観測点)。 */
  maxChunk = 0;
  getFileHandle = async (name: string, opts?: { create?: boolean }): Promise<unknown> => {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new Error(`NotFoundError: ${name}`);
      this.files.set(name, { bytes: new Uint8Array(0), lastModified: this.clock });
    }
    const files = this.files;
    return {
      getFile: async () => {
        const e = files.get(name);
        if (!e) throw new Error(`NotFoundError: ${name}`);
        return {
          size: e.bytes.length,
          lastModified: e.lastModified,
          arrayBuffer: async () => e.bytes.slice().buffer,
          text: async () => new TextDecoder().decode(e.bytes),
        };
      },
      createWritable: async () => {
        const parts: Uint8Array[] = [];
        return {
          write: async (chunk: Uint8Array | string) => {
            this.writes += 1;
            if (typeof chunk !== 'string') this.maxChunk = Math.max(this.maxChunk, chunk.length);
            parts.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk.slice());
          },
          close: async () => {
            const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let o = 0;
            for (const p of parts) {
              all.set(p, o);
              o += p.length;
            }
            files.set(name, { bytes: all, lastModified: this.clock });
          },
          abort: async () => undefined,
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
const asDir = (d: FakeDir): StageDir => d as unknown as StageDir;

const session: PdfSession = { token: 't1', assetKey: 'ast-1', name: '報告書.pdf', lid: 'L7' };
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]);

interface Made {
  name: string;
  bytes: Uint8Array;
  parentLid: string | null;
}
function rig(over: Partial<SaveEditedDeps> = {}): {
  dir: FakeDir;
  made: Made[];
  notices: { text: string; open: string }[];
  save: ReturnType<typeof createSaveEdited>;
} {
  const dir = new FakeDir();
  const made: Made[] = [];
  const notices: { text: string; open: string }[] = [];
  const save = createSaveEdited({
    stage: async () => asDir(dir),
    isHolder: () => true,
    canWrite: () => true,
    parentOf: (lid) => (lid === 'L7' ? 'F1' : null),
    createAttachment: async (a) => {
      made.push({ name: a.name, bytes: a.bytes, parentLid: a.parentLid });
      return 'NEW1';
    },
    notify: (text, open) => notices.push({ text, open }),
    now: () => dir.clock,
    ...over,
  });
  return { dir, made, notices, save };
}

describe('置く側と引き取る側の綴り', () => {
  it('🔴 棚の名前と meta の版が、窓の原文と本体で同じ / Office の棚とは別', () => {
    expect(stageJs.STAGE_DIR, '棚の名前が食い違うと、置いても誰も見つけられない').toBe(PDF_STAGE_DIR);
    expect(stageJs.META_VERSION).toBe(OFFICE_STAGE_META_VERSION);
    expect(PDF_STAGE_DIR).not.toBe(OFFICE_STAGE_DIR);
  });

  it('鍵は毎回違う(同じ時刻に 2 枚の窓が置いても重ならない)', () => {
    const keys = new Set(Array.from({ length: 20 }, () => stageJs.makeKey()));
    expect(keys.size).toBe(20);
  });
});

describe('往復 ── 窓が置いた bytes が、そのまま新しい添付になる', () => {
  it('同じフォルダ(元の添付の親)に、窓が言った名前で作り、棚を空にして、窓へ結果を返す', async () => {
    const g = rig();
    const staged = await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: '報告書 (編集).pdf' });
    const r = await g.save.receive(session, staged.key);
    expect(r).toEqual({ ok: true, message: '「報告書 (編集).pdf」を元の PDF と同じフォルダの添付に加えました' });
    expect(g.made).toHaveLength(1);
    const m = g.made[0] as Made;
    expect(m.name).toBe('報告書 (編集).pdf');
    expect([...m.bytes], '1 バイトも違えない').toEqual([...PDF_BYTES]);
    // 🔴 元の添付(L7)の親フォルダ(F1)へ。つながりは張らない(createAttachment は親しか受け取らない)
    expect(m.parentLid).toBe('F1');
    expect(g.notices).toEqual([{ text: '「報告書 (編集).pdf」を元の PDF と同じフォルダの添付に加えました', open: 'NEW1' }]);
    expect([...g.dir.files.keys()], '引き取った後に棚が残っている').toEqual([]);
  });

  it('元の添付がルートにあれば、ルートに作る(parentLid = null)/ lid が分からない窓でも作れる', async () => {
    const g = rig({ parentOf: () => null });
    const k1 = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'a (編集).pdf' })).key;
    await g.save.receive(session, k1);
    const k2 = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'b (編集).pdf' })).key;
    await g.save.receive({ ...session, lid: null }, k2);
    expect(g.made.map((m) => m.parentLid)).toEqual([null, null]);
  });

  it('名前の区切りは潰し、.pdf で終える', async () => {
    const g = rig();
    const k = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: '../x/メモ' })).key;
    await g.save.receive(session, k);
    expect((g.made[0] as Made).name).toBe('.._x_メモ.pdf');
  });

  it('大きな bytes は刻んで書く(1 度に丸ごと書かない)/ 窓は meta を最後に置く(.bin が先)', async () => {
    const g = rig();
    const big = new Uint8Array(stageJs.CHUNK * 2 + 10).fill(7);
    const before = g.dir.writes;
    await stageJs.stageBytes({ dir: g.dir, bytes: big, name: 'x.pdf', key: 'pbig' });
    // .bin を 3 回(1MiB, 1MiB, 10B)+ .json を 1 回
    expect(g.dir.writes - before).toBe(4);
    // 🔴 1 回の書き込みが CHUNK を超えない(回数だけ見ると、毎回丸ごと書く実装も 3 回で通る)/ 中身は 1 バイトも違わない
    expect(g.dir.maxChunk, '刻まず丸ごと書いている').toBeLessThanOrEqual(stageJs.CHUNK);
    expect(g.dir.files.get('pbig.bin')?.bytes.length).toBe(big.length);
    expect(g.dir.files.get('pbig.bin')?.bytes.every((b) => b === 7)).toBe(true);
    expect([...g.dir.files.keys()]).toEqual(['pbig.bin', 'pbig.json']);
  });
});

describe('作らない場面 ── 窓へ理由を返す', () => {
  it('🔴 書けるタブ(writer リース)でなければ作らない / この窓の置き物は棚へ残さず捨てる(誰も引き取らない)', async () => {
    const g = rig({ isHolder: () => false });
    const k = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'a.pdf' })).key;
    expect(await g.save.receive(session, k)).toEqual({ ok: false, message: SAVE_NOT_HOLDER });
    expect(g.made).toEqual([]);
    expect(g.dir.files.has(`${k}.bin`), '書けないタブの窓の置き物が棚に残っている(誰も引き取らず溜まる)').toBe(false);
    expect(g.dir.files.has(`${k}.json`)).toBe(false);
  });

  it('いま足せない相(canWrite が偽)では作らない。棚は捨てる(窓は編集を持っていて、押し直せる)', async () => {
    const g = rig({ canWrite: () => false });
    const k = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'a.pdf' })).key;
    expect(await g.save.receive(session, k)).toEqual({ ok: false, message: SAVE_BUSY });
    expect(g.made).toEqual([]);
    expect([...g.dir.files.keys()]).toEqual([]);
  });

  it('棚に無い鍵 / 棚が開けない環境 / 大きさが meta と食い違う書きかけ は作らない', async () => {
    const g = rig();
    expect(await g.save.receive(session, 'pnone')).toEqual({ ok: false, message: SAVE_NO_STAGE });
    const noDir = rig({ stage: async () => null });
    expect(await noDir.save.receive(session, 'pnone')).toEqual({ ok: false, message: SAVE_NO_STAGE });
    // 書きかけ: meta が言う大きさと .bin が違う
    const k = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'a.pdf', key: 'ptorn' })).key;
    g.dir.files.set(`${k}.bin`, { bytes: new Uint8Array(3), lastModified: g.dir.clock });
    expect(await g.save.receive(session, k)).toEqual({ ok: false, message: SAVE_NO_STAGE });
    expect(g.made).toEqual([]);
  });

  it('添付を作れなかった(null)/ 作る途中で落ちた は、窓へ「もう一度」と返し、棚は残さない', async () => {
    const g = rig({ createAttachment: async () => null });
    const k = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'a.pdf' })).key;
    const r = await g.save.receive(session, k);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('もう一度');
    expect(g.notices).toEqual([]);
    expect([...g.dir.files.keys()]).toEqual([]);
    const boom = rig({
      createAttachment: async () => {
        throw new Error('boom');
      },
    });
    const k2 = (await stageJs.stageBytes({ dir: boom.dir, bytes: PDF_BYTES, name: 'a.pdf' })).key;
    expect((await boom.save.receive(session, k2)).ok).toBe(false);
    expect([...boom.dir.files.keys()]).toEqual([]);
  });
});

describe('掃除', () => {
  it('引き取られないまま 1 時間を過ぎた置き物は消す ── 新しい物と、いま受けている鍵は消さない', async () => {
    const g = rig();
    const old = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'old.pdf', key: 'pold', now: () => g.dir.clock })).key;
    g.dir.clock += PDF_STAGE_STALE_MS + 1;
    const fresh = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'new.pdf', key: 'pnew', now: () => g.dir.clock })).key;
    const mine = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'mine.pdf', key: 'pmine', now: () => g.dir.clock })).key;
    await g.save.receive(session, mine);
    expect(g.dir.files.has(`${old}.json`), '古い置き物が残っている').toBe(false);
    expect(g.dir.files.has(`${old}.bin`)).toBe(false);
    expect(g.dir.files.has(`${fresh}.json`), '新しい物まで消した').toBe(true);
    expect(g.made.map((m) => m.name)).toEqual(['mine.pdf']);
  });

  it('猶予を過ぎた書きかけ(.bin だけ)は消す / 猶予内の書きかけは消さない', async () => {
    const g = rig();
    g.dir.files.set('porph.bin', { bytes: new Uint8Array(4), lastModified: g.dir.clock - 11 * 60 * 1000 });
    g.dir.files.set('pnow.bin', { bytes: new Uint8Array(4), lastModified: g.dir.clock });
    const k = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'a.pdf' })).key;
    await g.save.receive(session, k);
    expect(g.dir.files.has('porph.bin')).toBe(false);
    expect(g.dir.files.has('pnow.bin'), '書いている最中かもしれない物を消した').toBe(true);
  });
});

describe('同じ窓から続けて押しても、順に 1 件ずつ作る', () => {
  it('2 件を同時に受けても createAttachment は重ならない', async () => {
    let running = 0;
    let overlapped = false;
    const g = rig({
      createAttachment: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return 'N';
      },
    });
    const a = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'a.pdf' })).key;
    const b = (await stageJs.stageBytes({ dir: g.dir, bytes: PDF_BYTES, name: 'b.pdf' })).key;
    const [ra, rb] = await Promise.all([g.save.receive(session, a), g.save.receive(session, b)]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(overlapped).toBe(false);
  });
});

describe('棚を開く口', () => {
  it('作らずに見るだけ(create: false)/ OPFS が無い・棚が無い環境では null', async () => {
    const calls: unknown[] = [];
    const fake = {
      getDirectory: async () => ({
        getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
          calls.push([name, opts?.create]);
          return {} as StageDir;
        },
      }),
    };
    expect(await openPdfStageDir(fake)).not.toBeNull();
    expect(calls).toEqual([[PDF_STAGE_DIR, false]]);
    expect(await openPdfStageDir({ getDirectory: async () => ({ getDirectoryHandle: async () => Promise.reject(new Error('x')) }) })).toBeNull();
  });
});

describe('main.ts の配線(原文 pin ── main.ts は実行する test を持てない)', () => {
  /** 注釈を落とした main.ts(注釈が検査を満たさないように)。 */
  const code = readFileSync('src/main.ts', 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const at = code.indexOf('createSaveEdited({');
  const block = at === -1 ? '' : code.slice(at, code.indexOf('let pdfHost', at));

  it('⚠ 前提: 配線のブロックを取り出せている(空振り防止)', () => {
    expect(block.length).toBeGreaterThan(200);
  });

  it('窓の「置いた」は本体の受け口へ流れる / 窓の鍵は PdfReaderHost の onEdited から入る', () => {
    expect(code).toMatch(/onEdited:\s*\(session,\s*key\)\s*=>\s*pdfSaveEdited\.receive\(session,\s*key\)/);
  });

  it('🔴 元の添付と同じフォルダ(正準の親)へ、選択を動かさずに作る', () => {
    expect(block).toContain('resolveCanonicalParents(st.entryMetas, st.relations).get(lid)');
    expect(block).toContain('{ parentLid, keepSelection: true }');
  });

  it('🔴 書けるのは writer リースを持つタブだけ / 足せる相は ready か編集中だけ', () => {
    expect(block).toContain('isHolder: () => writerHolder');
    expect(block).toMatch(/phase === 'ready' \|\| phase === 'editing'/);
  });
});
