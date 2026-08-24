/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-uifiles.py` を**実物の入れ子ツリー**に当てて検める(#225)。
 *
 * 🔴 **これは 1 度落としたビルドの再発防止である**(2026-08-24、run 32734107620)。
 * 1 稿目は「上流に在る `.ui`」を **`<mod>/uiconfig/**` の実在**で数えて 57 件足し、
 * `gb_Deliver_deliver: file does not exist in instdir, and cannot be delivered:
 * .../cui/ui/fileextcheckdialog.ui` で**make ごと停止**した。
 * ⚠ `fileextcheckdialog` は `ifeq ($(OS),WNT)` の中でしか登録されておらず、
 * **ソースに在っても instdir へは配られない**。
 *
 * 🔑 だから検めるのは「何件足したか」ではなく **どれを足し、どれを足さなかったか**である。
 * ⚠ 件数だけ見る検査は、**足す物を全部取り違えても緑**になる。
 *
 * ⚠ **fixture は下限(900 件)を超える大きさで作る** ── script 側の空振り防止を
 * 迂回する抜け道(環境変数や flag)を製品側に開けないため。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-uifiles.py';
const PREFIX = '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/';

/** 一覧に載せる行(cfg 上の相対 path)。 */
const listLine = (rel: string): string => `${PREFIX}${rel} \\`;

