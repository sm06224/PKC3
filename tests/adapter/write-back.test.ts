/**
 * 🔴 **元の md へ書き戻すとき、飛んでいる書込を待つ**(#732、2026-09-05)。
 *
 * ## 直したバグ
 *
 * `main.ts` の書き戻しは、effect 層の書込 chain の**外**で disk の本文を読んでいた
 * ── つまり保存の直後に押すと、**保存前の本文が user のファイルへ書かれる**。
 * ⚠ 確認文言が言うとおり「ファイルの元の内容は失われます(**取り消せません**)」。
 * ⚠ しかも `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)ので、
 *   直しても守る物が無かった ── だから順番を持つ部分を `write-back.ts` へ出した。
 *
 * ## 観測点
 *
 * 🔑 「`settle()` を呼んだか」ではなく **ファイルへ書かれた中身**で見る
 *   (`export-entry-guard.test.ts` と同じ作法)── 呼んだかどうかは、
 *   呼んだ後に読み直していなければ何の意味も無い。
 */
import { describe, expect, it } from 'vitest';
import { writeBackEntry, type WriteBackDeps } from '../../src/adapter/ui/actions/write-back';

/**
 * 🔑 **書込が飛んでいる状態**を作る台。
 * `settle()` が解けるまで `getBody` は**古い本文**を返す(= 追い越すと古い方を書く)。
 */
function lagging(): { getBody: () => Promise<string | null>; settle: () => Promise<void> } {
  let landed = false;
  return {
    getBody: async () => (landed ? '保存した本文' : '保存前の本文'),
    settle: async () => {
      landed = true;
    },
  };
}

function harness(over: Partial<WriteBackDeps> = {}) {
  const written: string[] = [];
  const said: string[] = [];
  const lag = lagging();
  const deps: WriteBackDeps = {
    name: 'メモ.md',
    settle: lag.settle,
    getBody: lag.getBody,
    write: async (body) => {
      written.push(body);
      return { ok: true };
    },
    confirm: async () => true,
    done: (m) => said.push(`done:${m}`),
    fail: (m) => said.push(`fail:${m}`),
    ...over,
  };
  return { deps, written, said };
}

describe('元のファイルへ書き戻す', () => {
  it('🔴 飛んでいる書込が着地してから読む(古い本文で上書きしない)', async () => {
    const { deps, written, said } = harness();
    await writeBackEntry(deps);
    expect(written, '保存前の本文がファイルへ書かれた(取り消せない)').toEqual(['保存した本文']);
    expect(said).toEqual(['done:書き戻しました: メモ.md']);
  });

  /**
   * 🔴 **空振り防止** ── 上の 1 件は「台が古い本文を返しうる」ことに依っている。
   * 待たない実装なら**古い方**が書かれることを、ここで見せる(= 台が両者を
   * 見分けられる)。⚠ 置かないと、`getBody` が常に新しい本文を返す台でも緑になる。
   */
  it('⚠ 待たなければ古い本文が書かれる(台が両者を見分けられる)', async () => {
    const lag = lagging();
    const written: string[] = [];
    await writeBackEntry({
      name: 'メモ.md',
      // ⚠ ここだけ「待たない」に差し替える(実装ではなく台の対照群)
      settle: async () => {},
      getBody: lag.getBody,
      write: async (body) => {
        written.push(body);
        return { ok: true };
      },
      confirm: async () => true,
      done: () => {},
      fail: () => {},
    });
    expect(written).toEqual(['保存前の本文']);
  });

  it('🔴 「やめる」を選んだら、待ちもしないし 1 バイトも書かない', async () => {
    let settled = 0;
    const { deps, written, said } = harness({
      confirm: async () => false,
      settle: async () => {
        settled += 1;
      },
    });
    await writeBackEntry(deps);
    expect(written, '断ったのに書いた').toEqual([]);
    expect(settled, '断った人にまで書込の着地を待たせている').toBe(0);
    expect(said, '断っただけなのに何か言っている').toEqual([]);
  });

  it('⚠ 本文が見つからないときは、理由を出して書かない', async () => {
    const { deps, written, said } = harness({ getBody: async () => null });
    await writeBackEntry(deps);
    expect(written).toEqual([]);
    expect(said).toEqual(['fail:本文が見つかりません(整理された可能性)']);
  });

  it('⚠ 書けなかったときは、ファイル名と理由を出す', async () => {
    const { deps, said } = harness({
      write: async () => ({ ok: false, reason: 'ファイルへの書込を許可されませんでした' }),
    });
    await writeBackEntry(deps);
    expect(said).toEqual(['fail:メモ.md: ファイルへの書込を許可されませんでした']);
  });
});

/**
 * ⚠ **配線は原文 pin で妥協する**(`main.ts` はどの test からも実行されない)。
 * 🔑 見るのは 2 つ:①`writeBackEntry` を通していること
 * ②その場に **`getBody` を直に呼ぶ古い形が戻っていない**こと。
 */
describe('main.ts の配線(原文 pin)', () => {
  it('🔴 書き戻しは writeBackEntry を通り、getBody を直に呼んでいない', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main.ts', 'utf-8');
    const at = src.indexOf('writeBackFile: (lid) => {');
    expect(at, 'writeBackFile の service が読めない(空振り)').toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('\n    },\n', at));
    expect(block, 'writeBackEntry を通していない').toContain('writeBackEntry({');
    /**
     * ⚠ **「古い形が戻っていない」は書けない** ── 新しい形も同じ字
     *   (`client.request({ op: 'getBody' … })`)を `getBody:` の中に持つので、
     *   字面では**見分けられない**(1 稿目はここで空振りしていた)。
     * 🔑 順番の主張は `write-back.ts` の側で**振る舞い**として見る(上の 5 件)。
     *   ここが見るのは「**その口へ渡してあるか**」だけである。
     */
    expect(block, 'settled() を渡していない').toContain('storeEffects?.settled()');
  });
});
