/**
 * 外部の画像を読み込むかどうか(2026-08-06。user 裁定)。
 *
 * > user 裁定 2026-08-06「**外部画像は、要は追跡用のソースを csp するということか、
 * > ユーザー同意取る形ではいかんのか? / 設定で常にオン / 常に確認 / 常にオフを
 * > とりましょう。**」
 *
 * ## 何が漏れるのか
 *
 * 本文に `![](https://例/x.png)` と書くと、そのノートを開いた瞬間にブラウザが
 * その相手へ要求を出す。相手に届くのは「**この端末が、いま、これを開いた**」
 * という事実と IP と時刻である ── 画像そのものは飾りで、1×1 の透明画像でも
 * 同じだけ伝わる(いわゆる追跡用の画像)。⚠ 本文は **AI が書いたもの・人から
 * もらったもの**でもあるので、書いた本人が意図していないこともある。
 *
 * 漏れ口は **2 つだけ**である(2026-08-06 に全経路を確認した):
 *
 * 1. 本文の画像 ── `md` は `html: false`(生 HTML を全部 escape する)なので、
 *    画像は `![](…)` の image rule **1 か所**からしか出ない
 * 2. ` ```html` の箱 ── 中身は任意の HTML + script なので、`new Image().src` で
 *    好きな相手へ飛ばせる。ここは我々の DOM ではないので**箱の CSP で止める**
 *
 * 図(mermaid)は `securityLevel: 'strict'` + `htmlLabels: false` なので
 * 外部を指せない。csv / tsv の表に画像は出ない。
 *
 * ## 規則は 1 つ
 *
 * 「外か / 中か」の判定と「読み込むか」の判定は**この file にだけ**置く。
 * ⚠ 2 か所に生えると、画像 rule と箱の CSP がずれて**片方だけ漏れる**
 * (CLAUDE.md「判定を増やさない。誤差の向きを決めて、両側に使い回さない」)。
 *
 * 誤差の向きは **塞ぐ側**に倒す ── 判らないものは外扱いにする。逆に倒すと
 * 「知らない形」が漏れ口になり、しかも**画面には何も出ない**ので永久に露見しない。
 */

/**
 * 設定の 3 択。⚠ **flag ではない**(flag 枠 15 とは別)── これは user の
 * 判断であって開発用の切替ではない。`theme.ts` と同じ位置づけ。
 * ⚠ 並びは「緩い → 厳しい」。既定は真ん中の `ask`。
 */
export const EXTERNAL_IMAGE_MODES = [
  { id: 'always', label: '常にオン' },
  { id: 'ask', label: '常に確認' },
  { id: 'never', label: '常にオフ' },
] as const;

export type ExternalImageMode = (typeof EXTERNAL_IMAGE_MODES)[number]['id'];

/** 既定。⚠ **`always` にしない** ── 既定が漏れる側だと、設定を知らない人が全員漏れる。 */
export const DEFAULT_EXTERNAL_IMAGE_MODE: ExternalImageMode = 'ask';

const MODE_IDS: readonly string[] = EXTERNAL_IMAGE_MODES.map((m) => m.id);

export function isExternalImageMode(v: string): v is ExternalImageMode {
  return MODE_IDS.includes(v);
}

/**
 * この `src` は**外から取ってくる**か。
 *
 * ⚠ **許すものを数え上げる**(拒むものを数え上げない)。「知らない形は外」に
 * 倒しておけば、新しい scheme が生えても勝手に漏れない。
 * - `data:` / `blob:` は手元で作ったもの(要求は飛ばない)
 * - `pkc:` / `entry:` / `asset:` は **PKC 自身の scheme** ── 下の註記を見よ
 * - scheme の無い相対 URL は同じ出所(飛んでも自分のところ)
 * - それ以外(`https:` / `http:` / `//例/x.png` / 見慣れない scheme)は**外**
 *
 * 🔴 **PKC 自身の scheme を「外」に入れてはいけない**(2026-08-06、goldens の
 * 差分で気づいた)。`![](pkc://asset/x.png)` はブラウザから見れば解決できない
 * scheme なので**要求は 1 本も飛ばない** ── なのに外扱いにすると、確認の帯が
 * 「外部の画像が 1 件あります」と言い、**同意しても何も起きない**。
 * つまり user に**嘘の判断を求める**ことになる(そして帯の信用が落ちる)。
 * ⚠ `asset:` / `entry:` は image rule が手前で捕まえているので実際には来ない。
 *   それでも並べておくのは、**この関数だけを読んで判断が完結する**ようにするため。
 */
