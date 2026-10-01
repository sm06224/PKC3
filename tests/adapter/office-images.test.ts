/**
 * 🔴 **「挿入 → 画像」に、そのノートの添付を置く**(#146 裁定 A)── **窓の側**。
 *
 * ⚠ `public/office/office-images.js` は **bundle されない素の JS**(`host.html` が
 * `<script src>` で読む)。`readFileSync` + `new Function` で**実 file を**読み込んで当てる
 * (写経すると本物とずれる ── `office-save-watch.test.ts` と同じ作法)。
 *
 * 守る主張:
 *  ① 画像は **`/home/web_user` の直下**へ、**元の名前**で置かれる(Qt の初期位置)
 *  ② 同じ名前が何枚来ても**黙って上書きしない**
 *  ③ 名前で置き先の外へ出られない
 *  ④ 🔴 **置いた file は「保存」として返らない**(読み終えて閉じても / 本物の保存は今までどおり返る)
 *  ⑤ 1 枚のしくじりで残りを止めない
 *  ⑥ `host.html` が **文書と同じ口で `callMain` の前に**置き、**保存の見張りを積むときに**
 *     baseline を載せている(原文 pin ── host.html は unit が届かない)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

interface Placed {
  path: string;
  size: number;
  mtimeMs: number;
}
interface Api {
  IMAGE_DIR: string;
  placedName(raw: unknown, taken: Record<string, boolean>): string;
  placeImages(FS: unknown, images: unknown): Placed[];
  seedBaseline(watch: unknown, placed: unknown): void;
}
interface Watch {
  setBaseline(path: string, size: number, mtimeMs: number): void;
  note(kind: string, path: string, at?: number): boolean;
  due(
    stat: (p: string) => { size: number; mtimeMs: number } | null,
    at?: number,
  ): { path: string; name: string }[];
}
interface SaveApi {
  QUIET_MS: number;
  createSaveWatch(opts?: { now?: () => number }): Watch;
}

function loadScript<T>(file: string, key: string): T {
  const src = readFileSync(file, 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope[key] as T | undefined;
  expect(api, `${file} が globalThis へ何も置いていない`).toBeTruthy();
  return api!;
}
const api = loadScript<Api>('public/office/office-images.js', 'PKC3OfficeImages');
const saveApi = loadScript<SaveApi>('public/office/office-save-watch.js', 'PKC3OfficeSaveWatch');

/** MEMFS の最小の模型。⚠ 本物と同じく、親ディレクトリが無い書き込みは投げ、mtime は Date。 */
function fakeFs(opts: { failOn?: string } = {}) {
  const dirs = new Set<string>(['/']);
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  let clock = 1000;
  return {
    dirs,
    files,
    FS: {
      mkdirTree(p: string) {
        let cur = '';
        for (const part of p.split('/').filter(Boolean)) {
          cur += '/' + part;
          dirs.add(cur);
        }
      },
      writeFile(p: string, data: Uint8Array) {
        const dir = p.slice(0, p.lastIndexOf('/'));
        if (!dirs.has(dir)) throw new Error('ENOENT: ' + dir);
        if (opts.failOn && p.endsWith(opts.failOn)) throw new Error('EIO');
        clock += 1000;
        files.set(p, { bytes: data, mtime: clock });
      },
      stat(p: string) {
        const f = files.get(p);
        if (!f) throw new Error('ENOENT: ' + p);
        return { size: f.bytes.length, mtime: new Date(f.mtime) };
      },
    },
  };
}

const png = (...n: number[]) => new Uint8Array(n);

