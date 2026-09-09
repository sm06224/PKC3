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
  storageFallbackError,
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
  });

  it('🔴 ③ 落ちていない回は 1 文字も出さない', () => {
    expect(storageStatusLine(undefined), '落ちていないのに帯が出た').toBe('');
    // ⚠ 空文字も「落ちていない」── worker が理由を持たずに返す形を素通りさせない
    expect(storageStatusLine(''), '空の理由で帯が出た').toBe('');
  });

  it('🔴 ④ 起動を止める側も同じ言い方をする(説明を 2 通り持たない)', () => {
    const err = storageFallbackError(RAW);
    expect(err, '止める側が別の言い方をしている').toContain(STORAGE_FALLBACK_LINE);
    // ⚠ こちらは**開けない**ので原因も添える(報告に写せる)
    expect(err, '止めた回に原因が無い(報告に写せない)').toContain(RAW);
  });

  it('⚠ ④ 理由が無いまま止まった回も、言い方は同じ', () => {
    expect(storageFallbackError(undefined)).toContain(STORAGE_FALLBACK_LINE);
    expect(storageFallbackError(undefined)).toContain('unknown');
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
    expect(src, '止める側が別の言い方に戻っている').toContain('storageFallbackError(init.fallbackReason)');
    // 🔴 空振り防止 ── 直す前の綴りが残っていないこと(戻したら落ちる)
    expect(src, '例外の綴りをそのまま出す形が残っている').not.toContain('`⚠ ${init.fallbackReason}`');
  });
});