export function isExternalImageSrc(src: string): boolean {
  const s = src.trim();
  if (s === '') return false;
  if (/^(?:data|blob|pkc|entry|asset):/i.test(s)) return false;
  // `//例/x.png` は scheme 相対 ── 見た目は相対だが**外へ飛ぶ**
  if (s.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(s);
}

/**
 * 箱(`sandbox` iframe)の CSP の `img-src`。
 *
 * ⚠ 塞ぐ側に **`'self'` を書かない**。箱は `allow-same-origin` を持たないので
 * origin は opaque = `'self'` は**何にも一致しない**。書くと「同じ出所なら
 * 読める」と誤解させる飾りになる(そして誰も気づかない)。
 * ⚠ `data:` と `blob:` は残す ── 箱の中で作った画像は要求を出さない。
 */
export function imgSrcDirective(allow: boolean): string {
  return allow ? '* data: blob:' : 'data: blob:';
}

/**
 * 読み込まずに残した画像の目印。⚠ **元の URL は捨てない** ── 同意が出たときに
 * ここから復元する。⚠ `src` は**付けない**(付けたら要求が飛ぶ = 意味が無い)。
 */
export const EXTERNAL_IMAGE_ATTR = 'data-pkc-external-src';

/** 器の見た目(CSS 側の掛かり先)。`app.css` と書出し HTML の両面に在る。 */
export const EXTERNAL_IMAGE_CLASS = 'pkc-external-img';

/**
 * 箱の中で **CSP に止められた**ことの申告(箱 → 親)。
 *
 * 🔑 **箱は静的には読めない**(中身は script なので、何を要求するか描く前には
 * 判らない)。だから「止めた」を**箱の中の `securitypolicyviolation` から
 * 教えてもらう** ── これが無いと「常に確認」で箱の画像が**永久に出せない**
 * (聞く materials が無いので確認の帯が出ず、同意する手段が無い)。
 * ⚠ 中身(止められた URL)は運ばない ── 数だけでよく、URL は本文の秘密を含む。
 */
export const HTML_SANDBOX_BLOCKED_MSG_TYPE = 'pkc-html-blocked-images';

/**
 * 🔴 **箱の中で止まったもののうち、画像以外の種別**(#528 段③。2026-08-28)。
 *
 * ⚠ 直す前、見張っていたのは **`img-src` だけ**だった ── 外部の JavaScript /
 *   CSS / `fetch` が止まっても、**どこにも 1 行も出なかった**。
 *   CDN を前提にした中身は**真っ白になって、理由が画面のどこにも無い**。
 * 🔑 これは「動くようにする」話ではない ── **止めたことを言う**だけである
 *   (門は 1 つも開けない)。
 *
 * ⚠ **URL は運ばない**(本文の秘密を含む)── 運ぶのは**種別と件数**だけ。
 */
export type SandboxBlockedKind = 'script' | 'style' | 'connect' | 'frame' | 'other';

/** 種別 → 画面に出す字。⚠ 内部の名前(`script-src-elem`)を user に見せない。 */
export const SANDBOX_BLOCKED_LABELS: Readonly<Record<SandboxBlockedKind, string>> = {
  script: '外部のプログラム',
  style: '外部の見た目(CSS)',
  connect: '外部との通信',
  frame: '入れ子の外部ページ',
  other: 'そのほかの外部の読み込み',
};

/**
 * CSP の項目名 → 種別。
 * 🔑 **判定はここ 1 か所**(箱の中の script と親で同じ規則を使う)。
 * ⚠ `img-src` はここに入れない ── あちらは**同意で開けられる**別の話である。
 */
export function sandboxBlockedKind(directive: string): SandboxBlockedKind | null {
  const d = directive.toLowerCase();
  if (d.startsWith('img-src')) return null;
  if (d.startsWith('script-src')) return 'script';
  if (d.startsWith('style-src')) return 'style';
  if (d.startsWith('connect-src')) return 'connect';
  if (d.startsWith('frame-src') || d.startsWith('child-src')) return 'frame';
  return 'other';
}

/**
 * 止まった種別を、user に読める 1 行にする。
 * ⚠ **順番を固定する**(出るたびに並びが変わると、同じ状態が違う字に見える)。
 */
export function sandboxBlockedNote(kinds: readonly SandboxBlockedKind[]): string {
  const order: readonly SandboxBlockedKind[] = ['script', 'style', 'connect', 'frame', 'other'];
  const seen = order.filter((k) => kinds.includes(k));
  if (seen.length === 0) return '';
  const what = seen.map((k) => SANDBOX_BLOCKED_LABELS[k]).join('・');
  return (
    `この HTML は${what}を読み込もうとしましたが、止めました。` +
    'この表示枠は外とつながらない作りなので、外部からは取ってこられません。' +
    'どうしても動かしたいときは、HTML をファイルとして添付し、その画面の' +
    '「アプリとして登録」を押してください(アプリは別のウィンドウで開くので、外から取ってこられます)。'
  );
}
// ⚠ 名前を `pkc-html-render-…` で始めない(2026-08-06 に踏んだ)── 箱の id が
//    `pkc-html-render-<hash>` なので、id を拾う正規表現(goldens の正規化など)が
//    **この語も id として拾う**。実際 golden の normalizer が
//    `pkc-html-render-blocked` を連番へ書き換え、diff が別物に見えた。
