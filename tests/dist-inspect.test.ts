/** @vitest-environment node */
/**
 * 生成物の検品規則(P7 段①)を縛る。
 *
 * 🔴 **検品する側が壊れると「通った」という事実だけが残る** ── いちばん危険な
 * 壊れ方をする。実際、レビュー 2 ラウンドともこの規則が空振りしていた:
 *  1 巡目 「entry の `.js` が 1 件でもある」が `sw.js` に救われ、**本体が消えても `✓ ok`**
 *  2 巡目 「index.html の `./` 参照」が `manifest.webmanifest` / `icon.svg` に救われ、
 *         `base` を `/` にすると **本体が消えても `✓ ok`**(救い手が変わっただけだった)
 * そこで規則を純粋関数に切り出し、**それぞれの規則が固有の壊し方で鳴る**ことを
 * ここで assert する。⚠ 「正常系が通る」だけの test は、規則を全部消しても通る。
 *
 * ⚠ **fixture のゼロ件の次元は「測っていない次元」**。`healthy()` は css chunk /
 * query 付き参照 / 単一引用符 / 絶対 path を**実際に持つ** ── 持たせないと、
 * それらを扱う枝を消しても誰も気づかない。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 検品規則は素の .mjs(ビルド対象外の CI script 群)
import { inspectDist } from '../scripts/dist-inspect.mjs';

type File = { path: string; bytes: number };
type Input = {
  kind: 'product' | 'dev';
  capKb: number;
  floorKb: number;
  files: File[];
  text: Map<string, string>;
};
const inspect = inspectDist as (i: Input) => { lines: string[]; errors: string[] };
const run = (i: Input): string[] => inspect(i).errors;

const ENTRY = 'assets/index-AAAAAAAA.js';
const WORKER = 'assets/storage-worker-BBBBBBBB.js';
const WASM = 'assets/sqlite3-CCCCCCCC.wasm';
const CSS = 'assets/style-DDDDDDDD.css';

/**
 * index.html。実物と同じ癖を**わざと混ぜる**:
 * - entry は絶対 path(`base: '/'` にすると Vite がこう吐く)
 * - stylesheet は query 付き
 * - icon は単一引用符 + **`./` 無しの裸名**(手書き HTML の普通の書き方)
 * - preload は**拡張子つきの外部 URL**(dist の file として解決してはいけない)
 */
const INDEX_HTML = `<!doctype html><html><head>
<link rel="manifest" href="./manifest.webmanifest" />
<link rel="preload" as="style" href="https://cdn.example/theme.css" />
<link rel="icon" href='icon.svg' type="image/svg+xml" />
<link rel="stylesheet" href="./${CSS}?v=1" />
<script type="module" crossorigin src="/${ENTRY}"></script>
</head><body></body></html>`;

