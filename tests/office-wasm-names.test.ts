/** @vitest-environment node */
/**
 * `build/office-wasm/wasm-names.py` を検める(#631)。
 *
 * 🔴 **この道具の値打ちは「焼き 1 本(30 分〜4 時間)を待たなくてよい」ことである。**
 * Office の停止は `wasm-function[60973]` のような**番号だけ**で出る ── 配っている
 * 一式に name section が 0 件だからである。名前つきで焼いた一式の name section を
 * **表として引けば**、番号がそのまま名前になる(#117 で実証)。
 *
 * 🔴 **だから守るのは 2 つ。どちらも「静かに嘘を出す」経路である**:
 *
 * | 守ること | 守らないと何が起きるか |
 * |---|---|
 * | **名前が 0 件なら落ちる** | 配布一式を渡した人が「名前が付いていない関数だ」と誤読する(CLAUDE.md §1) |
 * | **`lo_sha` が違えば落ちる** | 🔴 **別の関数の名前がそれらしく出る** ── #631 の反例:番号 39465 は枝で `vcl::Window::ToTop` と `ImplBorderWindow::GetOptimalSize` に分かれる |
 *
 * ⚠ fixture は**自作の wasm** である ── 実物(数百 MB)に依存すると、この test は
 * 手元でも CI でも走らない(CLAUDE.md §2「経路が一度も通っていない」)。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/wasm-names.py';

/** LEB128(符号なし)。⚠ 番号は 128 を超えるので 1 バイトで済ませない。 */
function uleb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function str(s: string): number[] {
  const b = [...Buffer.from(s, 'utf-8')];
  return [...uleb(b.length), ...b];
}

/** custom section を 1 つ組む(id=0)。 */
function customSection(name: string, body: number[]): number[] {
  const payload = [...str(name), ...body];
  return [0, ...uleb(payload.length), ...payload];
}

/** 副節を 1 つ組む(id + 大きさ + 中身)。 */
function subsection(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

/**
 * 名前つきの wasm を 1 本作る。
 * ⚠ **本物と同じ入れ子**にする(custom `name` → 副節 → 個数 → (番号, 名前)*)──
 *   ここを簡略化すると、実物を読めない実装でも緑になる(stub が本物より甘い形)。
 *
 * 🔴 **副節 0(モジュール名)を必ず先に置く。** 実物の name section は
 *   0(モジュール)/ 1(関数)/ 2(ローカル)が並ぶので、**1 だけの fixture では
 *   「副節 id で絞り込む」処理を外しても緑になる**(変異試験 M7 が SURVIVED で教えた
 *   ── CLAUDE.md §2「fixture のゼロ件の次元は測っていない次元」)。
 */
function wasmWithNames(entries: readonly (readonly [number, string])[]): Buffer {
  const map: number[] = [...uleb(entries.length)];
  for (const [index, name] of entries) map.push(...uleb(index), ...str(name));
  const body = [
    ...subsection(0, str('soffice.wasm')), // 副節 0 = モジュール名(namemap ではない)
    ...subsection(1, map), // 副節 1 = 関数名
  ];
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...customSection('name', body),
  ]);
}

/**
 * 🔴 **name section は在るが、関数名の副節(id=1)が無い** wasm。
 * ⚠ これが無いと「関数名 0 件なら落とす」門を外しても緑になる(変異試験 M2)。
 */
function wasmWithModuleNameOnly(): Buffer {
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...customSection('name', subsection(0, str('soffice.wasm'))),
  ]);
}

/**
 * 🔴 **対照群 ── 配っている一式と同じ「名前を持たない」wasm**。
 * ⚠ ただの空 module にすると「custom section を 1 つも読まない実装」でも通るので、
 *   **別の custom section は持たせる**(`producers` は実物にも在る)。
 */
function wasmWithoutNames(): Buffer {
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...customSection('producers', [0x00]),
  ]);
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/**
 * ⚠ **成功した回の stderr も返す。**
 *   `execFileSync` は成功時に stderr を捨てるので、それで書くと
 *   「読めた件数」を見る assert が**常に空振り**する(1 稿目で踏んだ)。
 */
function run(dir: string, args: readonly string[]): Run {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf-8',
    cwd: process.cwd(),
    // ⚠ 既定でも pipe だが、明示する ── 書かないと子の stderr が画面へ漏れる形と
    //    見分けられない(`tests/repo-hygiene.test.ts` の「stdio を書いている」)
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** 名前つき一式の置き場を 1 つ作る(`soffice.wasm` + `build-info.json`)。 */
function pack(wasm: Buffer, loSha: string): { dir: string; wasm: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-wasm-names-'));
  const path = join(dir, 'soffice.wasm');
  writeFileSync(path, wasm);
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ version: 'lo-x-run1', lo_sha: loSha }));
  return { dir, wasm: path };
}

