/** @vitest-environment node */
/**
 * `build/office-wasm/check-fs-image-uifiles.py` を検める(#225)。
 *
 * 🔴 **これは「焼けた」と「届いた」の間に置いた後条件である。**
 * 非 ODF の保存が「一般的な I/O エラー」で落ちていた原因は、確認ダイアログの
 * `cui/ui/querydialog.ui` が**配る一式に入っていなかった**ことだった。
 * ⚠ **そのとき鳴った計器は 1 つも無い** ── `patch-lo-uifiles.py` の tripwire は
 * **一覧(mk)の側**しか見ず、焼きの検品は**日本語の翻訳しか数えていなかった**。
 *
 * 🔑 だからこの検品は **配った物の目録**(`soffice.data.js.metadata`)と一覧を
 * **集合で**突き合わせる。件数だけの検査は、同じ数だけ取り違えても緑になる。
 *
 * ⚠ **fixture は下限(900 件)を超える大きさで作る** ── 空振り防止を迂回する
 * 抜け道(環境変数 / flag)を製品側に開けないため。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/check-fs-image-uifiles.py';
const YML = '.github/workflows/office-wasm-build.yml';
const PREFIX = '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/';
/**
 * 🔴 **錨は script から読む。ここで綴り直さない**(CLAUDE.md §7)。
 *
 * ⚠ 2 か所に literal を置くと、片方だけ上流に追随して**両方緑のまま食い違う** ──
 *   実際 2026-08-28 に上流が `cui/ui/` → `svt/ui/` へ移し、script を直したときに
 *   ここが取り残された(この test が落ちて気づいた)。
 *
 * 🔴 **2026-08-28(2 度目): 綴りは 1 つではなくなった。**
 *   LO **26.8**(安定枝)は `cui/ui/…`、master は `svt/ui/…` ── **枝で違う**。
 *   script は**上流の実装から引く**ようになったので、ここは
 *   **引けなかったときの既知の綴り**(`ANCHOR_FALLBACK`)を読む。
 */
const FALLBACK = (() => {
  const m = /^ANCHOR_FALLBACK = \(([^)]+)\)$/m.exec(readFileSync(SCRIPT, 'utf-8'));
  const got = m?.[1];
  if (got === undefined) throw new Error(`${SCRIPT} から ANCHOR_FALLBACK を読めない(綴りが変わった)`);
  return [...got.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
})();
/** fixture に混ぜる 1 件(⚠ どれでもよい ── 機構の test は綴りに依らない)。 */
const ANCHOR = FALLBACK[0]!;

