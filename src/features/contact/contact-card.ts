/**
 * 🔴 **連絡先 ── ノートから「連絡の手段」を読む**(#278。user 指示 2026-08-19
 * 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ…、**連絡先**、
 * タイマー、アラートは組み込みアプリでリリースしたい」)。
 *
 * ## 🔴 アーキタイプを増やさない
 *
 * founding 方針「**全 body = PKC-Markdown、アーキタイプはフレーバー**」に従い、
 * **frontmatter に連絡の鍵を持つ普通のノート**を集める。⚠ 封印の教訓
 * (`SEAL_REASON`「機能を煮詰める前に作り込んで破綻した」)と同じ向きで、
 * **専用の型を先に作り込まない**。
 *
 * ## 🔑 名前は「題名」である(`name:` の鍵を作らない)
 *
 * ⚠ #278 の本文は鍵の例に `name` を挙げているが、**採らなかった**。
 * ノートには既に題名が在るので、`name:` を足すと**名前の出どころが 2 つ**になる
 * (CLAUDE.md §7)── そして必ず食い違い、user から見て
 * 「一覧では A、連絡先では B」という**理由の分からない差**が出る。
 * 🔑 だから **題名が名前**。連絡先かどうかを決めるのは `tel` / `email` である。
 *
 * ## ⚠ pure module
 *
 * browser API を使わない / 時計を読まない。⚠ **本文は持ち出さない** ──
 * 返すのは連絡の手段だけである(舐めるのは worker、渡るのは項目だけ)。
 */
