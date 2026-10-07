/**
 * **ノートを外から作る道は、この 1 本だけ**(#189 C-4 / #194 C-3 / #1407)。
 *
 * `pkc.createEntry`(許可リストの origin / ブックマークの合図)も、ブラウザの AI の
 * `pkc_create_note` も、**同じ関数**を通る。2 つ目を作らない。
 *
 * ## 🔴 3 つの規律
 *
 * 1. **読んでいる本文を退かさない(`via === 'origin'`)** ── `CREATE_ENTRY` は既定で選択と絞り込みを
 *    新しいノートへ動かす。許可した相手は user が作業している**最中**に送ってくるので、
 *    `keepSelection: true` で作る(`stack-save` と同じ作法)。見に行く道は知らせの「開く」。
 *    ⚠ `keepSelection` は編集中でも作れる(#1085)── 編集中のノートは何も変わらない。
 * 2. **本当に作られたかを見る** ── reducer は断るとき(起動の途中など)何も言わずに state を返す。
 *    dispatch の後に `entryMetas` を見て、無ければ**知らせを出さず、呼び側へ `null` を返す**
 *    (「作りました」と言ったのに無い、を作らない)。
 * 3. **合図の相手(`'capture'`)は目の前へ出す** ── その窓は取り込みのためにたったいま開かれたので、
 *    退かす作業が無く、身元を確かめていないので**編集の形で見せる**(#194)。
 *
 * 🔑 判断はここに在る(`main.ts` はどの test からも実行されない)。`main.ts` は道具を渡すだけ。
 */

import type { CreateEntryInput } from './create-entry-params';
import type { Via } from './message-bridge';

/** AI の道具が名乗る出どころの名前(知らせの字が変わる)。 */
export const AGENT_ORIGIN_LABEL = 'ブラウザの AI';

/** 道具(Dispatcher / ステータスバー)の最小の形。 */
export interface OutsideCreateDeps {
  dispatch: (action: {
    type: 'CREATE_ENTRY';
    archetype: 'text';
    lid: string;
    title: string;
    body: string;
    edit: boolean;
    keepSelection?: boolean;
    parentLid: null;
    relationId: string;
  }) => void;
  /** 作られたかを見るために、dispatch の後の一覧を読む。 */
  hasEntry: (lid: string) => boolean;
  /** 「開く」つきの知らせ(`OP_NOTICE`)を出す。 */
  notifyOpen: (message: string, lid: string) => void;
  /** 「開く」の要らない知らせを出す(合図の相手 ── 目の前に編集で出ているので要らない)。 */
  notify: (message: string) => void;
  generateLid: () => string;
}

/** 知らせの字。⚠ AI の経路は「取り込みました」ではなく「作りました」(取り込んだのではなく AI が作った)。 */
export function outsideCreatedText(origin: string, via: Via, title: string): string {
  if (via === 'capture') return `${origin} から取り込みました。保存すると残ります:『${title}』`;
  if (origin === AGENT_ORIGIN_LABEL) return `${origin} がノートを作りました:『${title}』`;
  return `${origin} から 1 件取り込みました:『${title}』`;
}

/**
 * @returns 作ったノートの ID。**作れなかったら `null`**(呼び側が失敗として返す)。
 */
export function createEntryFromOutside(
  deps: OutsideCreateDeps,
  input: CreateEntryInput,
  origin: string,
  via: Via,
): string | null {
  const lid = deps.generateLid();
  // 既にある ID は作らない(防波堤)── 後の「作られたか」の確認が、元からあるノートで満たされてしまう
  if (deps.hasEntry(lid)) return null;
  deps.dispatch({
    type: 'CREATE_ENTRY',
    archetype: 'text',
    lid,
    title: input.title,
    body: input.body,
    // 合図の相手だけ編集の形で目の前に出す。許可した相手は退かさない(編集にも入らない)
    edit: via === 'capture',
    ...(via === 'origin' ? { keepSelection: true } : {}),
    parentLid: null,
    relationId: deps.generateLid(),
  });
  // 🔴 作られていなければ、知らせも出さない
  if (!deps.hasEntry(lid)) return null;
  const text = outsideCreatedText(origin, via, input.title);
  if (via === 'origin') deps.notifyOpen(text, lid);
  else deps.notify(text);
  return lid;
}
