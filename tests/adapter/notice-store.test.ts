/** @vitest-environment happy-dom */
/**
 * 🔴 **お知らせの既読**(P11 段⑤。裁定 Q6 = localStorage の集合)。
 *
 * ## PKC2 の失敗を繰り返さない
 *
 * PKC2 は「**最後に閉じた id との厳密等価**」で判定していた。単一 HTML 製品では
 * user が旧ビルドを手元に残すので、旧へ戻ると古いお知らせが再表示され、閉じると
 * 既読が**古い id へ巻き戻る**。新へ戻るとまた出る ── 往復するたび書き換わる。
 * **集合なら巻き戻らない**。この test はその往復を実際に演じる。
 */
import { describe, expect, it } from 'vitest';
import { NoticeStore, type NoticeStorage } from '../../src/adapter/platform/notice-store';
import {
  unreadNotices,
  recentNotices,
  noticeDate,
  NOTICE_KEEP_MAX,
  type Notice,
} from '../../src/features/notice/notice-log';

/** ⚠ **書込回数まで観測できる**偽物(「変わらないなら書かない」を見るため)。 */
function fakeStorage(seed: Record<string, string> = {}): NoticeStorage & {
  writes: number;
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    writes: 0,
    get(k) {
      return data[k] ?? null;
    },
    set(k, v) {
      this.writes += 1;
      data[k] = v;
    },
    remove(k) {
      delete data[k];
    },
  };
}

const n = (id: string): Notice => ({ id, title: `t-${id}`, items: ['本文'] });

describe('既読の集合', () => {
  it('見たものが残り、次からは未読に出ない', () => {
    const s = new NoticeStore(fakeStorage());
    const all = [n('2026-01-01-a'), n('2026-02-01-b')];
    expect(unreadNotices(all, s.seenIds())).toHaveLength(2);
    s.markSeen(all.map((x) => x.id));
    expect(unreadNotices(all, s.seenIds())).toHaveLength(0);
  });

  /**
   * 🔴 **旧ビルドへ往復しても既読が巻き戻らない**(PKC2 の F5)。
   * ⚠ 「最後に閉じた 1 件」で持っていると、ここで古い id へ戻る。
   */
  it('🔴 旧ビルドへ戻って閉じても、新しい既読が消えない', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    s.markSeen(['2026-01-01-a', '2026-08-01-new']);
    // 旧ビルドは新しい id を知らない ── 古い分だけを「閉じた」と申告してくる
    const old = new NoticeStore(st);
    old.markSeen(['2026-01-01-a']);
    // 新ビルドへ戻る
    const back = new NoticeStore(st);
    expect(
      back.seenIds(),
      '新しい既読が巻き戻った(最後の 1 件で持っている)',
    ).toContain('2026-08-01-new');
  });

  it('壊れた保存でも落ちない(全部未読に戻るだけ)', () => {
    const s = new NoticeStore(fakeStorage({ 'pkc3.notices.seen': '{壊れ' }));
    expect(s.seenIds()).toEqual([]);
  });

  /** ⚠ **無用な書込をしない** ── 同じものを 2 度見ても 1 度しか書かない。 */
  it('⚠ 内容が変わらないなら書かない', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    s.markSeen(['2026-01-01-a']);
    expect(st.writes).toBe(1);
    s.markSeen(['2026-01-01-a']);
    expect(st.writes, '変わっていないのに書いた').toBe(1);
  });

  /**
   * 🔴 **上限を超えたら「古い方」を落とす** ── 投入順ではなく **id の降順**。
   * ⚠ 投入順で切ると、古い id を後から申告しただけで新しい既読が押し出される。
   */
  it('🔴 上限を超えたら古い id から落ちる(投入順ではない)', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    // ⚠ **新しいものを先に**入れる ── 投入順で切る実装なら、ここで新しい方が残らない
    const fresh = Array.from({ length: NOTICE_KEEP_MAX }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}-x`);
    s.markSeen(fresh);
    s.markSeen(['2020-01-01-ancient']);
    expect(s.seenIds(), '上限を超えて溜めている').toHaveLength(NOTICE_KEEP_MAX);
    expect(s.seenIds(), '古い id が新しい id を押し出した').not.toContain('2020-01-01-ancient');
    expect(s.seenIds()).toContain(fresh[0]);
  });

  /** ⚠ **戻せること**が要件(user が自分で復帰できる)。 */
  it('恒久オフにできて、戻せる', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    expect(s.enabled()).toBe(true);
    s.setEnabled(false);
    expect(new NoticeStore(st).enabled(), '保存されていない').toBe(false);
    s.setEnabled(true);
    expect(new NoticeStore(st).enabled(), '戻せない').toBe(true);
  });
});

describe('登記表の読み方', () => {
  it('🔴 新しい順に並べて、上限まで切る(切るのはここだけ)', () => {
    const all = Array.from({ length: 15 }, (_, i) => n(`2026-01-${String(i + 1).padStart(2, '0')}-x`));
    const shown = recentNotices(all);
    expect(shown).toHaveLength(10);
    expect(shown[0]?.id, '新しい順になっていない').toBe('2026-01-15-x');
  });

  it('日付は id から引く(field を二重に持たない)', () => {
    expect(noticeDate('2026-08-08-flags-and-help')).toBe('2026-08-08');
    expect(noticeDate('壊れた id')).toBe('');
  });
});
