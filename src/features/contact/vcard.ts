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
 * ⚠ **例外が 1 つある: 電話・メールの種別**(`TEL;TYPE=CELL`)は残せない ──
 * 値に混ぜると `buildVcf` が壊れた番号を書き出すためである。**だから言う**
 * (2026-08-28。それまでは警告 0 件で消えていた)。
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
  /** 所属の内訳(会社 / 部署 …)。⚠ **繋がない** ── `;` の区切りが書き出しに要る。 */
  readonly orgParts: readonly string[];
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
/**
 * 🔴 **QP を解いた結果と、壊れていたかを一緒に返す**(#534 ⑤)。
 *
 * ⚠ 1 稿目は字だけ返していたので、`=ZZ` のような**壊れた 16 進**が
 *   `"=ZZ"` のまま素通りし、UTF-8 として読めないバイト列は `<U+FFFD>` の
 *   モジバケになった ── **警告は 0 件**だった。user から見ると
 *   「名前が化けている理由がどこにも出ない」。
 * 🔑 この module の宣言は「黙って失わない」なので、**化けたことも言う**。
 */
interface QpResult {
  readonly text: string;
  /** ⚠ 16 進として読めない `=` が在ったか、復号したバイト列が UTF-8 でなかったか。 */
  readonly broken: boolean;
}

function decodeQp(v: string): QpResult {
  /**
   * 行末の `=`(ソフト改行)は折り返しの名残 ── 落とす。
   * ⚠ かつてここに `.replace(/=\r?\n/g, '')` も置いていたが、**no-op だった**
   *   (値は `line.slice(colon + 1)` なので改行を含みえない)。折り返しは
   *   `unfoldLines` が解く ── CLAUDE.md「『これが無いと壊れる』と書く前に、
   *   外して壊れるのを見る」に従って消した(2026-08-28)。
   */
  const joined = v.replace(/=$/, '');
  const bytes: number[] = [];
  let broken = false;
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i]!;
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // ⚠ QP で `=` の次が 16 進でないのは**壊れている**(素の `=` は `=3D` と書く)
      if (ch === '=') broken = true;
      // 素の ASCII 字はそのまま(UTF-8 では 1 バイト)
      bytes.push(ch.charCodeAt(0));
    }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
    // ⚠ `fatal: false` は読めないバイトを U+FFFD にする ── **それも壊れの印**
    return { text, broken: broken || text.includes('\uFFFD') };
  } catch {
    return { text: joined, broken: true };
  }
}

interface VcfProp {
  readonly name: string;
  /** `;` で並んだパラメタ(大文字化済み。`TYPE=CELL` / `ENCODING=QUOTED-PRINTABLE`)。 */
  readonly params: readonly string[];
  readonly value: string;
}

/**
 * その行が **QUOTED-PRINTABLE と名乗っているか**(パラメタ部だけを見る)。
 * ⚠ `[^:]*` は `:` を越えないので、**値の中の同じ字**には当たらない。
 */
const QP_HEAD = /^[^:]*;[^:]*ENCODING=QUOTED-PRINTABLE/i;

