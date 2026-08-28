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
 * ⚠ ただし PHOTO(base64 画像)だけは**大きさで別扱い** ── 本文に数十 KB の
 * base64 を書くと編集不能なノートができるので、**落として注意で言う**。
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
      case 'PHOTO':
        // ⚠ base64 の画像を本文に書くと編集不能なノートができる ── 落として言う
        warnings.push(`${cardNo()} 枚目: 写真(PHOTO)は取り込めません(本文には残しません)`);
        break;
      default: {
        // 🔴 写せない項目は本文の行として残す(黙って失わない)
        const label = prop.params.length > 0 ? `${prop.name};${prop.params.join(';')}` : prop.name;
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
  if (card.birthday !== '') meta['birthday'] = card.birthday;
  const parts: string[] = [serializeFrontmatter(meta)];
  if (card.notes.length > 0) parts.push('', ...card.notes);
  if (card.others.length > 0) parts.push('', ...card.others);
  return { title: card.name, body: `${parts.join('\n')}\n` };
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
    for (const t of c.tels) lines.push(`TEL;TYPE=voice:${escapeValue(t)}`);
    for (const e of c.emails) lines.push(`EMAIL;TYPE=internet:${escapeValue(e)}`);
    lines.push('END:VCARD');
  }
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}
