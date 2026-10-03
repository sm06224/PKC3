/**
 * 🔴 **窓が書いた編集の控え(影)を、本体が読む・消す**(#1228 段 2)。
 *
 * 書く側(`public/office/office-shadow.js`)と読む側(`office-shadow-shelf.ts`)は**別 realm・別 process** で、
 * 共有できるのは棚の名前と file の綴りだけ。だから**実物の書く側が書いた棚を、実物の読む側が読む**
 * (どちらも相手を模した偽物と話さない ── CLAUDE.md §7「両端が stub と話していると、綴りの食い違いが緑のまま通る」)。
 *
 * 守る主張:
 * 1. 綴りの parity ── 棚の名前 / meta の名前 / 影の名前 / 棚 id の規則(窓の `safeId`)
 * 2. 窓が書いた棚を読む(最新 1 つ・meta なしでも引ける・別のノートと取り違えない)
 * 3. 消すのは「保存済みの版で開く」と 7 日超過だけ。古く見えるだけの影・meta が無い影・空の棚・書き途中の棚は消さない
 * 4. 在るかもしれない(同期)/ 訊くべき(正本より新しい物だけ)/ 投げない
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OFFICE_SHADOW_META,
  OFFICE_SHADOW_SHELF,
  SHADOW_MAX_AGE_MS,
  shadowShelfId,
} from '../../src/features/office/office-shadow';
import {
  createOfficeShadows,
  discardShadow,
  findShadow,
  listShadows,
  openShadowShelf,
  readShadow,
  sweepShadows,
  type ShadowDir,
} from '../../src/adapter/platform/office/office-shadow-shelf';

// ───────────────────────── 偽の OPFS(書く側 = 窓の JS が使う口と、読む側が使う口の両方を持つ) ─────────────────────────

class FakeFile {
  data = new Uint8Array(0);
}
class FakeDir {
  files = new Map<string, FakeFile>();
  dirs = new Map<string, FakeDir>();
  async getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(n);
    if (!d) {
      if (!o?.create) throw new Error('NotFoundError');
      d = new FakeDir();
      this.dirs.set(n, d);
    }
    return d;
  }
  async getFileHandle(n: string, o?: { create?: boolean }) {
    let f = this.files.get(n);
    if (!f) {
      if (!o?.create) throw new Error('NotFoundError');
      f = new FakeFile();
      this.files.set(n, f);
    }
    const file = f;
    return {
      async createWritable() {
        const chunks: Uint8Array[] = [];
        let written = 0;
        return {
          async write(c: Uint8Array) { chunks.push(c.slice()); written += c.length; },
          async close() {
            const all = new Uint8Array(written);
            let o2 = 0;
            for (const c of chunks) { all.set(c, o2); o2 += c.length; }
            file.data = all;
          },
          async abort() { chunks.length = 0; },
        };
      },
      async getFile() {
        return {
          size: file.data.length,
          arrayBuffer: async () => file.data.slice().buffer as ArrayBuffer,
          text: async () => new TextDecoder().decode(file.data),
        };
      },
    };
  }
  async removeEntry(n: string, o?: { recursive?: boolean }) {
    const d = this.dirs.get(n);
    // ⚠ 本物の OPFS と同じ意味論(CLAUDE.md §3「stub は本物の意味論を真似る」): 空でない棚は
    //   `recursive` 無しだと InvalidModificationError ── これが無いと `{ recursive: true }` を落とす変異が生き延びる
    if (d !== undefined && !o?.recursive && d.files.size + d.dirs.size > 0) throw new Error('InvalidModificationError');
    if (!this.files.delete(n) && !this.dirs.delete(n)) throw new Error('NotFoundError');
  }
  async *keys() { for (const k of [...this.files.keys(), ...this.dirs.keys()]) yield k; }
  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const k of this.files.keys()) yield [k, { kind: 'file' }];
    for (const k of this.dirs.keys()) yield [k, { kind: 'directory' }];
  }
  async getDirectory() { return this; }
}

interface WindowApi {
  SHELF_DIR: string;
  META_NAME: string;
  safeId(token: string, fallback: string): string;
  shelve(d: {
    storage: unknown; id: string; ext: string; size: number; now(): number;
    read(into: Uint8Array, wanted: number, position: number): number;
    origin?: { name: string; size: number; lid?: string } | null;
  }): Promise<{ at: number; name: string; meta: boolean }>;
}
function loadWindow(): WindowApi {
  const src = readFileSync('public/office/office-shadow.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  return scope.PKC3OfficeShadow as WindowApi;
}
const win = loadWindow();

/** 実物の窓が書いたのと同じ形で、ノート(lid)の控えを 1 つ置く。 */
async function writeFromWindow(
  root: FakeDir,
  lid: string,
  at: number,
  opts: { ext?: string; bytes?: number[]; name?: string } = {},
): Promise<void> {
  const bytes = opts.bytes ?? [1, 2, 3, 4];
  await win.shelve({
    storage: root,
    id: win.safeId(lid, 'w-X'),
    ext: opts.ext ?? 'docx',
    size: bytes.length,
    now: () => at,
    read: (into, wanted, pos) => { for (let i = 0; i < wanted; i += 1) into[i] = bytes[pos + i]!; return wanted; },
    origin: { name: opts.name ?? '報告.docx', size: 99, lid },
  });
}
const shelfOf = (root: FakeDir): FakeDir | undefined => root.dirs.get(OFFICE_SHADOW_SHELF);
const NOW = 1_800_000_000_000;

