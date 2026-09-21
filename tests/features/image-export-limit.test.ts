/**
 * 🔴 **「持ち歩ける 1 枚」が大きさで詰まったとき、行き止まりにしない**(#971 段④の残り)。
 *
 * ⚠ ここで守りたいのは 2 つで、**片方だけだと害になる**:
 * ① 詰まったときに、何が起きたかと**代わりに何を押せばよいか**を言う
 * ② 🔴 **それ以外の理由まで「大きすぎる」と言わない** ── 壊れているのに
 *    「大きすぎます」と出ると、user は**在りもしない原因**(整理して減らす)を追う。
 */
import { describe, expect, it } from 'vitest';
import {
  imageTooBigMessage,
  looksOutOfMemory,
  MAX_EMBED_TEXT_CHARS,
  base64Length,
  tooBigToReadBack,
  tooBigToReadBackMessage,
} from '../../src/features/storage/image-export-limit';
import {
  COLLECTION_COMMANDS,
  SETTINGS_COMMANDS,
} from '../../src/adapter/ui/render/commands';
import { archiveSuffix } from '../../src/features/export/archive-kind';

describe('詰まったときの字(#971 段④)', () => {
  it('🔴 代わりの道を必ず書く(行き止まりにしない)', () => {
    const m = imageTooBigMessage(5_000_000_000);
    // 🔴 手で綴りを書かない(#1017 段④b)── `archive-kind.ts` から引く
    expect(m, '代わりの道が書いていない').toContain(archiveSuffix('full'));
    expect(m, '大きさで止まらないことを言っていない').toMatch(/大きさで止まりません/);
  });

  it('⚠ 測れた大きさは書く / 測れなければ 0 と嘘をつかない', () => {
    /**
     * ⚠ **`MB` である**(`GB` ではない)── `humanBytes` は MB で段が止まっている。
     * 🔴 4GB の DB は `4768.4 MB` と出るので**読みにくい**が、これは
     *   **見え方の変更**なので勝手に直さない(#978 で user へ出した)。
     * 🔑 ここでは「**測れた数が字に出ている**」ことだけを見る ── 単位を pin すると、
     *   段が増えた日にこの test が**製品の正しい変更を止める**。
     */
    expect(imageTooBigMessage(5_000_000_000), '測れた大きさを書いていない').toMatch(/4768\.4|4\.7/);
    // 🔑 測れなかったときに「0 B」と出ると、**いちばん危ない状態が軽く見える**
    for (const bad of [null, 0, -1, Number.NaN]) {
      expect(imageTooBigMessage(bad), `0 と書いた: ${String(bad)}`).not.toMatch(/0 B|0B/);
    }
  });

  it('⚠ 記法を書かない(素のテキストとして出る面がある)', () => {
    expect(imageTooBigMessage(null)).not.toMatch(/[*`_]|\[.*\]\(.*\)/);
  });
});

describe('確保の失敗かどうか(#971 段④)', () => {
  it('🔴 確保の失敗は拾う', () => {
    expect(looksOutOfMemory(new RangeError('Invalid typed array length'))).toBe(true);
    const wasm = new Error('allocation failed');
    wasm.name = 'WasmAllocError';
    expect(looksOutOfMemory(wasm), '名前で拾えていない').toBe(true);
    expect(looksOutOfMemory(new Error('Array buffer allocation failed'))).toBe(true);
    expect(looksOutOfMemory(new Error('out of memory'))).toBe(true);
  });

  /**
   * 🔴 **ここが本題** ── 誤検出のほうが害が大きい。
   * ⚠ 壊れているのに「大きすぎます」と出ると、user は**整理して減らそうとする**
   *   ── 壊れた DB へ書き込む向きなので、**壊れ方を広げる**。
   */
  it('🔴 別の理由まで「大きすぎる」と言わない(対照群)', () => {
    for (const other of [
      'database disk image is malformed',
      'no such table: entries',
      'sqlite が初期化されていません',
      'QuotaExceededError',
      'file is not a database',
    ]) {
      expect(looksOutOfMemory(new Error(other)), `誤って拾った: ${other}`).toBe(false);
    }
    expect(looksOutOfMemory(null), 'null を拾った').toBe(false);
    expect(looksOutOfMemory(undefined), 'undefined を拾った').toBe(false);
  });
});

/**
 * 🔴 **もう 1 つの天井 ── 「焼けた」と「読み戻せる」は別**(#996)。
 *
 * ⚠ この file の上の describe が守っているのは「**確保できなかった**」側で、
 *   こちらは「**焼けるが開けない**」側である ── **別の出来事**なので分けて見る。
 */
describe('読み戻せる大きさか(#996)', () => {
  /**
   * 🔴 **上限より上を、こちらの定数が許していないこと**を、**本物の V8 に聞く**。
   *
   * 🔑 これは**失敗する確保**なので**安い**(1 バイトも積まれない)── だから
   *   unit に置ける。⚠ 逆向き(定数ちょうどが**通る**こと)は 512MiB を
   *   実際に積むので**ここでは見ない**:この test が証明するのは
   *   「**甘すぎない**」ことだけで、「ちょうど良い」ことではない。
   */
  it('🔴 この定数より 1 字でも長い文字列は、本当に作れない', () => {
    expect(() => 'a'.repeat(MAX_EMBED_TEXT_CHARS + 1)).toThrow(RangeError);
    // ⚠ 空振り防止 ── 何を渡しても throw するわけではない
    expect('a'.repeat(1_000)).toHaveLength(1_000);
  });

  it('base64 の字数は「3 バイトごとに 4 字」(切り上げ)', () => {
    // ⚠ 端数を切り捨てると天井が緩む ── 4 通りの端数を全部見る
    expect(base64Length(0)).toBe(0);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(2)).toBe(4);
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    // 🔑 本物の base64 と突き合わせる(実装の綴りを写さない ── CLAUDE.md §1)
    for (const n of [1, 2, 3, 4, 5, 17, 100, 1_001]) {
      const real = Buffer.from(new Uint8Array(n)).toString('base64');
      expect(base64Length(n), `${n} バイト`).toBe(real.length);
    }
  });

  it('🔴 境目の両側で答えが変わる(片側だけ見て決めていない)', () => {
    const edge = Math.floor((MAX_EMBED_TEXT_CHARS * 3) / 4);
    expect(tooBigToReadBack(edge), '境目ちょうどを断っている').toBe(false);
    expect(tooBigToReadBack(edge + 1), '境目の 1 つ上を通している').toBe(true);
    expect(tooBigToReadBack(0)).toBe(false);
    expect(tooBigToReadBack(4 * 1024 * 1024)).toBe(false);
    // 🔑 実測で決まる値ではなく**算数**なので、値そのものも留める
    expect(edge).toBe(402_653_166);
  });

  it('🔴 断り文は「行き止まり」にしない ── 代わりの道を書く', () => {
    const s = tooBigToReadBackMessage('いまの中身', 500 * 1024 * 1024);
    expect(s, '大きさを書いていない').toContain('500.0 MB');
    expect(s, '代わりの道を書いていない').toContain(archiveSuffix('full'));
    expect(s, '何が起きるか書いていない').toContain('二度と開けません');
    // ⚠ **確保に失敗した側の字と混ざっていない**(user にとって別の出来事)
    expect(s, '確保の話と混ざっている').not.toContain('確保できませんでした');
  });
});

/**
 * 🔴 **断り文が「行き止まり」になっていないか ── 押す所の名前を、画面から引く**(2026-09-16)。
 *
 * ⚠ 直す前の 2 本は「**一式を書き出す**」と書いていたが、**その字は画面のどこにも無い**
 *   (`commands.ts` の label は「**バックアップ**」)── 探しても見つからないので、
 *   いちばん助けが要る場面で**断り文がそのまま行き止まり**になっていた。
 * 🔑 **綴りを写さない** ── 期待値を手で書くと、ボタン名を変えた日に
 *   **両方そのままで緑**になる(CLAUDE.md §1「期待値は別の観測から作る」)。
 *   だから **`COMMANDS` から label を引く**。
 */
describe('断り文が指すボタンは、画面に在る(2026-09-16)', () => {
  const archiveLabel = (): string => {
    // ⚠ **両方の一覧から探す** ── 命令が左の列から設定へ移った日に、
    //   片方だけ見ていると「見つからない」で落ちる(在るのに)
    const hit = [...COLLECTION_COMMANDS, ...SETTINGS_COMMANDS].find(
      (c) => c.action === 'export-archive',
    );
    // ⚠ 空振り防止 ── 命令が消えた / 名前が変わったら、ここで落ちる
    expect(hit, 'export-archive の命令が見つからない').toBeDefined();
    expect(hit!.label.length, 'label が空').toBeGreaterThan(0);
    return hit!.label;
  };

  it('🔴 どちらの断り文も、実在するボタンの名前で送っている', () => {
    const label = archiveLabel();
    for (const [name, s] of [
      ['確保できなかった側', imageTooBigMessage(5_000_000_000)],
      ['読み戻せない側', tooBigToReadBackMessage('いまの中身', 500 * 1024 * 1024)],
    ] as const) {
      expect(s, `${name}: 画面に無い名前で送っている`).toContain(label);
    }
  });
});
