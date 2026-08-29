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
  NOTICES,
  NOTICE_SEEN_MAX,
  NOTICE_SHOW_MAX,
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

  /**
   * 壊れた保存でも落ちない(全部未読に戻るだけ)。
   *
   * ⚠ 1 巡目は**構文的に壊れた JSON** しか渡しておらず、`readSeen` の**型検査**を
   * 外す変異が素通りした(変異試験で判明)── 「壊れている」には
   * **構文が壊れている**と**形が違う**の 2 通りある。両方を渡す。
   */
  it.each([
    ['構文が壊れている', '{壊れ'],
    ['配列ではない(オブジェクト)', '{"a":1}'],
    ['配列ではない(数値)', '42'],
    ['null', 'null'],
  ])('壊れた保存でも落ちない: %s', (_label, raw) => {
    expect(new NoticeStore(fakeStorage({ 'pkc3.notices.seen': raw })).seenIds()).toEqual([]);
  });

  /** ⚠ 中身に別の型が混ざっていたら、**文字列だけ**拾う(全部捨てない)。 */
  it('⚠ 配列の中に別の型が混ざっていても、文字列だけ拾う', () => {
    const s = new NoticeStore(fakeStorage({ 'pkc3.notices.seen': '[1,"2026-01-01-a",null]' }));
    expect(s.seenIds()).toEqual(['2026-01-01-a']);
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
    const fresh = Array.from(
      { length: NOTICE_SEEN_MAX },
      (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}-x`,
    );
    s.markSeen(fresh);
    s.markSeen(['2020-01-01-ancient']);
    expect(s.seenIds(), '上限を超えて溜めている').toHaveLength(NOTICE_SEEN_MAX);
    expect(s.seenIds(), '古い id が新しい id を押し出した').not.toContain('2020-01-01-ancient');
    expect(s.seenIds()).toContain(fresh[0]);
  });

  /**
   * 🔴 **読んだお知らせが、次の起動でよみがえらない**(2026-08-29 の着地前レビュー)。
   *
   * ## 何が起きかけたか
   *
   * 既読の切り詰めは元々 **id の降順**だけで、コメントは「= 新しい順」と書いていた。
   * ⚠ しかしそれは**日付が違う id にしか当たらない** ── 同じ日の id どうしは
   * **slug の綴り順**で並ぶ。一方 `recentNotices` は #585 で**日付だけ・安定**へ
   * 変わっている。2026-08-29 の登記表は 10 件とも同じ日付なので、2 つの順序は
   * 完全に食い違っていた。
   *
   * ⚠ 席に余裕があるうちは表に出ない ── `NOTICE_KEEP_MAX`(20)を既読にも使い回して
   * いたので **10 席の余裕**が吸収していた。登記表を 10 へ下げた瞬間に余裕が 0 になり、
   * **落ちた id が生きている id を押し出す**。押し出された 1 件は未読へ戻り、
   * user が閉じても `same` 判定で書込が起きないので **毎起動出続ける**
   * (localStorage を消すまで止まらない)。
   *
   * ## 🔑 だから見るのは「席の数」ではなく「押し出されないこと」
   *
   * ⚠ 🔴 **「定数を書かない」ではなく「定数を動かしても主張が崩れない形で使う」**
   * (2 巡目レビューの指摘 ── 1 稿目の docstring は「定数を 1 つも書かない」と
   * 書きながら、下で `NOTICE_SEEN_MAX` を 3 か所使っていた。**罠の説明文が
   * そのまま自分に当たっていた**)。
   * 🔑 溢れ条件は `落ちた分(= SEEN_MAX) + 生き(= 10) > SEEN_MAX` ⟺ `生き > 0` なので、
   * **席数をどう動かしても成り立ちます**。実測:席 11 / 席 500 のどちらでも、
   * 直す前の実装に戻すと **KILLED**。
   */
  it('🔴 登記表から落ちた id が既読に在っても、いま出る分を押し出さない', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    const live = NOTICES.map((n) => n.id);
    // ⚠ 🔴 **「同じ日の id が 2 件以上」を前提にしない**(2 巡目レビュー)── 落ちた id は
    //   下で `${top}-zz{i}` = **top と同じ日付を自前で作る**ので、登記表の日付が全部
    //   ばらけても再現します。前提にすると、日付がばらけた日に
    //   **壊れていないのに「台が再現できない」で落ちます**(誤警報)。
    // 🔑 落ちた id を、**綴り順で最大の生き id より上**に作る ── 押し出す側になる。
    // ⚠ **席が必ず足りなくなる数**にする ── 生き 10 + 落ち 10 = 20 = 席数だと
    //   切り詰めが 1 度も起きず、**古い実装でも緑**になる(空振り)。
    const top = [...live].sort().at(-1) ?? '';
    const dropped = Array.from({ length: NOTICE_SEEN_MAX }, (_, i) => `${top}-zz${i}`);
    // ⚠ 空振り防止 ── 押し出す側が本当に上に来ているか
    expect(
      dropped.every((d) => d > top),
      '落ちた id が綴り順で上に来ていない',
    ).toBe(true);

    s.markSeen(dropped); // 昔読んだ(いまは登記表に無い)
    s.markSeen(live); // 今日の分を全部読んだ

    // ⚠ 空振り防止 ── 切り詰めが実際に起きたか(起きていないなら何も守っていない)
    expect(s.seenIds(), '席が足りていて切り詰めが起きていない(台の空振り)').toHaveLength(
      NOTICE_SEEN_MAX,
    );
    expect(dropped.length + live.length, '席より多く入れていない').toBeGreaterThan(
      NOTICE_SEEN_MAX,
    );

    const seen = new Set(s.seenIds());
    expect(
      live.filter((id) => !seen.has(id)),
      '読んだのに既読から落ちた ── 次の起動でまた出る',
    ).toEqual([]);
  });

  /**
   * 🔴 **守るのは「画面に出ている登記表」であって、module が持つ `NOTICES` ではない**
   * (2026-08-29 の 2 巡目レビュー ⚠ A)。
   *
   * ⚠ 出す側(`announce.ts`)は **`main.ts` から渡された配列**を使うのに、
   *   既読の席を守る側が module 直輸入の `NOTICES` を見ていると、
   *   **2 つの登記表が食い違いうる**(CLAUDE.md §7「同じ値が 2 か所にある」)。
   * ⚠ そして `main.ts` は**原文しか読まれない file**なので、
   *   配線が変わっても**鳴る計器が 1 つも無い**(実際この変異は SURVIVED した)。
   *
   * 🔑 だから `markSeen` は登記表を**引数で**受ける ── ここはその配線を見る。
   */
  it('🔴 渡された登記表の分を守る(module の NOTICES ではなく)', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    // ⚠ `NOTICES` に**入っていない** id で作る ── 既定の挙動なら真っ先に捨てられる側
    const own: Notice[] = Array.from({ length: 4 }, (_, i) => ({
      id: `2026-09-0${i + 1}-own`,
      title: `渡した分 ${i + 1}`,
      items: ['これは渡した登記表の分です。'],
    }));
    // 🔑 席を溢れさせる ── 溢れなければ何を守っても結果が同じ(空振り)
    const top = [...own.map((n) => n.id), ...NOTICES.map((n) => n.id)].sort().at(-1) ?? '';
    const dropped = Array.from({ length: NOTICE_SEEN_MAX }, (_, i) => `${top}-zz${i}`);

    s.markSeen(dropped, own);
    s.markSeen(
      own.map((n) => n.id),
      own,
    );

    expect(s.seenIds(), '切り詰めが起きていない(台の空振り)').toHaveLength(NOTICE_SEEN_MAX);
    const seen = new Set(s.seenIds());
    expect(
      own.filter((n) => !seen.has(n.id)).map((n) => n.id),
      '渡した登記表の分が既読から落ちた ── 次の起動でまた出る',
    ).toEqual([]);
  });

  /**
   * 🔴 **守るのは「出る 10 件」であって「渡された全部」ではない**
   * (2026-08-29 の変異試験 M6 が SURVIVED で教えた)。
   *
   * ⚠ いま `NOTICES` は**ちょうど 10 件**なので `recentNotices(NOTICES)` と
   *   `NOTICES` が**同じ物**になる ── だから「`recentNotices` を通す」という
   *   構造的な保証を、既存の台では **1 度も見ていなかった**
   *   (CLAUDE.md「挙動を変えたのに test が前も後も通るなら、守っていない」)。
   * 🔑 だから**上限より多い登記表**を渡して、**出ない分は守られないこと**まで見る。
   */
  it('🔴 上限より多い登記表を渡しても、守るのは「出る分」だけ', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    // 上限 +3 件。日付が新しいほうが「出る」側
    const many: Notice[] = Array.from({ length: NOTICE_SHOW_MAX + 3 }, (_, i) => ({
      id: `2026-09-${String(NOTICE_SHOW_MAX + 3 - i).padStart(2, '0')}-many`,
      title: `渡した分 ${i}`,
      items: ['上限より多い登記表です。'],
    }));
    const shown = new Set(recentNotices(many).map((n) => n.id));
    // ⚠ 空振り防止 ── 出る分と出ない分が両方あること
    expect(shown.size, '出る分が上限と違う').toBe(NOTICE_SHOW_MAX);
    expect(many.length - shown.size, '出ない分が 0 件(この台では M6 を見られない)').toBe(3);

    // 席を溢れさせる(綴り順で上に来る「落ちた id」)
    const top = [...many.map((n) => n.id)].sort().at(-1) ?? '';
    s.markSeen(
      Array.from({ length: NOTICE_SEEN_MAX }, (_, i) => `${top}-zz${i}`),
      many,
    );
    s.markSeen(
      many.map((n) => n.id),
      many,
    );

    const seen = new Set(s.seenIds());
    expect(
      [...shown].filter((id) => !seen.has(id)),
      '出ている分が既読から落ちた',
    ).toEqual([]);
    expect(
      many.filter((n) => !shown.has(n.id)).every((n) => !seen.has(n.id)),
      '出ていない分まで守っている(= recentNotices を通していない)',
    ).toBe(true);
  });

  /**
   * 🔴 **落ちた id のうち、新しいほうを残す**(変異試験 M3 が SURVIVED で教えた)。
   * ⚠ 既読の席は `/` と `/dev/` で**同じ鍵を共有する**ので、どちらの登記表にも
   *   無い id の取捨は**別のビルドから見ると画面に出ます**。
   */
  it('🔴 席が足りないとき、落ちた id は新しいほうが残る', () => {
    const st = fakeStorage();
    const s = new NoticeStore(st);
    const live = NOTICES.map((n) => n.id);
    // 出ない id を席の 2 倍作る(日付は 01 が最古、値が大きいほど新しい)
    const old = Array.from({ length: NOTICE_SEEN_MAX }, (_, i) => `2020-01-${String(i + 1).padStart(2, '0')}-x`);
    const fresh = Array.from({ length: NOTICE_SEEN_MAX }, (_, i) => `2030-01-${String(i + 1).padStart(2, '0')}-x`);
    s.markSeen([...old, ...fresh], NOTICES);
    s.markSeen(live, NOTICES);

    const seen = s.seenIds();
    // ⚠ 空振り防止 ── 切り詰めが起きていること
    expect(seen, '切り詰めが起きていない').toHaveLength(NOTICE_SEEN_MAX);
    const kept = seen.filter((id) => !live.includes(id));
    expect(kept.length, '落ちた id が 1 件も残っていない(この台では M3 を見られない)').toBeGreaterThan(0);
    expect(
      kept.every((id) => fresh.includes(id)),
      '古いほうの id が新しいほうを押しのけて残っている',
    ).toBe(true);
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