describe('🔴 書く側と読む側の綴りの突き合わせ', () => {
  it('棚の名前 / meta の名前は、窓の file と同じ', () => {
    expect(OFFICE_SHADOW_SHELF).toBe(win.SHELF_DIR);
    expect(OFFICE_SHADOW_META).toBe(win.META_NAME);
    expect(OFFICE_SHADOW_SHELF, '取り込みの棚と取り違えた').not.toBe('pkc3-office-stage');
  });

  it('棚 id の規則は窓の safeId と同じ(lid の綴りを潰す規則・長さ・手元の file は棚を持たない)', () => {
    const lids = ['lid-1', 'e12_ab', 'a:b', 'あいう', 'x'.repeat(200), 'a/b\\c', ''];
    for (const lid of lids) {
      const id = shadowShelfId(lid);
      if (lid === '') expect(id).toBeNull();
      else expect(id, `lid=${JSON.stringify(lid)}`).toBe(win.safeId(lid, 'FALLBACK'));
    }
    // 手元の file(local:)は窓が窓ごとの棚へ書く ── 読む側は lid として引かない
    expect(shadowShelfId('local:1')).toBeNull();
    expect(win.safeId('local:1', 'w-A')).toBe('w-A');
    // 潰した結果が空になる綴り(全部記号)は窓が代わりの id を使う ── 読む側は棚を持てない扱い
    expect(shadowShelfId('::')).not.toBeNull();   // '__' になる(空ではない)
  });
});

