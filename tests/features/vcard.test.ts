/**
 * 🔴 **vCard の取込と書き出し**(#278 段③)。
 *
 * ## 守る主張
 *
 * 1. 読みは**広い**(2.1 の QP / 3.0 のエスケープ / 折り返し / 複数枚 / N しか無い形)
 * 2. 🔴 写せない項目は**本文の行として残る**(黙って失わない)。PHOTO だけは
 *    落として**注意で言う**
 * 3. 🔴 取込が書く鍵は、連絡先タブが**読む鍵と同じ**(別の綴りではなく
 *    **実物の読み手 `contactOf`** で検算する ── 期待値を実装と同じ文法で書かない)
 * 4. 書き出しは 3.0 / CRLF / エスケープ。書き出した物を**自分の読み手**が読み戻せる
 */
import { describe, expect, it } from 'vitest';
import { frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { contactOf, type ContactCard } from '../../src/features/contact/contact-card';
import { buildVcf, isVcfFileName, parseVcf, vcfNoteOf } from '../../src/features/contact/vcard';

const CARD_30 = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:山田;太郎;;;',
  'FN:山田太郎',
  'ORG:例の会社;営業部',
  'TEL;TYPE=CELL:090-1234-5678',
  'TEL;TYPE=WORK:03-1111-2222',
  'EMAIL;TYPE=INTERNET:taro@example.com',
  'BDAY:1990-01-02',
  'NOTE:水曜が空き\\, とのこと\\n次回は現地',
  'END:VCARD',
].join('\r\n');

describe('parseVcf ── 読みは広く', () => {
  it('3.0 の 1 枚 ── FN / TEL×2 / EMAIL / ORG / BDAY / NOTE', () => {
    const { cards, warnings } = parseVcf(CARD_30);
    expect(warnings).toEqual([]);
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.name).toBe('山田太郎');
    expect(c.org).toBe('例の会社 営業部');
    expect(c.tels).toEqual(['090-1234-5678', '03-1111-2222']);
    expect(c.emails).toEqual(['taro@example.com']);
    expect(c.birthday).toBe('1990-01-02');
    // エスケープ(\, と \n)が解けている
    expect(c.notes).toEqual(['水曜が空き, とのこと\n次回は現地']);
  });

  it('FN が無ければ N から組む(姓 名の並び)', () => {
    const { cards } = parseVcf('BEGIN:VCARD\r\nN:山田;太郎;;;\r\nTEL:090\r\nEND:VCARD');
    expect(cards[0]!.name).toBe('山田 太郎');
  });

  it('折り返し(行頭の空白は前の行の続き)を解く', () => {
    const folded = 'BEGIN:VCARD\r\nFN:山田\r\n 太郎\r\nTEL:090-1234\r\n -5678\r\nEND:VCARD';
    const { cards } = parseVcf(folded);
    expect(cards[0]!.name).toBe('山田太郎');
    expect(cards[0]!.tels).toEqual(['090-1234-5678']);
  });

  it('2.1 の QUOTED-PRINTABLE(UTF-8)を解く', () => {
    // 「山田」= E5 B1 B1 E7 94 B0
    const qp = 'BEGIN:VCARD\r\nFN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:=E5=B1=B1=E7=94=B0\r\nTEL:090\r\nEND:VCARD';
    const { cards } = parseVcf(qp);
    expect(cards[0]!.name).toBe('山田');
  });

  it('複数枚は複数の連絡先になる', () => {
    const two = `${CARD_30}\r\nBEGIN:VCARD\r\nFN:別人\r\nEMAIL:b@example.com\r\nEND:VCARD`;
    const { cards } = parseVcf(two);
    expect(cards.map((c) => c.name)).toEqual(['山田太郎', '別人']);
  });

  it('🔴 写せない項目(ADR)は本文の行として残る ── 黙って失わない', () => {
    const withAdr =
      'BEGIN:VCARD\r\nFN:山田\r\nTEL:090\r\nADR;TYPE=HOME:;;東京都千代田区1-1;;;;\r\nEND:VCARD';
    const { cards } = parseVcf(withAdr);
    expect(cards[0]!.others.join('\n')).toContain('ADR;TYPE=HOME: ;;東京都千代田区1-1;;;;');
  });

  it('🔴 PHOTO は落として注意で言う(本文に base64 の山を作らない)', () => {
    const withPhoto = 'BEGIN:VCARD\r\nFN:山田\r\nTEL:090\r\nPHOTO;ENCODING=b:AAAA\r\nEND:VCARD';
    const { cards, warnings } = parseVcf(withPhoto);
    expect(cards[0]!.others.join('')).not.toContain('AAAA');
    expect(warnings.join(''), '落としたのに言っていない').toContain('写真');
  });

  /**
   * 🔴 **落とすのは「名前」ではなく「中身」**(着地前レビュー 2026-08-28)。
   *
   * ⚠ 1 稿目は `case 'PHOTO':` だけを落としていたので、同じ base64 を運ぶ
   *   `LOGO` / `SOUND` / `KEY` は `default` へ落ち、**40KB の 1 行**として
   *   本文に入っていた(警告も 0 件)。
   * ⚠ **対照群を同じ it に置く**(下の URI 写真)── 置かないと
   *   「全部落とすようになっただけ」と区別が付かない。
   */
  it('🔴 base64 を運ぶ項目は名前を問わず落とす(LOGO / SOUND / KEY)', () => {
    for (const name of ['LOGO', 'SOUND', 'KEY', 'X-MS-CARDPICTURE']) {
      const v = `BEGIN:VCARD\r\nFN:山田\r\nTEL:090\r\n${name};ENCODING=B:QUJD\r\nEND:VCARD`;
      const { cards, warnings } = parseVcf(v);
      expect(cards[0]!.others.join(''), `${name} が本文に残った`).not.toContain('QUJD');
      expect(warnings.join(''), `${name} を黙って落とした`).toContain(name);
    }
  });

  it('🔴 ENCODING を名乗らなくても、長すぎる中身は落とす', () => {
    const huge = 'A'.repeat(2001);
    const { cards, warnings } = parseVcf(
      `BEGIN:VCARD\r\nFN:山田\r\nTEL:090\r\nX-BIG:${huge}\r\nEND:VCARD`,
    );
    expect(cards[0]!.others.join('')).not.toContain('AAAA');
    expect(warnings.join('')).toContain('X-BIG');
  });

  it('🔴 対照群 ── URL の写真は残す(短いし意味がある。落とすのは符号化された中身だけ)', () => {
    const { cards, warnings } = parseVcf(
      'BEGIN:VCARD\r\nFN:山田\r\nTEL:090\r\nPHOTO;VALUE=URI:https://example.com/a.png\r\nEND:VCARD',
    );
    expect(cards[0]!.others.join(''), 'URL の写真まで落とした').toContain(
      'https://example.com/a.png',
    );
    expect(warnings, '落としていないのに注意を出した').toEqual([]);
  });

  it('END の無いカードは捨てて、注意で言う', () => {
    const broken = 'BEGIN:VCARD\r\nFN:途中\r\nTEL:090';
    const { cards, warnings } = parseVcf(broken);
    expect(cards).toEqual([]);
    expect(warnings.join('')).toContain('END:VCARD');
  });
});

