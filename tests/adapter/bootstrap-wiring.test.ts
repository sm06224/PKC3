/** @vitest-environment node */
/**
 * `bootstrap()` の配線(P7)。
 *
 * ⚠ **原文の検査**である。`bootstrap()` は module 読込時に走り、実ブラウザの
 * PWA インストール / SW 登録を要求するので、node の unit からは呼べない ──
 * だからといって「誰も見ていない」で済ませると、**配線を消す変異が全緑で通る**
 * (実際に P7 段⑤ round-2 で 2 件がそうなっていた)。
 *
 * ⚠ 弱い検査だと自覚して使う。ここが守るのは「**呼んでいるか / 順序が正しいか**」
 * だけで、呼んだ結果は各 module の unit と smoke が見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync('src/main.ts', 'utf-8');

/** `bootstrap()` の本体だけを切り出す(他所の一致に救われないように)。 */
function bootstrapBody(): string {
  const at = MAIN.indexOf('function bootstrap()');
  expect(at, 'bootstrap() が無い').toBeGreaterThan(-1);
  return MAIN.slice(at);
}

describe('bootstrap の配線', () => {
  /**
   * 🔴 **ディープリンクは boot 完了の刻印より前に当てる**(#300 段②、2026-08-22)。
   *
   * ⚠ 後ろに置くと、`data-pkc-boot="ready"` を見て進む smoke / probe が
   *   **本文の面を見てから面が入れ替わる** ── 競走になり、`flake` の顔で出る。
   * ⚠ そして `main.ts` は**どの test からも実行されない**ので、配線を消す変異は
   *   全緑で通る(この file の冒頭の理由)。だから原文で pin する。
   * 🔑 判断・文言・断片の消し方は `deep-link.ts` の unit が見る ──
   *   ここが見るのは「**呼んでいるか / 順序が正しいか**」だけ。
   */
  it('🔴 ディープリンクを当ててから boot 完了を刻む', () => {
    const body = bootstrapBody();
    const applyAt = body.indexOf('applyViewDeepLink(');
    expect(applyAt, 'ディープリンクを当てていない').toBeGreaterThan(-1);
    const readyAt = body.indexOf(`setAttribute('data-pkc-boot', 'ready')`);
    expect(readyAt, 'boot 完了の刻印が無い').toBeGreaterThan(-1);
    expect(applyAt, '刻印の後に当てている(smoke と競走になる)').toBeLessThan(readyAt);
    // ⚠ 空振り防止 ── 撃つ先が dispatcher であること(呼ぶだけで捨てていない)
    expect(body.slice(applyAt, applyAt + 200)).toContain('app.dispatcher.dispatch');
  });

  it('🔴 SW の登録を boot の成功側・失敗側の**両方**から呼ぶ', () => {
    // round-2 review L-6: 当初は boot より**前**に登録していたが、`register` は
    // precache(実測 1.6MB)の取得を始めるので、**初回訪問で boot の wasm /
    // worker chunk と帯域を奪い合う**。かといって成功側だけに置くと、
    // 「boot が失敗しても次回オフラインで開ける」(段⑤ の意図)を失う。
    // ⚠ 変異試験で「失敗側の呼び出しを消す」が**生き残った**ので pin する
    const body = bootstrapBody();
    const calls = [...body.matchAll(/registerSw\(\)/g)].length;
    expect(calls, 'registerSw() の呼び出しが 2 か所ない').toBe(2);
    const thenAt = body.indexOf('.then((app)');
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(catchAt).toBeGreaterThan(thenAt);
    // 成功側は `.then` の中、失敗側は `.catch` の中
    expect(body.slice(thenAt, catchAt)).toContain('registerSw()');
    expect(body.slice(catchAt)).toContain('registerSw()');
  });

  it('🔴 登録は boot より**後**(帯域を奪い合わせない)', () => {
    const body = bootstrapBody();
    expect(body.indexOf('registerSw()')).toBeGreaterThan(body.indexOf('startApp(root)'));
  });

  /**
   * ⚠ **順序の検査は「両方が在ること」を先に見る**。`indexOf` は無いと `-1` を
   * 返すので、**片方を消すと `-1 < N` で素通りする** ── 実際に変異試験で
   * 「ready の印を消す」変異が生き残った(検査する側も変異の対象、CLAUDE.md)。
   */
  const orderedIn = (body: string, first: string, second: string): void => {
    const a = body.indexOf(first);
    const b = body.indexOf(second);
    expect(a, `${first} が無い`).toBeGreaterThan(-1);
    expect(b, `${second} が無い`).toBeGreaterThan(-1);
    expect(a, `${first} が ${second} より後ろにある`).toBeLessThan(b);
  };

  it('🔴 更新の見張りは boot が ready になってから張る', () => {
    // 案内の面は shell が無いと出せない ── 早く張ると `presentUpdate` が空を叩く
    orderedIn(bootstrapBody(), "'data-pkc-boot', 'ready'", 'watchForUpdate(');
  });

  it('🔴 `launchQueue` の受け口も boot が解決してから張る(段③)', () => {
    // 仕様上 LaunchParams は consume されるまで無期限にバッファされる ──
    // 早く張って自前バッファへ吸い出すと、取りこぼしの責任がアプリへ移る
    orderedIn(bootstrapBody(), '.then((app)', 'armLaunchQueue(');
  });

  it('🔴 boot 前の交代の見張りは **`startApp` より前**に張る(段⑧)', () => {
    // lease 待ちで止まっている窓こそが対象なので、boot の解決を待っては意味がない
    orderedIn(bootstrapBody(), 'reloadOnPrebootSwap(', 'startApp(root)');
  });

  it('🔴 boot が終わったら**成功側・失敗側の両方**で見張りを畳む(段⑧)', () => {
    // ⚠ 失敗側で畳まないと、更新のたびに **error 画面が勝手に読み直されて**
    // 理由が消える ── user は何が起きたか分からないまま同じ画面を見続ける
    const body = bootstrapBody();
    expect([...body.matchAll(/preboot\?\.booted\(\)/g)].length).toBe(2);
    const thenAt = body.indexOf('.then((app)');
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(body.slice(thenAt, catchAt)).toContain('preboot?.booted()');
    expect(body.slice(catchAt)).toContain('preboot?.booted()');
  });

  it('boot 失敗を白画面にしない(理由を出す)', () => {
    expect(bootstrapBody()).toContain("'data-pkc-boot', 'error'");
    expect(bootstrapBody()).toContain('起動に失敗しました');
  });
});