// #631 の実証で使われた実物の対(番号 → 名前)。⚠ 綴りをそのまま fixture に使う
const REAL: readonly (readonly [number, string])[] = [
  [60973, 'Scheduler::CallbackTaskScheduling()'],
  [198121, 'QtTimer::timeoutActivated()'],
  [235333, 'void doActivate<false>(QObject*, int, void**)'],
];
const SHA = '63426ccd1d7c9a0b1e2f3a4b5c6d7e8f90a1b2c3';

describe('wasm の番号を名前に直す(#631)', () => {
  it('🔴 番号を渡すと名前が返る(複数バイトの LEB128 を含む)', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA, '60973', '235333']);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toBe(
        '60973\tScheduler::CallbackTaskScheduling()\n235333\tvoid doActivate<false>(QObject*, int, void**)\n',
      );
      /**
       * 🔴 **読めた件数まで見る。**
       * ⚠ 引いた番号だけを見ていると、**副節 0 を関数名として読む**実装
       *   (= id での絞り込みを外した形)でも緑になる ── 副節 1 が後から
       *   正しい値で上書きするからである(変異試験 M7 が SURVIVED で教えた)。
       */
      expect(r.err, '読めた名前の件数が fixture と違う ── 副節 0 まで名前として読んでいる')
        .toContain(`名前 ${REAL.length} 件`);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 スタックの字をそのまま食わせると、拾って直す', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    const stack = join(p.dir, 'stack.txt');
    writeFileSync(
      stack,
      'at wasm-function[198121] (wasm://wasm/00e0:1)\nat wasm-function[60973] (…)\n',
      'utf-8',
    );
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA, '--stack', stack]);
      expect(r.code, r.err).toBe(0);
      // ⚠ **出てきた順**で返る(読み手はスタックの順に読む)
      expect(r.out).toBe(
        '198121\tQtTimer::timeoutActivated()\n60973\tScheduler::CallbackTaskScheduling()\n',
      );
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 名前が 0 件の一式(= 配っているほう)を渡すと落ちる', () => {
    const p = pack(wasmWithoutNames(), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA, '60973']);
      expect(r.code, '名前 0 件なのに通った ── 黙って「名前なし」を並べている').not.toBe(0);
      expect(r.err).toContain('name section が 0 件');
      // ⚠ 落ちたときに**何も刷らない**(半端な表を読ませない)
      expect(r.out).toBe('');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 lo_sha が違えば落ちる ── 別の枝の名前をそれらしく出さない', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', '95e83feb2e85', '60973']);
      expect(r.code, '枝が違うのに引けてしまった(#631 の反例をそのまま踏む)').not.toBe(0);
      expect(r.err).toContain('lo_sha が食い違う');
      expect(r.out).toBe('');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('⚠ 対照群 ── 短縮 sha でも、前方一致していれば引ける', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA.slice(0, 12), '60973']);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toBe('60973\tScheduler::CallbackTaskScheduling()\n');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 6 文字以下の sha は一致と見なさない(別の枝に当たる)', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA.slice(0, 6), '60973']);
      expect(r.code, '6 文字で通った ── 短すぎる突合は別の枝に当たる').not.toBe(0);
      expect(r.err).toContain('lo_sha が食い違う');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 build-info.json が無ければ落ちる(どの枝か分からないまま引かない)', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    rmSync(join(p.dir, 'build-info.json'));
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA, '60973']);
      expect(r.code, '枝が分からないのに引けてしまった').not.toBe(0);
      // ⚠ 「読めない」ではなく「**無い**」と言い分ける ── 綴り違いと欠落は直し方が違う。
      //    file 名だけを見る assert は、`exists()` の門を外しても
      //    OSError の文言に満たされて緑になる(変異試験 M5)
      expect(r.err).toContain('どの枝で焼いた一式か分からない');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 引けなかった番号があれば落ちる(穴を黙って読ませない)', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA, '60973', '999999']);
      expect(r.code, '引けない番号が在るのに通った').not.toBe(0);
      // ⚠ 引けた分は刷る(読み手はそこまでを使える)── 落ちるのは**後**である
      expect(r.out).toContain('60973\tScheduler::CallbackTaskScheduling()');
      expect(r.out).toContain('999999\t?');
      expect(r.err).toContain('引けなかった番号');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('⚠ 番号を 1 つも渡さなければ落ちる(黙って何も出さない、をしない)', () => {
    const p = pack(wasmWithNames(REAL), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('引く番号が 1 つも無い');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 name section は在るが関数名が 0 件でも落ちる', () => {
    const p = pack(wasmWithModuleNameOnly(), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA, '60973']);
      expect(r.code, '関数名 0 件なのに通った ── 名前を引ける一式ではない').not.toBe(0);
      expect(r.err).toContain('関数名の副節');
      expect(r.out).toBe('');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it('🔴 wasm でない file を渡すと落ちる', () => {
    const p = pack(Buffer.from('not a wasm at all', 'utf-8'), SHA);
    try {
      const r = run(p.dir, ['--wasm', p.wasm, '--lo-sha', SHA, '60973']);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('wasm ではない');
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});
