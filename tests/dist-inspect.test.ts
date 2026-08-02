/** @vitest-environment node */
/**
 * 生成物の検品規則(P7 段①)を縛る。
 *
 * 🔴 **検品する側が壊れると「通った」という事実だけが残る** ── いちばん危険な
 * 壊れ方をする。実際、レビューでこの規則のうち **2 件が空振りしていた**:
 *  ① `walk` が sub dir へ降りない変異で `assets/` を丸ごと見落としても product 側は
 *     ほぼ全部通った
 *  ② 「entry の `.js` が 1 件でもある」は `sw.js`(public の静的コピー)が常に
 *     満たすので、**アプリ本体が消えても `✓ ok`** だった
 * そこで規則を純粋関数に切り出し、**それぞれの規則が固有の壊し方で鳴る**ことを
 * ここで assert する。⚠ 「正常系が通る」だけの test は、規則を全部消しても通る。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 検品規則は素の .mjs(ビルド対象外の CI script 群)
import { inspectDist } from '../scripts/dist-inspect.mjs';

type File = { path: string; bytes: number };
type Input = {
  kind: 'product' | 'dev';
  capKb: number;
  files: File[];
  text: Map<string, string>;
};
type Report = { lines: string[]; errors: string[] };
const inspect = inspectDist as (i: Input) => Report;

const ENTRY = 'assets/index-AAAAAAAA.js';
const WORKER = 'assets/storage-worker-BBBBBBBB.js';
const WASM = 'assets/sqlite3-CCCCCCCC.wasm';

const INDEX_HTML = `<!doctype html><html><head>
<link rel="manifest" href="./manifest.webmanifest" />
<script type="module" crossorigin src="./${ENTRY}"></script>
</head><body></body></html>`;

/** 健全な product 生成物。各 test はここから **1 か所だけ**壊す。 */
function healthy(kind: 'product' | 'dev' = 'product'): Input {
  const files: File[] = [
    { path: 'index.html', bytes: 500 },
    { path: 'manifest.webmanifest', bytes: 600 },
    { path: 'icon.svg', bytes: 200 },
    { path: 'sw.js', bytes: 300 },
    { path: ENTRY, bytes: 300_000 },
    { path: WORKER, bytes: 230_000 },
    { path: WASM, bytes: 860_000 },
  ];
  const text = new Map<string, string>([
    ['index.html', INDEX_HTML],
    ['manifest.webmanifest', '{}'],
    ['sw.js', 'self.addEventListener("fetch", () => {});'],
    // entry は worker を、worker は wasm を名指しする(実物と同じ参照の連鎖)
    [ENTRY, `const w=new Worker("storage-worker-BBBBBBBB.js",{type:"module"});`],
    [WORKER, `const u="sqlite3-CCCCCCCC.wasm";`],
  ]);
  if (kind === 'dev') {
    files.push({ path: `${ENTRY}.map`, bytes: 1_400_000 });
    text.set(ENTRY, `${text.get(ENTRY)!}\n//# sourceMappingURL=index-AAAAAAAA.js.map`);
  }
  return { kind, capKb: 2400, files, text };
}

const run = (i: Input): string[] => inspect(i).errors;

describe('生成物の検品 — 健全なとき', () => {
  it('product は通る', () => {
    expect(run(healthy('product'))).toEqual([]);
  });
  it('dev も通る(map が有るので)', () => {
    expect(run(healthy('dev'))).toEqual([]);
  });
});

