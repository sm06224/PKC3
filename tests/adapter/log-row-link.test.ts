/** @vitest-environment happy-dom */
/**
 * 🔴 **ログの 1 行(見出し)を指すリンク**(#1559)。
 *
 * ## 物語
 *
 * 「ログの特定の 1 行を、メールやチャットで人に教えたい」。PKC2 は行ごとの 🔗 で
 * `fragment=log/<行の ID>` のリンクを作り、開くとその行へ送っていた。PKC3 のログは Markdown で、
 * 行は `## <日時>` の見出し ── 行に ID は無く、行の識別は**見出しの id**(`entry:<lid>#h/<id>` と同じ綴り)。
 * だからリンクは `fragment=h/<見出しの id>` で、本文に貼る「参照」と**同じ綴り**を使う(新しい記法は作らない)。
 *
 * ## 守る主張
 *
 * ① 作ったリンクを読む側が読み、**ノートを選んだ後に**その見出しへ送る(往復。日本語・★ 付きの id)
 * ② 場所の指定は**使ったらアドレスから落とす**(`F5` のたびに同じ行へ戻さない)。ノートの住所は残す
 * ③ 読めない綴り(PKC2 の `log/<id>`)は**黙らず**理由を出す。ノートは開く
 * ④ 開けないリンク(別の PKC / 居ないノート)では送らず、理由はノート側の物だけ
 * ⑤ 送った先を**光らせる**。行が無い・ノートを選べなかったときは**理由を出す**(ノートは開いたまま)
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { jumpToLinkedSection, LINK_SECTION_MISSING_MESSAGE } from '../../src/adapter/ui/actions/binder';
import { PAINTED_ATTR } from '../../src/adapter/ui/render/detail';
import {
  FOREIGN_ENTRY_LINK_MESSAGE,
  MISSING_ENTRY_LINK_MESSAGE,
  UNREADABLE_PLACE_MESSAGE,
  PLACE_WITHOUT_NOTE_MESSAGE,
  windowDeepLinkTarget,
  connectViewDeepLink,
  sectionPermalink,
  type DeepLinkTarget,
} from '../../src/adapter/platform/deep-link';
import {
  dropViewFragmentFromHash,
  parseViewDeepLinkEntry,
  parseViewDeepLinkFragment,
  setHashEntry,
  dropViewFromHash,
} from '../../src/features/link/permalink';
import { isLogRowHeading } from '../../src/features/flavor/textlog-flavor';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const hashOf = (url: string): string => url.slice(url.indexOf('#'));

/** 読む側の試験台(実物の `connectViewDeepLink` を、本物と同じ意味論の的で動かす)。 */
function opener(hash: string, own: { cid: string | null; lids: string[] }, withJump = true) {
  const log: string[] = [];
  const target: DeepLinkTarget & { hash: string } = {
    hash,
    clearHash: () => {
      target.hash = dropViewFromHash(target.hash);
    },
    dropToken: () => {},
    dropFragment: () => {
      log.push('dropFragment');
      target.hash = dropViewFragmentFromHash(target.hash);
    },
    setEntry: (c, l) => {
      target.hash = setHashEntry(target.hash, c, l);
    },
    restoreHash: (h) => {
      target.hash = h;
    },
  };
  connectViewDeepLink({
    openView: () => log.push('open-view'),
    selectEntry: (c, l) => log.push(`select:${c}:${l}`),
    ownContainerId: () => own.cid,
    hasEntry: (l) => own.lids.includes(l),
    ...(withJump ? { sectionJump: (l: string, s: string) => log.push(`jump:${l}:${s}`) } : {}),
    fail: (m) => log.push(`fail:${m}`),
    onViewChange: () => () => {},
    onSelectedEntry: () => () => {},
    target,
  });
  return { log, target };
}