import { frontmatterLineCount, parseFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { compareTitles } from '../filter/title-compare';

/**
 * frontmatter に書く鍵。⚠ **文字列を直接書かない**(綴り間違いが静かに効く ──
 * `schedule-keys.ts` と同じ作法)。
 */
export const CONTACT_KEYS = {
  /** 電話。1 本でも、並べて何本でも書ける。 */
  tel: 'tel',
  /** メール。1 つでも、並べて何個でも書ける。 */
  email: 'email',
  /** 所属(会社・部署)。⚠ 有っても連絡先にはならない(下の `contactOf`)。 */
  org: 'org',
  /** 誕生日。⚠ これも単体では連絡先にならない。 */
  birthday: 'birthday',
  /**
   * 🔴 **読み**(依頼 145。Gemini の回答「推薦どおり」= 読みを書けるようにして、あればそれで並べる)。
   * 例: `yomi: やまだ たろう`。⚠ 漢字の名前は文字の並びでは五十音順にならない ── 読みを書いた人だけ、読みで並ぶ。
   * 書かない人は題名で並ぶ(ひらがな・カタカナの違いは並びでは同じ字 ── `compareTitles`)。単体では連絡先にならない。
   */
  yomi: 'yomi',
} as const;

export interface ContactCard {
  readonly lid: string;
  /** 🔑 **題名がそのまま名前**(上の docstring)。 */
  readonly name: string;
  /**
   * 所属(画面に出す字)。書いていなければ空文字。
   * 🔑 **`orgParts` から作る派生値**である ── 出どころは 1 つ(CLAUDE.md §7)。
   */
  readonly org: string;
  /**
   * 所属の内訳(会社 / 部署 …)。
   * 🔴 **書き出しの往復を閉じるために持つ**(#534 段②)── vCard の `ORG` は
   * `;` で会社と部署を分ける。1 つの字に潰すと、書き出したとき
   * `ORG:例の会社 営業部` になり、**相手の端末で部署が消える**。
   * ⚠ 画面と絞り込みは `org`(空白で繋いだ字)を見る ── 内訳は書き出しだけが使う。
   */
  readonly orgParts: readonly string[];
  readonly tels: readonly string[];
  readonly emails: readonly string[];
  /**
   * 誕生日(書いていなければ空文字)。
   * 🔑 **書き出しの往復を閉じるために載せる**(着地前レビュー 2026-08-28)──
   *   取込は `birthday:` を書くのに、`ContactCard` に無いせいで
   *   `buildVcf` が `BDAY:` を書けず、**往復すると誕生日が消えていた**。
   */
  readonly birthday: string;
  /** 🔴 読み(依頼 145)。書いていなければ空文字。並べるときと探すときに使う。省略 = 書いていない。 */
  readonly yomi?: string;
  /**
   * 🔴 **長すぎるので外した宛先があるか**(#536 ③)。
   *
   * ⚠ **外したことを言うため**だけに在る ── 書き出しの帯が件数を出す。
   *   ⚠ 黙って落とすのは「静かに失う」そのものである。
   * 🔑 **外すのは値 1 つずつ**である(card ごとではない)── 1 稿目は card に印を付けて
   *   `buildVcf` が**その人の電話とメールを丸ごと書かない**形にしていたが、
   *   ⚠ **1 つの長い落書きと本物の電話番号が同じノートに在ると、本物のほうが消えた**。
   *   `tels` / `emails` に**残っている値は全部そのまま書ける**、が今の約束である。
   */
  readonly overlong: boolean;
}

/** 走査の結果。⚠ **切ったかどうかを一緒に運ぶ**(黙って切らない ── `TaskScan` と同じ)。 */
export interface ContactScan {
  readonly cards: readonly ContactCard[];
  /** 候補になったノートの総数(切る前)。 */
  readonly totalNotes: number;
  /** 実際に本文を読んだノートの数。 */
  readonly scannedNotes: number;
  /** 🔴 上限で切ったか。⚠ 切ったなら**画面にそう出す**(「無い」と読ませない)。 */
  readonly truncated: boolean;
}

/**
 * 上限。⚠ **切ったことは `truncated` で必ず言う**。
 * ⚠ `each` / `chars` は **画面の上限**である(`displayWays` が使う)──
 *   `ContactCard` の中身は丸めない(上の `displayWays` の注記)。
 */
export const CONTACT_LIMITS = {
  /** 舐めるノートの数。 */
  notes: 5000,
  /** 集める連絡先の数。 */
  cards: 2000,
  /** 1 件あたりの電話 / メールの数。⚠ 並べすぎた行で一覧が壊れない上限。 */
  each: 8,
  /** 1 つの値の長さ。 */
  chars: 120,
  /**
   * 🔴 **worker → main を渡ってよい 1 値の長さ**(#536 ③、2026-08-28 に測って置いた)。
   *
   * ⚠ **画面の丸め(`chars`)とは別物**である ── あちらは「見せ方」、こちらは
   *   「**渡す量**」。⚠ 混ぜると、#278 段③ で踏んだ「画面の丸めが .vcf へ漏れる」
   *   を作り直す(CLAUDE.md §7「誤差の向きを決めて、両側に使い回さない」)。
   *
   * ## 🔑 実測が置き場を決めた(2026-08-28)
   *
   * 2000 件 × 宛先 2 本で、**1 値の長さ**を変えたときに渡る量:
   *
   * | 1 値 | 渡る量 |
   * |---|---|
   * | 20 字(現実的) | 0.27 MB |
   * | 120 字 | 0.65 MB |
   * | 1,000 字 | 4.01 MB |
   * | **10,000 字** | 🔴 **38.34 MB** |
   *
   * ⚠ **件数の軸は問題ではなかった** ── 2000 件でも 0.27〜0.73 MB である。
   *   効いているのは**長さ**だけなので、そこに門を置く。
   * 🔑 1,000 字は「**本物の宛先なら絶対に超えない**」値である
   *   (メールアドレスの上限は 254 字 / E.164 の電話番号は 15 桁)。
   *   ⚠ だから外しても user の宛先は 1 つも失われない ── 失われるのは
   *   「宛先ではない何か」だけである。
   *   ⚠ **ただしそれは「値 1 つずつ外す」ときだけ成り立つ主張**である ──
   *   card ごと落とすと、同じノートの本物の宛先まで巻き添えになる(下の `cut` の注記)。
   */
  wire: 1000,
} as const;

/**
 * 値を「文字の並び」にする。
 * ⚠ **数として読まれた電話番号を捨てない** ── `tel: 0312345678` は
 *   frontmatter では**数**になりうるので、文字へ戻す(先頭の 0 が落ちる形は
 *   user が書いた字と違うが、**捨てるよりは出す**)。
 * ⚠ 空の値は落とす(`tel:` とだけ書いた行で空の札を作らない)。
 */
function values(v: FrontmatterValue | undefined): string[] {
  const raw = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of raw) {
    if (x === null || typeof x === 'boolean') continue;
    const s = String(x).trim();
    if (s === '') continue;
    out.push(s);
  }
  return out;
}

