/**
 * 🔴 **保存先が取れなかったときの言い方**(#811。user 報告 2026-09-09、iPhone)。
 *
 * ## 直す前に何が起きていたか
 *
 * 画面の下の帯に、こう出ていた ── **ブラウザの例外の綴りそのまま**:
 *
 * > ⚠ InvalidStateError: The object is in an invalid state.
 *
 * ⚠ user には **何が起きたか / 何を失うか / どうすればよいか**が 1 文字も出ていない。
 * 🔴 中身は「**このタブで書いたものは、閉じると消える**」である
 * (`storage-worker.ts` が `vfs = 'memory'` へ退避している)。
 *
 * ## 守る主張
 *
 * ① 🔴 帯に**例外の綴りを出さない**(user は直せないし、実害が読めない)
 * ② 🔴 帯は**何を失うか**を言う
 * ③ ⚠ **落ちた回だけ**出す ── 持ち歩ける 1 枚は**選んで** `memory` なので、
 *    そちらを事故として告げない
 * ④ 🔑 起動を止める側と**同じ言い方**を使う(同じ事実に説明を 2 通り持たない)
 * ⑤ 原因の綴りは**ツールチップ**には残す(診断が要る人のために)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/code-only';
import {
  STORAGE_FALLBACK_LINE,
  storageWhereLine,
  storageStatusLine,
  storageStatusTitle,
} from '../../src/features/storage/storage-notice';

/** 実際に iPhone に出ていた綴り。 */
const RAW = 'InvalidStateError: The object is in an invalid state.';

describe('保存先が取れなかったときの言い方(#811)', () => {
  it('🔴 ① ② 帯は例外の綴りを出さず、何を失うかを言う', () => {
    const line = storageStatusLine(RAW);
    expect(line, '例外の綴りがそのまま出ている').not.toContain('InvalidStateError');
    expect(line, '何を失うかを言っていない').toContain('閉じると消えます');
    // ⚠ 「どうすればよいか」まで言う(user がいま動ける手を書く)
    expect(line, '次に何をすればよいかを言っていない').toContain('読み込み直して');
    expect(line.startsWith('⚠ '), '警告の印が無い').toBe(true);
    /**
     * ⚠ **言い方は 1 か所**(CLAUDE.md §7)── 帯が独自の字を持ち始めていないこと。
     * 🔴 2026-09-09 まで「止める側」も同じ定数を使っており、この 2 か所が
     *   揃っていることを見ていた。⚠ 止める道は無くなったが、**定数は生きている**
     *   ので、帯がそこから組まれていることは引き続き見る(空振り防止)。
     */
    expect(line, '帯が別の言い方を持ち始めている').toContain(STORAGE_FALLBACK_LINE);
  });

  it('🔴 ③ 落ちていない回は 1 文字も出さない', () => {
    expect(storageStatusLine(undefined), '落ちていないのに帯が出た').toBe('');
    // ⚠ 空文字も「落ちていない」── worker が理由を持たずに返す形を素通りさせない
    expect(storageStatusLine(''), '空の理由で帯が出た').toBe('');
  });

  /**
   * 🔴 **「起動を止める」道は 2026-09-09 に無くなった**(#811 の 3 番目)。
   *
   * ⚠ ここには `storageFallbackError`(止めるときの字)の test が 2 件在ったが、
   *   **止める道ごと消えた**ので一緒に消した ── 残すと「まだ止まることがある」と
   *   次に読む人が読む(壊れたポインタと同じ)。
   * 🔑 いまは**取れなくても開く**(理由は `open-with-retry.ts`)── 代わりに
   *   帯とヘルプが言う。その 2 つは下の test が見ている。
   */
  it('🔴 止める道が戻っていない(取れなくても開く)', () => {
    const src = codeOnly(readFileSync(join(process.cwd(), 'src/main.ts'), 'utf-8'));
    expect(src.length, '注釈を落としたら空になった(前処理が壊れている)').toBeGreaterThan(10000);
    // ⚠ 「起動を止める」= 保存先が取れなかったことを理由に throw する形
    expect(src, '保存先が取れないと起動を止める形が戻っている').not.toContain(
      'throw new Error(storageFallback',
    );
    /**
     * 🔴 空振り防止 ── 代わりの道(再試行して開く)が本当に在ること。
     *
     * ⚠ **名前の頭だけ留めない**(CLAUDE.md §1「頭と尻を両方留める」)── 初稿は
     *   `toContain('openStorageWithRetry')` だったので、**`openStorageWithRetryX` に
     *   改名する変異が生き延びた**(部分一致で満たされる)。呼びの形ごと留める。
     */
    expect(src, '再試行の口を通っていない').toContain(
      'openStorageWithRetry<StoreClient, InitResult>({',
    );
    /**
     * 🔴 **持ち歩ける 1 枚の HTML は試し直さない**(#400 段③ と同じ理由)。
     * ⚠ ここを `true` にすると、**選んで memory で動く形が毎回 1.7 秒待たされてから
     *   同じ答え**になる ── 誰も損しか。しかも `main.ts` は test から実行されないので、
     *   字面で留めるしかない(変異試験 T8 が生き延びて分かった)。
     */
    expect(src, '持ち歩ける HTML でも試し直す形になっている').toContain(
      'retryable: portable === null',
    );
  });

  it('🔑 ⑤ 原因はツールチップに残る(落ちていなければ足さない)', () => {
    const base = 'pkc3 v3.2.0(開発版) — opfs-sahpool';
    expect(storageStatusTitle(base, undefined), '落ちていないのに足した').toBe(base);
    const t = storageStatusTitle('pkc3 v3.2.0 — memory', RAW);
    expect(t, '原因が消えている(診断できない)').toContain(RAW);
    expect(t, '版と保存先が消えている').toContain('memory');
  });

  /**
   * 🔴 **`main.ts` が自前で組み直していないこと**(CLAUDE.md §2)。
   *
   * ⚠ `main.ts` は**どの test からも実行されない**ので、判断を書かれると
   *   全 test 緑のまま壊れる ── だから**呼んでいることだけ**を字面で pin する。
   * ⚠ 弱い検査だと自覚して使う(位置は見ない。呼びが在るかだけ)。
   */
  it('🔴 main.ts は自分で字を組まず、この口を通す', () => {
    /**
     * ⚠ **注釈を落としてから見る**(CLAUDE.md §1 の 5 度目と同じ罠)。
     * 🔴 直す前の綴りを**この直しの解説コメントに書いた**ので、file 全体で
     *   `not.toContain` すると**自分の説明に満たされて必ず落ちる** ── 実際に落ちた。
     * ⚠ 「無い」ことの主張ほど、範囲を実行する行に絞る。
     */
    const src = codeOnly(readFileSync(join(process.cwd(), 'src/main.ts'), 'utf-8'));
    // 🔴 空振り防止 ── 注釈を落とした後も中身が残っていること
    expect(src.length, '注釈を落としたら空になった(前処理が壊れている)').toBeGreaterThan(10000);
    expect(src, '帯の字を main.ts が組んでいる').toContain('storageStatusLine(init.fallbackReason)');
    expect(src, 'ツールチップの組み立てが main.ts に戻っている').toContain('storageStatusTitle(');
    // 🔴 空振り防止 ── 直す前の綴りが残っていないこと(戻したら落ちる)
    expect(src, '例外の綴りをそのまま出す形が残っている').not.toContain('`⚠ ${init.fallbackReason}`');
  });
});