describe('vcfNoteOf ── 取込が書く鍵は、読む側と同じ 1 つ', () => {
  it('🔴 作った本文を**実物の読み手(contactOf)**が読める', () => {
    const { cards } = parseVcf(CARD_30);
    const note = vcfNoteOf(cards[0]!);
    expect(note.title).toBe('山田太郎');
    // 🔑 期待値を「同じ綴りの別の書き方」にしない ── 連絡先タブが実際に使う
    //    読み手へ通し、同じ値が返ることを見る(§1「別の観測から作る」)
    const read = contactOf('l1', note.title, note.body);
    expect(read).not.toBeNull();
    expect(read!.tels).toEqual(['090-1234-5678', '03-1111-2222']);
    expect(read!.emails).toEqual(['taro@example.com']);
    expect(read!.org).toBe('例の会社 営業部');
    // NOTE は本文に残る
    expect(note.body).toContain('水曜が空き, とのこと');
  });

  it('🔴 誕生日は連絡先タブと同じ鍵で書く(往復が閉じる)', () => {
    const { cards } = parseVcf(CARD_30);
    const note = vcfNoteOf(cards[0]!);
    expect(contactOf('l1', note.title, note.body)!.birthday).toBe('1990-01-02');
  });

  /**
   * 🔴 **鍵が 1 つも無いなら囲みを書かない**(着地前レビュー 2026-08-28)。
   * ⚠ 空の `---\n---` は `frontmatterLineCount` が **2** と数えるので、
   *   情報ペインが「この文書の情報 (空)」を永久に出す(#343 が畳んだ形)。
   * 🔑 観測点は**実物の読み手**にする ── 字面(`---`)を数えると、
   *   本文に `---` を書いた別の形と区別が付かない。
   */
  it('🔴 鍵が 1 つも無ければ空の囲みを書かない(情報ペインに空の札を作らない)', () => {
    const { cards } = parseVcf('BEGIN:VCARD\r\nFN:A\r\nNOTE:めも\r\nEND:VCARD');
    const note = vcfNoteOf(cards[0]!);
    expect(frontmatterLineCount(note.body), '空の囲みを書いた').toBe(0);
    expect(note.body, 'メモまで落とした').toContain('めも');
  });

  it('⚠ 対照群 ── 本文の 1 行目が --- のときは空の囲みを残す(本文が飲まれない)', () => {
    const { cards } = parseVcf('BEGIN:VCARD\r\nFN:A\r\nNOTE:---\r\nEND:VCARD');
    const note = vcfNoteOf(cards[0]!);
    expect(frontmatterLineCount(note.body), '囲みを外して本文が飲まれた').toBe(2);
  });

  it('⚠ 鍵が在るときは今までどおり囲みを書く(上の直しで囲みごと消していない)', () => {
    const { cards } = parseVcf('BEGIN:VCARD\r\nFN:A\r\nTEL:090\r\nEND:VCARD');
    expect(frontmatterLineCount(vcfNoteOf(cards[0]!).body)).toBeGreaterThan(0);
  });

  it('1 本だけの電話はスカラで書く ── ⚠ 数字だけの番号は引用が付く(先頭の 0 を数として失わない)', () => {
    const { cards } = parseVcf('BEGIN:VCARD\r\nFN:A\r\nTEL:090\r\nEND:VCARD');
    const note = vcfNoteOf(cards[0]!);
    expect(note.body).toContain('tel: "090"');
    expect(contactOf('l1', 'A', note.body)!.tels).toEqual(['090']);
  });
});