describe('🔴 窓が書いた棚を読む', () => {
  it('実物の窓が書いた控えを、ノートの lid で引く(最新 1 つ・時刻・拡張子・元の文書の名前)', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', 1_800_000_000_000, { ext: 'odt' });
    await writeFromWindow(root, 'lid-1', 1_800_000_005_000, { ext: 'docx', name: '議事録.docx' });
    await writeFromWindow(root, 'lid-2', 1_800_000_001_000);
    const shelf = (await openShadowShelf(root as never))!;
    expect(shelf).toBeTruthy();
    const e = await findShadow(shelf, 'lid-1');
    expect(e).toMatchObject({ id: 'lid-1', at: 1_800_000_005_000, ext: 'docx', docName: '議事録.docx', lid: 'lid-1' });
    expect(Array.from((await readShadow(shelf, e!))!)).toEqual([1, 2, 3, 4]);
    expect((await listShadows(shelf)).map((x) => x.id).sort()).toEqual(['lid-1', 'lid-2']);
    expect(await findShadow(shelf, 'lid-none'), '別のノートの控えを返した').toBeNull();
    expect(await findShadow(shelf, 'local:1')).toBeNull();
  });

  it('🔴 meta.json が無くても控えは引ける(窓が meta を書き損ねた user の唯一の控えを引けなくしない)', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', 1_800_000_000_000);
    shelfOf(root)!.dirs.get('lid-1')!.files.delete('meta.json');
    const shelf = (await openShadowShelf(root as never))!;
    const e = await findShadow(shelf, 'lid-1');
    expect(e, 'meta が無いので控えを引けない').toMatchObject({ at: 1_800_000_000_000, ext: 'docx', docName: '', lid: '' });
    expect(Array.from((await readShadow(shelf, e!))!)).toEqual([1, 2, 3, 4]);
  });

  it('meta.json が壊れていても / 知らない版でも控えは引く。meta の lid が別のノートなら取り違えない', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', 1_800_000_000_000);
    const dir = shelfOf(root)!.dirs.get('lid-1')!;
    const put = (text: string) => { const f = new FakeFile(); f.data = new TextEncoder().encode(text); dir.files.set('meta.json', f); };
    const shelf = (await openShadowShelf(root as never))!;
    put('{ not json');
    expect(await findShadow(shelf, 'lid-1')).toMatchObject({ at: 1_800_000_000_000, lid: '' });
    put(JSON.stringify({ v: 9, lid: 'lid-X', name: 'x' }));
    expect(await findShadow(shelf, 'lid-1'), '知らない版の meta を解釈した').toMatchObject({ lid: '', docName: '' });
    // 綴りを潰すと別のノートが同じ棚へ落ちる('a:b' と 'a_b')── meta の lid が違えば取り違えない
    put(JSON.stringify({ v: 1, lid: 'lid_1', name: 'x', at: 1, ext: 'docx' }));
    expect(await findShadow(shelf, 'lid-1'), '別のノートの控えを返した').toBeNull();   // 棚は 'lid-1' だが meta は 'lid_1' のノートの物
  });

  it('控えの名前でない file(meta.json / 別の拡張子の残骸)を控えと取り違えない / 控えの無い棚は無いものとして扱う', async () => {
    const root = new FakeDir();
    const shelf0 = await root.getDirectoryHandle(OFFICE_SHADOW_SHELF, { create: true });
    const dir = await shelf0.getDirectoryHandle('lid-1', { create: true });
    dir.files.set('meta.json', new FakeFile());
    dir.files.set('notes.txt', new FakeFile());
    dir.files.set('123.docx', new FakeFile());   // 13 桁でない
    const shelf = (await openShadowShelf(root as never))!;
    expect(await findShadow(shelf, 'lid-1')).toBeNull();
    expect(await listShadows(shelf)).toEqual([]);
  });

  it('棚が無い / OPFS が無い環境では「控えは無い」(落とさない)', async () => {
    expect(await openShadowShelf(new FakeDir() as never)).toBeNull();
    expect(await openShadowShelf({ getDirectory: async () => { throw new Error('SecurityError'); } } as never)).toBeNull();
  });

  it('空の控え(0 byte)は返さない', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', 1_800_000_000_000);
    shelfOf(root)!.dirs.get('lid-1')!.files.get('1800000000000.docx')!.data = new Uint8Array(0);
    const shelf = (await openShadowShelf(root as never))!;
    expect(await readShadow(shelf, (await findShadow(shelf, 'lid-1'))!)).toBeNull();
  });
});