describe('置き先と名前', () => {
  it('🔴 画像は /home/web_user の直下へ、元の名前のまま置かれる', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [
      { name: '猫の 写真.png', bytes: png(1, 2, 3) },
      { name: 'logo.svg', bytes: png(4, 5) },
    ]);
    expect(api.IMAGE_DIR).toBe('/home/web_user');
    expect(placed.map((p) => p.path)).toEqual(['/home/web_user/猫の 写真.png', '/home/web_user/logo.svg']);
    // 空振り防止 ── 本当に FS に入っている / bytes がそのまま
    expect(m.files.size).toBe(2);
    expect(Array.from(m.files.get('/home/web_user/logo.svg')!.bytes)).toEqual([4, 5]);
    expect(placed[0]).toMatchObject({ size: 3 });
  });

  it('ArrayBuffer で届いても置ける(封筒の型に依らない)', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [{ name: 'a.png', bytes: new Uint8Array([9, 8]).buffer }]);
    expect(placed.length).toBe(1);
    expect(Array.from(m.files.get('/home/web_user/a.png')!.bytes)).toEqual([9, 8]);
  });

  it('🔴 同じ名前が何枚来ても、黙って上書きしない(拡張子の前に連番)', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [
      { name: 'image.png', bytes: png(1) },
      { name: 'image.png', bytes: png(2) },
      { name: 'image.png', bytes: png(3) },
    ]);
    expect(placed.map((p) => p.path)).toEqual([
      '/home/web_user/image.png',
      '/home/web_user/image (2).png',
      '/home/web_user/image (3).png',
    ]);
    expect(m.files.size, '3 枚とも残っている').toBe(3);
  });

  it('🔴 名前で置き先の外へ出られない(区切りより前は落とす)', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [
      { name: '../../etc/passwd.png', bytes: png(1) },
      { name: 'C:\\Users\\x\\y.png', bytes: png(2) },
    ]);
    expect(placed.map((p) => p.path)).toEqual(['/home/web_user/passwd.png', '/home/web_user/y.png']);
  });

  it('空・"."・".."・先頭 "." の名前は _ を前に付ける(保存の見張りが読み飛ばす名前を作らない)', () => {
    const taken = Object.create(null) as Record<string, boolean>;
    expect(api.placedName('', taken)).toBe('_');
    expect(api.placedName('..', taken)).toBe('_..');
    expect(api.placedName('.hidden.png', taken)).toBe('_.hidden.png');
    expect(api.placedName(undefined, taken)).toBe('_ (2)');
  });

  it('0 件なら何も作らない(ディレクトリも触らない)', () => {
    const m = fakeFs();
    expect(api.placeImages(m.FS, [])).toEqual([]);
    expect(api.placeImages(m.FS, null)).toEqual([]);
    expect(m.dirs.has('/home/web_user'), '0 件のとき FS へ触れていない').toBe(false);
  });

  it('🔴 1 枚が書けなくても、残りは並ぶ', () => {
    const m = fakeFs({ failOn: 'bad.png' });
    const placed = api.placeImages(m.FS, [
      { name: 'a.png', bytes: png(1) },
      { name: 'bad.png', bytes: png(2) },
      { name: 'c.png', bytes: png(3) },
    ]);
    expect(placed.map((p) => p.path)).toEqual(['/home/web_user/a.png', '/home/web_user/c.png']);
  });
});

describe('🔴 置いた file を「保存」として返さない(office-save-watch.js と実際に組む)', () => {
  /** 実物の見張りに hook を模して出来事を流し、「保存」として返るものを集める。 */
  function watchWith(m: ReturnType<typeof fakeFs>, placed: Placed[], seed: boolean) {
    let t = 10_000;
    const watch = saveApi.createSaveWatch({ now: () => t });
    if (seed) api.seedBaseline(watch, placed);
    const stat = (p: string) => {
      const st = m.FS.stat(p);
      return { size: st.size, mtimeMs: st.mtime.getTime() };
    };
    return {
      watch,
      stat,
      /** LO が画像を**読んで閉じた**(hook には close が来る)。 */
      readAndClose(path: string) {
        expect(watch.note('close', path, t), '見張りの対象(直下)でない ── この検査が空振り').toBe(true);
      },
      settle() {
        t += saveApi.QUIET_MS + 1;
        return watch.due(stat, t).map((h) => h.path);
      },
      advance(ms: number) { t += ms; },
    };
  }

  it('置いた画像を LO が読んで閉じても、保存として返らない', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [
      { name: 'a.png', bytes: png(1, 2, 3) },
      { name: 'b.png', bytes: png(4, 5) },
    ]);
    expect(placed.length, '空振り防止(置けている)').toBe(2);
    const w = watchWith(m, placed, true);
    for (const p of placed) w.readAndClose(p.path);
    expect(w.settle(), '読んだだけの画像が「保存」として PKC へ流れる').toEqual([]);
  });

  it('🔴 対照群:baseline を載せなければ、同じ操作で「保存」として返る(= 載せることが効いている)', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [{ name: 'a.png', bytes: png(1, 2, 3) }]);
    const w = watchWith(m, placed, false);
    w.readAndClose(placed[0]!.path);
    expect(w.settle()).toEqual(['/home/web_user/a.png']);
  });

  it('🔴 同じ名前で上書き保存すれば(大きさが変わる)今までどおり保存として返る', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [{ name: 'a.png', bytes: png(1, 2, 3) }]);
    const w = watchWith(m, placed, true);
    // user が LO で編集して同じ名前で保存した
    m.FS.writeFile('/home/web_user/a.png', png(1, 2, 3, 4, 5, 6));
    w.readAndClose('/home/web_user/a.png');
    expect(w.settle(), '本物の保存まで握り潰している').toEqual(['/home/web_user/a.png']);
  });

  it('🔴 大きさが同じでも mtime が動けば保存として返る(baseline は mtime も見ている)', () => {
    const m = fakeFs();
    const placed = api.placeImages(m.FS, [{ name: 'a.png', bytes: png(1, 2, 3) }]);
    const w = watchWith(m, placed, true);
    m.FS.writeFile('/home/web_user/a.png', png(7, 8, 9)); // 同じ 3 バイト・mtime だけ進む
    w.readAndClose('/home/web_user/a.png');
    expect(w.settle()).toEqual(['/home/web_user/a.png']);
  });

  it('seedBaseline は watch が無くても投げない(見張りの口が読めなかった窓)', () => {
    expect(() => api.seedBaseline(null, [{ path: '/x', size: 1, mtimeMs: 1 }])).not.toThrow();
    expect(() => api.seedBaseline({ setBaseline() {} }, null)).not.toThrow();
  });
});

