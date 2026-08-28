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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * 🔑 綴りそのものは下の「錨の身元」1 本で pin する ── 機構の test は
 *   **どんな綴りでも成り立つ**ように書く(値ではなく振る舞いを見る)。
 */
const ANCHOR = (() => {
  const m = /^ANCHOR = "([^"]+)"$/m.exec(readFileSync(SCRIPT, 'utf-8'));
  const got = m?.[1];
  if (got === undefined) throw new Error(`${SCRIPT} から ANCHOR を読めない(綴りが変わった)`);
  return got;
})();

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
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-uicheck-'));
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
    const mkPath = join(dir, 'fs.mk');
    const metaPath = join(dir, 'meta.json');
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
    rmSync(dir, { recursive: true, force: true });
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
  it('🔴 錨は、いま上流が読んでいる在り処を指している', () => {
    expect(ANCHOR, '錨が上流の在り処と食い違っている').toBe('svt/ui/querydialog.ui');
    const src = readFileSync(SCRIPT, 'utf-8');
    // ⚠ 移動の履歴を消さない ── 消すと、次に落ちた人が同じ 1 時間を払う
    expect(src, '古い在り処の記録が消えている').toContain('cui/ui/querydialog.ui');
    expect(src, '落ちたときの調べ方が書かれていない').toContain('grep -rn');
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
