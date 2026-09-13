/**
 * 🔴 **グループ用のノート**(#857 段②)── 意味論の側。
 *
 * 🔴 守る主張:
 * 1. 目印の**読み方はタイルと同じ 1 か所**(絵文字はそのまま / 図案の名前は図案)
 * 2. 書き戻しは**原文 splice**(説明文も他の key も無傷)。空にしたら **key ごと消す**
 * 3. 🔴 **同じ名前が 2 つあったら先勝ち**(決め方が機械で読める)
 * 4. ⚠ **`__proto__` という名前の群で入れ物が壊れない**
 */
import { describe, expect, it } from 'vitest';
import {
  APP_GROUP_ICON_KEY,
  appGroupIconOf,
  appGroupIconsOf,
  appGroupSeed,
  readAppGroupIcon,
  writeAppGroupIcon,
} from '../../src/features/launcher/app-group-spec';
import { parseIconValue } from '../../src/features/icon/icon-value';
import { tileFrom } from '../../src/features/launcher/tiles';

const body = (icon: string): string => `---\n${APP_GROUP_ICON_KEY}: ${icon}\n---\n説明\n`;

describe('目印の読み方(タイルと同じ 1 か所)', () => {
  it('🔴 図案の名前は図案として読む(字にしない)', () => {
    expect(parseIconValue('calendar')).toEqual({ symbol: 'calendar' });
    // ⚠ 直す前は `ca` と出ていた(#770 段②)── 字のほうを立てない
    expect(readAppGroupIcon(body('calendar'))).toEqual({ symbol: 'calendar' });
  });

  it('🔴 絵文字はそのまま(1 ドットも変えない)', () => {
    expect(readAppGroupIcon(body('\u{1F9EE}'))).toEqual({ icon: '\u{1F9EE}' });
  });

  it('⚠ 長い字は 2 字で切る ── ただしサロゲートペアを割らない', () => {
    expect(parseIconValue('abcdef')).toEqual({ icon: 'ab' });
    // 🔑 `[...]` で切らないと絵文字が壊れる(半分だけ残る)
    expect(parseIconValue('\u{1F9EE}\u{1F4C5}\u{1F5C2}')).toEqual({
      icon: '\u{1F9EE}\u{1F4C5}',
    });
  });

  it('目印が無いノートは空', () => {
    expect(readAppGroupIcon('---\ntitle: x\n---\n本文\n')).toEqual({});
    // ⚠ 空文字も「無い」と同じ(`appgroup.icon: ` だけ書かれた作りたての本文)
    expect(readAppGroupIcon(body(''))).toEqual({});
  });
});

describe('目印を書き戻す(原文 splice)', () => {
  it('🔴 説明文も他の key も無傷のまま足す', () => {
    const src = '---\ntitle: 資料\n---\n説明の行\n';
    const out = writeAppGroupIcon(src, 'calendar');
    expect(out).toContain('title: 資料');
    expect(out).toContain('説明の行');
    expect(readAppGroupIcon(out)).toEqual({ symbol: 'calendar' });
  });

  it('🔴 外すと key ごと消える(「在るのに出ない」を作らない)', () => {
    const out = writeAppGroupIcon(body('calendar'), null);
    expect(out, '空の key が残っている').not.toContain(APP_GROUP_ICON_KEY);
    expect(out, '説明まで消えた').toContain('説明');
  });

  it('⚠ 空文字も「外す」と同じ', () => {
    expect(writeAppGroupIcon(body('calendar'), '  ')).not.toContain(APP_GROUP_ICON_KEY);
  });

  it('🔴 作りたての本文は、書いたものが読み戻せる(囲みを忘れていない)', () => {
    // ⚠ `---` を書き忘れると**ただの本文の 1 行**になり、目印を書いても読めない
    const seeded = writeAppGroupIcon(appGroupSeed('資料'), 'calendar');
    expect(readAppGroupIcon(seeded)).toEqual({ symbol: 'calendar' });
    expect(seeded, '何の入れ物か書いていない').toContain('資料');
  });
});