/** 健全な生成物。各 test はここから **1 か所だけ**壊す。 */
function healthy(kind: 'product' | 'dev' = 'product'): Input {
  const files: File[] = [
    { path: 'index.html', bytes: 500 },
    { path: 'manifest.webmanifest', bytes: 600 },
    { path: 'icon.svg', bytes: 200 },
    { path: 'sw.js', bytes: 300 },
    { path: ENTRY, bytes: 300_000 },
    { path: WORKER, bytes: 230_000 },
    { path: WASM, bytes: 860_000 },
    { path: CSS, bytes: 20_000 },
  ];
  const text = new Map<string, string>([
    ['index.html', INDEX_HTML],
    ['manifest.webmanifest', JSON.stringify({ icons: [{ src: 'icon.svg' }] })],
    [
      'sw.js',
      // ⚠ 実物と同じ形(検品はここを読む)。**生成物と一致していること**が規則
      `const PRECACHE = ${JSON.stringify(
        ['index.html', 'manifest.webmanifest', 'icon.svg', ENTRY, WORKER, WASM, CSS].map(
          (p) => `./${p}`,
        ),
      )};\nself.addEventListener("fetch", () => {});`,
    ],
    // 参照の連鎖は実物と同じ構文で(entry → worker → wasm)。
    // ⚠ 散文に **hash らしき名前**を混ぜてある ── 形で拾う実装だと誤検知して
    // release を偽の理由で止める(2 巡目 M-2 で実証した実在の名前)
    [
      ENTRY,
      'const w=new Worker(new URL(`storage-worker-BBBBBBBB.js`,import.meta.url));' +
        'navigator.serviceWorker.register("./sw.js");' +
        // ⚠ 参照の**書かれ方**の次元をゼロにしない ── 絶対 path(`base: '/'`)・
        // 外部 URL・拡張子なしの 3 つは、扱いを間違えると誤検知で release が止まる
        'const s=new URL("/sw.js",location.href);' +
        '// …is not intended to be invoked from`,`client-level code' +
        'const up=new URL("https://sqlite.org/dist/helper.js");' +
        'if(0)import("./nowhere");' +
        // 外部化された動的 import(bare specifier)は dist の生成物ではない
        'if(0)import("legacy-shim/polyfill.js");' +
        '// see markdown-it-footnote.js / sqlite3-worker1-promiser.js / sqlite3-vfs-opfs.js',
    ],
    [WORKER, 'const u=new URL(`sqlite3-CCCCCCCC.wasm`,self.location.href);'],
    [CSS, 'body{margin:0}'],
  ]);
  if (kind === 'dev') {
    files.push({ path: `${ENTRY}.map`, bytes: 1_400_000 });
    text.set(ENTRY, `${text.get(ENTRY)!}\n//# sourceMappingURL=index-AAAAAAAA.js.map`);
  }
  return { kind, capKb: 2400, floorKb: 1200, files, text };
}

describe('生成物の検品 — 健全なとき', () => {
  it('product は通る', () => {
    expect(run(healthy('product'))).toEqual([]);
  });
  it('dev も通る(map が有るので)', () => {
    expect(run(healthy('dev'))).toEqual([]);
  });
  it('🔴 散文の中の hash らしき名前を誤検知しない', () => {
    // ⚠ ここが鳴ると release / Pages deploy が**偽の理由で止まる**。
    // 実物の bundle には `sqlite3-vfs-opfs.js` がコメント中に既にある
    const i = healthy();
    // ⚠ precache 一覧は残したまま散文だけ足す(別の規則に鳴らせない)
    i.text.set(
      'sw.js',
      `${i.text.get('sw.js')!}\n// counterpart of the API defined in sqlite3-vfs-opfs.js and friends`,
    );
    expect(run(i)).toEqual([]);
  });
});