describe('作ったリンクを、読む側が読んで同じ行へ送る(往復)', () => {
  it('🔴 日本語・★ 付きの行の id でも、ノートを選んだ後に同じ id で送る', () => {
    // 🔑 id は描画が刻んだ物から引く(自前で計算しない)
    const html = renderMarkdown('## 2026-10-11 11:00:00 ★\n\n中身\n\n## 第 1 章\n');
    const ids = [...html.matchAll(/<h2[^>]* id="([^"]*)"/g)].map((m) => m[1]!);
    expect(ids, '前提が崩れている: 見出しの id が 2 つ引けていない').toHaveLength(2);
    for (const slug of ids) {
      const url = sectionPermalink('c1', 'n42', slug);
      expect(url, 'リンクが組めない').not.toBeNull();
      expect(url!.split('#')[0], 'クエリを運んでいる').not.toContain('?');
      expect(parseViewDeepLinkEntry(hashOf(url!))).toEqual({ containerId: 'c1', lid: 'n42' });
      const o = opener(hashOf(url!), { cid: 'c1', lids: ['n42'] });
      // 順番も見る: 選んでから送る(選ぶ前に送ると、送り先の本文が描かれていない)
      expect(o.log, `${slug}: 選んでから送っていない`).toEqual(['select:c1:n42', `jump:n42:${slug}`, 'dropFragment']);
    }
  });

  it('🔴 使ったら場所の指定をアドレスから落とす(ノートの住所は残す ── F5 で同じ行へ戻さない)', () => {
    const url = sectionPermalink('c1', 'n42', '2026-10-11-110000')!;
    const o = opener(hashOf(url), { cid: 'c1', lids: ['n42'] });
    expect(parseViewDeepLinkFragment(o.target.hash), '場所の指定が残っている').toBeNull();
    expect(parseViewDeepLinkEntry(o.target.hash), 'ノートの住所まで落とした').toEqual({ containerId: 'c1', lid: 'n42' });
  });

  it('🔴 いまのアドレスに `?pkc-flag=…` が付いていても、リンクは運ばない(送り主の切替を受け手に押しつけない)', () => {
    history.replaceState(null, '', '/app/index.html?pkc-flag=x#pkc?view=calendar');
    try {
      expect(location.search, '前提が崩れている: 台のアドレスに ? が無い').toBe('?pkc-flag=x');
      const url = sectionPermalink('c1', 'n42', 'x')!;
      expect(url.split('#')[0]).toMatch(/\/app\/index\.html$/);
      expect(url).not.toContain('pkc-flag');
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  it('組めないとき(入れ物が無い / 行の id が空)は null', () => {
    expect(sectionPermalink(null, 'n1', 'x')).toBeNull();
    expect(sectionPermalink('c1', 'n1', '')).toBeNull();
  });

  it('⚠ 対照群 ── 場所の指定が無いリンクは、送らない・落とさない', () => {
    const o = opener('#pkc?container=c1&entry=n42', { cid: 'c1', lids: ['n42'] });
    expect(o.log).toEqual(['select:c1:n42']);
  });
});

describe('読めない指定・開けないリンクで黙らない', () => {
  it('🔴 PKC2 の `log/<id>` のような読めない綴りは、ノートを開いたうえで理由を出し、指定を落とす', () => {
    const o = opener('#pkc?container=c1&entry=n42&fragment=log%2F01HABC', { cid: 'c1', lids: ['n42'] });
    expect(o.log).toEqual(['select:c1:n42', `fail:${UNREADABLE_PLACE_MESSAGE}`, 'dropFragment']);
  });

  // ⚠ 開けなかった回も場所の指定は落とす(#1087)── 残すと次に選んだ別のノートへ付いて回る
  it('🔴 別の PKC のリンクは送らず、ノートの理由だけを言う', () => {
    const url = sectionPermalink('other', 'n42', 'x')!;
    expect(opener(hashOf(url), { cid: 'c1', lids: ['n42'] }).log).toEqual([`fail:${FOREIGN_ENTRY_LINK_MESSAGE}`, 'dropFragment']);
  });

  it('🔴 居ないノートのリンクは送らず、ノートの理由だけを言う', () => {
    const url = sectionPermalink('c1', 'gone', 'x')!;
    expect(opener(hashOf(url), { cid: 'c1', lids: ['n42'] }).log).toEqual([`fail:${MISSING_ENTRY_LINK_MESSAGE}`, 'dropFragment']);
  });

  it('⚠ 送る配線が無い古い的でも、他は壊れない(選ぶし、指定は落とす)', () => {
    const url = sectionPermalink('c1', 'n42', 'x')!;
    expect(opener(hashOf(url), { cid: 'c1', lids: ['n42'] }, false).log).toEqual(['select:c1:n42', 'dropFragment']);
  });
});

describe('住所の追随が、貼られたリンクを潰さない(着地前レビュー 🔴)', () => {
  /** 状態の通知(保存の完了など)を、好きな時に撃てる試験台。 */
  function bench(hash: string) {
    let selectListener: ((c: string | null, l: string | null) => void) | null = null;
    let hashListener: (() => void) | null = null;
    const log: string[] = [];
    const target: DeepLinkTarget & { hash: string } = {
      hash,
      clearHash: () => {},
      dropToken: () => {},
      dropFragment: () => {
        target.hash = dropViewFragmentFromHash(target.hash);
      },
      setEntry: (c, l) => {
        log.push(`follow:${l}`);
        target.hash = setHashEntry(target.hash, c, l);
      },
      restoreHash: () => {},
    };
    connectViewDeepLink({
      openView: () => {},
      selectEntry: (c, l) => log.push(`select:${c}:${l}`),
      sectionJump: (l, sl) => log.push(`jump:${l}:${sl}`),
      fail: (m) => log.push(`fail:${m}`),
      onViewChange: () => () => {},
      onHashChange: (fn) => {
        hashListener = fn;
        return () => {};
      },
      onSelectedEntry: (fn) => {
        selectListener = fn;
        return () => {};
      },
      target,
    });
    return {
      log,
      target,
      notify: (l: string | null) => selectListener!('c1', l),
      /** アドレスにリンクを貼った(`hashchange` はまだ届かない)。 */
      paste: (h: string) => {
        target.hash = h;
      },
      hashchange: () => hashListener!(),
    };
  }

  it('🔴 リンクを貼った直後・`hashchange` が届く前に、古い選択の通知が来ても、リンクの entry を書き潰さない', () => {
    const b = bench('#pkc?container=c1&entry=old');
    b.notify('old');
    b.paste(hashOf(sectionPermalink('c1', 'new', 'x')!));
    // ⚠ 保存の完了などで、選択は変わらないまま通知が来る
    b.notify('old');
    expect(parseViewDeepLinkEntry(b.target.hash), '貼ったリンクの entry が古いノートに書き換わった').toEqual({
      containerId: 'c1',
      lid: 'new',
    });
    b.hashchange();
    expect(b.log.filter((l) => !l.startsWith('follow')).slice(1), 'リンクのノートを選んで送っていない').toEqual([
      'select:c1:new',
      'jump:new:x',
    ]);
    expect(b.log.filter((l) => l === 'follow:old'), '古い選択を書いた').toHaveLength(0);
  });

  it('🔴 まだ追随していない別の選択の通知でも、貼られたリンクの entry は潰さない', () => {
    const b = bench('#pkc?container=c1&entry=old');
    b.notify('old');
    b.paste(hashOf(sectionPermalink('c1', 'new', 'x')!));
    b.notify('other');
    expect(parseViewDeepLinkEntry(b.target.hash)?.lid).toBe('new');
  });

  it('⚠ 対照群 ── 実際に選択が変わったときは、これまでどおり追随する(リンクを開いた後も)', () => {
    const b = bench('#pkc?container=c1&entry=old');
    b.notify('old');
    b.notify('n2');
    expect(parseViewDeepLinkEntry(b.target.hash)?.lid).toBe('n2');
    // ⚠ 続けて動いても追随する(自分が書いた entry を「誰かが書き換えた」と読んで止まらない)
    b.notify('n2b');
    expect(parseViewDeepLinkEntry(b.target.hash)?.lid, '2 回目の移動で追随が止まった').toBe('n2b');
    b.paste(hashOf(sectionPermalink('c1', 'new', 'x')!));
    b.hashchange();
    b.notify('new');
    b.notify('n3');
    expect(parseViewDeepLinkEntry(b.target.hash)?.lid, 'リンクを開いた後に追随が止まった').toBe('n3');
  });
});

describe('ノートの指定が無い場所指定は黙って残さない(着地前レビュー 🟡)', () => {
  it('🔴 `fragment` だけのリンク / 面を開くリンクに付いた `fragment` は、理由を出して落とす', () => {
    for (const h of ['#pkc?fragment=h%2Fx', '#pkc?view=dual&fragment=h%2Fx']) {
      const o = opener(h, { cid: 'c1', lids: [] });
      expect(o.log.filter((l) => l.startsWith('fail') || l === 'dropFragment'), h).toEqual([
        `fail:${PLACE_WITHOUT_NOTE_MESSAGE}`,
        'dropFragment',
      ]);
      expect(parseViewDeepLinkFragment(o.target.hash), `${h}: 指定が残っている`).toBeNull();
    }
  });
  it('🔴 空の行指定(`fragment=h/`)は読めない綴りとして理由を出す', () => {
    const o = opener('#pkc?container=c1&entry=n42&fragment=h%2F', { cid: 'c1', lids: ['n42'] });
    expect(o.log).toEqual(['select:c1:n42', `fail:${UNREADABLE_PLACE_MESSAGE}`, 'dropFragment']);
  });
});

describe('本物の的の `dropFragment`(happy-dom の履歴で)', () => {
  it('🔴 `fragment` だけを落とし、ノートの住所と `?` 側は残す(`dropAsset` などの別の落とし方ではない)', () => {
    history.replaceState(null, '', '/app/index.html?pkc-flag=x#pkc?container=c1&entry=n1&fragment=h%2Fx&asset=k');
    try {
      windowDeepLinkTarget().dropFragment!();
      expect(location.hash).toBe('#pkc?container=c1&entry=n1&asset=k');
      expect(location.search).toBe('?pkc-flag=x');
    } finally {
      history.replaceState(null, '', '/');
    }
  });
});

describe('付箋の窓で、目次から見出しへ飛んだあと(#693)に、場所の指定を戻さない', () => {
  it('🔴 戻す先の住所に `fragment` を残さない(残すと見出しへ飛ぶたびに同じ行へ引き戻される)', () => {
    let hashListener: (() => void) | null = null;
    const restored: string[] = [];
    const target: DeepLinkTarget & { hash: string } = {
      hash: hashOf(sectionPermalink('c1', 'n42', 'x')!),
      clearHash: () => {},
      dropToken: () => {},
      dropFragment: () => {
        target.hash = dropViewFragmentFromHash(target.hash);
      },
      setEntry: () => {},
      restoreHash: (h) => {
        restored.push(h);
      },
    };
    connectViewDeepLink({
      openView: () => {},
      selectEntry: () => {},
      sectionJump: () => {},
      fail: () => {},
      onViewChange: () => () => {},
      onHashChange: (fn) => {
        hashListener = fn;
        return () => {};
      },
      onSelectedEntry: () => () => {},
      target,
    });
    // 目次のリンクを押した(断片が `#<見出しの id>` に入れ替わる)
    target.hash = '#midashi';
    hashListener!();
    expect(restored, '戻していない(前提が崩れている)').toHaveLength(1);
    expect(restored[0]).toBe('#pkc?container=c1&entry=n42');
  });
});

describe('main.ts の配線(どの test からも実行されない層なので原文で pin)', () => {
  it('🔴 connectViewDeepLink に sectionJump を渡し、binder の jumpToLinkedSection を呼んでいる', () => {
    const code = readFileSync('src/main.ts', 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    const at = code.indexOf('connectViewDeepLink({');
    expect(at, 'connectViewDeepLink の呼び出しが見つからない').toBeGreaterThan(0);
    expect(code.slice(at, at + 4000)).toContain(
      'sectionJump: (lid, slug) => void jumpToLinkedSection(app.dispatcher, root, lid, slug),',
    );
  });
});

describe('送った先を光らせる / 行が無いときは理由を出す(jumpToLinkedSection)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.textContent = '';
    root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
  });

  const meta = (lid: string): EntryMeta => ({
    lid,
    title: `t-${lid}`,
    archetype: 'textlog',
    createdAt: null,
    updatedAt: null,
    entryOrder: 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  });

  /** 本物と同じ属性で見出しを置く(`navigate-link.test.ts` の台と同じ作法)。 */
  function plant(lid: string, ids: readonly string[]): Record<string, HTMLElement> {
    const detail = document.createElement('div');
    detail.setAttribute('data-pkc-region', 'detail');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    host.setAttribute(PAINTED_ATTR, lid);
    const out: Record<string, HTMLElement> = {};
    for (const id of ids) {
      const h = document.createElement('h2');
      h.id = id;
      h.textContent = id;
      h.scrollIntoView = vi.fn();
      host.append(h);
      out[id] = h;
    }
    detail.append(host);
    root.append(detail);
    return out;
  }

  function open(selected: string | null): Dispatcher {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
    if (selected !== null) d.dispatch({ type: 'SELECT_ENTRY', lid: selected });
    return d;
  }

  it('🔴 見つかった行へ送り、その行だけを光らせる(他の行は光らせない)', async () => {
    const d = open('n1');
    const hs = plant('n1', ['2026-10-11-100000', '2026-10-11-110000']);
    await jumpToLinkedSection(d, root, 'n1', '2026-10-11-110000');
    expect(hs['2026-10-11-110000']!.scrollIntoView, '行へ送っていない').toHaveBeenCalled();
    expect(hs['2026-10-11-110000']!.getAttribute('data-pkc-flash'), '送った先を光らせていない').toBe('true');
    expect(hs['2026-10-11-100000']!.scrollIntoView, '別の行へ送った').not.toHaveBeenCalled();
    expect(hs['2026-10-11-100000']!.hasAttribute('data-pkc-flash'), '別の行を光らせた').toBe(false);
    expect(d.getState().error, '送れたのに理由が出ている').toBeNull();
  });

  it('🔴 行が無ければ(日時を直した / 消した)、ノートは開いたまま理由を出す', async () => {
    const d = open('n1');
    plant('n1', ['2026-10-11-100000']);
    await jumpToLinkedSection(d, root, 'n1', '2026-10-11-999999');
    expect(d.getState().selectedLid, 'ノートまで閉じた').toBe('n1');
    expect(d.getState().error).toBe(LINK_SECTION_MISSING_MESSAGE);
  });

  it('🔴 ノートを選べなかったとき(別のノートが開いたまま)は、別のノートの行へ送らず理由を出す', async () => {
    const d = open('n2');
    const hs = plant('n2', ['2026-10-11-110000']);
    await jumpToLinkedSection(d, root, 'n1', '2026-10-11-110000');
    expect(hs['2026-10-11-110000']!.scrollIntoView, '別のノートの同じ id の行へ送った').not.toHaveBeenCalled();
    expect(d.getState().error ?? '', '無言で終わった').toContain('ノートを開けなかった');
  });
});

describe('ログの行の見出しの判定(右クリックの字を決める 1 本)', () => {
  it('日時の形の `##` だけが「行」。★ 付き(取り込み)も行', () => {
    expect(isLogRowHeading('textlog', 2, '2026-10-11 10:00:00')).toBe(true);
    expect(isLogRowHeading('textlog', 2, '2026-10-11 10:00:00 ★')).toBe(true);
  });
  it('⚠ 対照群 ── 別の型・別の段・別の字は行ではない', () => {
    expect(isLogRowHeading('text', 2, '2026-10-11 10:00:00')).toBe(false);
    expect(isLogRowHeading('textlog', 3, '2026-10-11 10:00:00')).toBe(false);
    expect(isLogRowHeading('textlog', 2, '手書きの見出し')).toBe(false);
    expect(isLogRowHeading('textlog', 2, '2026-10-11 10:00')).toBe(false);
    expect(isLogRowHeading(undefined, 2, '2026-10-11 10:00:00')).toBe(false);
  });
});