/**
 * 🔴 **boot が失敗したときの後始末**(2026-08-06。user 報告 2-14)。
 *
 * ⚠ ここも原文の検査である ── `bootstrap()` は node から呼べない。だが
 * 「誰も見ていない」で済ませると、**この 2 行を消す変異が全緑で通る**
 * (実際、直す前は `release()` の呼び出しが src に **0 件**だった)。
 */
describe('boot 失敗の後始末', () => {
  it('🔴 握った書込 lease を返す(他のタブを永久に待たせない)', () => {
    const body = bootstrapBody();
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(catchAt).toBeGreaterThan(-1);
    expect(
      body.slice(catchAt),
      'boot 失敗で lease を返していない ── このタブが開いている間、他のタブは' +
        '「別のタブで開いています」から進めない',
    ).toContain('bootLease?.release()');
    // ⚠ 成功側では返さない(握り続けるのが正しい)
    const thenAt = body.indexOf('.then((app)');
    expect(body.slice(thenAt, catchAt)).not.toContain('release()');
  });

  it('🔴 `release()` の呼び出しが src に実在する(0 件に戻っていない)', () => {
    // 直す前はここが 0 件だった ── 型が通るので tsc も lint も黙る
    expect(
      [...MAIN.matchAll(/bootLease\?\.release\(\)/g)].length,
      'lease を返す呼び出しが消えている',
    ).toBeGreaterThan(0);
  });

  it('🔴 OS から渡されたファイルが消えていないことを伝える', () => {
    const body = bootstrapBody();
    const catchAt = body.indexOf('.catch((e: unknown)');
    const tail = body.slice(catchAt);
    // 受け口は成功側にしか張らない(= 消えていない)ので、**そう言う**
    expect(tail, 'ファイルの行方を伝えていない').toContain('launchQueue');
    expect(tail).toContain('読み直すと開きます');
  });

  /**
   * 🔴 **起動したときのお知らせを、boot の成功側で出す**(P11 段⑤)。
   *
   * ⚠ この file は原文しか見ていないが、それでも置く ── `presentAnnounce()` を
   * 呼ばなくしても、`main.ts` は**どの test からも実行されない**ので全 test が
   * 緑だった(2026-08-08 の変異試験で確認)。
   * ⚠ **boot 完了の刻印より後**であることも見る ── 先に出すと、まだ何も映って
   *   いない画面に帯だけが立つ。
   */
  it('🔴 お知らせを、boot 完了の刻印の後に出す', () => {
    const body = bootstrapBody();
    const ready = body.indexOf("root.setAttribute('data-pkc-boot', 'ready')");
    const present = body.indexOf('app.presentAnnounce()');
    expect(present, 'お知らせを出していない(起動しても永久に出ない)').toBeGreaterThan(-1);
    expect(ready, 'boot 完了の刻印が無い').toBeGreaterThan(-1);
    expect(present, '刻印より先に出している(空の画面に帯だけが立つ)').toBeGreaterThan(ready);
    // ⚠ 失敗側では出さない(起動できていないのにお知らせを出さない)
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(body.slice(catchAt), '失敗側でお知らせを出している').not.toContain('presentAnnounce');
  });

  it('⚠ 受け口(launchQueue)は失敗側では張らない(consume すると本当に消える)', () => {
    const body = bootstrapBody();
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(
      body.slice(catchAt),
      '失敗側で受け口を張っている ── consume した時点でファイルは戻らない',
    ).not.toContain('armLaunchQueue(');
  });
});

