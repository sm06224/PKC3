/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-templates.py` を検める(#591 の**直し**)。
 *
 * 🔴 **これは配る一式に入る直しである**(計装ではない)。#591 は PR #601 で
 * `--with-templates=yes` を渡して閉じたつもりだったが、**届いていなかった** ──
 * run 33279050889 の一式を落として目録を数えたら **`.otp` 0 件 / `.ott` 0 件**
 * (拡張子 `.otp .ott .otg .otm .ots` のどれも 1 件も無い)。
 *
 * 真因は `patch-lo-scripting.py`(#431)と**同じ 2 段**である:
 * `configure.ac:1301` が Emscripten で `enable_wasm_strip=yes` を無条件に立て、
 * `configure.ac:3495` がその中で **`with_templates=no` を無条件に上書き**する。
 *
 * ⚠ **錨は上流の実物と一字一句同じ**でなければならない。上流が形を変えたら
 * **黙って当たらない**のではなく**落ちる**こと ── それがこの検査の主眼である。
 *
 * 🔴 見るのは 5 つ:①当たる ②当たった結果が**shell として正しく動く**
 * ③二重当ては落ちる ④**錨が無ければ落ちる** ⑤**既定が変わらない**。
 *
 * 🔑 ②が肝である ── 字面が入ったことだけ見る検査は、
 * 「`${with_templates+set}` が実は常に set」のような**意味論の誤り**を
 * 1 つも捕まえられない(`patch-lo-scripting.py` の 1 稿目がまさにそれで、
 * `AC_ARG_ENABLE(scripting)` は action-if-not-given を持つので `+set` が
 * 常に真になり、**wasm の既定まで scripting on** になるところだった)。
 * ⚠ `templates` はそこが違う ── `AC_ARG_WITH(templates, AS_HELP_STRING(...), )` は
 * **action を 1 つも持たない**。だからここでは使える。
 * その差は**字面では見えない**ので、**shell を実際に走らせて**確かめる。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-templates.py';
const REL = 'configure.ac';

/**
 * 🔴 **上流の実物と同じ字**(LO `47104c82` で一致を確認済み ── 全体で 1 件)。
 * ⚠ ここを「だいたい同じ」で書くと、**patch が本物に当たらないのに test は緑**になる。
 */
const UPSTREAM_BLOCK = `if test "$enable_wasm_strip" = "yes"; then
    enable_report_builder=no
    enable_sdremote=no
    with_galleries=no
    with_gssapi=no
    with_templates=no
    with_x=no

    test "\${with_fonts+set}" = set || with_fonts=yes
fi
`;

/**
 * 🔴 **`configure.ac:3622-3641` をそのまま写した**(`_os` は Emscripten)。
 * ⚠ patch が触るのは 3495 行だが、**効いたかどうかが決まるのはここ**である ──
 * だから検査は「置換できた」ではなく「**この枝を通した結果**」で採る。
 */
const DECIDER = `_os=Emscripten
WITH_TEMPLATES=TRUE
if test -n "\${with_templates}"; then
    if test "$with_templates" = "yes"; then :
    elif test "$with_templates" = "no"; then WITH_TEMPLATES=
    else echo UNKNOWN; exit 1
    fi
else
    if test $_os != iOS -a $_os != Android -a $_os != Emscripten; then :
    else WITH_TEMPLATES=
    fi
