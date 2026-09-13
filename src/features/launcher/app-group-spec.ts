/**
 * 🔴 **グループ用のノート**(#857 段②。user 裁定 2026-09-12 の **C**
 * 「グループ専用のノートを作る」)。
 *
 * ## 何のために在るか
 *
 * アプリの一覧のグループは、いままで**名前の字でしかなかった**
 * (どのノートにも属していない ── タイルの `attachment.app_group` から生える)。
 * だから**目印(絵)を置く場所がどこにも無い**。🔑 それを置ける場所がこれである。
 *
 * ## 🔴 `attachment.app_group` を流用しない
 *
 * ⚠ 流用すると「**X グループに入っているタイル**」と「**X グループを表すノート**」が
 *   **同じ字**になり、値だけでは永久に見分けられない ── しかも user は添付の画面から
 *   **同じ字を手で打てる**(検証も一意性チェックも無い)。
 * ⚠ `tiles.ts` 自身が同型の事故を既に戒めている:「組み込みだけの群を落とし先にすると、
 *   user のタイルに `app_group: 組み込みアプリ` が書かれ、**最初から在る物の中へ紛れる**」。
 * 🔑 だから**別の名前空間**(`appgroup.*`)にし、**入れ物(archetype)でも分ける**。
 *
 * ## ⚠ 読み出しをタイルに相乗りさせない
 *
 * タイルを読む経路は `archetype === 'attachment'` で絞ってから本文を読む
 * (`REQUEST_LAUNCHER_TILES`)。⚠ **そこへ相乗りさせた瞬間**に、`tileFrom` が
 * 両方を同じ土俵で処理することになり、上の見分けが効かなくなる。
 * 🔑 読み筋は**別に立てる**(`REQUEST_APP_GROUP_ICONS`)。
 *
 * ## 同じ名前のノートが 2 つあったら
 *
 * ⚠ 題名に**一意制約は無い**(`schema.ts` ── 改名でも衝突を見ていない)ので、
 *   手で同じ題名にすれば 2 つ作れる。
 * 🔑 **起こらなくする側に倒す**(CLAUDE.md「衝突は、検出するより起こらなくする
 *   ほうが強い」)── 目印を選んだときは**在るものを探して、無いときだけ作る**。
 * ⚠ それでも 2 つになったら **一覧の並びで最初の 1 件**(`appGroupIconsOf` が
 *   先勝ちで畳む)── 決め方が機械で読め、グループ用ノートは普通のノートなので
 *   user 自身が直せる。
 *
 * ⚠ **pure module**。DOM も保存も知らない。
 */
import { parseFrontmatter, spliceFrontmatterKeys } from '@features/markdown/frontmatter';
import { parseIconValue, type IconValue } from '@features/icon/icon-value';

/** 綴り。⚠ `archetype-label.ts` / `icons.ts` / `plain-markdown.ts` もこの綴りで登記する。 */
export const APP_GROUP_ARCHETYPE = 'appgroup';

/** 目印の鍵。⚠ `attachment.app_icon` と**別の名前空間**にしてある(上の理由)。 */
export const APP_GROUP_ICON_KEY = 'appgroup.icon';

/**
 * そのノートが表すグループの名前。
 * 🔑 **題名そのもの**である ── 別の鍵に書くと「題名と鍵がずれたらどちら?」という
 *   問いが増える(#857 段① で「名前か id か」を**名前**に決めたのと同じ向き)。
 */
export function appGroupName(title: string): string {
  return title.trim();
}

/** 本文から目印を読む。⚠ 読み方の正本は `icon-value.ts`(タイルと同じ口)。 */
export function readAppGroupIcon(body: string): IconValue {
  const raw = parseFrontmatter(body).meta[APP_GROUP_ICON_KEY];
  return parseIconValue(typeof raw === 'string' && raw !== '' ? raw : undefined);
}

/**
 * 目印を本文へ書き戻す(**原文 splice** ── 説明文も他の key も無傷)。
 * ⚠ 空にするときは **key ごと消す**(`appgroup.icon: ` を残すと、次に読んだとき
 *   「目印が在るのに出ない」に見える ── `writeSmartSpec` と同じ作法)。
 */
export function writeAppGroupIcon(body: string, icon: string | null): string {
  const next = icon === null ? '' : icon.trim();
  return spliceFrontmatterKeys(body, {
    [APP_GROUP_ICON_KEY]: next === '' ? undefined : next,
  });
}

/**
 * 作るときの本文。⚠ **何をする入れ物かを 1 行だけ**置く ── 白紙だと、
 * 開いた user が「なぜこのノートが在るのか」を読めない。
 */
export function appGroupSeed(name: string): string {
  const label = name.trim();
  return (
    // ⚠ 囲み(`---`)を忘れない ── 無いと**ただの本文の 1 行**になり、目印を書いても読めない
    `---\n${APP_GROUP_ICON_KEY}: \n---\n\n` +
    `アプリの一覧の「${label === '' ? '(名前なし)' : label}」の見出しに出る目印を憶えるノートです。\n`
  );
}

/** 名前 → 目印。⚠ state に載るので**素の object**(Map は JSON にならない)。 */
export type AppGroupIcons = Readonly<Record<string, IconValue>>;

/**
 * 名前 → 目印の対応を作る。
 *
 * ⚠ **先勝ち**(同じ名前が 2 つあったら、渡された並びの最初を採る)── 上の理由。
 * ⚠ 目印を持たないノートは**入れない**(空の対応を作らない ── 出す側が
 *   「在るのに空」と「無い」を見分けなくて済む)。
 * ⚠ 組み立ては `Object.fromEntries` で行う ── **素の代入だと `__proto__` という
 *   名前の群で入れ物そのものが壊れる**(`fromEntries` は own property を定義する)。
 */
export function appGroupIconsOf(
  notes: readonly { readonly title: string; readonly body: string }[],
): AppGroupIcons {
  const out = new Map<string, IconValue>();
  for (const n of notes) {
    const name = appGroupName(n.title);
    if (name === '' || out.has(name)) continue;
    const v = readAppGroupIcon(n.body);
    if (v.icon === undefined && v.symbol === undefined) continue;
    out.set(name, v);
  }
  return Object.fromEntries(out);
}

/** その群の目印。⚠ 引くのはここ 1 か所(`obj[name]` を呼び側に書かせない)。 */
export function appGroupIconOf(icons: AppGroupIcons, name: string): IconValue | undefined {
  return Object.prototype.hasOwnProperty.call(icons, name) ? icons[name] : undefined;
}