describe('🔴 空振りしないこと ── 規則ごとに固有の壊し方で鳴る', () => {
  it('entry chunk が消えたら鳴る(`sw.js` に救われない)', () => {
    // 1 巡目 H-2 の実物。旧規則「`.js` が 1 件でもある」は sw.js が満たす
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== ENTRY);
    i.text.delete(ENTRY);
    expect(run(i).join('\n')).toContain(ENTRY);
    expect(i.files.some((f) => f.path.endsWith('.js'))).toBe(true); // sw.js は残っている
  });

  it('🔴 entry が絶対 path で参照されていても消滅を捕まえる', () => {
    // 2 巡目 H-1 の実物。`./` 始まりだけを拾う実装は `base: '/'` で盲目になる。
    // fixture の entry は既に `/assets/…` なので、上の test がそのまま効いている
    expect(INDEX_HTML).toContain(`src="/${ENTRY}"`);
  });

  it('worker chunk が消えたら鳴る(index.html は指していない)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== WORKER);
    i.text.delete(WORKER);
    expect(run(i).join('\n')).toContain('storage-worker-BBBBBBBB.js');
  });

  it('css chunk が消えたら鳴る(query 付き参照でも解決する)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== CSS);
    i.text.delete(CSS);
    expect(run(i).join('\n')).toContain(CSS);
  });

  it('icon が消えたら鳴る(単一引用符の href でも拾う)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== 'icon.svg');
    i.text.set('manifest.webmanifest', '{}'); // manifest 側の検査に救われない形で見る
    expect(run(i).join('\n')).toContain('icon.svg  ← index.html');
  });

  // 🔴 存在検査は **参照突合に救われる**。素直に「消して、何か鳴るか」を見ると、
  // 存在検査を丸ごと殺しても参照側が鳴って test が通る ── 変異試験で実際に 2 件
  // 生き残った(wasm / manifest)。**参照ごと消して、その規則だけが鳴る形**で見る。
  it('wasm が消えたら鳴る(参照ごと消しても)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== WASM);
    i.text.delete(WASM);
    i.text.set(WORKER, 'const u="";');
    expect(run(i).join('\n')).toContain('storage が起動しない');
  });

  it('index.html が消えたら鳴る', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== 'index.html');
    i.text.delete('index.html');
    expect(run(i).join('\n')).toContain('生成物として成立していない');
  });

  it('manifest が消えたら鳴る(参照ごと消しても)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== 'manifest.webmanifest');
    i.text.delete('manifest.webmanifest');
    i.text.set('index.html', INDEX_HTML.replace(/<link rel="manifest"[^>]*>/, ''));
    expect(run(i).join('\n')).toContain('PWA として成立していない');
  });

  it('sw.js が消えたら鳴る(文字列 register なので構文走査には出ない)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== 'sw.js');
    i.text.delete('sw.js');
    i.text.set(ENTRY, 'const w=new Worker(new URL(`storage-worker-BBBBBBBB.js`,import.meta.url));');
    expect(run(i).join('\n')).toContain('PWA の登録先');
  });

  it('🔴 index.html が hash 付き生成物を参照していなければ「空振り」として鳴る', () => {
    // ⚠ 「参照が 1 件でもある」では `public/` の静的参照(manifest / icon)で
    // 満たされてしまう ── それが 2 巡目 H-1 の穴だった
    const i = healthy();
    i.text.set(
      'index.html',
      `<!doctype html><link rel="manifest" href="./manifest.webmanifest" /><link rel="icon" href="./icon.svg" />`,
    );
    expect(run(i).join('\n')).toContain('空振り');
  });

  it('sub dir を見落とす形(assets が丸ごと消える)でも鳴る', () => {
    const i = healthy();
    i.files = i.files.filter((f) => !f.path.startsWith('assets/'));
    for (const k of [...i.text.keys()]) if (k.startsWith('assets/')) i.text.delete(k);
    expect(run(i).length).toBeGreaterThan(0);
  });

  // 🔴 孤立検出は **hash 付きと認識できた生成物にしか効かない**。拡張子を 1 つ
  // 落とすと、その種類の chunk は孤立しても静かに通る ── 3 種とも pin する
  it.each([
    ['js', 'assets/orphan-EEEEEEEE.js', 'export const a=1;'],
    ['css', 'assets/orphan-EEEEEEEE.css', 'body{color:red}'],
    ['mjs', 'assets/orphan-EEEEEEEE.mjs', 'export const a=1;'],
  ])('孤立した hash 付き生成物(%s)で鳴る', (_ext, path, body) => {
    const i = healthy();
    i.files.push({ path, bytes: 1000 });
    i.text.set(path, body);
    expect(run(i).join('\n')).toContain('誰からも参照されていない');
  });

  it('🔴 `.mjs` の中の参照も走査する(拡張子で取りこぼさない)', () => {
    const i = healthy();
    i.files.push({ path: 'assets/extra-FFFFFFFF.mjs', bytes: 1000 });
    i.text.set(
      'assets/extra-FFFFFFFF.mjs',
      'const w=new Worker(new URL(`gone-GGGGGGGG.js`,import.meta.url));',
    );
    // ⚠ 孤立検出でも鳴るので、**参照突合が鳴っていること**を名指しで見る
    expect(run(i).join('\n')).toContain('assets/gone-GGGGGGGG.js  ← assets/extra-FFFFFFFF.mjs');
  });
});