fi
printf 'WITH_TEMPLATES=[%s]\\n' "$WITH_TEMPLATES"
`;

interface Tree {
  dir: string;
  read: () => string;
  run: () => { code: number; out: string };
}

function tree(body: string): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-tpl-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, REL), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    run: () => {
      try {
        return { code: 0, out: execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' }) };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    },
  };
}

/**
 * patch を当てた `configure.ac` から**書き換えた行だけ**を取り出し、
 * 「その行 + 判定の枝」を `sh` に食わせて `WITH_TEMPLATES` を読む。
 *
 * 🔑 **実装の綴りを test 側で書き直さない**(CLAUDE.md「期待値は別の綴りではなく
 * 別の観測から作る」)── 走らせるのは**patch が書いた行そのもの**である。
 */
function decide(patched: string, given: 'yes' | 'no' | null): string {
  const line = patched.split('\n').find((l) => l.includes('with_templates+set'));
  expect(line, 'patch が書いた行を取り出せない').toBeTruthy();
  const pre = given === null ? 'unset with_templates' : `with_templates=${given}`;
  const out = execFileSync('sh', ['-c', `${pre}\n${line}\n${DECIDER}`], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  const m = /WITH_TEMPLATES=\[(.*)\]/.exec(out);
  expect(m, `判定の出力を読めない: ${out}`).not.toBeNull();
  return m![1]!;
}

describe('patch-lo-templates.py(#591 の直し)', () => {
  it('🔴 上流の実物に当たり、二度目は SKIP する', () => {
    const t = tree(UPSTREAM_BLOCK);
    try {
      const first = t.run();
      expect(first.code, first.out).toBe(0);
      expect(first.out).toContain('OK');
      const patched = t.read();
      // 空振り防止 ── 「当たった」と言うからには、元の無条件代入が消えている
      expect(patched, '無条件の with_templates=no が残っている').not.toMatch(
        /^\s{4}with_templates=no$/m,
      );
      expect(patched).toContain('with_templates+set');
      // ⚠ 周りの行は 1 バイトも変えない(同じブロックの他の既定を巻き込まない)
      expect(patched).toContain('    with_gssapi=no\n');
      expect(patched).toContain('    with_x=no\n');

      const second = t.run();
      expect(second.code, second.out).toBe(0);
      expect(second.out).toContain('SKIP');
      expect(t.read(), '二度目で中身が変わった').toBe(patched);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **ここが本題** ── 字面ではなく、**走らせた結果**で 3 通りを見る。
   *
   * ⚠ 対照群(1 行目)を置かないと、②③ が「そもそも patch が無意味」でも通る。
   */
  it('🔴 走らせると、渡した回だけ TRUE になり、既定は変わらない', () => {
    const t = tree(UPSTREAM_BLOCK);
    try {
      expect(t.run().code).toBe(0);
      const patched = t.read();
      // ① 対照群 ── 直す前は、何を渡しても潰されて空になる
      const before = execFileSync(
        'sh',
        ['-c', `with_templates=yes\n    with_templates=no\n${DECIDER}`],
        { encoding: 'utf-8', stdio: 'pipe' },
      );
      expect(before, '直す前でも TRUE になるなら、この patch は何も直していない').toContain(
        'WITH_TEMPLATES=[]',
      );
      // ② 渡した回は届く(#591 の直しそのもの)
      expect(decide(patched, 'yes'), '--with-templates=yes が届いていない').toBe('TRUE');
      // ③ 渡さない回は既定のまま(docstring の「1 バイトも変わらない」を留める)
      expect(decide(patched, null), '渡していないのに既定が変わった').toBe('');
      // ④ no を渡した回は尊重する(尊重の向きが片道になっていないこと)
      expect(decide(patched, 'no'), '--with-templates=no を無視した').toBe('');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 錨が無ければ落ちる(上流の変形に気づける)', () => {
    const t = tree('nothing to anchor on\n');
    try {
      const r = t.run();
      expect(r.code, '上流が形を変えても黙って通った').not.toBe(0);
      expect(r.out).toContain('錨が 0 件');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **workflow 側の指示と対で効く**(片方だけ消せば静かに空へ戻る)。
   * ⚠ だから両方を留める ── patch は「渡された指示を届かせる」だけで、
   * **渡す指示そのものは workflow に在る**。
   */
  it('🔴 workflow が --with-templates=yes を渡し、config_host.mk で受け取りを確かめる', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    // ⚠ コメント行を落としてから見る ── 解説文に満たされないため
    const code = yml
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code, 'テンプレートを建てる指示が消えている').toContain('--with-templates=yes');
    expect(code, 'configure の直後に受け取りを確かめていない').toContain(
      "grep -q '^export WITH_TEMPLATES=TRUE$' config_host.mk",
    );
  });
});
