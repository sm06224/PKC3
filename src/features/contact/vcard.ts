/**
 * 🔴 **vCard の取込と書き出し**(#278 段③)。
 *
 * ## 読む側は広く、書く側は素直に
 *
 * - **取込**は vCard 2.1 / 3.0 / 4.0 を**広く受ける**(折り返し・QUOTED-PRINTABLE・
 *   エスケープ・複数枚)── user の手元の .vcf は端末やアプリごとに癖が違うので、
 *   厳しくすると「読めたはずの連絡先が黙って落ちる」(`mailHref` の「厳密に検めない」
 *   と同じ向き)。
 * - **書き出し**は 3.0 を 1 種類だけ書く(受け手がいちばん広い版)。
 *
 * ## 🔴 対応しない項目も**捨てない**
 *
 * 写真(PHOTO)や住所(ADR)など、frontmatter の鍵に写せない項目は
 * **本文の行として残す**(`- ADR: …`)── 取込で情報を黙って失うと、
 * user は元の .vcf を既に消していることがある(戻れない欠損になる)。
 * ⚠ ただし**符号化された中身**(写真 / 音 / 鍵 ── `ENCODING=B` か 2000 字超)は
 * **落として注意で言う**。本文に数十 KB の base64 を書くと編集不能なノートになる。
 * ⚠ 落とすのは**名前ではなく中身**で決める(`isEncodedBlob`)── `PHOTO` だけを
 * 名指ししていた 1 稿目は、`LOGO` / `SOUND` / `KEY` を素通ししていた。
 *
 * ## ⚠ pure module
 *
 * browser API を使わない。鍵の綴りは `contact-card.ts` の `CONTACT_KEYS` を
 * 参照する(取込が書く鍵と、連絡先タブが読む鍵を 2 か所にしない ── §7)。
 */
import { serializeFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { CONTACT_KEYS, type ContactCard } from './contact-card';

/** 取込の振り分けが見る拡張子(`isMarkdownFileName` と同じ作法 ── 中身では決めない)。 */
export function isVcfFileName(name: string): boolean {
  return /\.(vcf|vcard)$/i.test(name);
}

/** vCard 1 枚を読んだ結果。 */
export interface VcfCard {
  /** FN(無ければ N の組み立て、それも無ければ空文字 ── 呼び手が番号名を振る)。 */
  readonly name: string;
  readonly org: string;
  readonly tels: readonly string[];
  readonly emails: readonly string[];
  /** BDAY(そのままの字)。 */
  readonly birthday: string;
  /** NOTE(エスケープを解いた本文)。 */
  readonly notes: readonly string[];
  /** frontmatter に写せなかった項目(`ADR;TYPE=home: …` の形の行)。 */
  readonly others: readonly string[];
}

export interface VcfParseResult {
  readonly cards: readonly VcfCard[];
  /** 落とした・欠けた事情(「どのカードの何か」まで言う)。 */
  readonly warnings: readonly string[];
}

/** 3.0/4.0 の値エスケープを解く(`\\` `\,` `\;` `\n`)。 */
function unescapeValue(v: string): string {
  return v.replace(/\\([\\,;nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** QUOTED-PRINTABLE(2.1)を解く。⚠ UTF-8 のバイト列として復号する。 */
function decodeQp(v: string): string {
  // 行末の `=`(ソフト改行)は折り返しの名残 ── 落とす
  const joined = v.replace(/=\r?\n/g, '').replace(/=$/, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i]!;
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // 素の ASCII 字はそのまま(UTF-8 では 1 バイト)
      bytes.push(ch.charCodeAt(0));
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return joined;
  }
}

interface VcfProp {
  readonly name: string;
  /** `;` で並んだパラメタ(大文字化済み。`TYPE=CELL` / `ENCODING=QUOTED-PRINTABLE`)。 */
  readonly params: readonly string[];
  readonly value: string;
}

/** 折り返し(行頭の空白 / タブは前の行の続き)を解いて、性質の行に割る。 */
function unfoldLines(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line !== '') {
      out.push(line);
    }
  }
  return out;
}

function parseProp(line: string): VcfProp | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const parts = head.split(';');
  // group.NAME の group は捨てる(識別に使わない)
  const name = parts[0]!.replace(/^[^.]+\./, '').toUpperCase();
  const params = parts.slice(1).map((p) => p.toUpperCase());
  return { name, params, value: line.slice(colon + 1) };
}

/** 本文に置ける長さの上限 ── これを超える値は「符号化された中身」とみなす。 */
const BLOB_CHARS = 2000;

/**
 * 符号化された中身(写真・音・鍵)か。
 * ⚠ **パラメタと長さの両方**で見る ── `ENCODING` を書かない実装が在るので
 *   名乗りだけに頼らない。逆に長い散文(NOTE)は `default` へ来ないので巻き込まない。
 */
function isEncodedBlob(params: readonly string[], value: string): boolean {
  const enc = params.some(
    (p) => p === 'ENCODING=B' || p === 'ENCODING=BASE64' || p === 'BASE64' || p === 'B',
  );
  return enc || value.length > BLOB_CHARS;
}

/**
 * `;` で部品に割る ── ⚠ **エスケープを解く前に割る**(`\;` は部品の中の字)。
 * 解いてから割ると、名前や所属に書かれた `;` が部品の区切りに化ける。
 */
function splitUnescaped(v: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i]!;
    if (ch === '\\' && i + 1 < v.length) {
      cur += ch + v[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** N(family;given;…)から名前を組む ── 日本の並び(姓 名)で空白 1 つ。 */
function nameFromN(value: string): string {
  const comps = splitUnescaped(value, ';').map((c) => unescapeValue(c).trim());
  return [comps[0] ?? '', comps[1] ?? ''].filter(Boolean).join(' ').trim();
}

/**
 * .vcf の中身を読む。⚠ **壊れた行は黙って捨てず warnings に積む**。
 */
export function parseVcf(text: string): VcfParseResult {
  const warnings: string[] = [];
  const cards: VcfCard[] = [];
  const lines = unfoldLines(text);

  let cur: {
    fn: string;
    n: string;
    org: string;
    tels: string[];
    emails: string[];
    birthday: string;
    notes: string[];
    others: string[];
  } | null = null;
  const cardNo = (): number => cards.length + 1;

  for (const line of lines) {
    const prop = parseProp(line);
    if (prop === null) {
      if (cur !== null && line.trim() !== '')
        warnings.push(`${cardNo()} 枚目: 読めない行を捨てました(${line.slice(0, 40)})`);
      continue;
    }
    if (prop.name === 'BEGIN' && prop.value.trim().toUpperCase() === 'VCARD') {
      if (cur !== null) warnings.push(`${cardNo()} 枚目: END:VCARD が無いまま次が始まりました`);
      cur = { fn: '', n: '', org: '', tels: [], emails: [], birthday: '', notes: [], others: [] };
      continue;
    }
    if (prop.name === 'END' && prop.value.trim().toUpperCase() === 'VCARD') {
      if (cur !== null) {
        cards.push({
          name: cur.fn !== '' ? cur.fn : cur.n,
          org: cur.org,
          tels: cur.tels,
          emails: cur.emails,
          birthday: cur.birthday,
          notes: cur.notes,
          others: cur.others,
        });
      }
      cur = null;
      continue;
    }
    if (cur === null) continue;

    const qp = prop.params.some((p) => p === 'ENCODING=QUOTED-PRINTABLE' || p === 'QUOTED-PRINTABLE');
    const decoded = unescapeValue(qp ? decodeQp(prop.value) : prop.value).trim();
    switch (prop.name) {
      case 'VERSION':
      case 'PRODID':
      case 'REV':
        break; // 中身ではなく書いた道具の情報 ── ノートに写す価値が無い
      case 'FN':
        cur.fn = decoded;
        break;
      case 'N':
        cur.n = nameFromN(qp ? decodeQp(prop.value) : prop.value);
        break;
      case 'ORG':
        cur.org = splitUnescaped(qp ? decodeQp(prop.value) : prop.value, ';')
          .map((s) => unescapeValue(s).trim())
          .filter(Boolean)
          .join(' ');
        break;
      case 'TEL':
        if (decoded !== '') cur.tels.push(decoded);
        break;
      case 'EMAIL':
        if (decoded !== '') cur.emails.push(decoded);
        break;
      case 'BDAY':
        cur.birthday = decoded;
        break;
      case 'NOTE':
        if (decoded !== '') cur.notes.push(decoded);
        break;
      default: {
        const label = prop.params.length > 0 ? `${prop.name};${prop.params.join(';')}` : prop.name;
        /**
         * 🔴 **中身で落とす。名前で落とさない**(着地前レビュー 2026-08-28)。
         *
         * ⚠ 1 稿目は `case 'PHOTO':` だけを落としていたが、base64 を運ぶのは
         *   PHOTO だけではない ── `LOGO` / `SOUND` / `KEY`(vCard 3.0 の標準)や
         *   `X-MS-CARDPICTURE` は `default` に落ちて、**40KB の 1 行**として
         *   本文に入っていた(警告も 0 件)。docstring が言う「編集不能なノート」を
         *   自分で作っていたことになる。
         * 🔑 守るのは「PHOTO という綴り」ではなく「**巨大な中身**」である
         *   (CLAUDE.md §1「guard を file 名指しで書かない」)。
         * ⚠ URL の写真(`PHOTO;VALUE=uri:https://…`)は**残す** ── 短いし、
         *   情報として意味がある。落とすのは符号化された中身だけ。
         */
        if (isEncodedBlob(prop.params, decoded)) {
          warnings.push(
            prop.name === 'PHOTO'
              ? `${cardNo()} 枚目: 写真(PHOTO)は取り込めません(本文には残しません)`
              : `${cardNo()} 枚目: ${prop.name} は大きすぎて取り込めません(本文には残しません)`,
          );
          break;
        }
        // 🔴 写せない項目は本文の行として残す(黙って失わない)
        cur.others.push(`- ${label}: ${decoded}`);
      }
    }
  }
  if (cur !== null) warnings.push(`${cardNo()} 枚目: END:VCARD が無いまま終わりました(捨てました)`);
  return { cards, warnings };
}

/** 取込で作るノートの題名と本文。⚠ 本文の鍵は `CONTACT_KEYS`(読む側と同じ 1 つ)。 */
export function vcfNoteOf(card: VcfCard): { title: string; body: string } {
  const meta: Record<string, FrontmatterValue> = {};
  if (card.tels.length > 0)
    meta[CONTACT_KEYS.tel] = card.tels.length === 1 ? card.tels[0]! : [...card.tels];
  if (card.emails.length > 0)
    meta[CONTACT_KEYS.email] = card.emails.length === 1 ? card.emails[0]! : [...card.emails];
  if (card.org !== '') meta[CONTACT_KEYS.org] = card.org;
  if (card.birthday !== '') meta[CONTACT_KEYS.birthday] = card.birthday;
  const rest: string[] = [];
  if (card.notes.length > 0) rest.push(...card.notes);
  if (card.others.length > 0) {
    if (rest.length > 0) rest.push('');
    rest.push(...card.others);
  }
  /**
   * ⚠ **鍵が 1 つも無いなら囲みを書かない**(着地前レビュー 2026-08-28)。
   * 空の `---\n---` は `frontmatterLineCount` が **2** と数えるので、
   * 情報ペインの札が「この文書の情報 (空)」を**永久に出す** ── #343 が
   * 「user は何も書いていないのに、書いた物の入れ物を見せられる」として
   * わざわざ畳んだ形を、こちらが作り直していた。
   * ⚠ ただし**本文の 1 行目が `---` のときは空の囲みを残す** ── 外すと
   * その行が開きと読まれ、本文が frontmatter に飲まれる。
   */
  const needsFence = Object.keys(meta).length > 0 || rest[0]?.startsWith('---') === true;
  const parts = needsFence
    ? [serializeFrontmatter(meta), ...(rest.length > 0 ? ['', ...rest] : [])]
    : rest;
  return { title: card.name, body: parts.length === 0 ? '' : `${parts.join('\n')}\n` };
}

/** 3.0 の値エスケープ(`\` `,` `;` と改行)。 */
function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r?\n/g, '\\n');
}

/**
 * 🔴 **連絡先を vCard 3.0 で書き出す**。
 * ⚠ 行末は CRLF(仕様どおり ── LF だけだと読めない受け手が実在する)。
 * ⚠ 折り返し(75 octet)はしない ── 折らない長い行を受けない道具は現実には無く、
 *   折ると QP や UTF-8 の途中で割る事故のほうが起きやすい。
 */
export function buildVcf(cards: readonly ContactCard[]): string {
  const lines: string[] = [];
  for (const c of cards) {
    lines.push('BEGIN:VCARD', 'VERSION:3.0');
    lines.push(`N:${escapeValue(c.name)};;;;`);
    lines.push(`FN:${escapeValue(c.name)}`);
    if (c.org !== '') lines.push(`ORG:${escapeValue(c.org)}`);
    // 🔑 取込が `birthday:` を書くので、**書き出しも書く**(往復を閉じる ──
    //    無いと「取り込んで書き出したら誕生日が消えた」になる)
    if (c.birthday !== '') lines.push(`BDAY:${escapeValue(c.birthday)}`);
    for (const t of c.tels) lines.push(`TEL;TYPE=voice:${escapeValue(t)}`);
    for (const e of c.emails) lines.push(`EMAIL;TYPE=internet:${escapeValue(e)}`);
    lines.push('END:VCARD');
  }
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}
