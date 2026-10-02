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
import {
  writeBackEntry,
  WRITE_BACK_EMPTY_NOTE,
  type WriteBackDeps,
} from '../../src/adapter/ui/actions/write-back';

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

  it('🔴 「やめる」を選んだら、1 バイトも書かないし何も言わない', async () => {
    const { deps, written, said } = harness({ confirm: async () => false });
    await writeBackEntry(deps);
    expect(written, '断ったのに書いた').toEqual([]);
    expect(said, '断っただけなのに何か言っている').toEqual([]);
  });

  /**
   * 🔴 **空の本文では書かない**(#215 段③)── 元のファイルが空で上書きされる。
   * 観測点は**ファイルへ書かれた中身**と**確認の窓が出たか**の 2 つ。
   * ⚠ 台は `getBody` を差し替えるだけ(門は `settle` の後の本文を見る)。
   */
  describe.each([
    ['空文字', ''],
    ['空白と改行だけ', '  \n\n\t \n'],
    ['全角空白だけ(日本語入力のまま打った)', '　　\n　'],
    ['設定行(frontmatter)だけ', '---\ntitle: メモ\ntags: [a]\n---\n'],
    ['設定行の後が空白だけ', '---\ntitle: メモ\n---\n\n  \n'],
    ['CRLF の設定行だけ', '---\r\ntitle: メモ\r\n---\r\n'],
  ])('本文が空(%s)', (_label, empty) => {
    it('🔴 確認の窓も出さず、書かず、理由を言う', async () => {
      let asked = 0;
      const { deps, written, said } = harness({
        getBody: async () => empty,
        confirm: async () => {
          asked += 1;
          return true;
        },
      });
      await writeBackEntry(deps);
      expect(written, '空の本文でファイルを上書きした').toEqual([]);
      expect(asked, '空なのに確認の窓を出した').toBe(0);
      expect(said).toEqual([`fail:${WRITE_BACK_EMPTY_NOTE}`]);
    });
  });

  it('🔴 断り文の字(画面に出る物)', () => {
    expect(WRITE_BACK_EMPTY_NOTE).toBe(
      '本文が空なので、元ファイルへは書き戻しません(消したいときはパソコン側で消してください)',
    );
  });

  /**
   * 🔴 **対照群**(空振り防止)── 上の門が「何でも断る」門ではないこと。
   * 設定行の**後に本文が在る** / 本文が 1 字だけ / 設定行ではない `---` で始まる文書は
   * 今までどおり確認 → 書く。
   */
  it.each([
    ['設定行 + 本文', '---\ntitle: メモ\n---\n本文'],
    ['1 字だけ', 'a'],
    ['先頭が水平線の普通の文書', '---\n本文\n'],
    ['前後に空白の在る本文', '\n  本文  \n'],
  ])('対照群: 本文が在れば書く(%s)', async (_l, text) => {
    let asked = 0;
    const { deps, written, said } = harness({
      getBody: async () => text,
      confirm: async () => {
        asked += 1;
        return true;
      },
    });
    await writeBackEntry(deps);
    expect(asked).toBe(1);
    expect(written).toEqual([text]);
    expect(said).toEqual(['done:書き戻しました: メモ.md']);
  });

  /**
   * 🔴 **確認の窓が開いている間に空にされても、書かない**。
   * ⚠ 確認の前に読んだ物を書く実装だと、ここで「空」ではなく古い本文を書いてしまう
   *   ── 門は**書く物そのもの**に掛かっていなければならない。
   */
  it('🔴 確認の間に本文が空になったら、書かない(書く物を読み直している)', async () => {
    let body = '確認の前の本文';
    const { deps, written, said } = harness({
      getBody: async () => body,
      confirm: async () => {
        body = '';
        return true;
      },
    });
    await writeBackEntry(deps);
    expect(written, '確認の間に空になったのに書いた').toEqual([]);
    expect(said).toEqual([`fail:${WRITE_BACK_EMPTY_NOTE}`]);
  });

  it('🔴 確認の間に本文が変わったら、確認の後の本文を書く(巻き戻さない)', async () => {
    let body = '確認の前の本文';
    const { deps, written } = harness({
      getBody: async () => body,
      confirm: async () => {
        body = '確認の間に書いた本文';
        return true;
      },
    });
    await writeBackEntry(deps);
    expect(written).toEqual(['確認の間に書いた本文']);
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
 * 🔴 **`settle` の 2 か所(確認の前 / 確認の後)を、それぞれ単独で守る**(#1266)。
 *
 * ⚠ 上の `lagging()` は「待つ前は**保存前の本文(空ではない)**、待った後は保存した本文」── 待たなくても
 *   空の門は通るので、**1 回目の `settle` を外しても緑**だった(変異で生き延びた)。2 回目も同じ:
 *   確認の間の変更は `getBody` を**直に書き換える**形で、`settle` を待たなくても見えていた。
 * 🔑 台を「**書込が飛んでいる間は disk に載っていない**」形にする(`settle` が解けて初めて載る)。
 *   これなら、待たない側は**空 / 古い本文**を読み、観測点(書かれた中身・断り)が分かれる。
 */
describe('settle は確認の前と後の両方で待つ', () => {
  /** 飛んでいる書込を持つ台。`settle()` が解けるまで、`post` した本文は `getBody` に見えない。 */
  function inFlight(initial: string) {
    let committed = initial;
    const queue: string[] = [];
    const store = {
      settleCalls: 0,
      post: (b: string): void => {
        queue.push(b);
      },
      settle: async (): Promise<void> => {
        store.settleCalls += 1;
        for (const b of queue.splice(0)) committed = b;
      },
      getBody: async (): Promise<string | null> => committed,
    };
    return store;
  }

  it('🔴 空のノートに字を打って保存し、すぐ押すと、打った字が書かれる(待たずに読むと空で断る)', async () => {
    const store = inFlight(''); // ディスクは空のまま
    store.post('打った字'); // 保存の書込が飛んでいる
    const { deps, written, said } = harness({ settle: store.settle, getBody: store.getBody });
    await writeBackEntry(deps);
    expect(said, '待たずに空を読んで断った').toEqual(['done:書き戻しました: メモ.md']);
    expect(written).toEqual(['打った字']);
  });

  it('🔴 確認の間に飛んでくる書込も、2 回目の待ちで着地してから読む(書く物は確認の後の本文)', async () => {
    const store = inFlight('確認の前の本文');
    const { deps, written } = harness({
      settle: store.settle,
      getBody: store.getBody,
      confirm: async () => {
        store.post('確認の間に飛んで来た本文'); // 窓が開いている間に別の保存が飛ぶ
        return true;
      },
    });
    await writeBackEntry(deps);
    expect(written, '確認の間の保存を待たず、古い本文を書いた(巻き戻し)').toEqual(['確認の間に飛んで来た本文']);
    expect(store.settleCalls, '待つのは確認の前と後で 2 回').toBe(2);
  });

  it('⚠ 対照群: 飛んでいる書込が無くても、待ちは 2 回呼ばれ、書かれる本文は変わらない', async () => {
    const store = inFlight('そのままの本文');
    const { deps, written } = harness({ settle: store.settle, getBody: store.getBody });
    await writeBackEntry(deps);
    expect(written).toEqual(['そのままの本文']);
    expect(store.settleCalls).toBe(2);
  });

  it('⚠ 「やめる」なら 2 回目の待ちも読みも起きない(待ちは確認の前の 1 回だけ)', async () => {
    const store = inFlight('本文');
    const { deps, written } = harness({ settle: store.settle, getBody: store.getBody, confirm: async () => false });
    await writeBackEntry(deps);
    expect(written).toEqual([]);
    expect(store.settleCalls).toBe(1);
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

  /**
   * 🔴 **章の欄が開いている間も断る**(#1044 段2 5巡目の修理、U4)。
   *
   * ⚠ 直す前は `state.phase !== 'ready'` だけを見ていた ── 章の欄は `phase` を
   *   `ready` のまま保つ(設計 doc §3)ので、章の欄が開いている間に書き戻すと
   *   disk の本文(下書きより古い)が user のファイルへ流れる。
   * ⚠ `main.ts` はどの test からも実行されない(CLAUDE.md §2)ので、原文 pin で
   *   妥協する ── `writeBackFile` の block が `hasUnsavedTyping(` を通ることだけ見る
   *   (`phase !== 'ready'` へ戻す変異(§1「代替物で満たせない条件にする」)が
   *   このまま `if (state.phase !== 'ready') {` を残しても拾えるよう、
   *   `hasUnsavedTyping` の呼び出しそのものを見る)。
   */
  it('🔴 writeBackFile は hasUnsavedTyping で断る(phase だけの判定に戻っていない)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main.ts', 'utf-8');
    const at = src.indexOf('writeBackFile: (lid) => {');
    expect(at, 'writeBackFile の service が読めない(空振り)').toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('\n    },\n', at));
    expect(block, 'hasUnsavedTyping を通していない(章の欄の gap が戻っている)').toContain(
      'hasUnsavedTyping(state)',
    );
    // ⚠ SECTION_DRAFT_NOTE を使わずに `phaseBlockReason('ready')`(= null)を
    //   出すと「null書き戻してください」になる(F-D と同じ罠) ── 出し分けを見る
    expect(block, 'section-draft 側の文言(SECTION_DRAFT_NOTE)が無い').toContain('SECTION_DRAFT_NOTE');
  });
});