/**
 * 🔴 **「,」で並べた複数の宛先を、1 件ずつに割る**(依頼 285 A)。
 * ⚠ `email: a@b.co, c@d.co` / `tel: 090-1111-2222, 03-1234-5678` の全体が 1 つの字で残ると、
 *   メールは押せず、電話は先頭の番号しか掛からない。`- ` で 1 行ずつ書いた形と同じに読む。
 * ⚠ 割るのは `<…>` ・`"…"`・`(…)` の**外**の「,」「，」だけ ── `"山田, 太郎" <a@b.co>` の名前の中の「,」で割らない。
 * 🔑 割るのはここ 1 か所 ── 画面・絞り込み・.vcf 書き出しは `ContactCard` の `tels` / `emails` を同じに読む。
 */
export function splitWays(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let angle = false;
  let quote = false;
  let paren = 0;
  for (const c of s) {
    if (c === '"') quote = !quote;
    else if (!quote && c === '<') angle = true;
    else if (!quote && c === '>') angle = false;
    else if (!quote && !angle && c === '(') paren += 1;
    else if (!quote && !angle && c === ')' && paren > 0) paren -= 1;
    if ((c === ',' || c === '，') && !quote && !angle && paren === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/**
 * 🔴 **`名前 <宛先>` の宛先だけを取る**(依頼 285 A)。`<…>` が末尾に無ければそのまま返す。
 * ⚠ 押し先(`mailto:` / `tel:`)と .vcf の `EMAIL` / `TEL` は必ずこれを通す ── 名前ごと渡すと壊れた宛先になる。
 */
export function wayAddress(s: string): string {
  const m = /<([^<>]*)>\s*$/.exec(s.trim());
  return m === null ? s.trim() : m[1]!.trim();
}

/**
 * 🔴 **手で書いた電話番号の先頭の 0 を落とさない**(#1087)。
 * ⚠ `tel: 09012345678` は frontmatter では**数**として読まれ、`9012345678` になる ──
 *   そのまま `tel:` に使うと**別の番号**へかかる。数として読まれた値は、原文の行から
 *   **書いたままの字**を引き直す(引用符で囲んだ値は文字のまま読まれるので、ここへ来ない)。
 * ⚠ 原文に見つからなければ従来どおり数を文字へ戻す(捨てない)。
 */
function telValues(body: string, v: FrontmatterValue | undefined): string[] {
  const raw = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  if (!raw.some((x) => typeof x === 'number')) return values(v);
  const lines = body.split(/\r?\n/).slice(0, frontmatterLineCount(body));
  const tokens: string[] = [];
  const at = lines.findIndex((l) => new RegExp(`^${CONTACT_KEYS.tel}\\s*:`).test(l));
  if (at >= 0) {
    const inline = lines[at]!.replace(new RegExp(`^${CONTACT_KEYS.tel}\\s*:`), '').replace(/\s+#.*$/, '').trim();
    if (inline !== '') {
      tokens.push(...inline.replace(/^\[/, '').replace(/\]$/, '').split(',').map((t) => t.trim()));
    } else {
      for (let i = at + 1; i < lines.length; i++) {
        const m = /^\s*-\s+(.*?)\s*(?:\s#.*)?$/.exec(lines[i]!);
        if (m === null) break;
        tokens.push(m[1]!.trim());
      }
    }
  }
  const out: string[] = [];
  for (const x of raw) {
    if (x === null || typeof x === 'boolean') continue;
    const written = typeof x === 'number' ? tokens.find((t) => /^[+-]?\d+(?:\.\d+)?$/.test(t) && Number(t) === x) : undefined;
    const s = (written ?? String(x)).trim();
    if (s !== '') out.push(s);
  }
  return out;
}

/**
 * 画面に出す 1 つの宛先。
 * 🔴 **`text` は見せる字、`raw` は押し先を作る値。混ぜてはいけない**
 * (2 巡目の着地前レビュー 2026-08-28)。
 *
 * ⚠ 1 稿目は丸めた字を 1 本返すだけだったので、描画が **`telHref(丸めた字)` /
 *   `mailHref(丸めた字)`** を作っていた ── 120 字を超える宛先では、
 *   字は正しく `…` で丸まっているのに**押すと別の宛先へ送る**。
 *   しかも `…` は `[^\s@]` に当たるので `mailHref` の検査を**すり抜ける**
 *   (= 押せない口にもならない、いちばん気づけない形)。
 * 🔑 1 巡目の指摘は「丸めが**外へ出る成果物**に漏れている」だった ──
 *   `href` も外へ出る成果物である(CLAUDE.md「1 巡目の修正は、2 巡目の対象」)。
 */
export interface DisplayWay {
  /** 画面に出す字(長ければ `…` で切ってある)。 */
  readonly text: string;
  /** 🔴 **原値**。押し先(`tel:` / `mailto:`)は必ずこちらから作る。 */
  readonly raw: string;
}

/**
 * 🔴 **画面に出す分だけ丸める**(#278 段③ の着地前レビュー 2026-08-28)。
 *
 * ⚠ 1 稿目はここの丸め(8 件 / 120 字 + `…`)を **`contactOf` の中**でやっていた。
 *   その結果 `ContactCard` は「画面のために削った値」を持ち、⚠ **書き出し
 *   (`buildVcf`)がそれをそのまま .vcf へ書いていた** ── 9 本目の電話は消え、
 *   130 字のメールは `…` 付きで出る。受け取った端末は**壊れた宛先を在るものとして
 *   保存する**(落ちるより悪い)。
 * 🔑 CLAUDE.md §7「誤差の向きを決めて、両側に使い回さない」── 画面は
 *   false-keep で丸めてよいが、**外へ出す file に同じ丸めを流用しない**。
 * ⚠ だから丸めは**描画の仕事**にした。`ContactCard` は原値を持つ。
 */
export function displayWays(list: readonly string[]): {
  readonly shown: readonly DisplayWay[];
  readonly hidden: number;
} {
  const shown = list.slice(0, CONTACT_LIMITS.each).map((raw) => ({
    raw,
    text: raw.length <= CONTACT_LIMITS.chars ? raw : `${raw.slice(0, CONTACT_LIMITS.chars)}…`,
  }));
  return { shown, hidden: Math.max(0, list.length - shown.length) };
}

/**
 * 🔴 **ノート 1 件を連絡先にする**(連絡先でなければ `null`)。
 *
 * ⚠ **`org` だけでは連絡先にしない** ── 所属を書いただけの議事録が
 *   全部連絡先に並ぶ(「要る物が要らない物に押し出される」)。
 * 🔑 連絡先とは「**連絡できる**もの」なので、**電話かメールが 1 つ以上**要る。
 */
export function contactOf(lid: string, title: string, body: string): ContactCard | null {
  const { meta } = parseFrontmatter(body);
  const rawTels = telValues(body, meta[CONTACT_KEYS.tel]).flatMap(splitWays);
  const rawEmails = values(meta[CONTACT_KEYS.email]).flatMap(splitWays);
  if (rawTels.length === 0 && rawEmails.length === 0) return null;
  /**
   * 🔴 **渡る量に門を置く**(#536 ③)。⚠ 実測は `CONTACT_LIMITS.wire` の注記に在る
   *   ── 効いているのは件数ではなく**1 値の長さ**である(10,000 字で 38MB)。
   *
   * 🔑 **切らずに、外す。** 途中で切った宛先を残すと、下流(.vcf / `tel:` / `mailto:`)が
   *   **壊れた宛先を「在るもの」として扱う** ── 落ちるより悪い(#278 段③ と同じ形)。
   * 🔴 **外すのは値 1 つずつ**である。⚠ card ごとに落とすと、**同じノートに在る本物の
   *   電話番号まで消える** ── 1 稿目はそれをやっていた(自分で「失う本物の宛先は
   *   0 件」と書いておきながら、mixed な 1 件で嘘になっていた)。
   * ⚠ 連絡先かどうかの判定は**外す前**(`rawTels` / `rawEmails`)で済ませてある ──
   *   落書きしか無いノートも一覧には出る(user が「ここに書いた」ことは事実なので、
   *   黙って一覧から消さない)。
   */
  let overlong = false;
  const cut = (list: readonly string[]): string[] =>
    list.filter((v) => {
      if (v.length <= CONTACT_LIMITS.wire) return true;
      overlong = true;
      return false;
    });
  const tels = cut(rawTels);
  const emails = cut(rawEmails);
  /**
   * ⚠ `org:` は **1 つの字でも、並べて何個でも**書ける ── 取込は
   * vCard の `ORG:会社;部署` を `org: [会社, 部署]` として書く(#534 段②)。
   * 🔑 画面に出すのは空白で繋いだ 1 つの字 ── 内訳は `buildVcf` だけが使う。
   */
  const orgParts = values(meta[CONTACT_KEYS.org]);
  const birthday = values(meta[CONTACT_KEYS.birthday])[0] ?? '';
  // ⚠ 渡る量の門は宛先と同じ(長すぎる落書きは読みとして持たない ── 切らずに外す)
  const yomiRaw = values(meta[CONTACT_KEYS.yomi])[0] ?? '';
  const yomi = yomiRaw.length <= CONTACT_LIMITS.wire ? yomiRaw : '';
  return { lid, name: title, org: orgParts.join(' '), orgParts, tels, emails, birthday, yomi, overlong };
}

/**
 * 絞り込み。⚠ **名前・所属・電話・メールのどれに当たってもよい** ──
 *   user は「田中」でも「090」でも探す。
 * ⚠ 大文字小文字は区別しない(メールは実際どちらでも届く)。
 */
export function matchContact(card: ContactCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = [card.name, card.yomi ?? '', card.org, ...card.tels, ...card.emails].join(' ').toLowerCase();
  if (hay.includes(q)) return true;
  // 🔴 電話は区切りと全角を無視して探す(#1087)── `09011112222` でも `090-1111` でも `０９０` でも当たる
  // ⚠ 数字の比べ方は、**探す字が数字と区切りだけのとき**に使う。名前と混ぜた「山田 090」で
  //   数字だけを取り出すと、090 の人が全員当たる(名前の絞りが効かない)
  const telDigits = card.tels.map((t) => t.normalize('NFKC').replace(/[^\d]/g, ''));
  const phoneLike = (s: string): boolean => /^[\d\s+()-]+$/.test(s) && /\d/.test(s);
  const digitHit = (s: string): boolean => {
    const qd = s.replace(/[^\d]/g, '');
    return qd.length >= 3 && telDigits.some((t) => t.includes(qd));
  };
  const qn = q.normalize('NFKC');
  if (phoneLike(qn)) return digitHit(qn);
  // 名前と番号が混ざった探し方は、語ごとに**全部**当たること
  const terms = qn.split(/\s+/).filter(Boolean);
  if (terms.length < 2) return false;
  const hayN = hay.normalize('NFKC');
  return terms.every((w) => hayN.includes(w) || (phoneLike(w) && digitHit(w)));
}

/**
 * 並び。🔴 **一覧の「題名順」と同じ規則**(`features/filter/entry-sort.ts`)──
 * 小文字にしてから素直に比べる。⚠ 同じなら lid で割る(毎回同じ順)。
 *
 * ⚠ **`localeCompare` を使わない。** 1 稿目は使っており、`山田` と `青木` が
 *   一覧と**逆の順**になった ── user から見て「同じ題名順なのに、面によって
 *   並びが違う」という**理由の分からない差**である(CLAUDE.md §7)。
 * ⚠ 読みを書いていない漢字の名前は**五十音順にはならない**(読みを持っていないので原理的に無理)。
 *   🔑 揃っていることのほうが、どちらが「正しい順」かより効く。読みを書いた人(`yomi:`)だけ読みで並ぶ(依頼 145)。
 */
export function sortContacts(cards: readonly ContactCard[]): ContactCard[] {
  // 🔑 一覧の題名順と同じ比べ方(`compareTitles`)── 面によって順が違わない(#1087)
  // 🔴 読みを書いた人は読みで並ぶ(依頼 145)── 書かない人は題名のまま。両方が混ざる一覧でも同じ 1 本の比べ方で並べる
  const keyOf = (c: ContactCard): string => (c.yomi !== undefined && c.yomi.trim() !== '' ? c.yomi : c.name);
  return [...cards].sort((a, b) => {
    const byName = compareTitles(keyOf(a), keyOf(b));
    if (byName !== 0) return byName;
    return a.lid < b.lid ? -1 : a.lid > b.lid ? 1 : 0;
  });
}

/**
 * 🔴 **押せる宛先にする**。
 *
 * ⚠ **電話の字はそのまま出す**(`090-1234-5678`)が、`href` からは
 *   **記号を落とす** ── `tel:` は数字と `+` しか受けないので、
 *   ハイフンや括弧を残すと端末によっては掛からない。
 * ⚠ 数字が 1 桁も無ければ `null`(押せない口を出さない)。
 */
export function telHref(tel: string): string | null {
  /**
   * 🔴 **番号の後ろに書いた字の中の数字を、番号に混ぜない**(#1087 の見直し 2026-10-13)。
   * ⚠ 直す前は数字を全部つないでいたので、`03-1234-5678(内線 123)` は `tel:0312345678123`
   *   (**別の番号**)になった。番号に使う字(数字・`+`・`-`・空白・括弧)が続く所までで切る。
   * ⚠ 全角の数字も番号として読む(`\d` は半角しか当たらない ── 押せない字のままだった)。
   */
  const half = wayAddress(tel).normalize('NFKC');
  // ⚠ 頭の飾り(`TEL:` など)は今までどおり読み飛ばす ── 最初の数字か `+` から読み始める
  const first = half.search(/[+\d]/);
  if (first < 0) return null;
  const start = half[first - 1] === '(' ? first - 1 : first; // `(03) …` の括弧から読む
  /**
   * 🔴 番号の続きとして読むのは、数字・`+`(頭だけ)・区切り・**閉じた数字だけの括弧**(`(03)`)まで(#1087)。
   * ⚠ 閉じない括弧・数字以外の入った括弧・空白のあとに独りで立つ `-123` は、番号の外の字なのでそこで止める
   *   (`03-1234-5678 (9-18時)` の 9-18 を番号に混ぜない)。`+81 (0) 90…` の `(0)` は国番号の直後なので落とす。
   */
  let digits = '';
  for (let i = start; i < half.length; i++) {
    const c = half[i]!;
    if (/\d/.test(c) || (c === '+' && digits === '')) digits += c;
    else if (/\s/.test(c)) continue;
    else if (/[-‐−―]/.test(c)) {
      if (/\s/.test(half[i - 1] ?? '')) break;
    } else if (c === '(') {
      const close = half.indexOf(')', i);
      const inner = close < 0 ? '' : half.slice(i + 1, close);
      if (!/^\d+$/.test(inner)) break;
      if (!(inner === '0' && /^\+\d{1,3}$/.test(digits))) digits += inner;
      i = close;
    } else break;
  }
  return /\d/.test(digits) ? `tel:${digits}` : null;
}

/**
 * ⚠ `@` を挟んで前後があることだけを見る ── **厳密に検めない**。
 *   厳しくすると user が書いた宛先が黙って押せなくなる(`schedule-date.ts` の
 *   「広く拾う」と同じ向き)。
 * 🔴 **`?` `&` `#` を含む宛先は押せる形にしない**(#1087)── `mailto:` の後ろに書くと
 *   件名・宛先の追加・本文などの**クエリ**として読まれ、書いた宛先と別の相手へ宛てた下書きになる。
 */
export function mailHref(email: string): string | null {
  // 🔴 `名前 <宛先>` は宛先だけを `mailto:` に載せる(依頼 285 A)
  const addr = wayAddress(email);
  const m = /^[^\s@?&#]+@[^\s@?&#]+$/.exec(addr);
  return m === null ? null : `mailto:${addr}`;
}

/** 一覧の 1 行に出す字。⚠ **所属が無ければ足さない**(空の括弧を出さない)。 */
export function contactLine(card: ContactCard): string {
  return card.org === '' ? card.name : `${card.name}(${card.org})`;
}

/**
 * 🔴 **いま見えている連絡先**(絞り込み + 並び)── 描画と書き出しが**同じ 1 つ**を
 * 呼ぶ(#278 段③)。⚠ 別々に filter を書くと「画面は 3 件なのに書き出しは 5 件」
 * という**黙った食い違い**になる(§7 ── 個人情報の書き出しでは特に踏めない)。
 */
export function visibleContacts(
  cards: readonly ContactCard[],
  query: string,
): ContactCard[] {
  return sortContacts(cards.filter((c) => matchContact(c, query)));
}
