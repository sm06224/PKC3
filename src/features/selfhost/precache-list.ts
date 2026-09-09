/**
 * 配っている file の一覧(`precache.json`)── **綴りは 1 か所**(#532 段 B)。
 *
 * 🔴 なぜ data として配るのか。「自分のパソコンで動かす」は、いま配っている物を
 * **1 つ残らず**集めて zip にするので、その一覧が要る。⚠ 一覧が在るのは
 * `sw.js` の**コードの中**(`const PRECACHE = [...]`)だけなので、アプリから読むと
 * **JS を正規表現で削る**ことになる ── それは「同じ問いに答える口が 2 つ」
 * (CLAUDE.md §7)そのもので、片方の綴りが変わった日に**黙って空になる**。
 *
 * 🔑 だから `build/sw-plugin.ts` が**同じ配列**を data として 1 つ emit し、
 *   `scripts/dist-inspect.mjs` が **sw.js の中身と両方向で突き合わせる**
 *   (どちらかにしか無い名前が 1 つでもあれば落ちる)。
 * ⚠ 名前をここに置くのは、**build / 検品 / アプリの 3 か所が同じ字を使う**ため。
 */
export const PRECACHE_LIST_FILE = 'precache.json';

/**
 * `precache.json` の中身を読む。
 *
 * ⚠ **空を通さない**。⚠ 型だけ見て通すと、生成器が壊れて `[]` を吐いた日に
 * 「0 件の一式」を zip にして配ってしまう ── user から見ると
 * **中身が空の zip が落ちてくる**(いちばん気づけない壊れ方)。
 * @throws 配列でない / 空 / 文字列でない要素がある
 */
export function parsePrecacheList(text: string): readonly string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${PRECACHE_LIST_FILE} が JSON として読めません`, { cause: e });
  }
  if (!Array.isArray(raw)) throw new Error(`${PRECACHE_LIST_FILE} が配列ではありません`);
  if (raw.length === 0) throw new Error(`${PRECACHE_LIST_FILE} が空です(配る物が 1 つも無い)`);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v === '') {
      throw new Error(`${PRECACHE_LIST_FILE} に文字列でない要素があります`);
    }
    out.push(v);
  }
  return out;
}

/**
 * 一覧の 1 件を、dist の中の相対 path に直す(`./assets/x.js` → `assets/x.js`)。
 *
 * ⚠ **絶対 path を受けない** ── `base: './'` を守る門(#532 S1)が在るので
 * 本来来ないが、来たら**そこで止める**。黙って `/` を削ると、
 * 「どこに置いても動く」が崩れたことに誰も気づかないまま zip が出来上がる。
 */
export function precacheEntryPath(ref: string): string {
  if (ref.startsWith('/')) {
    throw new Error(`配置場所を根に決め打ちした参照が一覧に在ります: ${ref}`);
  }
  return ref.replace(/^\.\//, '');
}
