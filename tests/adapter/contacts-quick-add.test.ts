/** @vitest-environment happy-dom */
/**
 * #278 段③: **連絡先の面から、その場で 1 件足す**(user 裁定 2026-09-04
 * 「予定表も連絡先も別窓」の後半 ── 面に「書く」口が 0 件だった)。
 *
 * > user の物語: 連絡先タブを眺めている。名刺をもらった人を足したい。
 * > いまは足す口が無い ── ノートを作る → 先頭に `---` / `tel:` … と**手で書く** → 戻る。
 *
 * 🔴 **正本は本文のまま**(user 指示 2026-08-23「面は映すだけにしない ── 双方向」)。
 *   書く形は取込と**同じ 1 本**(`vcfNoteOf`)。
 *
 * 観測点は **disk に着いた本文**(画面だけ変わって保存されない、を作らない)と、
 * **走査を集め直して一覧に並ぶこと**(作っただけでは面に出ない)。
 * ⚠ `tests/adapter/schedule-quick-add.test.ts` の写し ── 作法を揃える。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ContactsRenderer } from '../../src/adapter/ui/render/contacts';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { ContactScan } from '../../src/features/contact/contact-card';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

/**
 * 走査の代わり ── disk の frontmatter から札を組む。
 * ⚠ **本物の意味論を真似る**(CLAUDE.md §3):電話かメールが 1 つ以上ある行だけ並ぶ。
 *   ここを「全部並ぶ」にすると、名前だけの回が並んで見えて、下の「並ばない」が嘘になる。
 */
function scanOf(disk: Record<string, string>, d: Dispatcher): ContactScan {
  const cards = Object.entries(disk).flatMap(([lid, body]) => {
    const tel = /^tel: (.+)$/m.exec(body)?.[1];
    const email = /^email: (.+)$/m.exec(body)?.[1];
    const org = /^org: (.+)$/m.exec(body)?.[1];
    if (tel === undefined && email === undefined) return [];
    return [
      {
        lid,
        name: d.getState().entryMetas.get(lid)?.title ?? '',
        org: org ?? '',
        tels: tel === undefined ? [] : [tel],
        emails: email === undefined ? [] : [email],
        birthday: '',
        orgParts: org === undefined ? [] : [org],
        overlong: false,
      },
    ];
  });
  return { cards, totalNotes: cards.length, scannedNotes: cards.length, truncated: false };
}

function setup(metas: EntryMeta[] = [], bodies: Record<string, string> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  // 面は左の列に在るが、ここでは器を直に組む(`schedule-quick-add.test.ts` と同じ作法)
  const host = document.createElement('div');
  host.setAttribute('data-pkc-browse-pane', 'contacts');
  regions.browseHost.append(host);
  const view = new ContactsRenderer(host);
  d.onState((s) => view.render(s));
  const events: string[] = [];
  d.onEvent((e) => events.push(e.type));
  const disk: Record<string, string> = { ...bodies };
  const persisted: EntryUpsert[] = [];
  const effects = connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      /**
       * ⚠ **書込は一拍遅れて着く**(本物の worker と同じ)── 同期に着く stub だと
       *   「着く前に集め直す」実装でも一覧に並んで見え、`settle` を待つ 1 行を
       *   外す変異が生き延びる(CLAUDE.md §3「stub は本物の意味論を真似る」)。
       */
      await new Promise((r) => setTimeout(r, 5));
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
    contactScan: async () => scanOf(disk, d),
  });
  // ⚠ 配線は `main.ts` と同じ形(`settle` を渡す)── 渡さないと「書込が着いてから集め直す」
  //   経路がこの harness では 1 度も通らない(CLAUDE.md §2)
  bindActions(root, d, { settle: () => effects.settled() });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  // 集め終わった状態から始める(0 件)
  d.dispatch({ type: 'SET_CONTACT_SCAN', scan: scanOf(disk, d) });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, disk, persisted, events, host, q };
}