describe('🔴 空振りしないこと ── 規則ごとに固有の壊し方で鳴る', () => {
  it('entry chunk が消えたら鳴る(`sw.js` に救われない)', () => {
    // これがレビュー H-2 の実物。旧規則「`.js` が 1 件でもある」は sw.js が満たす
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== ENTRY);
    i.text.delete(ENTRY);
    expect(run(i).join('\n')).toContain(ENTRY);
    // ⚠ sw.js は残っている = 「.js が在るか」では鳴らない状況であることを pin
    expect(i.files.some((f) => f.path.endsWith('.js'))).toBe(true);
  });

  it('worker chunk が消えたら鳴る(index.html は指していない)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== WORKER);
    i.text.delete(WORKER);
    expect(run(i).join('\n')).toContain('storage-worker-BBBBBBBB.js');
  });

  // 🔴 存在検査は **参照突合に救われる**。素直に「消して、何か鳴るか」を見ると、
  // 存在検査を丸ごと殺しても参照側が鳴って test が通る ── 変異試験で実際に 2 件
  // 生き残った(wasm / manifest)。**参照ごと消して、その規則だけが鳴る形**で見る。
  it('wasm が消えたら鳴る(参照ごと消しても ── 存在検査そのものを見る)', () => {
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== WASM);
    i.text.delete(WASM);
    i.text.set(WORKER, 'const u="";'); // 参照も消す = 救い手を外す
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
    i.text.set(
      'index.html',
      INDEX_HTML.replace('<link rel="manifest" href="./manifest.webmanifest" />', ''),
    );
    expect(run(i).join('\n')).toContain('PWA として成立していない');
  });

  it('参照だけが残って実体が無いときは、参照突合の側が名指しで鳴る', () => {
    // 上 3 件と役割が違う ── こちらは「index.html が指す先が無い」を見る
    const i = healthy();
    i.files = i.files.filter((f) => f.path !== 'manifest.webmanifest');
    i.text.delete('manifest.webmanifest');
    expect(run(i).join('\n')).toContain('manifest.webmanifest  ← index.html');
  });

  it('🔴 index.html が何も参照していなければ「走査が空振り」として鳴る', () => {
    // ⚠ 参照 0 件を「壊れていない」と読むと、参照の抽出が壊れた瞬間に
    // **この規則ごと静かに無効化**される
    const i = healthy();
    i.text.set('index.html', '<!doctype html><html><head></head><body></body></html>');
    expect(run(i).join('\n')).toContain('空振り');
  });

  it('sub dir を見落とす形(assets が丸ごと消える)でも鳴る', () => {
    // ⚠ 変異試験で実際に踏んだ形。旧規則では product 側がほぼ全部通った
    const i = healthy();
    i.files = i.files.filter((f) => !f.path.startsWith('assets/'));
    for (const k of [...i.text.keys()]) if (k.startsWith('assets/')) i.text.delete(k);
    expect(run(i).length).toBeGreaterThan(0);
  });
});

describe('map の扱い', () => {
  it('🔴 product に外部 map が 1 件でもあれば鳴る', () => {
    const i = healthy();
    i.files.push({ path: `${ENTRY}.map`, bytes: 1_400_000 });
    expect(run(i).join('\n')).toContain('map が 1 件ある');
  });

  it('🔴 product の inline map は「件数 0」でも鳴る', () => {
    // `--sourcemap inline` は `.map` を 1 件も出さない ── 件数だけ見ると
    // 4.3MB の base64 map を出荷しながら「map 0 件」と報告する(レビュー M-2)
    const i = healthy();
    i.text.set(ENTRY, 'x//# sourceMappingURL=data:application/json;charset=utf-8;base64,AAAA');
    const errors = run(i);
    expect(errors.join('\n')).toContain('inline sourcemap');
    expect(i.files.filter((f) => f.path.endsWith('.map'))).toHaveLength(0); // 件数は 0 のまま
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

  it('`foo-HASH.js.map` への参照は「実在しない生成物」として拾わない', () => {
    // dev の `//# sourceMappingURL=…js.map` で毎回誤検知しては使い物にならない
    const i = healthy('dev');
    expect(run(i)).toEqual([]);
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

  it('cap 以内なら残量を報告する(「内」ではなく残量 ── PKC2 から継承)', () => {
    const report = inspect(healthy());
    const out = report.lines.join('\n');
    expect(out).toMatch(/cap 残量: [\d.]+ KB/);
    expect(out).toMatch(/[\d.]+% \/ cap 2400 KB/); // 分母まで書く(百分率の規律)
  });
});