describe('名前 → 目印の対応', () => {
  it('🔴 同じ名前が 2 つあったら先勝ち(決め方が機械で読める)', () => {
    const icons = appGroupIconsOf([
      { title: '資料', body: body('calendar') },
      { title: '資料', body: body('\u{1F9EE}') },
    ]);
    expect(appGroupIconOf(icons, '資料'), '後の 1 件に上書きされている').toEqual({
      symbol: 'calendar',
    });
  });

  it('⚠ 目印を持たないノートは入れない(空の対応を作らない)', () => {
    const icons = appGroupIconsOf([{ title: '資料', body: '---\ntitle: 資料\n---\n' }]);
    expect(appGroupIconOf(icons, '資料')).toBeUndefined();
  });

  it('⚠ 名前の無いノートは入れない(名前の無い群は畳めもしない)', () => {
    expect(appGroupIconOf(appGroupIconsOf([{ title: '  ', body: body('calendar') }]), '')).toBeUndefined();
  });

  it('題名の前後の空白は落とす(見出しの字と突き合わせるため)', () => {
    const icons = appGroupIconsOf([{ title: ' 資料 ', body: body('calendar') }]);
    expect(appGroupIconOf(icons, '資料')).toEqual({ symbol: 'calendar' });
  });

  /**
   * 🔴 **`__proto__` という名前の群で入れ物が壊れない。**
   * ⚠ 素の代入で作ると、この名前だけ**入れ物の親が差し替わる**(値は入らない)。
   * 🔑 `Object.fromEntries` は own property を定義するので壊れない。
   */
  it('🔴 `__proto__` という名前の群でも壊れない', () => {
    const icons = appGroupIconsOf([{ title: '__proto__', body: body('calendar') }]);
    expect(appGroupIconOf(icons, '__proto__'), '入れ物が壊れている').toEqual({
      symbol: 'calendar',
    });
    // ⚠ 対照群 ── 別の名前を引いても、親から拾ってこない
    expect(appGroupIconOf(icons, '資料')).toBeUndefined();
  });
});

/**
 * 🔴 **見出しの字と、ノートの題名が食い違わない**(#857 段② の直し、2026-09-13)。
 *
 * ⚠ frontmatter の読み手は**裸の値だけ**を trim する ── `app_group: " 資料 "` のように
 *   **引用符つき**だと空白が残る。⚠ そのままだと**見出しは「 資料 」・ノートの題名は
 *   「資料」**になり、目印を選んでも引けない(押しても何も出ない = 無言の dead click)。
 */
describe('群の名前は、読む側でも書く側でも前後の空白を落とす', () => {
  it('🔴 引用符つきで空白が残っていても、目印が引ける', () => {
    const t = tileFrom({
      lid: 'a1',
      title: '地図',
      body:
        '---\nattachment.launcher_url: https://a.test/\nattachment.app_group: " 資料 "\n---\n',
    });
    expect(t, '前提が崩れている(タイルとして読めていない)').not.toBeNull();
    expect(t!.group, '群の名前に空白が残っている').toBe('資料');

    const icons = appGroupIconsOf([
      { title: '資料', body: `---\n${APP_GROUP_ICON_KEY}: calendar\n---\n` },
    ]);
    expect(
      appGroupIconOf(icons, t!.group),
      '目印が引けない(見出しの字とノートの題名が食い違っている)',
    ).toEqual({ symbol: 'calendar' });
  });

  it('⚠ 空白だけの名前は「名前なし」と同じ(畳めない群へ落ちる)', () => {
    const t = tileFrom({
      lid: 'a2',
      title: '電卓',
      body: '---\nattachment.launcher_url: https://b.test/\nattachment.app_group: "   "\n---\n',
    });
    expect(t!.group, '空白だけの名前が群として残っている').toBe('');
  });
});