describe('🔴 SW の precache 一覧は生成物と一致する(手書きに退化させない)', () => {
  it('一覧が空なら鳴る(生成器が壊れても誰も気づかない、を作らない)', () => {
    const i = healthy();
    i.text.set('sw.js', 'const PRECACHE = [];');
    expect(run(i).join('\n')).toContain('precache 一覧が空');
  });

  it('一覧が無ければ鳴る', () => {
    const i = healthy();
    i.text.set('sw.js', 'self.addEventListener("fetch", () => {});');
    expect(run(i).join('\n')).toContain('precache 一覧が無い');
  });

  it('🔴 生成物が増えたのに一覧に載っていなければ鳴る(オフラインで欠ける)', () => {
    const i = healthy();
    i.files.push({ path: 'assets/added-EEEEEEEE.js', bytes: 100 });
    i.text.set(
      'assets/added-EEEEEEEE.js',
      'export const a=1;',
    );
    // 参照もしておく(孤立検出ではなく **precache 突合**が鳴ることを見る)
    i.text.set(ENTRY, `${i.text.get(ENTRY)!}new Worker(new URL(\`added-EEEEEEEE.js\`,import.meta.url));`);
    expect(run(i).join('\n')).toContain('precache に載っていない');
  });

  it('🔴 一覧が実在しないものを指していれば鳴る', () => {
    const i = healthy();
    i.text.set('sw.js', 'const PRECACHE = ["./index.html","./消えた-FFFFFFFF.js"];');
    expect(run(i).join('\n')).toContain('実在しないものを指している');
  });

  it('SW 自身は一覧に載せない(載っていなくても鳴らない)', () => {
    expect(run(healthy())).toEqual([]);
  });
});

describe('🔴 縮む方向の事故 ── cap は上限しか見ない', () => {
  it('0 バイトの出荷物で鳴る', () => {
    // entry chunk を空にしても「配る量が減った」だけで通っていた(2 巡目 M-1)
    const i = healthy();
    i.files = i.files.map((f) => (f.path === ENTRY ? { ...f, bytes: 0 } : f));
    expect(run(i).join('\n')).toContain('空のファイル');
  });

  it('配る量が下限を割ったら鳴る', () => {
    const i = healthy();
    i.files = i.files.map((f) => ({ ...f, bytes: Math.floor(f.bytes / 10) || 1 }));
    expect(run(i).join('\n')).toContain('下限');
  });

  it('🔴 下限も KB は 1024 で数える(境界のすぐ両側で見る)', () => {
    // ⚠ 単位が 1000 に化けると床が 2.4% ずれる ── 「下回っている」が「足りている」に
    // 化けても誰も気づかないので、境界で pin する
    const base = (bytes: number): Input => {
      const i = healthy();
      i.floorKb = 100;
      i.files = [{ path: 'index.html', bytes }];
      i.text = new Map([['index.html', `<script src="./${ENTRY}"></script>`]]);
      return i;
    };
    expect(run(base(1024 * 100)).join('\n')).not.toContain('下限');
    expect(run(base(1024 * 100 - 1)).join('\n')).toContain('下限');
  });

  it('manifest が指す icon が無ければ鳴る(index.html の link が無くても)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== 'icon.svg');
    i.text.set('index.html', INDEX_HTML.replace(/<link rel="icon"[^>]*>/, ''));
    expect(run(i).join('\n')).toContain('manifest が指す icon が無い');
  });

  it('manifest が JSON として壊れていたら鳴る', () => {
    const i = healthy();
    i.text.set('manifest.webmanifest', '{ oops');
    expect(run(i).join('\n')).toContain('JSON として読めない');
  });
});

