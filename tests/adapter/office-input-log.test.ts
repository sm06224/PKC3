/** @vitest-environment happy-dom */
/**
 * 🔴 **Office の入力経路を console に出す口**(#433 の計測)。
 *
 * ⚠ 見るのは 2 つ:①**既定では 1 バイトも足さない** ②**窓を開くたびに読み直す**。
 * ⚠ ②が要るのは flag がフラグ画面から変わるからである ── 構築時に固めると
 *   「切り替えたのに次の窓でも出ない」になる(そして user は flag を疑わない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OfficeWindow } from '../../src/adapter/platform/office/office-window';

function harness(inputLog: () => boolean) {
  const opened: string[] = [];
  return {
    opened,
    ow: new OfficeWindow({
      openWindow: (url) => { opened.push(url); },
      makeChannel: () => ({ postMessage: () => {}, close: () => {}, onmessage: null }) as never,
      // ⚠ **大きな値にする** ── `lastAliveAt` の初期値は 0 なので、`now` が小さいと
      //   「たったいま生きていた」と読まれて `already-open` になり、窓が開かない
      //   (既存の harness が `100_000` を使っているのは同じ理由である)
      now: () => 100_000,
      baseUrl: 'https://app.example/pkc3/',
      inputLog,
    }),
  };
}

describe('flag が切れているとき', () => {
  it('🔴 URL に 1 バイトも足さない(既定で console を汚さない)', () => {
    const { ow, opened } = harness(() => false);
    ow.open({});
    expect(opened[0]).toBe('https://app.example/pkc3/office/host.html');
  });

  it('他の項目が在っても、計測の項目は付かない', () => {
    const { ow, opened } = harness(() => false);
    ow.open({ name: 'a.docx', expectDocument: true });
    expect(opened[0]).not.toContain('input-log');
  });
});

describe('flag が立っているとき', () => {
  it('🔴 窓の URL に計測の項目が付く', () => {
    const { ow, opened } = harness(() => true);
    ow.open({});
    expect(opened[0]).toContain('input-log=1');
  });

  it('文書つきで開いても付く(経路で落ちない)', () => {
    const { ow, opened } = harness(() => true);
    ow.open({ name: 'a.docx', expectDocument: true });
    expect(opened[0]).toContain('await-doc=1');
    expect(opened[0], '添付から開く経路で計測が落ちている').toContain('input-log=1');
  });

  /**
   * 🔴 **窓を開くたびに読み直す**(値で固めない)。
   * ⚠ 固めると「フラグ画面で入れたのに、次に開いた窓でも出ない」になる ──
   *   user は「flag が壊れている」ではなく「**Office が壊れている**」と読む。
   */
  it('🔴 途中で切り替えると、次に開く窓から効く', () => {
    let on = false;
    const { ow, opened } = harness(() => on);
    ow.open({});
    on = true;
    ow.open({});
    expect(opened[0], '1 枚目は切れていた').not.toContain('input-log');
    expect(opened[1], '2 枚目に効いていない ── 構築時に固めている').toContain('input-log=1');
  });
});

/**
 * 🔴 **flag と窓が、実際に繋がっている**(#433)。
 *
 * ⚠ ここが無いと、**flag は在る / 窓は受ける / でも誰も繋いでいない**という形が
 *   緑のまま通る ── user から見ると「フラグを入れたのに何も出ない」で、
 *   ⚠ そのとき疑われるのは **Office のほう**である(flag は疑われない)。
 * ⚠ 変異試験 P7(`main.ts` が flag を読まない)が `SURVIVED` で教えた。
 * ⚠ `main.ts` は**原文を読む test しか無い**ので pin は弱い ── 弱いと自覚して使う
 *   (CLAUDE.md §2「どの test からも実行されない file に判断を書かない」)。
 */
describe('flag と窓の配線(main.ts の原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf8');

  it('🔴 `OfficeWindow` に flag を渡している', () => {
    expect(MAIN, '窓に計測の口を渡していない').toContain('inputLog:');
    expect(MAIN, '渡しているが flag を読んでいない(常に false などになっている)').toContain(
      'FLAG_OFFICE_INPUT_LOG.name',
    );
  });

  it('⚠ 登記所の flag を import している(綴りを直書きしていない)', () => {
    expect(MAIN).toContain('FLAG_OFFICE_INPUT_LOG');
  });
});

/**
 * 🔴 **窓の中(別 document)が、その項目を実際に読んでいる**。
 *
 * ⚠ ここを見ないと、`office-window.ts` は正しく付けているのに
 *   `host.html` が読んでいない、という**両端が別々に緑**の形になる
 *   (CLAUDE.md §7 の #195 で実際に踏んだ ── 外殻とホストが
 *   「相手を模した stub」と話していて、綴りの食い違いが両方緑のまま通った)。
 */
describe('窓の側(host.html)', () => {
  const HOST = readFileSync('public/office/host.html', 'utf8');

  it('🔴 送る綴りと読む綴りが一致している', () => {
    expect(HOST, 'host.html が計測の項目を読んでいない').toContain("params.has('input-log')");
  });

  it('🔴 立てるのは Qt の log 種別(綴りを間違えると黙って何も出ない)', () => {
    expect(HOST).toContain('QT_LOGGING_RULES');
    expect(HOST, 'log の種別が違う ── 出るのは別の面の行になる').toContain(
      'qt.qpa.wasm.inputcontext.debug=true',
    );
  });

  it('⚠ `preRun` に載せている(起動後に立てても Qt はもう読んでいる)', () => {
    expect(HOST).toContain('preRun: preRun');
  });
});