describe('host.html の配線(原文 pin ── host.html は bundle されず unit が届かない)', () => {
  const html = readFileSync('public/office/host.html', 'utf-8');

  /** 注釈を落とした「実行する行」だけ(解説コメントに満たされない)。 */
  const code = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('office-images.js を読み込んでいる(保存の見張りより後でも前でもよいが、host の script より前)', () => {
    const i = code.indexOf('<script src="office-images.js"></script>');
    expect(i, 'script src が無い ── window.PKC3OfficeImages が生えない').toBeGreaterThan(0);
    expect(i).toBeLessThan(code.indexOf('(function () {'));
  });

  it('🔴 文書を書く口の直後・callMain の前で画像を置く(新しい経路を作らない)', () => {
    const write = code.indexOf('FS.writeFile(path, docBytes)');
    const place = code.indexOf('window.PKC3OfficeImages.placeImages(FS, docImages)');
    const main = code.indexOf('inst.callMain(args)');
    expect(write).toBeGreaterThan(0);
    expect(place, '画像を置く呼び出しが無い').toBeGreaterThan(write);
    expect(main).toBeGreaterThan(place);
  });

  it('🔴 置くのは同期で(文書を書いてから callMain までの間に非同期を挟まない ── 起動に間に合わなくなる)', () => {
    const from = code.indexOf('FS.writeFile(path, docBytes)');
    const to = code.indexOf('inst.callMain(args)');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const between = code.slice(from, to);
    expect(between, '空振り防止(置く呼び出しが範囲に入っている)').toContain('placeImages(FS, docImages)');
    expect(between, '画像を置く道に setTimeout / await / then を挟んでいる').not.toMatch(
      /setTimeout|await |\.then\(|requestAnimationFrame/,
    );
  });

  it('封筒の images を受け取り、置いたら手放す(MEMFS が持つので二重持ちしない)', () => {
    expect(code).toContain('docImages = (d.payload && d.payload.images) || null;');
    expect(code).toMatch(/placeImages\(FS, docImages\);[\s\S]*?docImages = null;/);
  });

  it('🔴 保存の見張りを積むときに、置いた画像の baseline を載せる', () => {
    const arm = code.indexOf('function armSaveWatch(FS, token)');
    const seed = code.indexOf('window.PKC3OfficeImages.seedBaseline(watch, window.__loImagePlaced)');
    const create = code.indexOf('W.createSaveWatch()');
    expect(seed, 'baseline を載せる呼び出しが無い ── 画像を挿すたびに保存として流れる').toBeGreaterThan(0);
    expect(seed).toBeGreaterThan(create);
    expect(seed).toBeGreaterThan(arm);
    // ⚠ 置いた結果は `armSaveWatch` より前に決まっている(置く → 見張りを積む の順)
    expect(code.indexOf('window.__loImagePlaced = window.PKC3OfficeImages.placeImages')).toBeLessThan(
      code.indexOf('armSaveWatch(FS, docToken);'),
    );
  });

  it('画像が無い窓でも壊れない(置く口が読めなかった版は黙って飛ばす)', () => {
    expect(code).toContain('docImages && docImages.length && window.PKC3OfficeImages');
    expect(code).toMatch(/if \(window\.PKC3OfficeImages\) \{\s*try \{ window\.PKC3OfficeImages\.seedBaseline/);
  });
});