/** 連番の名前。⚠ 下限 900 を超えるために要る。 */
const names = (tag: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(4, '0')}`);

const CUI = names('a', 600);
const SW = names('w', 400);
const SD = names('d', 20);

interface Tree {
  dir: string;
  mk: string;
}

/**
 * LO の形をした最小の木を作る。
 *
 * - `cui` … 条件なしの登録。**`querydialog` だけ一覧に無い**(= 足されるべき)
 * - `cui` の `ifeq ($(OS),WNT)` … `fileextcheckdialog`(= 足してはいけない)
 * - `sw` … `ifneq ($(ENABLE_WASM_STRIP_WRITER),TRUE)` の中に一覧が在る。
 *   `newcomment` だけ一覧に無い(= **その条件ブロックの中へ**足されるべき)
 * - `sd` … `modules/sdraw` を登録するが、一覧には 1 件も無い
 *   (= モジュールごと積んでいない。足してはいけない)
 */
function makeTree(extraListLines: string[] = []): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-uifiles-'));
  mkdirSync(join(dir, 'static'), { recursive: true });
  mkdirSync(join(dir, 'cui', 'uiconfig', 'ui'), { recursive: true });
  mkdirSync(join(dir, 'sw'), { recursive: true });
  mkdirSync(join(dir, 'sd'), { recursive: true });

  const list = [
    'gb_emscripten_fs_image_files := \\',
    '    $(INSTROOT)/$(LIBO_BIN_FOLDER)/intro.png \\',
    ...CUI.map((n) => listLine(`cui/ui/${n}.ui`)),
    ...extraListLines,
    '',
    'ifneq ($(ENABLE_WASM_STRIP_WRITER),TRUE)',
    'gb_emscripten_fs_image_files += \\',
    ...SW.map((n) => listLine(`modules/swriter/ui/${n}.ui`)),
    '',
    'endif # !ENABLE_WASM_STRIP_WRITER',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'static', 'CustomTarget_emscripten_fs_image.mk'), list);

  const call = (cfg: string, items: string[]): string =>
    [`$(eval $(call gb_UIConfig_add_uifiles,${cfg},\\`, ...items, '))'].join('\n');

  writeFileSync(
    join(dir, 'cui', 'UIConfig_cui.mk'),
    [
      '$(eval $(call gb_UIConfig_UIConfig,cui))',
      '',
      call(
        'cui',
        [...CUI, 'querydialog'].map((n) => `\tcui/uiconfig/ui/${n} \\`),
      ),
      '',
      'ifeq ($(OS),WNT)',
      call('cui', ['\tcui/uiconfig/ui/fileextcheckdialog \\']),
      'endif',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'sw', 'UIConfig_sw.mk'),
    [
      '$(eval $(call gb_UIConfig_UIConfig,modules/swriter))',
      '',
      call(
        'modules/swriter',
        [...SW, 'newcomment'].map((n) => `\tsw/uiconfig/swriter/ui/${n} \\`),
      ),
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'sd', 'UIConfig_sdraw.mk'),
    [
      '$(eval $(call gb_UIConfig_UIConfig,modules/sdraw))',
      '',
      call(
        'modules/sdraw',
        SD.map((n) => `\tsd/uiconfig/sdraw/ui/${n} \\`),
      ),
      '',
    ].join('\n'),
  );

  // 🔴 **ソースに実在するが登録されていない** file。1 稿目はこれを足して落ちた。
  writeFileSync(join(dir, 'cui', 'uiconfig', 'ui', 'ondiskonly.ui'), '<interface/>\n');

  return { dir, mk: join(dir, 'static', 'CustomTarget_emscripten_fs_image.mk') };
}

function run(dir: string): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 一覧に載っている cfg 相対 path。⚠ script と同じ正規表現を書き写さない ── 素直に読む。 */
function listed(mk: string): string[] {
  return readFileSync(mk, 'utf-8')
    .split('\n')
    .flatMap((l) => {
      const at = l.indexOf('/soffice.cfg/');
      return at < 0 || !l.trimEnd().endsWith('\\') ? [] : [l.slice(at + 13).replace(/ \\$/, '')];
    });
}

describe('#225 .ui の取りこぼしを埋める patch', () => {
  it('🔴 登録されているものだけを足す(ソースに在るだけの file は足さない)', () => {
    const { dir, mk } = makeTree();
    try {
      const before = listed(mk);
      // 前提の検算 ── fixture が下限を超えていること(超えないと script が別の理由で落ちる)
      expect(before.length, 'fixture が小さすぎる(空振り防止の下限に届かない)').toBeGreaterThan(
        900,
      );
      const { code, out } = run(dir);
      expect(code, out).toBe(0);
      const after = listed(mk);
      const added = after.filter((r) => !before.includes(r));

      // ✅ 足すべき 2 件
      expect(added.sort()).toEqual([
        'cui/ui/querydialog.ui',
        'modules/swriter/ui/newcomment.ui',
      ]);
      // 🔴 足してはいけない 3 種を名指しで見る(件数だけ見ると取り違えを見逃す)
      expect(after, '条件つきの登録を足している').not.toContain('cui/ui/fileextcheckdialog.ui');
      expect(after, 'ソースに在るだけの file を足している').not.toContain('cui/ui/ondiskonly.ui');
      expect(
        after.filter((r) => r.startsWith('modules/sdraw/')),
        '一覧に兄弟が 1 件も無いディレクトリへ足している',
      ).toEqual([]);
      // ⚠ 落とした理由を黙らない
      expect(out).toContain('兄弟が 1 件も無い');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 足す先は「同じディレクトリの兄弟の隣」── 条件ブロックの外へ出さない', () => {
    const { dir, mk } = makeTree();
    try {
      expect(run(dir).code).toBe(0);
      const lines = readFileSync(mk, 'utf-8').split('\n');
      const at = lines.findIndex((l) => l.includes('modules/swriter/ui/newcomment.ui'));
      const open = lines.findIndex((l) => l.startsWith('ifneq ($(ENABLE_WASM_STRIP_WRITER)'));
      const close = lines.findIndex((l) => l.startsWith('endif # !ENABLE_WASM_STRIP_WRITER'));
      expect(at, '足した行が見つからない').toBeGreaterThan(-1);
      expect(open, '条件ブロックの開きが見つからない').toBeGreaterThan(-1);
      expect(at, 'Writer の行が条件ブロックの前に出ている').toBeGreaterThan(open);
      expect(at, 'Writer の行が条件ブロックの後ろへ出ている').toBeLessThan(close);
      // ⚠ 継続行の形(末尾の ` \`)を保つ ── 崩すと make が一覧を打ち切る
      expect(lines[at]!.endsWith(' \\'), '継続の印が付いていない').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 一覧にしか無い .ui が在れば、名前を挙げて落ちる(登録を読めていない合図)', () => {
    const { dir } = makeTree([listLine('cui/ui/zzz_notregistered.ui')]);
    try {
      const { code, out } = run(dir);
      expect(code, '一覧にしか無い .ui を黙って通した').not.toBe(0);
      expect(out).toContain('cui/ui/zzz_notregistered.ui');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⚠ 二重当てを断る', () => {
    const { dir } = makeTree();
    try {
      expect(run(dir).code).toBe(0);
      const second = run(dir);
      expect(second.code, '2 回当ててしまう').not.toBe(0);
      expect(second.out).toContain('二重当て');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