describe('map の扱い', () => {
  it('🔴 product に外部 map が 1 件でもあれば鳴る', () => {
    const i = healthy();
    i.files.push({ path: `${ENTRY}.map`, bytes: 1_400_000 });
    expect(run(i).join('\n')).toContain('map が 1 件ある');
  });

  it('🔴 product の inline map は「件数 0」でも鳴る', () => {
    const i = healthy();
    i.text.set(ENTRY, 'x//# sourceMappingURL=data:application/json;charset=utf-8;base64,AAAA');
    expect(run(i).join('\n')).toContain('inline sourcemap');
    expect(i.files.filter((f) => f.path.endsWith('.map'))).toHaveLength(0); // 件数は 0 のまま
  });

  it('🔴 `.mjs` の inline map も見る(拡張子で取りこぼさない)', () => {
    const i = healthy();
    i.files.push({ path: 'assets/extra-FFFFFFFF.mjs', bytes: 1000 });
    i.text.set(
      'assets/extra-FFFFFFFF.mjs',
      'export const a=1;//# sourceMappingURL=data:application/json;base64,AAAA',
    );
    expect(run(i).join('\n')).toContain('inline sourcemap');
  });

  it('🔴 dev から map が消えたら鳴る(調査手段の喪失)', () => {
    const i = healthy('dev');
    i.files = i.files.filter((f) => !f.path.endsWith('.map'));
    i.text.set(ENTRY, 'no map here');
    expect(run(i).join('\n')).toContain('調査手段');
  });

  it('dev が inline map だけを持つときは「map が無い」と誤検知しない', () => {
    const i = healthy('dev');
    i.files = i.files.filter((f) => !f.path.endsWith('.map'));
    i.text.set(ENTRY, 'x//# sourceMappingURL=data:application/json;base64,AAAA');
    expect(run(i).join('\n')).not.toContain('調査手段');
  });

  it('dev の `//# sourceMappingURL=….js.map` を「実在しない生成物」として拾わない', () => {
    expect(run(healthy('dev'))).toEqual([]);
  });
});

describe('配る量の tripwire', () => {
  it('cap を超えたら鳴る', () => {
    const i = healthy();
    i.capKb = 1000;
    expect(run(i).join('\n')).toContain('超過');
  });

  it('🔴 inline map で膨れたときは「cap を上げてよい」と言わない', () => {
    // ⚠ ここで cap を上げると inline map がそのまま出荷される(誤った処方)
    const i = healthy();
    i.capKb = 1000;
    i.text.set(ENTRY, 'x//# sourceMappingURL=data:application/json;base64,AAAA');
    const msg = run(i).join('\n');
    expect(msg).toContain('cap を上げる前にそちらを消す');
    expect(msg).not.toContain('引き上げてよい');
  });

  it('🔴 KB は 1024 で数える(cap も報告値も)', () => {
    // ⚠ 単位が 1000 に化けると cap も残量も静かにズレる ── 実数で pin する
    const i = healthy();
    i.files = [
      { path: 'index.html', bytes: 1024 * 100 },
      { path: 'manifest.webmanifest', bytes: 0 },
    ];
    i.capKb = 200;
    i.floorKb = 0;
    i.text = new Map([['index.html', `<script src="./${ENTRY}"></script>`]]);
    const out = inspect(i).lines.join('\n');
    expect(out).toContain('配る量: 100.0 KB');
    expect(out).toContain('cap 残量: 100.0 KB(50.0% / cap 200 KB)');
  });

  it('cap 以内なら残量を報告する(「内」ではなく残量 ── PKC2 から継承)', () => {
    const out = inspect(healthy()).lines.join('\n');
    expect(out).toMatch(/cap 残量: [\d.]+ KB/);
    expect(out).toMatch(/[\d.]+% \/ cap 2400 KB/); // 分母まで書く(百分率の規律)
  });

  it('ファイル数と map の件数を報告する(CI ログで人が読む数字)', () => {
    const out = inspect(healthy('dev')).lines.join('\n');
    expect(out).toContain('[dev] ファイル 9 件 / うち map 1 件');
    expect(out).toContain('map: 1367.2 KB');
  });
});
