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
import { parseFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';

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
} as const;

export interface ContactCard {
  readonly lid: string;
  /** 🔑 **題名がそのまま名前**(上の docstring)。 */
  readonly name: string;
  /** 所属。書いていなければ空文字。 */
  readonly org: string;
  readonly tels: readonly string[];
  readonly emails: readonly string[];
  /**
   * 誕生日(書いていなければ空文字)。
   * 🔑 **書き出しの往復を閉じるために載せる**(着地前レビュー 2026-08-28)──
   *   取込は `birthday:` を書くのに、`ContactCard` に無いせいで
   *   `buildVcf` が `BDAY:` を書けず、**往復すると誕生日が消えていた**。
   */
  readonly birthday: string;
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
  readonly shown: readonly string[];
  readonly hidden: number;
} {
  const shown = list
    .slice(0, CONTACT_LIMITS.each)
    .map((s) => (s.length <= CONTACT_LIMITS.chars ? s : `${s.slice(0, CONTACT_LIMITS.chars)}…`));
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
  const tels = values(meta[CONTACT_KEYS.tel]);
  const emails = values(meta[CONTACT_KEYS.email]);
  if (tels.length === 0 && emails.length === 0) return null;
  const org = values(meta[CONTACT_KEYS.org])[0] ?? '';
  const birthday = values(meta[CONTACT_KEYS.birthday])[0] ?? '';
  return { lid, name: title, org, tels, emails, birthday };
}

/**
 * 絞り込み。⚠ **名前・所属・電話・メールのどれに当たってもよい** ──
 *   user は「田中」でも「090」でも探す。
 * ⚠ 大文字小文字は区別しない(メールは実際どちらでも届く)。
 */
export function matchContact(card: ContactCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = [card.name, card.org, ...card.tels, ...card.emails].join(' ').toLowerCase();
  return hay.includes(q);
}

/**
 * 並び。🔴 **一覧の「題名順」と同じ規則**(`features/filter/entry-sort.ts`)──
 * 小文字にしてから素直に比べる。⚠ 同じなら lid で割る(毎回同じ順)。
 *
 * ⚠ **`localeCompare` を使わない。** 1 稿目は使っており、`山田` と `青木` が
 *   一覧と**逆の順**になった ── user から見て「同じ題名順なのに、面によって
 *   並びが違う」という**理由の分からない差**である(CLAUDE.md §7)。
 * ⚠ どちらも**五十音順にはならない**(読みを持っていないので原理的に無理)。
 *   🔑 揃っていることのほうが、どちらが「正しい順」かより効く。
 */
export function sortContacts(cards: readonly ContactCard[]): ContactCard[] {
  return [...cards].sort((a, b) => {
    const ka = a.name.toLowerCase();
    const kb = b.name.toLowerCase();
    if (ka !== kb) return ka < kb ? -1 : 1;
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
  const digits = tel.replace(/[^\d+]/g, '');
  return /\d/.test(digits) ? `tel:${digits}` : null;
}

/**
 * ⚠ `@` を挟んで前後があることだけを見る ── **厳密に検めない**。
 *   厳しくすると user が書いた宛先が黙って押せなくなる(`schedule-date.ts` の
 *   「広く拾う」と同じ向き)。
 */
export function mailHref(email: string): string | null {
  const m = /^[^\s@]+@[^\s@]+$/.exec(email.trim());
  return m === null ? null : `mailto:${email.trim()}`;
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
