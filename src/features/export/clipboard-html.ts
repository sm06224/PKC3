/**
 * **よそのアプリへ貼るための HTML**(#193 / 台帳 #180 の C-2)。
 *
 * 🔴 いま「HTML でコピー」が渡しているのは**画面の DOM そのもの**である。
 * 画面の DOM は PKC3 の中で動くために作られているので、Word / Notion / メールへ
 * 貼ると次が付いてくる:
 *
 * | 付いてくるもの | 貼り先でどうなるか |
 * |---|---|
 * | 隠してあるソース(`pkc-mermaid-source` / `pkc-chart-source` / `pkc-render-source`) | **CSS が無いので隠れない** ── 図の下に生の原文が出る |
 * | 操作子(コピー / 保存 のボタン) | 押せないボタンが本文に混ざる |
 * | `blob:` の画像 | **貼り先では読めない**(この document でしか有効でない)── 画像が壊れる |
 * | `data-pkc-*` 属性 | 意味の無い属性が延々と付く |
 *
 * ⚠ どれも**貼ってみるまで気づけない**(こちらの画面では正しく見える)。
 *
 * 🔑 ここは **features 層の純関数**。DOM を受け取り、**複製に対して**掃除する
 * ── 元の画面には指 1 本触れない(触ると「コピーしたら画面が変わった」になる)。
 */

/** 掃除の結果。⚠ **落としたものを数えて返す**(黙って消さない)。 */
export interface CleanResult {
  html: string;
  /** 貼り先で読めないので落とした画像の数。 */
  droppedImages: number;
  /** 取り除いた操作子・隠しソースの数。 */
  removed: number;
}

/**
 * 🔴 **「画面の都合でしか無い物」の定義は、ここ 1 つ**(2026-09-05、#735)。
 *
 * ⚠ 直す前は塊のコピー(`copy-md-block.ts`)が**自前の一覧**を持っており、
 *   そちらは **PKC2 由来の 4 つ**(並べ替え / 絞り込みの飾り)しか落とさなかった ──
 *   #418 が足した csv の**升をいじるボタン**(`edit-cell` の印 /
 *   `.pkc-csv-shape`)は素通りし、⧉ で表をコピーすると**押せないボタンが貼られた**。
 * 🔑 だから**判定を寄せる**(CLAUDE.md §7)── 塊のコピーもこの選択子を通す。
 */
export const COPY_CHROME_SELECTOR = '[data-pkc-action]';

/**
 * 🔴 **「押すためだけの器」のタグ**(2026-09-05、#735 の実装中に実測して判明)。
 *
 * ⚠ `data-pkc-action` は**押せる器だけに付いているのではない** ── csv の表は
 *   **升そのもの**(`td` / `th`)に `edit-cell` を付ける(`csv-table.ts`)。
 * 🔴 だから「`[data-pkc-action]` を要素ごと消す」は、**表の中身を丸ごと消す**。
 *   実測(読む面と同じ `interactiveCells: true` で描いた csv の表):
 *   掃除の前 **升 4 個** → 後 **0 個**。つまり「ノートを HTML でコピー」すると
 *   **升の無い表**が貼られていた(pasted 側でしか見えないので、誰も気づかない形)。
 * 🔑 だから**タグで見分ける** ── 押す器は消し、中身を持つ要素は**残して属性だけ落とす**
 *   (属性は下の ④ が全部落とす)。
 * ⚠ 実測した読む面の `[data-pkc-action]` は **`button` と `td` / `th` の 2 種類だけ**だった。
 */
export const COPY_CONTROL_TAGS: ReadonlySet<string> = new Set([
  'button',
  'input',
  'select',
  'textarea',
]);

/** その要素は「押すためだけの器」か(= 消してよいか)。 */
export function isCopyControl(el: Element): boolean {
  return COPY_CONTROL_TAGS.has(el.tagName.toLowerCase());
}

/** 画面の都合でしか無い器(貼り先には要らない)。 */
export const COPY_JUNK_CLASSES = [
  'pkc-mermaid-source',
  'pkc-chart-source',
  'pkc-render-source',
  'pkc-md-block-actions',
];

/**
 * 貼る用に掃除する。
 *
 * @param root 画面の本文の器(⚠ **複製してから渡す** ── ここでは複製しない。
 *   複製の責任を呼び側に置くのは、呼び側が「どこを切り取るか」を決めるから)
 * @param dataUrls `blob:` → `data:` の対応(貼り先でも読める形に置き換える)。
 *   ⚠ 対応が無い画像は**落として数える**(壊れた画像を貼らせない)
 */
export function cleanForClipboard(
  root: HTMLElement,
  dataUrls: ReadonlyMap<string, string> = new Map(),
): CleanResult {
  let removed = 0;
  let droppedImages = 0;

  // ① 操作子を落とす(押せないボタンを本文に混ぜない)。⚠ 綴りは上の 1 か所
  //    🔴 **押す器だけ**を消す ── 中身を持つ要素(csv の升)は残す(上の註記)
  for (const el of [...root.querySelectorAll(COPY_CHROME_SELECTOR)]) {
    if (!isCopyControl(el)) continue;
    el.remove();
    removed += 1;
  }
  // ② 隠してあるものを落とす。⚠ **CSS で隠れているだけ**なので、貼り先では出る
  for (const cls of COPY_JUNK_CLASSES) {
    for (const el of [...root.querySelectorAll(`.${cls}`)]) {
      el.remove();
      removed += 1;
    }
  }
  for (const el of [...root.querySelectorAll('[hidden]')]) {
    el.remove();
    removed += 1;
  }

  // ③ 画像。⚠ `blob:` は**この document でしか有効でない**
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('data:')) continue;
    if (src.startsWith('blob:')) {
      const data = dataUrls.get(src);
      if (data !== undefined) {
        img.setAttribute('src', data);
        continue;
      }
      /**
       * 🔴 **壊れた画像を貼らせない。** ⚠ ただし**黙って消さない** ──
       * `alt` を文字として残し、件数も返す(何が落ちたか user に言えるように)。
       */
      const note = root.ownerDocument.createElement('span');
      note.textContent = img.getAttribute('alt') || '(画像)';
      img.replaceWith(note);
      droppedImages += 1;
      continue;
    }
    // 外部 URL(http/https)は**そのまま**にする ── 貼り先でも読めるので
  }

  // ④ PKC3 の内部属性を落とす(意味が無いものを延々と付けない)
  const strip = (el: Element): void => {
    for (const name of [...el.getAttributeNames()]) {
      if (name.startsWith('data-pkc-')) el.removeAttribute(name);
    }
    for (const child of [...el.children]) strip(child);
  };
  strip(root);

  return { html: root.innerHTML, droppedImages, removed };
}
