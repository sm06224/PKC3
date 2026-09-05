/**
 * 🔴 **空の一覧に「次の一手」を置く**(#722 P2-13)。
 *
 * > cowork の評価:一覧が空のとき「まだ何もありません」だけが出る。
 * > 案内は**本文の面**に在るが、狭い幅(600px 以下)では本文が別ページなので
 * > **画面の外**である ── 立ち上げた直後の user は、次に何を押すのか分からない。
 *
 * 🔑 **押せる物を、空だと言っているその場に置く**(探させない)。
 * ⚠ 受け手は**既存のもの**(`create-entry` / `import-file`)── 同じ仕事に 2 つ目の
 *   受け手を作らない(CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ
 *   壊しても届かない」)。
 * ⚠ 字も**登記簿から引く**(`COLLECTION_COMMANDS`)── 「取り込む」の綴りと
 *   受けられる形式の説明は、左の列のボタンと 1 文字も違ってはいけない。
 *
 * ⚠ **幅で出し分けない。** 狭いときだけ出すと、広い画面の user には
 *   「空のときに何をすればいいか」が**永久に出ない**(#722 の指摘そのもの)。
 */
import { COLLECTION_COMMANDS } from './commands';
import { iconButton } from './icons';

/** 器の印。⚠ unit / smoke はこの印で見る。 */
export const EMPTY_START_FIELD = 'empty-start';

/**
 * 「まだ何もありません」の下に置く 2 つの口を作る。
 *
 * ⚠ 呼ぶのは**本当に 1 件も無いとき**だけ ── 絞り込みで 0 件になっただけの面で
 *   出すと、「作る」は的外れ(在る物が見えていないだけ)である。絞りの側には
 *   既に「絞りを外す」が在るので、そちらと混ぜない。
 */
export function emptyStartActions(): HTMLElement {
  const box = document.createElement('div');
  box.setAttribute('data-pkc-field', EMPTY_START_FIELD);

  // ⚠ 種類は**ボタン自身**に持たせる(`create-bar` の `<select>` から離れた場所に
  //    置くので、binder が種類を引ける唯一の手掛かりがこの属性である)
  const create = iconButton('create-entry', '+ ノートを作る', 'archetype:text');
  create.setAttribute('data-pkc-archetype', 'text');
  create.setAttribute('data-pkc-field', 'empty-start-create');
  create.title = 'ノートを 1 つ作って、すぐ書き始めます';
  box.append(create);

  /**
   * ⚠ **登記簿を絞って回す**(見つからなければ出さない)── 予備の字を
   *   ここに書くと、登記簿から消えた日に**誰も気づかないまま古い字が残る**。
   */
  for (const cmd of COLLECTION_COMMANDS) {
    if (cmd.action !== 'import-file') continue;
    const btn = iconButton(cmd.action, cmd.label);
    btn.setAttribute('data-pkc-field', 'empty-start-import');
    btn.title = cmd.title;
    box.append(btn);
  }
  return box;
}