/**
 * 🔴 **「いまどこに保存しているか」を、指で触る端末でも読める形にする**(#811 の 2 番目)。
 *
 * ⚠ 直す前、これが読めるのは**帯のツールチップだけ**だった(user 報告は iPhone)。
 * ⚠ しかも帯の 1 行は**落ちた回にしか出ない** ── 「ちゃんと保存できている」ことを
 *   確かめる道が画面に 1 つも無かった。
 */
describe('いまどこに保存しているか(#811 の 2 番目)', () => {
  it('🔴 いつもの保存先なら、残ることを言う', () => {
    const line = storageWhereLine('opfs-sahpool', undefined);
    expect(line, '残ると言っていない').toContain('残ります');
    expect(line, '無用に不安を煽っている').not.toContain('消えます');
  });

  it('🔴 落ちて退避した回は、消えることを言う', () => {
    const line = storageWhereLine('memory', 'InvalidStateError: The object is in an invalid state.');
    expect(line, '何を失うかを言っていない').toContain('消えます');
    // ⚠ **内部の言葉を画面に出さない**(帯の 1 行と同じ作法)
    expect(line, 'ブラウザの例外の綴りがそのまま出ている').not.toContain('InvalidStateError');
  });

  /**
   * 🔴 **`memory` を一律に事故として言わない**(`storageStatusLine` と同じ見分け方)。
   * ⚠ 持ち歩ける 1 枚の HTML は**選んで** `memory` で動くので、
   *   そこで「⚠ 消えます」と出すと**正常な使い方を事故だと告げる**ことになる。
   * 🔑 分けるのは `fallbackReason` である(`vfs` ではない)。
   */
  it('🔴 持ち歩ける 1 枚の HTML(選んだ memory)は、事故として言わない', () => {
    const line = storageWhereLine('memory', undefined);
    expect(line, '選んだ形を事故として告げている').not.toContain('⚠');
    expect(line, '書き出しの案内が無い(それが唯一の残し方である)').toContain('書き出して');
  });
});
