/**
 * 🔴 **左の列を畳んだとき、縁に「アプリ全体の操作」を縦に残す**(#582)。
 *
 * ## user から見て何が起きていたか
 *
 * 左の列を境目の帯(#497)で畳むと、列ごと `display: none` になり、列の下にあった
 * 取り込む / バックアップ / 操作を探す / 集計 / システム / フラグ / ヘルプが**道連れで
 * 消えた**(キーでは出せるが、マウスだけの人は設定に辿り着けない)。
 * 🟣 Gemini 裁定(2026-10-01、#582 のコメント)= **畳んだ縁に、そのボタンだけを出す**。
 * 根拠は「業務画面: マウスで完結しキーボードは近道」。#197「畳んでも操作子が消えてはいけない」の
 * 続きである。
 *
 * ## 🔴 登記簿を 2 つにしない
 *
 * 縁のボタンは `collection-bar.ts` の**同じ一覧**(`collectionBarItems`)から、**同じ関数**
 * (`collectionBarButton`)で組む。字・`data-pkc-action`・説明を**手で写さない** ──
 * 写すと、帯へ 1 つ足した日に縁だけ古いまま残る。
 * ⚠ 一覧に載っていれば**例外なく**出る(個別に落とす物は書かない)。
 *
 * ## 作り
 *
 * - 縁は**畳んでいる間だけ** shell の子として在る(戻すと**器ごと消える**)。常設で隠しておくと、
 *   同じ `data-pkc-action` を持つボタンが DOM に**常に 2 組**居ることになる(受け手・検査が
 *   最初の 1 件を引く前提を持つ)。
 * - 置き場は左の掴む帯と**同じ grid の 1 マス**(`gripl`)。マスが 40px(縁 32px + 帯 8px)に
 *   なるのは CSS(`app.css` の `--pkc-edge-w`)の仕事で、ここは DOM だけ書く。
 * - 呼び手は `applyPaneVisibility` の 1 か所(畳みの写し先と同じ場所 ── 別々に呼ぶと
 *   「畳んだのに縁が無い」「戻したのに縁が残る」が起きる)。
 * - スマホ用画面は列を畳まない(`applyPaneVisibility` が `sidebar` を写さない)ので、ここへも来ない。
 */
import { collectionBarButton, collectionBarItems, markCollectionView } from './collection-bar';

const EDGE_REGION = 'collapsed-edge';

/** shell の**直下**の子から引く(`:scope` の対応は環境で揺れるので、子を直に見る)。 */
function childWhere(shell: HTMLElement, test: (el: Element) => boolean): HTMLElement | null {
  for (const el of Array.from(shell.children)) if (test(el)) return el as HTMLElement;
  return null;
}

/**
 * 縁を出す / 外す。**何度呼んでも同じ結果**(畳んでいて既に在れば触らない ──
 * `applyPaneVisibility` は追記のたびにも呼ばれるので、毎回作り直すとボタンの焦点が飛ぶ)。
 *
 * @returns 出している縁(畳んでいなければ `null`)
 */
export function paintCollapsedEdge(shell: HTMLElement, collapsed: boolean): HTMLElement | null {
  const existing = childWhere(shell, (el) => el.getAttribute('data-pkc-region') === EDGE_REGION);
  if (!collapsed) {
    existing?.remove();
    return null;
  }
  if (existing !== null) return existing;

  const doc = shell.ownerDocument;
  const edge = doc.createElement('div');
  edge.setAttribute('data-pkc-region', EDGE_REGION);
  edge.setAttribute('role', 'toolbar');
  edge.setAttribute('aria-orientation', 'vertical');
  // 名前は画面の字に寄せる(縁は図案だけなので、読み上げの手掛かりはこれと各ボタンの名前)
  edge.setAttribute('aria-label', 'アプリ全体の操作');
  for (const item of collectionBarItems()) {
    const btn = collectionBarButton(item);
    // 🔴 縁は図案だけのタイル ── 名前を**明示**する(帯の見えない `label` の span と同じ字)
    btn.setAttribute('aria-label', item.label);
    // ⚠ `title` は組み立て側が持つ(説明 + 鍵の綴り)。無ければ名前だけでも出す
    if (btn.title === '') btn.title = item.label;
    edge.append(btn);
  }
  // 🔴 いま開いている面の印を**作ったときに当て直す**(#1206 D1)。縁は畳んでいる間だけ在る器なので、
  //   作り直すたびに印が消える ── `markView`(main.ts)は同じ面なら早く戻るので、そちらには任せられない。
  //   現在の面は、DOM に残っている左の列のボタンの印から読む(列は畳んでも消えず、`display: none` なだけ)。
  const current = shell
    .querySelector('[data-pkc-region="sidebar"] [data-pkc-view][data-pkc-active]')
    ?.getAttribute('data-pkc-view');
  if (current !== null && current !== undefined) markCollectionView(edge, current);
  // 左の掴む帯の**すぐ後ろ**へ(同じマスに載る)。⚠ 一覧(`sidebar`)より後ろなので、
  //   鍵の受け手が `querySelector` で引く先は従来どおり一覧の側の 1 件目である。
  const grip = childWhere(
    shell,
    (el) =>
      el.getAttribute('data-pkc-region') === 'pane-grip' &&
      el.getAttribute('data-pkc-pane') === 'sidebar',
  );
  if (grip !== null) grip.after(edge);
  else shell.append(edge);
  return edge;
}
