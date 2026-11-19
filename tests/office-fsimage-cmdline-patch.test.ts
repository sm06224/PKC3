/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-fsimage-cmdline.py` を検める(#591 の**直し**)。
 *
 * 🔴 **これは「字が入ったか」だけ見ても意味がない直しである。**
 * 守っているのは **`sh -c` の 1 引数が 128 KiB を越えない**ことなので、
 * ⚠ 字面の検査は「置換できた」しか言わない ── **効くかどうかは規模で決まる**。
 * 🔑 だから **実物の `make` に、実物と同じ規模の一覧を食わせて**両方向を見る。
 *
 * ## 実測(2026-08-30)
 *
 * | | file 数 | `--preload` の byte | 128 KiB まで |
 * |---|---|---|---|
 * | 直前の成功(run 33279050889) | 1,993 | 130,251 | 🟡 残り 821 |
 * | テンプレート 34 件を足した回 | 2,027 | 132,359 | 🔴 1,287 超過 |
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-fsimage-cmdline.py';
const REL = 'static/CustomTarget_emscripten_fs_image.mk';

/** 🔴 **上流の実物と同じ字**(LO `47104c82` の 1825 行目)。 */
const UPSTREAM = `$(emscripten_fs_image_WORKDIR)/soffice.data.js.metadata: $(emscripten_fs_image_WORKDIR)/soffice.data.filelist
\t$(call gb_Output_announce,x,$(true),GEN,2)
\tcd $(BUILDDIR) && \\
\t$(EMSDK_FILE_PACKAGER) $(emscripten_fs_image_WORKDIR)/soffice.data --preload $(shell cat $^) --js-output=$(emscripten_fs_image_WORKDIR)/soffice.data.js --separate-metadata \\
\t    || rm -f $(emscripten_fs_image_WORKDIR)/soffice.data.js
`;

function tree(body: string): { dir: string; read: () => string; run: () => { code: number; out: string } } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-fsimg-'));
  mkdirSync(join(dir, 'static'), { recursive: true });
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

describe('patch-lo-fsimage-cmdline.py(#591 の直し)', () => {
  it('🔴 上流の実物に当たり、二度目は SKIP する', () => {
    const t = tree(UPSTREAM);
    try {
      const first = t.run();
      expect(first.code, first.out).toBe(0);
      const patched = t.read();
      expect(patched, 'make 側の展開が残っている').not.toContain('--preload $(shell cat $^)');
      expect(patched, 'shell 側の展開になっていない').toContain('--preload $$(cat $^)');
      // ⚠ 周りは 1 バイトも変えない(recipe の他の部分を巻き込まない)
      expect(patched).toContain('--js-output=$(emscripten_fs_image_WORKDIR)/soffice.data.js');
      expect(patched).toContain('cd $(BUILDDIR) && \\');

      const second = t.run();
      expect(second.out).toContain('SKIP');
      expect(t.read()).toBe(patched);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 錨が無ければ落ちる(上流が形を変えたら気づける)', () => {
    const t = tree('nothing here\n');
    try {
      const r = t.run();
      expect(r.code, '上流が形を変えても黙って通った').not.toBe(0);
      expect(r.out).toContain('錨が 0 件');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **ここが本題** ── 実物の `make` で、**同じ規模の一覧**を両方向に通す。
   *
   * ⚠ 字面の検査だけだと、`$$(cat …)` を `$(shell cat …)` に戻す変更が
   *   「置換が無い」でしか落ちない ── **なぜ戻してはいけないか**を守っていない。
   * 🔑 実測の 132,359 byte を跨ぐ規模(約 136 KB)で:
   *   **make 側の展開は落ち、shell 側の展開は通る**ことを見る。
   */
  it('🔴 実物の make で、128 KiB を越える一覧を通す(直す前は Error 127)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-argmax-'));
    try {
      // 実物と同じ長さ(1 件 ≈ 65 byte)で、実測の 132,359 を越える規模にする
      // ⚠ 1 稿目は 2,030 件にしたが **123,829 byte** にしかならず、前提の assert が
      //    落ちて教えてくれた(1 件 61 byte だった ── 実物の平均 65 より短い)。
      //    🔑 だから件数ではなく**byte で足りるまで**積む。
      const limit = 132_359;
      const entries: string[] = [];
      let bytes = 0;
      for (let i = 0; bytes <= limit + 4096; i += 1) {
        const e = `instdir/share/config/soffice.cfg/modules/mod${String(i).padStart(5, '0')}/ui/d${String(i).padStart(5, '0')}.ui`;
        entries.push(e);
        bytes += e.length + 1;
      }
      const list = entries.join(' ');
      // ⚠ 前提を assert する ── 短い一覧で「通った」と読まないため
      expect(list.length, '台の一覧が実測より小さい(空振り)').toBeGreaterThan(limit);
      writeFileSync(join(dir, 'filelist'), list, 'utf-8');

      const run = (recipe: string): number => {
        writeFileSync(join(dir, 'Makefile'), `all:\n\t@cd . && ${recipe} || echo fallback\n`, 'utf-8');
        try {
          execFileSync('make', ['-C', dir], { encoding: 'utf-8', stdio: 'pipe' });
          return 0;
        } catch (e) {
          return (e as { status?: number }).status ?? 1;
        }
      };
      /**
       * 🔴 **この箱の make が、長い 1 行を断るかを先に確かめる**(対照群)。
       * ⚠ 2026-11-19 に CI の runner でだけ「make 側の展開なのに通った」と落ちた ── 頁は 4 KiB で、node から
       *   `sh -c` に同じ長さの 1 引数を渡すと断られるのに、**その runner の make は長い行を通した**(make の側の事情)。
       *   上限は箱しだいで、決め打てない。
       * 🔑 だから比べる相手は **make 自身**:直す前の形とは無関係の最小の行(`: xxxx…`、同じ長さ)を make に渡し、
       *   断られるかを見る。直す前の形の結果はそれと**同じ**であること(断る箱では落ちる = 直しが要る理由がその箱で成り立つ)。
       * ⚠ 直した形(shell が argv を組む)は**どの箱でも**通ること・中身が欠けないことを見る(下)。
       */
      const makeRefusesLongLine = run(`: ${'x'.repeat(list.length)}`) !== 0;
      // 直す前 ── make が行に並べる = sh -c の 1 引数が肥大する。⚠ 落ちるかは、この箱の make が長い 1 行を断るか(上)と同じ
      expect(
        run('/bin/echo -n $(shell cat filelist) > out') !== 0,
        `make 側の展開の結果が、この箱の make の 1 行の上限と食い違った(長い 1 行を${makeRefusesLongLine ? '断る' : '通す'} make / 一覧 ${String(list.length)} byte)`,
      ).toBe(makeRefusesLongLine);
      // 直した後 ── shell が argv を組むので通る
      expect(
        run('/bin/echo -n $$(cat filelist) > out'),
        'shell 側の展開でも落ちた ── 直しが効いていない',
      ).toBe(0);
      // ⚠ 通っただけでなく、一覧が 1 字も欠けずに渡っている(途中で切れて「通った」に見える形を通さない)
      expect(readFileSync(join(dir, 'out'), 'utf-8'), '直した側で一覧が欠けた').toBe(list);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
