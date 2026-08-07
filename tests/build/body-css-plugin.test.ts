/**
 * `virtual:pkc-body-css` を配る Vite plugin(2026-08-07)。
 *
 * 🔴 **plugin の hook は Vite を起こさないと走らない。** 初版はここに test が 1 件も
 * 無く、`this.error` を 3 ブロックとも削除しても**全 test が緑**だった
 * (CLAUDE.md「検品する側・test する側も変異試験の対象にする」)。
 *
 * ⚠ 判定そのもの(何を不合格とするか)は `build/body-css.ts` の `auditBodyCss` に
 * 置いてあり、`tests/build/body-css.test.ts` が合成入力で検めている。ここが見るのは
 * **配線**:名前が解決するか / 他の id を掴まないか / **不合格のとき本当に止まるか**。
 *
 * ⚠ 壊れた入力は **fs を mock せず、別の root を指させて**作る ── 実際の読み込み経路と
 *   `configResolved` の配線を同時に通せるので、mock より検出力が高い。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BODY_CSS_ID, bodyCssPlugin } from '../../build/body-css-plugin';

/** Rollup の plugin context の最小の代役(この plugin が触る 2 つだけ)。 */
function context(): { addWatchFile: ReturnType<typeof vi.fn>; error: (m: string) => never } {
  return {
    addWatchFile: vi.fn(),
    error: (m: string) => {
      throw new Error(m);
    },
  };
}

type Ctx = ReturnType<typeof context>;
type Hook<T> = (this: Ctx, id: string) => T;

/** 本文の規則が 1 本も無い app.css を持つ root を作る。 */
function brokenRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-bodycss-'));
  mkdirSync(join(dir, 'src/styles'), { recursive: true });
  writeFileSync(join(dir, 'src/styles/app.css'), '.some-other-scope p{color:red}\n', 'utf8');
  copyFileSync('src/styles/tokens.css', join(dir, 'src/styles/tokens.css'));
  return dir;
}

describe('本文 CSS の virtual module を配る plugin', () => {
  const plugin = bodyCssPlugin();
  const resolveId = plugin.resolveId as unknown as Hook<string | null>;
  const load = plugin.load as unknown as Hook<string | null>;

  it('名前を解決する(解決後の id は他の plugin が触らない印を持つ)', () => {
    const id = resolveId.call(context(), BODY_CSS_ID);
    expect(id, '名前が解決していない').toBeTruthy();
    // ⚠ 先頭の NUL が Rollup の「触るな」の印。**生バイトを書かない**ので符号で見る
    expect(id!.charCodeAt(0), '解決後の id に NUL の印が無い').toBe(0);
  });

  it('⚠ 他の id は掴まない(掴むと無関係な import が壊れる)', () => {
    const ctx = context();
    expect(resolveId.call(ctx, 'virtual:something-else')).toBeNull();
    expect(resolveId.call(ctx, '/src/main.ts')).toBeNull();
    expect(load.call(ctx, '/src/main.ts'), '他の id に中身を返している').toBeNull();
  });

  it('🔴 焼いた CSS を default export で返す(本文の規則とトークンが載っている)', () => {
    const ctx = context();
    const code = load.call(ctx, resolveId.call(ctx, BODY_CSS_ID)!)!;
    expect(code, 'default export になっていない').toMatch(/^export default "/);
    // ⚠ 返しているのは**文字列リテラル**である(素の CSS を返すと JS として壊れる)
    const css = JSON.parse(code.replace(/^export default /, '').replace(/;$/, '')) as string;
    expect(css, '本文の規則が入っていない').toContain('.pkc-md-rendered .pkc-section-callout');
    expect(css, 'トークンが入っていない').toContain('--surface-2:');
    expect(css.length, '短すぎる').toBeGreaterThan(8000);
  });

  it('🔴 CSS の変更を監視に載せる(直したのに変わらない、を作らない)', () => {
    const ctx = context();
    load.call(ctx, resolveId.call(ctx, BODY_CSS_ID)!);
    const watched = ctx.addWatchFile.mock.calls.map((c) => String(c[0]));
    expect(
      watched.some((p) => p.endsWith('app.css')),
      'app.css を監視していない',
    ).toBe(true);
    expect(
      watched.some((p) => p.endsWith('tokens.css')),
      'tokens.css を監視していない',
    ).toBe(true);
  });

  /**
   * 🔴 **不合格のときに本当に build が止まる**。ここが繋がっていないと、
   * `auditBodyCss` をどれだけ厳しくしても**出荷は止まらない** ── 判定を書いただけで
   * 満足する型の欠陥である(初版がまさにそれだった)。
   */
  it('🔴 抜き出しが壊れたら例外を投げて build を止める(理由つき)', () => {
    // ⚠ この plugin は別インスタンスにする ── root を差し替えるので、上の
    //    正常系と同じインスタンスを汚さない
    const p = bodyCssPlugin();
    const cfg = p.configResolved as unknown as (this: Ctx, c: { root: string }) => void;
    const id = (p.resolveId as unknown as Hook<string | null>).call(context(), BODY_CSS_ID)!;
    const ld = p.load as unknown as Hook<string | null>;
    const ctx = context();

    // まず既定の root で通ることを見る(下の throw が「常に落ちるだけ」でない担保)
    expect(ld.call(ctx, id), '既定の root で中身が返らない').toBeTruthy();

    cfg.call(ctx, { root: brokenRoot() });
    let msg = '';
    try {
      ld.call(ctx, id);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg, '壊れた入力で build が止まらない').toContain('焼き込みが壊れています');
    // ⚠ 理由まで出す(「どこか壊れた」では次の人が直せない)
    expect(msg, '規則が 0 本であることを言っていない').toContain('本しか抜けていません');
    expect(msg, 'トークンが焼かれていないことを言っていない').toContain('焼いたトークンが');
  });
});