describe('buildVcf ── 書き出し', () => {
  const card = (over: Partial<ContactCard> = {}): ContactCard => ({
    lid: 'l1',
    name: '山田太郎',
    org: '例の会社',
    tels: ['090-1234-5678'],
    emails: ['taro@example.com'],
    birthday: '',
    ...over,
  });

  it('3.0 / CRLF / FN と N が入る', () => {
    const out = buildVcf([card()]);
    expect(out).toContain('BEGIN:VCARD\r\nVERSION:3.0\r\n');
    expect(out).toContain('FN:山田太郎\r\n');
    expect(out).toContain('N:山田太郎;;;;\r\n');
    expect(out).toContain('TEL;TYPE=voice:090-1234-5678\r\n');
    expect(out).toContain('EMAIL;TYPE=internet:taro@example.com\r\n');
    expect(out.endsWith('END:VCARD\r\n')).toBe(true);
  });

  it('🔴 エスケープ ── 名前や所属の , ; \\ が壊れない(往復で検める)', () => {
    const tricky = card({ name: 'A, B; C\\D', org: '会;社' });
    const back = parseVcf(buildVcf([tricky]));
    expect(back.cards[0]!.name).toBe('A, B; C\\D');
    // ⚠ ORG は ; が部品の区切りなので、エスケープした ; は 1 語に戻る
    expect(back.cards[0]!.org).toBe('会;社');
  });

  it('往復 ── 書き出した物を自分の読み手が読み戻せる(複数枚)', () => {
    const cards = [card(), card({ lid: 'l2', name: '別人', org: '', tels: [], emails: ['b@x.jp'] })];
    const back = parseVcf(buildVcf(cards));
    expect(back.warnings).toEqual([]);
    expect(back.cards.map((c) => c.name)).toEqual(['山田太郎', '別人']);
    expect(back.cards[1]!.emails).toEqual(['b@x.jp']);
  });

  /**
   * 🔴 **取込が書いた鍵は、書き出しも書く**(着地前レビュー 2026-08-28)。
   * ⚠ `ContactCard` に `birthday` が無かったので、取り込んで書き出すと
   *   **誕生日だけが消えていた**(往復が閉じていない)。
   */
  it('🔴 誕生日の往復 ── .vcf → ノート → .vcf で BDAY が残る', () => {
    const { cards } = parseVcf(CARD_30);
    const note = vcfNoteOf(cards[0]!);
    const read = contactOf('l1', note.title, note.body)!;
    const out = buildVcf([read]);
    expect(out, '往復で誕生日が消えた').toContain('BDAY:1990-01-02\r\n');
    expect(parseVcf(out).cards[0]!.birthday).toBe('1990-01-02');
  });

  it('⚠ 誕生日が無ければ BDAY の行を書かない(空の行を作らない)', () => {
    expect(buildVcf([card()])).not.toContain('BDAY');
  });

  it('空なら空文字(空の VCARD を書かない)', () => {
    expect(buildVcf([])).toBe('');
  });
});

describe('isVcfFileName', () => {
  it('拡張子で決める(中身では決めない ── md の取込と同じ規則)', () => {
    expect(isVcfFileName('連絡先.vcf')).toBe(true);
    expect(isVcfFileName('a.VCF')).toBe(true);
    expect(isVcfFileName('a.vcard')).toBe(true);
    expect(isVcfFileName('a.vcf.txt')).toBe(false);
    expect(isVcfFileName('note.md')).toBe(false);
  });
});