describe('🔴 消すのは 2 つだけ(保存済みの版で開く / 7 日超過)', () => {
  it('discardShadow は指したノートの棚だけ消す。冪等・手元の file は触れない', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', NOW);
    await writeFromWindow(root, 'lid-2', NOW);
    const shelf = (await openShadowShelf(root as never))!;
    expect(await discardShadow(shelf, 'lid-1')).toBe(true);
    expect(shelfOf(root)!.dirs.has('lid-1')).toBe(false);
    expect(shelfOf(root)!.dirs.has('lid-2'), '別のノートの控えを消した').toBe(true);
    expect(await discardShadow(shelf, 'lid-1')).toBe(false);
    expect(await discardShadow(shelf, 'local:1')).toBe(false);
  });

  it('sweep: 7 日を過ぎた棚だけ消す(ちょうど 7 日は残す)。meta が無い棚・空の棚・書き途中の棚は消さない', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'old', NOW - SHADOW_MAX_AGE_MS - 1);
    await writeFromWindow(root, 'edge', NOW - SHADOW_MAX_AGE_MS);
    await writeFromWindow(root, 'fresh', NOW - 60_000);
    // meta が無い古い棚 ── 控えは引ける(7 日を過ぎていれば消える。過ぎていなければ残る)
    await writeFromWindow(root, 'nometa-old', NOW - SHADOW_MAX_AGE_MS - 5000);
    shelfOf(root)!.dirs.get('nometa-old')!.files.delete('meta.json');
    await writeFromWindow(root, 'nometa-fresh', NOW - 5000);
    shelfOf(root)!.dirs.get('nometa-fresh')!.files.delete('meta.json');
    // 空の棚(窓が最初の控えを書いている最中かもしれない)
    await shelfOf(root)!.getDirectoryHandle('empty', { create: true });
    const shelf = (await openShadowShelf(root as never))!;
    const removed = await sweepShadows(shelf, { now: () => NOW });
    expect(removed).toBe(2);
    expect([...shelfOf(root)!.dirs.keys()].sort()).toEqual(['edge', 'empty', 'fresh', 'nometa-fresh']);
  });
});