/** 折り返し(行頭の空白 / タブは前の行の続き、または行末 `=`)を解いて、性質の行に割る。 */
function unfoldLines(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    const prev = out.length > 0 ? out[out.length - 1]! : null;
    if ((line.startsWith(' ') || line.startsWith('\t')) && prev !== null) {
      out[out.length - 1] = prev + line.slice(1);
    } else if (prev !== null && prev.endsWith('=') && QP_HEAD.test(prev)) {
      /**
       * 🔴 **2.1 の QUOTED-PRINTABLE は「行末 `=`」で折る**(2 巡目の着地前
       * レビュー 2026-08-28)── 継続行は**空白で始まらない**ので、上の枝では
       * 拾えない。Android / 古い Outlook / ガラケーの書き出しの標準形である。
       *
       * ⚠ 直す前は、折られた行の続きが**別の性質の行**として読まれ、
       *   `parseProp` が `:` を見つけられずに捨てていた ── 実測:
       *   `FN;ENCODING=QUOTED-PRINTABLE:…=E5=A4=AA=` + `=E9=83=8E` は
       *   **「山田太」**(「郎」が消える)。⚠ 警告は出るが
       *   「読めない行を捨てました(=E9=83=8E)」なので、**名前が欠けたことと
       *   結び付かない** ── user は題名が切れた理由を知りようがない。
       * ⚠ **QP と名乗っている行だけ**を継ぐ ── そうしないと、base64 の
       *   詰め物(`…QUJD=`)の次の行まで巻き込む。
       */
      out[out.length - 1] = prev.slice(0, -1) + line;
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
/**
 * 🔴 **写せない項目を「読める字」で本文に書く**(#534 段③。2026-08-28)。
 *
 * ⚠ 直す前は `- ADR;TYPE=HOME: ;;東京都…;渋谷区;東京都;150-0001;日本` と、
 *   **`.vcf` の生の綴りがそのまま**本文に出ていた。捨てない判断は正しかったが、
 *   user が開いて見るのは**内部の書式**であって、住所ではない
 *   (`pkc3-ux-reviewer` の型「画面に内部の名前がそのまま出ていたら欠陥」)。
 * ⚠ **綴りを知らない項目は元の名前のまま出す** ── 対応表に無いものを
 *   隠すと、そこだけ何の項目か分からなくなる(黙って失うのと同じ)。
 */
const OTHER_LABELS: Readonly<Record<string, string>> = {
  ADR: '住所',
  LABEL: '住所(表記)',
  URL: 'ウェブ',
  TITLE: '肩書き',
  ROLE: '役割',
  NICKNAME: '呼び名',
  CATEGORIES: '分類',
  GEO: '位置',
  TZ: '時間帯',
  IMPP: 'メッセージ',
  RELATED: '関係',
  LANG: '言語',
};

/** `TYPE=…` → 画面に出す字。⚠ 知らない綴りは**そのまま**出す(隠さない)。 */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  HOME: '自宅',
  WORK: '勤務先',
  CELL: '携帯',
  FAX: 'FAX',
  PAGER: 'ポケベル',
  VOICE: '電話',
  INTERNET: 'メール',
  PREF: '主',
  POSTAL: '郵送',
  PARCEL: '荷物',
};

/** 項目名 + 種別を、画面に出す 1 つの字にする(`住所(自宅)`)。 */
function otherLabel(name: string, params: readonly string[]): string {
  const base = OTHER_LABELS[name.toUpperCase()] ?? name;
  const types = params
    .filter((x) => x.toUpperCase().startsWith('TYPE='))
    .flatMap((x) => x.slice('TYPE='.length).split(','))
    .map((t) => t.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((t) => TYPE_WORDS[t.toUpperCase()] ?? t);
  return types.length === 0 ? base : `${base}(${types.join(' / ')})`;
}

/**
 * 構造を持つ値(`;` で区切る)を、読める 1 行にする。
 * ⚠ **unescape の前に割る** ── 先に unescape すると `\;`(値の中の `;`)まで
 *   区切りとして割れてしまう(`ORG` が同じ作法で書かれている)。
 * ⚠ 空の欄は落とす ── vCard の住所は 7 欄あり、ふつう半分は空である。
 */
function readableParts(raw: string): string {
  return splitUnescaped(raw, ';')
    .map((x) => unescapeValue(x).trim())
    .filter(Boolean)
    .join(' ');
}

function nameFromN(value: string): string {
  const comps = splitUnescaped(value, ';').map((c) => unescapeValue(c).trim());
  return [comps[0] ?? '', comps[1] ?? ''].filter(Boolean).join(' ').trim();
}

/** 読みかけの 1 枚。⚠ 型を書き出しておく(`finishCard` と 2 か所で組み立てない)。 */
interface VcfDraft {
  fn: string;
  n: string;
  orgParts: string[];
  tels: string[];
  emails: string[];
  birthday: string;
  notes: string[];
  others: string[];
  /** 種別を落としたことを**このカードで既に言ったか**(200 枚で 200 行にしない)。 */
  typeSaid: boolean;
  /** 文字の壊れを**このカードで既に言ったか**(同じ理由で 1 枚 1 行)。 */
  qpSaid: boolean;
}

/**
 * 🔴 **中身が 1 つも無いカードか**(#534 ④)。
 *
 * ⚠ `BEGIN:VCARD` / `END:VCARD` だけの塊は実在する(書き出しの区切りの名残)。
 *   これをノートにすると、**題名「連絡先 N」・本文が空**のノートが増えるだけで、
 *   user は「何これ」となる ── 捨ててよい唯一の形である。
 * ⚠ **「名前が無い」だけでは捨てない** ── 電話が在れば連絡先として意味がある
 *   (そちらは番号名を振る道が既に在る)。
 */
function isEmptyCard(cur: VcfDraft): boolean {
  return (
    cur.fn === '' &&
    cur.n === '' &&
    cur.orgParts.length === 0 &&
    cur.birthday === '' &&
    cur.tels.length === 0 &&
    cur.emails.length === 0 &&
    cur.notes.length === 0 &&
    cur.others.length === 0
  );
}

/**
 * 読みかけを 1 枚にする。
 * ⚠ **1 か所だけ**にする ── 閉じが在るときと無いときで作り方が違うと、
 *   片方だけ field を足し忘れて**静かに欠ける**(CLAUDE.md §7)。
 */
function finishCard(cur: VcfDraft): VcfCard {
  return {
    name: cur.fn !== '' ? cur.fn : cur.n,
    orgParts: cur.orgParts,
    tels: cur.tels,
    emails: cur.emails,
    birthday: cur.birthday,
    notes: cur.notes,
    others: cur.others,
  };
}

/**
 * .vcf の中身を読む。⚠ **壊れた行は黙って捨てず warnings に積む**。
 */
export function parseVcf(text: string): VcfParseResult {
  const warnings: string[] = [];
  const cards: VcfCard[] = [];
  const lines = unfoldLines(text);

  let cur: VcfDraft | null = null;
  const cardNo = (): number => cards.length + 1;

  for (const line of lines) {
    const prop = parseProp(line);
    if (prop === null) {
      if (cur !== null && line.trim() !== '')
        warnings.push(`${cardNo()} 枚目: 読めない行を捨てました(${line.slice(0, 40)})`);
      continue;
    }
    if (prop.name === 'BEGIN' && prop.value.trim().toUpperCase() === 'VCARD') {
      /**
       * 🔴 **閉じが無くても、読めた分は捨てない**(2 巡目の着地前レビュー 2026-08-28)。
       *
       * ⚠ 直す前は `cur` を**丸ごと上書き**していたので、`END:VCARD` を書かない
       *   書き出し(実在する)を読むと、**名前も電話も在るカードが 1 枚ごと消えた**。
       *   しかも文言は「次が始まりました」だけで**捨てたと言っていない** ──
       *   末尾の同型(下の `END が無いまま終わりました(捨てました)`)とも非対称だった。
       * 🔑 この module の宣言は「**対応しない項目も捨てない**」である。
       *   閉じの書き忘れで**中身ごと**捨てるのは、その宣言と正面から反する。
       */
      if (cur !== null) {
        if (isEmptyCard(cur)) warnings.push(`${cardNo()} 枚目: 中身が無いので飛ばしました`);
        else {
          warnings.push(
            `${cardNo()} 枚目: END:VCARD が無いまま次が始まりました(読めた分は取り込みました)`,
          );
          cards.push(finishCard(cur));
        }
      }
      cur = { fn: '', n: '', orgParts: [], tels: [], emails: [], birthday: '', notes: [], others: [], typeSaid: false, qpSaid: false };
      continue;
    }
    if (prop.name === 'END' && prop.value.trim().toUpperCase() === 'VCARD') {
      if (cur !== null) {
        // 🔴 中身の無いカードはノートを作らない(#534 ④)── ただし黙らない
        if (isEmptyCard(cur)) warnings.push(`${cardNo()} 枚目: 中身が無いので飛ばしました`);
        else cards.push(finishCard(cur));
      }
      cur = null;
      continue;
    }
    if (cur === null) continue;

    const qp = prop.params.some((p) => p === 'ENCODING=QUOTED-PRINTABLE' || p === 'QUOTED-PRINTABLE');
    const qpOut = qp ? decodeQp(prop.value) : null;
    if (qpOut?.broken === true && !cur.qpSaid) {
      cur.qpSaid = true;
      warnings.push(
        `${cardNo()} 枚目: 文字が壊れている所がありました(元の .vcf の書き方が古いのかもしれません)`,
      );
    }
    const decoded = unescapeValue(qpOut?.text ?? prop.value).trim();
    switch (prop.name) {
      case 'VERSION':
      case 'PRODID':
      case 'REV':
        break; // 中身ではなく書いた道具の情報 ── ノートに写す価値が無い
      case 'FN':
        cur.fn = decoded;
        break;
      case 'N':
        cur.n = nameFromN(qpOut?.text ?? prop.value);
        break;
      case 'ORG':
        // 🔴 **繋がずに持つ**(#534 段②)── `;` は会社と部署の区切りなので、
        //    ここで空白に潰すと書き出しで部署が消える
        cur.orgParts = splitUnescaped(qpOut?.text ?? prop.value, ';')
          .map((x) => unescapeValue(x).trim())
          .filter(Boolean);
        break;
      case 'TEL':
      case 'EMAIL': {
        /**
         * 🔴 **種別(携帯 / 自宅 / FAX / 勤務先)は取り込めない ── 黙って落とさない**
         * (2 巡目の着地前レビュー 2026-08-28)。
         *
         * ⚠ この module の宣言は「**対応しない項目も捨てない**」なのに、
         *   `TYPE=` は値だけ拾って**警告 0 件で消えていた** ── スマホの 200 件を
         *   取り込んで書き出すと、**自宅 / 携帯 / FAX の区別が全部消える**
         *   (`buildVcf` は一律 `TYPE=voice` を書く)。user は失ったことに気づけない。
         * ⚠ **値に混ぜて残さない**(`090-…(携帯)`)── `buildVcf` がそれを
         *   そのまま `TEL:` に書き、**相手の端末に壊れた番号が保存される**。
         * ⚠ PKC 自身の書き出しを読み直したときは黙る ── `TYPE=VOICE` /
         *   `TYPE=INTERNET` はこちらが書いた綴りなので、言うと嘘の狼になる。
         */
        const types = prop.params.filter((p) => p.startsWith('TYPE='));
        if (!cur.typeSaid && types.some((p) => p !== 'TYPE=VOICE' && p !== 'TYPE=INTERNET')) {
          cur.typeSaid = true;
          warnings.push(
            `${cardNo()} 枚目: 電話・メールの種別(携帯 / 自宅 / FAX など)は取り込めません`,
          );
        }
        if (decoded === '') break;
        if (prop.name === 'TEL') cur.tels.push(decoded);
        else cur.emails.push(decoded);
        break;
      }
      case 'BDAY':
        cur.birthday = decoded;
        break;
      case 'NOTE':
        if (decoded !== '') cur.notes.push(decoded);
        break;
      default: {
        const label = otherLabel(prop.name, prop.params);
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
        // ⚠ ただし**読める字**で ── 生の `;;東京都…;渋谷区;…` を出さない(#534 段③)
        const shown = readableParts(qpOut?.text ?? prop.value);
        if (shown !== '') cur.others.push(`- ${label}: ${shown}`);
      }
    }
  }
  if (cur !== null) {
    // ⚠ 上と同じ ── 閉じが無いだけで中身を捨てない(非対称を作らない)
    if (isEmptyCard(cur)) warnings.push(`${cardNo()} 枚目: 中身が無いので飛ばしました`);
    else {
      warnings.push(
        `${cardNo()} 枚目: END:VCARD が無いまま終わりました(読めた分は取り込みました)`,
      );
      cards.push(finishCard(cur));
    }
  }
  return { cards, warnings };
}

/** 取込で作るノートの題名と本文。⚠ 本文の鍵は `CONTACT_KEYS`(読む側と同じ 1 つ)。 */
export function vcfNoteOf(card: VcfCard): { title: string; body: string } {
  const meta: Record<string, FrontmatterValue> = {};
  if (card.tels.length > 0)
    meta[CONTACT_KEYS.tel] = card.tels.length === 1 ? card.tels[0]! : [...card.tels];
  if (card.emails.length > 0)
    meta[CONTACT_KEYS.email] = card.emails.length === 1 ? card.emails[0]! : [...card.emails];
  if (card.orgParts.length > 0)
    meta[CONTACT_KEYS.org] =
      card.orgParts.length === 1 ? card.orgParts[0]! : [...card.orgParts];
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
    // 🔴 内訳を `;` で繋ぎ直す(#534 段②)── 会社と部署の区切りを相手へ渡す
    if (c.orgParts.length > 0)
      lines.push(`ORG:${c.orgParts.map(escapeValue).join(';')}`);
    // 🔑 取込が `birthday:` を書くので、**書き出しも書く**(往復を閉じる ──
    //    無いと「取り込んで書き出したら誕生日が消えた」になる)
    if (c.birthday !== '') lines.push(`BDAY:${escapeValue(c.birthday)}`);
    /**
     * ⚠ **ここに門は置かない**(#536 ③、2026-08-28)。
     *
     * 🔑 長すぎる宛先(1,000 字超)は **`contactOf` が card に入れる前に外して**いる
     *   (`contact-card.ts` の `CONTACT_LIMITS.wire`。実測もそこ)── なので
     *   `c.tels` / `c.emails` に**残っている値は全部そのまま書ける**。
     * 🔴 **同じ規則を 2 か所に書かない**(CLAUDE.md §7)── 1 稿目はここに
     *   `if (!c.overlong)` を置いて**その人の宛先を丸ごと書かない**形にしていたが、
     *   ⚠ 1 つの長い落書きの巻き添えで**本物の電話番号まで .vcf から消えた**。
     *   `overlong` は「外したことを**帯で言う**」ためだけの印であって、
     *   ここで読む物ではない。
     */
    for (const t of c.tels) lines.push(`TEL;TYPE=voice:${escapeValue(t)}`);
    for (const e of c.emails) lines.push(`EMAIL;TYPE=internet:${escapeValue(e)}`);
    lines.push('END:VCARD');
  }
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}