/**
 * 🔴 **Office の窓が固まったことに気づく配線**(#135)。
 *
 * ⚠ ここも原文の検査である。`watchOfficeHang(...)` の呼び出しごと消しても、
 * `main.ts` は**どの test からも実行されない**ので全 test が緑になる ──
 * 「どの test からも実行されない file に、判断を書かない」の裏側で、
 * **判断を置かなくても「呼ぶのをやめる」変異は誰も殺さない**。
 *
 * ⚠ 弱い検査だと自覚して使う。物差しも文言も `office-hang-watch.ts` の unit が見る。
 */
describe('#135 ハング検知の配線', () => {
  it('🔴 watchOfficeHang を、showStatus へつないで呼ぶ', () => {
    const at = MAIN.indexOf('watchOfficeHang({');
    expect(at, '呼んでいない(固まっても永久に何も出ない)').toBeGreaterThan(-1);
    // 呼び出しの引数だけを見る(他所の一致に救われない)
    const args = MAIN.slice(at, MAIN.indexOf('});', at));
    expect(args, '放送を購読していない').toContain('officeWindow.onEvent');
    expect(args, '出口が status につながっていない').toContain('notify: showStatus');
    expect(args, 'visibilitychange を張る先を渡していない').toContain('doc: document');
  });

  it('🔴 OfficeWindow は 1 個だけ(窓の状態を 2 か所で持たない)', () => {
    // ⚠ 2 個作っても**放送は両方に届く**ので動いてしまう ── 静かに壊れる型である。
    //    余計な BroadcastChannel が開きっぱなしになり、使い回し判定の控えが分かれる
    const made = [...MAIN.matchAll(/new OfficeWindow\(/g)].length;
    expect(made, 'OfficeWindow を 2 個以上作っている').toBe(1);
  });

  it('⚠ 購読は opener が使うのと**同じ** instance に付ける', () => {
    // 別の instance を渡すと、上の「1 個だけ」を満たしたまま配線だけ外せる
    const at = MAIN.indexOf('createOfficeOpener({');
    expect(at).toBeGreaterThan(-1);
    expect(MAIN.slice(at, MAIN.indexOf('});', at))).toContain('officeWindow');
  });
});

/**
 * 🔴 **配布元と版が違うことを知らせる配線**(user 裁定 2026-08-13「通知のみで OK」)。
 *
 * ⚠ ここも原文の検査である ── 呼び出しごと消しても `main.ts` は
 * **どの test からも実行されない**ので全 test が緑になる。
 * ⚠ 弱い検査だと自覚して使う(判定も文言も `office-pack-update.ts` の unit が見る)。
 */
describe('配布元との版ちがいの配線', () => {
  it('🔴 checkPackUpdate を、目録だけ読む口へつないで呼ぶ', () => {
    const at = MAIN.indexOf('checkPackUpdate({');
    expect(at, '呼んでいない(版が違っても永久に何も出ない)').toBeGreaterThan(-1);
    const args = MAIN.slice(at, MAIN.indexOf('})', at));
    expect(args, '手元の版を渡していない').toContain('installedVersion');
    // 🔴 **一式(77MB)ではなく目録だけを読む口**を渡していること
    expect(args, '目録だけを読む口を渡していない').toContain('readAvailableVersion');
    expect(args, '一式を取りに行く口を渡している').not.toContain('installFromUrl');
  });

  it('🔴 結果を、設定の面と起動時の知らせの**両方**へ渡す', () => {
    // ⚠ 片方だけだと「設定を開かないと分からない」か「開いても消えている」になる
    const at = MAIN.indexOf('checkPackUpdate({');
    const tail = MAIN.slice(at, at + 900);
    expect(tail, '設定の面へ映していない').toContain('setAvailableVersion');
    expect(tail, '起動時に知らせていない').toContain('packUpdateNotice');
    expect(tail, '知らせの出口が status につながっていない').toContain('showStatus');
  });
});

/**
 * 🔴 **書き出しの前に、飛んでいる書込を着地させる配線**(2026-08-17 実測)。
 *
 * `ExportDeps.settle` は必須なので「渡し忘れ」は tsc が止めるが、
 * **`async () => {}` を渡す**(= 待たない)ことは止められない ── そこだけを見る。
 * ⚠ 実体の振る舞いは `store-settle.test.ts` と `export-entry-guard.test.ts` が持つ。
 */
describe('書き出しの settle の配線', () => {
  /** 書き出しの deps リテラルだけを切り出す(他所の一致に救われないように)。 */
  function exportDeps(): string {
    const at = MAIN.indexOf('const deps: ExportDeps = {');
    expect(at, 'ExportDeps の組み立てが無い').toBeGreaterThan(-1);
    const end = MAIN.indexOf('await exportEntryDocx(', at);
    expect(end, 'deps を使う所が無い').toBeGreaterThan(at);
    return MAIN.slice(at, end);
  }

  it('🔴 effect 層の settled() を待つ(空の関数を渡していない)', () => {
    expect(exportDeps(), 'settle が effect 層に繋がっていない').toContain(
      'await storeEffects?.settled()',
    );
  });

  it('🔴 その settled() の出所は connectStoreEffects である', () => {
    expect(MAIN).toContain('storeEffects = connectStoreEffects(');
  });
});

/**
 * 🔴 **取込の衝突検査は DB に問う**(#328、2026-08-22)。
 *
 * ⚠ 判定そのものは `features/import/existing-lids.ts` に取り出してあり、
 *   `tests/features/existing-lids.test.ts` が決定的に見ている。
 *   **ここが守るのは配線**(その口に何を渡しているか)── 変異試験で
 *   「`main.ts` 側で entry の口を `[]` にする」が生き延びたので足した。
 *
 * ⚠ `main.ts` は原文 pin しか持てない層なので**弱いと自覚して使う**
 *   (CLAUDE.md「取り出せないものは原文 pin で妥協するが、弱いと自覚して使う」)。
 */
describe('取込の衝突検査の配線(#328)', () => {
  /** `existingLids` の配線だけを切り出す(他所の一致に救われないように)。 */
  function existingLidsWiring(): string {
    const at = MAIN.indexOf('existingLids: () =>');
    expect(at, 'existingLids の配線が無い(state 直読みへ戻っていないか)').toBeGreaterThan(-1);
    const end = MAIN.indexOf('existingRelationIds', at);
    expect(end, '次の口が見つからない ── 切り出せていない').toBeGreaterThan(at);
    return MAIN.slice(at, end);
  }

  it('🔴 判定は取り出した純関数へ渡す(main.ts に直書きしない)', () => {
    expect(existingLidsWiring(), '判定が main.ts へ戻っている').toContain(
      'collectExistingLids({',
    );
  });

  it('🔴 DB の entry の lid を渡している(state だけに戻っていない)', () => {
    const w = existingLidsWiring();
    expect(w, 'DB の entry を読んでいない ── 他タブの取込を上書きする').toContain(
      "op: 'listEntryMetas'",
    );
    expect(w, '読んだ meta から lid を取り出していない').toContain('.map((m) => m.lid)');
  });

  it('🔴 DB の revision の lid も渡している(ゴミ箱の履歴を背負わない)', () => {
    expect(existingLidsWiring(), 'revision を読んでいない').toContain("op: 'listRevisionLids'");
  });

  it('⚠ state も渡している(書込 ack 待ちの lid を落とさない)', () => {
    expect(existingLidsWiring(), 'state を捨てている').toContain('entryMetas.keys()');
  });
});