/** 下限(900)を超える名前の束。⚠ 超えないと空振り防止のほうで落ちる。 */
const names = (tag: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${tag}/ui/${tag}${String(i).padStart(4, '0')}.ui`);

const BASE = [...names('cui', 700), ...names('svx', 250), ANCHOR];

/**
 * 🔴 **`soffice.cfg/` の下に居る「`.ui` でない file」** ── メニューやツールバーの定義。
 * 実測(2026-08-24 の配った一式): `soffice.cfg/` 配下 1,688 件のうち
 * **598 件が `.ui` ではない**。⚠ この次元をゼロにした fixture では、
 * 「`.ui` だけを拾う」という絞り込みを外す変異が**素通りする**
 * (CLAUDE.md §2「fixture のゼロ件の次元は『測っていない次元』」)。
 */
const NOT_UI = [
  'modules/swriter/menubar/menubar.xml',
  'modules/scalc/popupmenu/anchor.xml',
  'modules/simpress/toolbar/standardbar.xml',
];

interface Run {
  code: number;
  out: string;
}

/**
 * 一覧(mk)と目録(metadata)を作って検品を走らせる。
 *
 * ⚠ **一覧には `.ui` 以外の行も混ぜる**(`.xcd` / ディレクトリ)── 読み手が
 * それを拾っていたら件数がずれて分かる。
 * ⚠ **目録にも `.ui` 以外を混ぜる**(`.wasm` / フォント)── 同じ理由。
 */
function run(listed: string[], delivered: string[]): Run {
  return runIn(null, listed, delivered);
}

/**
 * @param root 上流の木の根(⚠ script は `<mk の 2 つ上>` を根と見なすので、
 *   mk を `<root>/static/fs.mk` に置く)。`null` なら**実装を読めない場所**で回す。
 */
function runIn(root: string | null, listed: string[], delivered: string[]): Run {
  const dir = root === null ? mkdtempSync(join(tmpdir(), 'pkc3-uicheck-')) : root;
  const keep = root !== null;
  try {
    const mk = [
      'PKC3_FS_IMAGE_FILES := \\',
      '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/ \\',
      '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/main.xcd \\',
      // ⚠ 実物と同じく、`.ui` でない cfg の file も**同じ前置きで**並んでいる
      ...NOT_UI.map((rel) => `${PREFIX}${rel} \\`),
      ...listed.map((rel) => `${PREFIX}${rel} \\`),
      '',
    ].join('\n');
    const meta = {
      files: [
        { filename: '/instdir/program/soffice.wasm', start: 0, end: 1 },
        { filename: '/instdir/share/fonts/x.ttf', start: 1, end: 2 },
        // ⚠ `soffice.cfg/` の下だが `.ui` ではない ── 拾ってはいけない
        ...NOT_UI.map((rel) => ({
          filename: `/instdir/share/config/soffice.cfg/${rel}`,
          start: 0,
          end: 1,
        })),
        ...delivered.map((rel, i) => ({
          filename: `/instdir/share/config/soffice.cfg/${rel}`,
          start: i + 2,
          end: i + 3,
        })),
      ],
      remote_package_size: 1,
    };
    // ⚠ script は `mk の 2 つ上` を木の根と見なす ── 実物と同じ深さに置く
    const mkDir = join(dir, 'static');
    mkdirSync(mkDir, { recursive: true });
    const mkPath = join(mkDir, 'fs.mk');
    const metaPath = join(mkDir, 'meta.json');
    writeFileSync(mkPath, mk, 'utf-8');
    writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');
    try {
      const out = execFileSync('python3', [SCRIPT, mkPath, metaPath], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

describe('配った一式のダイアログ資源を検める', () => {
  it('一覧と目録が一致していれば通る(対照群)', () => {
    const r = run(BASE, [...BASE]);
    // 🔑 件数が **BASE ちょうど**であることが、`.ui` でない cfg の file
    //    (`NOT_UI` の 3 件)を**両側とも拾っていない**証拠である
    expect(NOT_UI.length, 'fixture が「.ui でない cfg の file」を持っていない').toBeGreaterThan(0);
    expect(r.out).toContain(`一覧 ${BASE.length} 件 / 配った物 ${BASE.length} 件`);
    expect(r.code, r.out).toBe(0);
  });

  it('🔴 一覧に在るのに配られていない 1 件を、名指しで落とす', () => {
    const dropped = 'svx/ui/svx0100.ui';
    const r = run(BASE, BASE.filter((n) => n !== dropped));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('一覧に在るのに配られていない 1 件');
    expect(r.out).toContain(dropped);
  });

  it('🔴 配られたのに一覧に無い 1 件を、名指しで落とす(読み方が追随できていない合図)', () => {
    const added = 'cui/ui/brandnew.ui';
    const r = run(BASE, [...BASE, added]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('配られたのに一覧に無い 1 件');
    expect(r.out).toContain(added);
  });

  /**
   * 🔴 **錨の身元を 1 本で pin する。**(2026-08-28)
   *
   * ⚠ 上の `ANCHOR` は script から読むので、**script を書き換えれば黙って追随する** ──
   *   それは「機構が動くこと」を見るには正しいが、**「正しい file を指しているか」は
   *   誰も見ていない**ことになる(§1 の空振り)。だからここで綴りそのものを留める。
   * 🔑 上流の実測(LO `570a4c78` → `72012ca1`):`cui/uiconfig/ui/querydialog.ui` は
   *   **404** になり、実体は `svtools` へ移った ──
   *   `include/svtools/querydialog.hxx` の `class QueryDialog` が
   *   `u"svt/ui/querydialog.ui"` を読み、`svtools/UIConfig_svt.mk` が登録している。
   *   配った一式でも確かめた(旧 `cui/ui/…` → 新 `svt/ui/…`)。
   * ⚠ **また移ったらここが落ちる。** そのときは「保存が壊れた」と読む前に
   *   上流の在り処を grep する(script の注記にその手順が書いてある)。
   */
  it('🔴 既知の綴りは、上流の 2 つの枝の両方を持っている', () => {
    // 🔑 master(`svt/ui/`)と 26.8(`cui/ui/`)── **どちらも実在する在り処**である
    expect(FALLBACK, '既知の綴りが片方しか無い(枝を替えた焼きが必ず落ちる)').toEqual([
      'svt/ui/querydialog.ui',
      'cui/ui/querydialog.ui',
    ]);
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src, '落ちたときの調べ方が書かれていない').toContain('grep -rn');
  });

  /**
   * 🔴 **綴りは上流の実装から引く**(2026-08-28、#511 の 26.8 の焼きで判明)。
   *
   * ⚠ 焼きは 3 時間 37 分かけて成功し、集合の突合も **1090 / 1090 で完全一致**
   *   だったのに、**焼き込んだ錨 1 件だけ**で赤になった ── 26.8 は
   *   `cui/ui/querydialog.ui` のままで、master が `svt/ui/` へ移していた。
   * 🔑 だから「その枝の実装が**実際に読む**綴り」を引く。
   *   ⚠ 引けたときは**その 1 つ**を要求する(移動を見逃さないため)。
   */
  it('🔴 実装から引いた綴りを要求する(別の枝の綴りでは通さない)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pkc3-lo-'));
    try {
      mkdirSync(join(root, 'include', 'svtools'), { recursive: true });
      writeFileSync(
        join(root, 'include', 'svtools', 'querydialog.hxx'),
        'GenericDialogController(pParent, u"svt/ui/querydialog.ui"_ustr, "Dialog")\n',
        'utf-8',
      );
      // ⚠ 一式は **26.8 の綴り**しか持っていない ── 実装は `svt/ui/` を読むので落ちる
      const listed = [...names('cui', 700), ...names('svx', 250), 'cui/ui/querydialog.ui'];
      const r = runIn(root, listed, [...listed]);
      expect(r.out, '実装から引いたことを言っていない').toContain('錨は実装から引いた');
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('svt/ui/querydialog.ui');
      // 🔴 **対照群** ── 実装の綴りが入っていれば通る(この検査が常に落ちるのではない)
      const ok = [...names('cui', 700), ...names('svx', 250), 'svt/ui/querydialog.ui'];
      expect(runIn(root, ok, [...ok]).code, '実装どおりの綴りなのに落ちた').toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * ⚠ **実装を読めない場所で回しても、判定は止めない**(既知の綴りへ落ちる)。
   * 🔑 そのとき**どちらで判定したかを必ず言う** ── 黙って通すと、次に読む人が
   *   「実装から引けている」と思い込む(#511 の 26.8 がまさにこの形で落ちた)。
   */
  it('⚠ 実装が読めないときは既知の綴りへ落ち、そう言う', () => {
    const listed = [...names('cui', 700), ...names('svx', 250), 'cui/ui/querydialog.ui'];
    const r = run(listed, [...listed]);
    expect(r.out, '落ちたことを言っていない').toContain('実装から錨を引けなかった');
    expect(r.code, r.out).toBe(0); // 26.8 の綴りでも通る
  });

  /**
   * 🔴 **錨が余計でないことを示す。** 一覧と目録から `querydialog` を**両方**落とすと
   * 集合は一致し、件数も下限を超える ── ⚠ 集合の突合だけなら**緑になる**。
   * それでも落ちなければ、#225 の当の欠落を素通りさせる検査である。
   */
  it('🔴 両方から querydialog が消えても落ちる(集合が一致していても)', () => {
    const without = BASE.filter((n) => n !== ANCHOR);
    const r = run(without, [...without]);
    expect(r.out, '差が無いことは前提 ── ここが崩れたら別の理由で落ちている').not.toContain(
      '一覧に在るのに配られていない',
    );
    expect(r.out).not.toContain('配られたのに一覧に無い');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(ANCHOR);
    expect(r.out).toContain('#225');
  });

  /**
   * 🔴 **空振り防止は片側ずつ検める。**
   * ⚠ 初稿は一覧と目録を**同時に**小さくしていたので、下限の検査を片方だけ殺しても
   * **もう片方が救って**落ち続けた ── 変異試験 M4 / M5 が SURVIVED で教えた
   * (CLAUDE.md §1「救い手が同じ式のもう一方の項だった」)。
   * 🔑 だから **どちらの下限が鳴ったのか、文言で分ける**。
   */
  it('🔴 一覧をほとんど読めていないとき、一覧側の下限で落ちる', () => {
    const tiny = ['cui/ui/a.ui', ANCHOR];
    const r = run(tiny, [...tiny]);
    expect(r.code, r.out).toBe(1);
    expect(r.out, '一覧側の下限が鳴っていない').toContain('一覧から 2 件しか読めていない');
  });

  it('🔴 配った物がほとんど空のとき、配った物側の下限で落ちる', () => {
    const r = run(BASE, ['cui/ui/a.ui', ANCHOR]);
    expect(r.code, r.out).toBe(1);
    expect(r.out, '配った物側の下限が鳴っていない').toContain('配った物に 2 件しか入っていない');
    // ⚠ ここで差分の側が鳴っていたら、下限を素通りしている(= 検査の順が壊れている)
    expect(r.out, '下限より先に差分が鳴っている').not.toContain('一覧に在るのに配られていない');
  });

  it('目録が JSON として読めなければ、そう言って落ちる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-uicheck-'));
    try {
      const mkPath = join(dir, 'fs.mk');
      const metaPath = join(dir, 'meta.json');
      writeFileSync(mkPath, BASE.map((rel) => `${PREFIX}${rel} \\`).join('\n'), 'utf-8');
      writeFileSync(metaPath, '{ これは JSON ではない', 'utf-8');
      let code = 0;
      let out = '';
      try {
        out = execFileSync('python3', [SCRIPT, mkPath, metaPath], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        code = err.status ?? -1;
        out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      expect(code, out).toBe(1);
      expect(out).toContain('JSON として読めない');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('焼きがこの検品を実際に呼ぶ', () => {
  /**
   * ⚠ 検査を書いただけでは足りない ── **呼ばれていること**を pin する
   * (CLAUDE.md「材料が実際に届いていることを pin する」)。
   */
  it('🔴 workflow が検品を呼び、目録ができた後に置かれている', () => {
    const yml = readFileSync(YML, 'utf-8');
    const callAt = yml.indexOf('check-fs-image-uifiles.py');
    expect(callAt, '焼きがこの検品を呼んでいない').toBeGreaterThan(-1);
    const madeAt = yml.indexOf('- name: 実行一式を集める');
    expect(madeAt, '実行一式を集める step が無い').toBeGreaterThan(-1);
    // ⚠ 目録は「実行一式を集める」が作る ── その前に読んでも file が無い
    expect(callAt, '目録ができる前に読んでいる').toBeGreaterThan(madeAt);
    // ⚠ 渡す 2 つが揃っていること(片方だけだと usage で exit 2 になり、
    //    「落ちた理由」が検品の結果と見分けられない)
    const step = yml.slice(callAt, callAt + 320);
    expect(step, '一覧を渡していない').toContain('CustomTarget_emscripten_fs_image.mk');
    expect(step, '目録を渡していない').toContain('soffice.data.js.metadata');
  });
});