function type(
  s: { q: <T extends HTMLElement>(sel: string) => T | null },
  v: { name?: string; tel?: string; email?: string; org?: string },
): void {
  for (const f of ['name', 'tel', 'email', 'org'] as const) {
    s.q<HTMLInputElement>(`[data-pkc-field="contacts-quick-${f}"]`)!.value = v[f] ?? '';
  }
}

describe('#278 段③ 連絡先の面から足す', () => {
  it('🔴 名前を題名に、電話・メール・所属を先頭の囲みに、取込と同じ形で書く', async () => {
    const s = setup();
    type(s, { name: '山田太郎', tel: '090-1234-5678', email: 'taro@example.com', org: '例の会社' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick();
    expect(s.persisted, 'disk に届いていない').toHaveLength(1);
    const e = s.persisted[0]!;
    expect(e.title).toBe('山田太郎');
    // 🔑 取込(`vcfNoteOf`)と同じ形 ── 鍵の綴りは向こうの 1 本
    expect(e.body.startsWith('---\n'), '先頭の囲みが無い').toBe(true);
    expect(e.body).toContain('tel: 090-1234-5678');
    expect(e.body).toContain('email: taro@example.com');
    expect(e.body).toContain('org: 例の会社');
  });

  /**
   * 🔴 **作っただけでは並ばない** ── 面は走査の結果から出る。書込が**着いてから**
   *   集め直して、一覧に名前が出るところまで見る(観測点は一覧の行)。
   */
  it('🔴 足したら、集め直されて一覧に並ぶ', async () => {
    const s = setup();
    expect(s.host.querySelectorAll('[data-pkc-contact]'), '前提: 0 件で始まる').toHaveLength(0);
    type(s, { name: '鈴木花子', tel: '080-9876-5432' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick(40);
    expect(s.events, '集め直しが頼まれていない').toContain('REQUEST_CONTACT_SCAN');
    const rows = s.host.querySelectorAll('[data-pkc-contact]');
    expect(rows, '足したのに一覧に並ばない').toHaveLength(1);
    expect(rows[0]!.querySelector('[data-pkc-field="contact-name"]')?.textContent).toContain(
      '鈴木花子',
    );
  });

  it('🔴 名前が空なら理由が出て、書かない(打った字は残す)', async () => {
    const s = setup();
    type(s, { name: '   ', tel: '090-0000-0000' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick();
    expect(s.d.getState().error ?? '', '無言で終わった').toContain('名前を入力');
    expect(s.persisted, '断ったのに書いた').toHaveLength(0);
    expect(
      s.q<HTMLInputElement>('[data-pkc-field="contacts-quick-tel"]')!.value,
      '断ったのに欄を空にした',
    ).toBe('090-0000-0000');
  });

  /**
   * 🔴 **面を奪わない**(#300「補助が主の作業領域を奪わない」)── 中央は本文のまま、
   *   編集にも入らない。
   */
  it('🔴 中央の面を奪わず、編集にも入らない(眺めたまま足せる)', async () => {
    const s = setup();
    const before = s.d.getState().viewMode;
    type(s, { name: '佐藤', email: 'sato@example.com' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick();
    expect(s.d.getState().viewMode, '中央の面が切り替わった').toBe(before);
    expect(s.d.getState().phase, '編集に入った').toBe('ready');
  });

  it('🔑 通ったら 4 つの欄が空になり、焦点は名前へ戻る(続けて足せる)', async () => {
    const s = setup();
    type(s, { name: 'ひとり目', tel: '1', email: 'a@b.c', org: 'x' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick();
    for (const f of ['name', 'tel', 'email', 'org']) {
      expect(s.q<HTMLInputElement>(`[data-pkc-field="contacts-quick-${f}"]`)!.value, f).toBe('');
    }
    expect(document.activeElement, '焦点が名前の欄に戻っていない').toBe(
      s.q('[data-pkc-field="contacts-quick-name"]'),
    );
  });

  /**
   * ⚠ **名前だけなら囲みを書かない**(`vcfNoteOf` の既存規則 ── 空の `---\n---` は
   *   情報ペインの札が「(空)」を永久に出す)。⚠ そして**この面には並ばない**
   *   (並ぶ条件は「連絡できること」)── 黙らず、そう伝える。
   */
  it('⚠ 名前だけなら囲みを書かず、連絡先に並ばないことを伝える', async () => {
    const s = setup();
    type(s, { name: '名前だけ' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick(40);
    expect(s.persisted, 'ノートが作られていない').toHaveLength(1);
    expect(s.persisted[0]!.body, '空の囲みを書いた').toBe('');
    expect(s.d.getState().notice ?? '', '並ばないことを黙っている').toContain('連絡先に並びます');
    expect(s.host.querySelectorAll('[data-pkc-contact]'), '連絡できないのに並んだ').toHaveLength(0);
  });

  /**
   * 🔴 **電話・メールの妥当性は書く側で弾かない** ── 原値のまま書く。押せない宛先を
   *   字のまま出す規則は `contacts.ts` が持つ(2 か所で判定しない)。
   */
  it('🔴 電話の書き方は検めない ── 書いたまま入る', async () => {
    const s = setup();
    type(s, { name: '検めない', tel: 'ないしょ' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick();
    expect(s.persisted[0]!.body).toContain('tel: ないしょ');
  });

  it('🔴 編集中は声に出して断る(黙って捨てない)', async () => {
    const s = setup([meta('n1')], { n1: '本文\n' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    s.d.dispatch({ type: 'START_EDIT' });
    expect(s.d.getState().phase, '前提が崩れた(編集に入れていない)').toBe('editing');
    type(s, { name: '編集中', tel: '1' });
    s.q('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick();
    expect(s.d.getState().error ?? '').toContain('編集を終了してから');
    expect(s.persisted, '編集中に書いた').toHaveLength(0);
  });
});

/**
 * 🔴 **面が 2 つ在るとき、押した面の欄を読む**(#278 段③ ── 予定の `scheduleFaceOf` と同型)。
 * ⚠ 連絡先の面は左の列のタブと中央(別窓 / 退避)の 2 つ在りうる。`root.querySelector` で
 *   引くと**先に描かれた左の空欄**を読み、「名前を入力してください」と断る。
 * ⚠ document 順で左が先、を前提に置く(前提を assert する)。
 */
describe('#278 段③ 2 面あるとき、押した面の欄を読む', () => {
  it('🔴 中央の面で打った名前が、中央の「足す」で書かれる', async () => {
    const s = setup();
    const center = new CenterRouter(s.root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!);
    s.d.onState((st) => center.render(st));
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'contacts' });
    const pane = s.root.querySelector<HTMLElement>('[data-pkc-view-pane="contacts"]')!;
    const names = [...s.root.querySelectorAll('[data-pkc-field="contacts-quick-name"]')];
    expect(names, '前提が崩れた(欄が 2 つ描かれていない)').toHaveLength(2);
    expect(s.host.contains(names[0]!), '前提が崩れた(document 順で左が先ではない)').toBe(true);
    // 左は空のまま、中央にだけ打つ
    pane.querySelector<HTMLInputElement>('[data-pkc-field="contacts-quick-name"]')!.value = '中央の人';
    pane.querySelector<HTMLInputElement>('[data-pkc-field="contacts-quick-tel"]')!.value = '070-1';
    pane.querySelector<HTMLElement>('[data-pkc-action="contacts-quick-add"]')!.click();
    await tick();
    expect(s.d.getState().error ?? '', '左の空欄を読んで断った').toBe('');
    expect(s.persisted.map((e) => e.title), '中央で打った名前が書かれていない').toEqual(['中央の人']);
  });
});