describe('🔴 「Office で開く」の入口が使う束(createOfficeShadows)', () => {
  // ⚠ 比べる相手は「添付の中身が最後に保存された時刻」(ノートの updatedAt ではない ── UX レビュー 2026-10-03)
  const mk = (root: FakeDir, savedAt: (lid: string) => number | null = () => null, now = NOW) =>
    createOfficeShadows({ openShelf: () => openShadowShelf(root as never), savedAt: async (lid) => savedAt(lid), now: () => now });

  it('mayHave は同期。refresh するまでは偽(起動直後に押されても同期で開く)/ refresh で棚の名前が入る', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', NOW - 1000);
    const s = mk(root);
    expect(s.mayHave('lid-1'), 'refresh の前に真').toBe(false);
    await s.refresh();
    expect(s.mayHave('lid-1')).toBe(true);
    expect(s.mayHave('lid-2'), '控えの無いノートが真').toBe(false);
    expect(s.mayHave('local:1')).toBe(false);
    expect(s.mayHave('')).toBe(false);
  });

  it('🔴 find は「正本より新しい」ときだけ返す。古い(同じ時刻を含む)控えは返さないが、消さない', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', NOW - 10_000);
    const newer = mk(root, () => NOW - 20_000);
    expect(await newer.find('lid-1'), '正本より新しい控えを訊かない').toEqual({ at: NOW - 10_000, ext: 'docx' });
    const same = mk(root, () => NOW - 10_000);
    expect(await same.find('lid-1'), '同じ時刻を訊いた').toBeNull();
    const older = mk(root, () => NOW - 1000);
    expect(await older.find('lid-1'), '正本より古い控えを訊いた').toBeNull();
    expect(shelfOf(root)!.dirs.has('lid-1'), '古く見えるだけで控えを消した(添付の保存時刻が後から判明する余地を残す)').toBe(true);
    // 正本の時刻が分からない → 訊く側へ倒す
    expect(await mk(root, () => null).find('lid-1')).toEqual({ at: NOW - 10_000, ext: 'docx' });
  });

  it('find は 7 日を過ぎた控えを返さない。投げない(棚が壊れていても null)', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', NOW - SHADOW_MAX_AGE_MS - 1);
    expect(await mk(root).find('lid-1')).toBeNull();
    const bad = createOfficeShadows({ openShelf: async () => { throw new Error('boom'); }, savedAt: async () => null });
    expect(await bad.find('lid-1')).toBeNull();
    expect(await bad.readBytes('lid-1')).toBeNull();
    await expect(bad.discard('lid-1')).resolves.toBeUndefined();
    await expect(bad.refresh()).resolves.toBeUndefined();
    await expect(bad.sweep()).resolves.toBeUndefined();
  });

  it('find が控えを見つけなかったら、その場で「在るかもしれない」から外す(次の押しは同期で開く)。discard も外す', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', NOW - 1000);
    await writeFromWindow(root, 'lid-2', NOW - 1000);
    const s = mk(root, (lid) => (lid === 'lid-1' ? NOW : null));
    await s.refresh();
    // 🔴 添付より古い控えの棚は、refresh の時点で既に「在るかもしれない」に**入らない**(最初の押しが
    //   await の後に窓を開く形にしない ── Safari 等の遮断。レビュー 2026-10-03)
    expect(s.mayHave('lid-1'), '添付より古い控えの棚が在るだけで真になった(最初の押しが非同期で開く)').toBe(false);
    expect(await s.find('lid-1')).toBeNull();      // 正本のほうが新しい
    expect(s.mayHave('lid-1'), '見つからなかったのに在るかもしれないまま').toBe(false);
    expect(s.mayHave('lid-2')).toBe(true);
    await s.discard('lid-2');
    expect(s.mayHave('lid-2')).toBe(false);
    expect(shelfOf(root)!.dirs.has('lid-2'), '消していない').toBe(false);
  });

  it('🔴 refresh は期限切れの棚を「在るかもしれない」に入れない(sweep が消す前でも同期で開く側)', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'old', NOW - SHADOW_MAX_AGE_MS - 10);
    await writeFromWindow(root, 'fresh', NOW - 1000);
    const s = mk(root);
    await s.refresh();
    expect(s.mayHave('old'), '期限切れの棚が在るだけで真になった').toBe(false);
    expect(s.mayHave('fresh'), '対照群: 期限内で添付の時刻が分からない控えは真').toBe(true);
    expect(shelfOf(root)!.dirs.has('old'), 'refresh が消した(消すのは sweep だけ)').toBe(true);
  });

  it('🔴 refresh が重なったら、後から始まった結果が勝つ(遅い古い読み取りが新しい棚を潰さない)', async () => {
    const root = new FakeDir();
    let release: (() => void) | null = null;
    let calls = 0;
    const s = createOfficeShadows({
      openShelf: async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>((r) => { release = r; }); // 1 回目だけ遅い
        return openShadowShelf(root as never);
      },
      savedAt: async () => null,
      now: () => NOW,
    });
    const slow = s.refresh();             // 棚が空の版を読み始める(まだ返らない)
    await writeFromWindow(root, 'lid-1', NOW - 1000);
    await s.refresh();                    // 新しい棚を読んだ
    expect(s.mayHave('lid-1')).toBe(true);
    release!();
    await slow;                           // 古い結果が後から返る
    expect(s.mayHave('lid-1'), '遅い古い読み取りが新しい棚を潰した').toBe(true);
  });

  it('readBytes は控えの bytes を返す(消さない)。sweep は期限切れを消してから refresh する', async () => {
    const root = new FakeDir();
    await writeFromWindow(root, 'lid-1', NOW - 1000, { bytes: [9, 8, 7] });
    await writeFromWindow(root, 'old', NOW - SHADOW_MAX_AGE_MS - 10);
    const s = mk(root);
    expect(Array.from((await s.readBytes('lid-1'))!)).toEqual([9, 8, 7]);
    expect(shelfOf(root)!.dirs.has('lid-1')).toBe(true);
    await s.sweep();
    expect(shelfOf(root)!.dirs.has('old'), '期限切れが残った').toBe(false);
    expect(s.mayHave('lid-1')).toBe(true);
    expect(s.mayHave('old')).toBe(false);
  });
});

// 型の確認(ShadowDir が偽の OPFS を受けられること ── 型が緩すぎないかの見張りではなく、受け口の形の pin)
const _typed: ShadowDir | null = null;
void _typed;
