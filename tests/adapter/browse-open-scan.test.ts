/**
 * 🔴 **開いたときに集めるタブが、起動直後に止まっていた**(2026-09-09)。
 *
 * ## 直す前、画面で何が起きていたか
 *
 * 一覧の中身を**開いたときに集める**タブが 3 つある(アプリ / 予定 / 連絡先)。
 * ⚠ 集めを頼んでいたのは **`setBrowse`(タブを押したとき)だけ**で、
 * 起動側は **`=== 'schedule'` の名指し 1 本**しか持っていなかった。
 *
 * 🔴 帰結:**前回そのタブで閉じた user は、起動した瞬間に止まる**
 * ──「アプリ」なら **読み込んでいます…**(組み込みアプリを 1 つも開けない)、
 * 「連絡先」なら **集めています…**。⚠ 別のタブへ行って戻るまで動かない。
 * ⚠ しかも**断り文は出ない**(「まだ」と「駄目だった」の区別なので)ので、
 *   user から見れば**壊れている**。
 *
 * ## なぜ「綴りを揃える」で守れなかったか
 *
 * `main.ts` のコメントは「条件は `setBrowse` の 1 行と**同じ綴り**にしておく
 * (片方だけ直すと、また片方が止まる)」と**警告していた**。⚠ それでも、
 * その後に足された 2 つ(アプリ / 連絡先)は**押した側にしか足されなかった**。
 * 🔑 だから直したのは綴りではなく**形**である ── 表を 1 つ置き、両方が引く
 * (CLAUDE.md §7「同じ判定が 2 か所に生えたら、規則を 1 つに寄せる」)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSE_MODES, browseScanOf, homeTabOf } from '@adapter/ui/render/browse-mode';
import { VIEW_MODES } from '@adapter/state/app-state';
import { codeOnly } from '../helpers/code-only';

describe('開いたときに集めるタブ(2026-09-09)', () => {
  /**
   * ⚠ **等値で pin する** ── タブを 1 つ足した日に鳴る。
   * 🔑 「集めるタブが 1 つ以上ある」では、**足し忘れを 1 つも捕まえられない**。
   */
  it('🔴 集め直しを頼むタブは、この 4 つで全部', () => {
    const asked = BROWSE_MODES.filter((m) => browseScanOf(m) !== null);
    expect(
      [...asked].sort(),
      '集めるタブが増減した ── 起動側(main.ts)にも同じ表が効いているか確かめる',
      // ⚠ 録ったもの(#683 段①)を足した ── 添付の本文を読むので、
      //    開いたときだけ集める(連絡先・アプリと同じ流儀)
    ).toEqual(['captures', 'contacts', 'launcher', 'schedule']);
  });

  it('🔴 それぞれが、頼む相手を取り違えていない', () => {
    expect(browseScanOf('launcher')).toBe('REFRESH_LAUNCHER_TILES');
    expect(browseScanOf('schedule')).toBe('REFRESH_TASK_SCAN');
    expect(browseScanOf('contacts')).toBe('REFRESH_CONTACT_SCAN');
    expect(browseScanOf('captures')).toBe('REFRESH_CAPTURE_SCAN');
    // ⚠ 対照群 ── 集めないタブは `null`(押すたびに無駄な走査を撃たない)
    expect(browseScanOf('list'), '集める必要の無いタブが走査を撃っている').toBeNull();
  });

  /**
   * 🔴 **`main.ts` はどの unit からも実行されない**(CLAUDE.md §2)ので、
   *   配線は原文で pin するしかない ── ⚠ **弱いと自覚して使う**。
   * 🔑 見るのは 2 つ:①**両方**が同じ口を通っていること
   *   ②直す前の**名指しの形が戻っていない**こと。
   */
  it('🔴 main.ts は、押した側と起動側の両方でこの口を通す', () => {
    const src = codeOnly(readFileSync(join(process.cwd(), 'src/main.ts'), 'utf-8'));
    // 空振り防止 ── 注釈を落とした後も中身が残っていること
    expect(src.length, '注釈を落としたら空になった(前処理が壊れている)').toBeGreaterThan(10000);
    const hits = src.split('browseScanOf(').length - 1;
    expect(hits, '押した側と起動側の 2 か所から引いていない').toBe(2);
    // 🔴 起動側が「覚えている探し方」から引いていること(押した値ではない)
    expect(src, '起動側が覚えている探し方から引いていない').toContain(
      'browseScanOf(appBrowseMode.get())',
    );
    /**
     * 🔴 **直す前の名指しが戻っていない** ── これが戻ると、また片方だけ足される。
     * ⚠ 注釈は落としてある(自分の解説コメントに満たされない)。
     */
    expect(src, "起動側が `=== 'schedule'` の名指しへ戻っている").not.toContain(
      "appBrowseMode.get() === 'schedule'",
    );
    expect(src, '押した側が名指しの並びへ戻っている').not.toContain(
      "if (mode === 'launcher') dispatcher.dispatch",
    );
  });
});

/**
 * 🔴 **別窓が塞がれたときの退避先**(#673 段②。CLAUDE.md 不可侵指示)。
 *
 * > 「別窓が塞がれたときの退避先を、中央にしない ── 同じものが左に在るなら
 * > そこへ送る。⚠ 中央へ落とすと『**ポップアップを止めている user だけ
 * > 本文が消える**』という、いちばん再現しない形の実害になる」
 *
 * ⚠ `HOME_TAB` は `Partial<Record<…>>` なので、**足し忘れても tsc は黙る** ──
 *   足し忘れた面は `null` を返し、中央へ落ちて**本文を退かす**。
 * 🔑 だから「左に同じ名前のタブが在る面は、必ずそこへ送る」を全数で見る
 *   (⚠ 名前が同じでも名前空間は別なので、**在る場合だけ**を要求する)。
 */
describe('別窓が塞がれたときの退避先(全数)', () => {
  it('🔴 左に同じ名前のタブが在る面は、中央へ落とさない', () => {
    const tabs = new Set<string>(BROWSE_MODES);
    const fell: string[] = [];
    for (const view of VIEW_MODES) {
      if (!tabs.has(view)) continue;
      if (homeTabOf(view) !== view) fell.push(view);
    }
    // 空振り防止 ── 見ている面が 1 つも無ければ、この test は何も守っていない
    const looked = VIEW_MODES.filter((v) => tabs.has(v));
    expect(looked.length, '同じ名前の面が 1 つも無い(走査が壊れている)').toBeGreaterThan(1);
    expect(
      fell,
      '左に同じタブが在るのに中央へ落ちる ── ポップアップを止めている user だけ本文が消える',
    ).toEqual([]);
  });
});
