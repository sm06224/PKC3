/**
 * 🔴 **操作を名前で探す ── 一覧を組む側**(#425 段①)。
 *
 * ⚠ ここは**純関数だけ**を見る。「いま押せるか」を実際の画面から決める配線は
 *   `tests/adapter/palette.test.ts` が見る(2 つの検査で役割を分ける)。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LABELS,
  CONTEXT_WHEN,
  KEY_COMMANDS,
  defaultBindings,
  findCommand,
  onlyWhenSentence,
  type KeyContext,
} from '../../src/features/keymap';
import { NOT_READY_PREFIX, paletteRows } from '../../src/features/palette/palette-rows';

const BINDINGS = defaultBindings();
/** 全部押せる、という前提の集合。 */
const ALL = new Set(KEY_COMMANDS.map((c) => c.id));
const NONE = new Set<string>();

const idsOf = (q: string, ready = ALL): string[] =>
  paletteRows(q, BINDINGS, ready).map((r) => r.id);

describe('操作を名前で探す(一覧)', () => {
  it('🔴 語を打っていなければ、表のコマンドが全部出る(隠さない)', () => {
    const rows = paletteRows('', BINDINGS, ALL);
    // ⚠ **全数**で見る ── 「1 件以上ある」だと、絞りの式が壊れても素通りする
    expect(rows.map((r) => r.id)).toEqual(KEY_COMMANDS.map((c) => c.id));
  });

  /**
   * 🔴 **画面から消した呼び名でも、探せば当たる**(#1017 段⑤-2 / #690 I5)。
   *
   * ⚠ 「小窓」は画面の字としては**使わない語**なので消したが、user は
   *   **その言葉で憶えている**(#690 で user 自身が探した語である)。
   *   消しただけだと「**探しても出てこない**」= 動線が 1 つ減る
   *   (user 裁定 2026-08-07「記法の縮小は user の動線の縮小」と同じ向き)。
   * 🔑 だから `alias` に残す ── **描画では読まない**ので画面には出ない。
   * ⚠ この検査が無いと、次に `alias` を消した人が**何も落ちないまま**動線を消せる
   *   (実際 1 稿目は配線だけ在って検査が 1 つも無かった)。
   */
  it('🔴 画面から消した旧い呼び名(小窓)でも、探せば当たる', () => {
    const hit = idsOf('小窓');
    expect(hit, '旧い呼び名で探せない ── 画面から消した語の行き先が無い').toContain(
      'open-note-window',
    );
    // ⚠ 空振り防止 ── 全部返っているなら「当たった」は何も言わない
    expect(hit.length, '絞れていない(全部返っている)').toBeLessThan(KEY_COMMANDS.length);
  });

  it('⚠ その呼び名は**画面には出ない**(alias は描画で読まない)', () => {
    const cmd = findCommand('open-note-window');
    expect(cmd, '相手の命令が無い(空振り)').toBeDefined();
    expect(cmd?.label ?? '', '画面の字に旧い呼び名が戻っている').not.toContain('小窓');
    expect(cmd?.note ?? '', '説明に旧い呼び名が戻っている').not.toContain('小窓');
  });

  it('🔴 名前で絞れる ── 当たらないものは落ちる', () => {
    const hit = idsOf('ヘルプ');
    expect(hit, '名前で当たっていない').toContain('open-help');
    expect(hit.length, '絞れていない(全部返っている)').toBeLessThan(KEY_COMMANDS.length);
  });

  it('🔴 名前の頭で当たったものが上に来る(途中で当たる別物より先)', () => {
    /**
     * 🔴 **表の並びと逆になる組で見る**(2026-08-26。変異試験 M2 が教えた)。
     *
     * ⚠ 1 稿目は「ノート」で見ていたが、`create-entry`(頭で当たる)は
     *   `edit-entry`(途中で当たる)より**表でも前**だったので、
     *   **頭の優先を丸ごと外しても順番が変わらなかった**
     *   ── 表の並びに救われていた(CLAUDE.md §1「救い手が変わっただけ」)。
     * 🔑 「編集」なら逆になる:`commit-edit`(**編集**を確定する)は頭で当たるが
     *   **表では 34 番目**、`edit-entry`(選んでいるノートを**編集**する)は
     *   途中で当たるが**表では 2 番目**。頭の優先が効いていないと順番が入れ替わる。
     * ⚠ 順番が逆だと、絞ってすぐ Enter を押した人が**別の操作**を実行する。
     */
    const hit = idsOf('編集');
    expect(hit, '前提が崩れている(頭で当たる側が落ちている)').toContain('commit-edit');
    expect(hit, '前提が崩れている(途中で当たる側が落ちている)').toContain('edit-entry');
    expect(KEY_COMMANDS.findIndex((c) => c.id === 'commit-edit'), '前提が崩れている(表の並び)')
      .toBeGreaterThan(KEY_COMMANDS.findIndex((c) => c.id === 'edit-entry'));
    expect(hit.indexOf('commit-edit')).toBeLessThan(hit.indexOf('edit-entry'));
  });

  it('説明の中の語でも当たる(名前を思い出せないとき)', () => {
    const cmd = findCommand('insert-date')!;
    expect(cmd.note ?? '', '前提が崩れている(説明が無い)').not.toBe('');
    expect(idsOf('カーソル'), '説明で当たっていない').toContain('insert-date');
  });

  it('綴り(id)でも当たる ── 大文字小文字は問わない', () => {
    expect(idsOf('OPEN-HELP')).toContain('open-help');
  });

  it('当たらない語では 1 件も返らない(空を返す ── 全部返さない)', () => {
    expect(idsOf('ぬるぽ')).toEqual([]);
  });

  describe('押せるか / なぜ押せないか', () => {
    it('🔴 押せる行の説明には「いまは押せません」が付かない', () => {
      const row = paletteRows('', BINDINGS, ALL).find((r) => r.id === 'create-entry')!;
      expect(row.ready).toBe(true);
      expect(row.why.startsWith(NOT_READY_PREFIX), '押せるのに断り書きが付いている').toBe(false);
      // 🔑 説明そのものは出る(何をする操作か分かる)
      expect(row.why).toBe(findCommand('create-entry')!.note);
    });

    it('🔴 押せない行は、必ず理由が付く(黙って無反応にしない)', () => {
      const rows = paletteRows('', BINDINGS, NONE);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.ready, `${r.id} が押せることになっている`).toBe(false);
        expect(r.why.startsWith(NOT_READY_PREFIX), `${r.id} に理由が付いていない`).toBe(true);
      }
    });

    it('🔴 その面にいないものは、**どこにいれば効くか**を書く', () => {
      /**
       * ⚠ `commit-edit` は `editor` の操作 ── 全域ではない。
       *   「いまは押せません」だけだと、user は**いつなら押せるのか分からない**。
       */
      const row = paletteRows('', BINDINGS, NONE).find((r) => r.id === 'commit-edit')!;
      expect(row.why).toBe(
        `${NOT_READY_PREFIX}2 ペインの編集で、原文か題名の欄にカーソルがあるときだけ効きます`,
      );
    });

    it('🔴 全域の操作は、**その操作自身の説明**を理由にする(書き直さない)', () => {
      /**
       * ⚠ ここで別の字を書くと、説明と理由の**2 つの答え**ができる(§7)。
       *   `edit-entry` は「ノートを選んでいるときだけ効きます」と自分で名乗っている。
       */
      const cmd = findCommand('edit-entry')!;
      const row = paletteRows('', BINDINGS, NONE).find((r) => r.id === 'edit-entry')!;
      expect(row.why).toBe(`${NOT_READY_PREFIX}${cmd.note}`);
    });

    it('🔴 押せるものが先に並ぶ ── 絞って即 Enter が空振りしない', () => {
      const only = new Set(['edit-entry']);
      const rows = paletteRows('ノート', BINDINGS, only);
      expect(rows.length, '前提が崩れている(2 件以上当たっていない)').toBeGreaterThan(1);
      expect(rows[0]!.id, '押せない行が先頭に来ている').toBe('edit-entry');
      expect(rows.slice(1).every((r) => !r.ready)).toBe(true);
    });
  });

  describe('鍵の字', () => {
    it('割り当たっている鍵が出る(次はこれで呼べる、が伝わる)', () => {
      const row = paletteRows('', BINDINGS, ALL).find((r) => r.id === 'create-entry')!;
      // 🔴 既定は Alt+N(台帳 #1852、依頼 182 = A ── Ctrl+N はブラウザが取る)
      expect(row.keys).toEqual(['Alt + N']);
    });

    it('mac では ⌘ で出る(既定のままでも綴りが違う)', () => {
      // ⚠ 「ノートを作る」は Alt+N になったので、Ctrl(⌘)を既定に持つ「ノートを編集する」(Ctrl+E)で見る
      const row = paletteRows('', BINDINGS, ALL, true).find((r) => r.id === 'edit-entry')!;
      expect(row.keys).toEqual(['⌘ + E']);
      // 対照群: Alt の既定は mac で ⌥
      const create = paletteRows('', BINDINGS, ALL, true).find((r) => r.id === 'create-entry')!;
      expect(create.keys).toEqual(['⌥ + N']);
    });

    it('🔴 user が変えた割当で出る(既定を出し続けない)', () => {
      const row = paletteRows('', { ...BINDINGS, 'create-entry': ['Alt+9'] }, ALL).find(
        (r) => r.id === 'create-entry',
      )!;
      expect(row.keys).toEqual(['Alt + 9']);
    });
  });
});

describe('🔴 本文の欄が要る操作の理由(#1206 D3)', () => {
  const editorOnly = (id: string): boolean => id === 'format-ruby';
  const whyOf = (id: string, rows: ReturnType<typeof paletteRows>): string =>
    rows.find((r) => r.id === id)!.why;

  it('🔴 判定を渡したときだけ、その操作の理由が「どこから呼べるか」になる(他の行は今までのまま)', () => {
    const plain = paletteRows('', BINDINGS, NONE);
    const hinted = paletteRows('', BINDINGS, NONE, false, () => null, editorOnly);
    expect(whyOf('format-ruby', plain), '前提: 渡さないと今までの理由').toBe(
      `${NOT_READY_PREFIX}${onlyWhenSentence(findCommand('format-ruby')!.contexts)}`,
    );
    expect(whyOf('format-ruby', hinted)).toBe(
      `${NOT_READY_PREFIX}本文の欄で Ctrl + Shift + P の『操作を探す』から呼べます`,
    );
    // 判定が false の行は 1 字も変わらない
    for (const r of plain) if (r.id !== 'format-ruby') expect(whyOf(r.id, hinted), r.id).toBe(r.why);
  });

  it('🔴 案内の鍵は user が割り当て直した字に従う / 押せる行には付かない', () => {
    const rebound = { ...BINDINGS, 'open-palette': ['Alt+9'] };
    const rows = paletteRows('', rebound, NONE, false, () => null, editorOnly);
    expect(whyOf('format-ruby', rows)).toContain('Alt + 9');
    expect(whyOf('format-ruby', rows)).not.toContain('Ctrl');
    const ready = paletteRows('', BINDINGS, new Set(['format-ruby']), false, () => null, editorOnly);
    expect(whyOf('format-ruby', ready), '押せる行に案内が付いた').not.toContain(NOT_READY_PREFIX);
  });

  it('🔴 「操作を探す」のキーを全部外していても、文が欠けない(2026-10-13)', () => {
    const none = { ...BINDINGS, 'open-palette': [] };
    const rows = paletteRows('', none, NONE, false, () => null, editorOnly);
    expect(whyOf('format-ruby', rows)).toBe(`${NOT_READY_PREFIX}本文の欄で『操作を探す』を開くと呼べます`);
    expect(whyOf('format-ruby', rows), '空のキーを挟んだ').not.toContain('  ');
  });

  it('🔴 ボタンが持っている押せない理由(編集中など)は案内より先に出る', () => {
    const rows = paletteRows(
      '',
      BINDINGS,
      NONE,
      false,
      (id) => (id === 'format-ruby' ? '保存しています' : null),
      editorOnly,
    );
    expect(whyOf('format-ruby', rows)).toBe(`${NOT_READY_PREFIX}保存しています`);
  });
});

describe('2 語以上で探す(#1087 の見直し 2026-10-13)', () => {
  it('🔴 空白で区切った語が全部当たる行を出す(離れていても・順番が違っても)', () => {
    // 「字幕 書き出し」は alias の中で離れている(間に「文字起こし」)── 1 つの塊として探すと当たらない
    expect(idsOf('字幕 書き出し')).toContain('export-transcript-srt');
    expect(idsOf('書き出し 字幕')).toContain('export-transcript-srt');
    expect(idsOf('字幕　書き出し'), '全角の空白でも割る').toContain('export-transcript-srt');
  });

  it('⚠ どれか 1 語でも当たらない行は出さない(全部の語で絞る)', () => {
    expect(idsOf('字幕 ぬるぽ')).toEqual([]);
  });
});

describe('🔴 押せない理由の文(#1087 の見直し 2026-10-14)', () => {
  const CONTEXTS = Object.keys(CONTEXT_LABELS) as KeyContext[];

  it('🔴 全部の文脈について、文を**等値**で見る(見出しの末尾に関わらず自然な日本語になる)', () => {
    // 期待値は literal で持つ ── 実装の表を回して作ると、表を壊したとき検査も一緒に縮む(§1.10)
    const EXPECTED: Record<KeyContext, string> = {
      global: 'どの画面でもだけ効きます',
      editor: '2 ペインの編集で、原文か題名の欄にカーソルがあるときだけ効きます',
      append: '追記の欄にカーソルがあるときだけ効きます',
      row: '1 画面の編集で、開いている行の欄にカーソルがあるときだけ効きます',
      live: '1 画面で編集していて、画面ぜんたいにフォーカスがあるときだけ効きます',
      filer: 'フォルダの一覧か 2 ペインで、行を選んでいるときだけ効きます',
      dual: '2 ペインで、そのペインにフォーカスがあるときだけ効きます',
      reading: 'ノートを読んでいるときだけ効きます',
      window: '集計・システム・ヘルプなどの画面を開いているときだけ効きます',
    };
    expect([...CONTEXTS].sort(), '文脈が増えた ── 文を足す').toEqual(Object.keys(EXPECTED).sort());
    for (const c of CONTEXTS) {
      // global は灰色の理由に出ない(全域の操作は別の分岐)ので、句の終わり方だけは全部見る
      expect(CONTEXT_WHEN[c].length, c).toBeGreaterThan(0);
      if (c === 'global') continue;
      expect(onlyWhenSentence([c]), c).toBe(EXPECTED[c]);
      expect(CONTEXT_WHEN[c].endsWith('とき'), `${c} は「…とき」で終わる句`).toBe(true);
    }
    expect(onlyWhenSentence(['editor', 'row'])).toBe(
      `${EXPECTED.editor.replace('だけ効きます', '')}、または${EXPECTED.row}`,
    );
  });

  it('🔴 灰色の行の理由に、「ときにいるとき」のような壊れた継ぎ目が 1 つも出ない', () => {
    for (const fromField of [false, true]) {
      const rows = paletteRows('', BINDINGS, NONE, false, () => null, undefined, fromField);
      for (const r of rows) {
        expect(r.why, r.id).not.toMatch(/とき\)?にいる/);
        expect(r.why.startsWith(NOT_READY_PREFIX), r.id).toBe(true);
      }
    }
  });

  it('🔴 「ノートを閉じる」(reading)と「画面を閉じる」(window)は、実際の条件を言う', () => {
    const rows = paletteRows('', BINDINGS, NONE);
    const why = (id: string) => rows.find((r) => r.id === id)!.why;
    expect(why('deselect-entry')).toBe(`${NOT_READY_PREFIX}ノートを読んでいるときだけ効きます`);
    expect(why('close-pane')).toBe(
      `${NOT_READY_PREFIX}集計・システム・ヘルプなどの画面を開いているときだけ効きます`,
    );
  });

  it('🔴 P2: 欄の中で開いた一覧では、欄の中の操作は「その場で押すキー」を言う(居るのに居ろと言わない)', () => {
    const fromField = paletteRows('', BINDINGS, NONE, false, () => null, undefined, true);
    const why = (id: string) => fromField.find((r) => r.id === id)!.why;
    expect(why('commit-edit')).toBe(
      `${NOT_READY_PREFIX}2 ペインの編集で、原文か題名の欄にカーソルがあるときに、Ctrl + S か Ctrl + Enter を押して使う操作です`,
    );
    // 対照群: 欄の外から開いた(既定)なら、条件のまま。欄の中の操作でない行は変わらない
    const plain = paletteRows('', BINDINGS, NONE);
    expect(plain.find((r) => r.id === 'commit-edit')!.why).not.toContain('押して使う操作');
    for (const r of plain) {
      const c = findCommand(r.id)!;
      if (c.contexts.every((x) => x === 'editor' || x === 'append' || x === 'row' || x === 'live')) continue;
      expect(why(r.id), r.id).toBe(r.why);
    }
    // 鍵を全部外した人には、押すキーの案内を出さない(空のキーを挟まない)
    const none = paletteRows('', { ...BINDINGS, 'commit-edit': [] }, NONE, false, () => null, undefined, true);
    expect(none.find((r) => r.id === 'commit-edit')!.why).toBe(
      `${NOT_READY_PREFIX}${onlyWhenSentence(['editor'])}`,
    );
  });

  it('🔴 P3: 条件で押せなくなる操作は、説明(note)ではなく押せない理由(whyNot)を言う', () => {
    const rows = paletteRows('', BINDINGS, NONE);
    const why = (id: string) => rows.find((r) => r.id === id)!.why;
    const EXPECTED: Record<string, string> = {
      'nav-back': '戻る先がありません',
      'nav-forward': '進む先がありません',
      'open-note-window': 'ノートを選んでいるときだけ効きます',
      'copy-entry-link': 'ノートを選んでいるときだけ効きます',
      'view-detail': 'いま本文を開いています',
      'export-note-markdown': 'ノートを開いているときだけ効きます',
      'export-note-pdf': 'ノートを開いているときだけ効きます',
      'export-transcript-srt': 'ノートを開いていて、行頭に時刻のある行があるときだけ効きます',
      'embed-transcript-srt': 'ノートを開いていて、行頭に時刻のある行があるときだけ効きます',
    };
    for (const [id, text] of Object.entries(EXPECTED)) {
      expect(why(id), id).toBe(`${NOT_READY_PREFIX}${text}`);
      expect(why(id), `${id}: note をそのまま出している`).not.toContain(findCommand(id)!.note!);
    }
    // 押せる行は今までどおり note(whyNot は灰色のときだけ)
    const ready = paletteRows('', BINDINGS, ALL);
    expect(ready.find((r) => r.id === 'nav-back')!.why).toBe(findCommand('nav-back')!.note);
    // blocked(ボタン自身の理由)は whyNot より先
    const blocked = paletteRows('', BINDINGS, NONE, false, (id) => (id === 'nav-back' ? '編集中です' : null));
    expect(blocked.find((r) => r.id === 'nav-back')!.why).toBe(`${NOT_READY_PREFIX}編集中です`);
  });

  it('🔴 P3: whyNot を持つ操作を名指しで pin する(増やすときは理由を 1 行添える)', () => {
    const withWhyNot = KEY_COMMANDS.filter((c) => c.whyNot !== undefined).map((c) => c.id).sort();
    expect(withWhyNot).toEqual(
      [
        'copy-entry-link',
        'export-note-markdown',
        'export-note-pdf',
        'embed-transcript-srt',
        'export-transcript-srt',
        // #1640 ②: 日付のノートを開いていて、その向きに日付のノートがあるときだけ効く
        'open-next-day-note',
        'open-prev-day-note',
        // #1163 依頼 153: ノートの並べ替え ── 端・並び順が「自分で並べた順」でないときは note ではなく専用の理由を言う
        'move-order-down',
        'move-order-up',
        'nav-back',
        'nav-forward',
        'open-note-window',
        // #1087: 元に戻す(ゴミ箱へ移した直後)── 戻せる物が無い間は note ではなく専用の理由を言う
        'undo-trash',
        // 台帳 #1852 N1 / 依頼 324 A: 元に戻す(2 ペインで移した直後)── 戻せる物が無い間は専用の理由を言う
        'undo-dual-move',
        'view-detail',
      ].sort(),
    );
    for (const c of KEY_COMMANDS) {
      // ⚠ 例外は `undo-trash` だけ ── 鍵はフォルダの表(`filer` / `dual`)の `Ctrl+Z` だが、一覧からはどこからでも呼ぶ(#1163 依頼 132)
      if (c.whyNot !== undefined && c.id !== 'undo-trash') expect(c.contexts, c.id).toContain('global');
    }
  });
});

describe('🔴 画面の名前を探し語にしても当たる(#1087 の見直し 2026-10-14)', () => {
  it('🔴 「設定」で「システムへ移る」が、「マニュアル」で「ヘルプへ移る」が当たる', () => {
    expect(idsOf('設定'), '「設定」で探してもシステムへ移る行が出ない').toContain('open-settings');
    expect(idsOf('マニュアル'), '「マニュアル」で探してもヘルプへ移る行が出ない').toContain('open-help');
    // 対照群: alias を持たない別の画面の行は、この語では当たらない(語が広すぎて何にでも当たっていない)
    expect(idsOf('設定')).not.toContain('open-flags');
  });
});

describe('🔴 かな・カナ・全角半角の揺れでも当たる(#1087 K2)', () => {
  it('🔴 「のーと」「ﾉｰﾄ」は「ノート」と、「ＳＱＬ」は「sql」と同じ行を出す', () => {
    const noto = idsOf('ノート');
    expect(noto.length, '前提: 「ノート」で 1 行も出ない').toBeGreaterThan(0);
    expect(idsOf('のーと'), 'ひらがなで探すと違う行になる').toEqual(noto);
    expect(idsOf('ﾉｰﾄ'), '半角カナで探すと違う行になる').toEqual(noto);
    const sql = idsOf('sql');
    expect(sql.length, '前提: 「sql」で 1 行も出ない').toBeGreaterThan(0);
    expect(idsOf('ＳＱＬ'), '全角英字で探すと違う行になる').toEqual(sql);
    // 対照群: 揺れを均しても、何にでも当たってはいない
    expect(noto.length).toBeLessThan(KEY_COMMANDS.length);
  });

  it('🔴 「けいさん」で「この行を計算する」が当たる(keymap の注釈が言っていること)', () => {
    expect(idsOf('けいさん')).toContain('inline-calc');
    expect(idsOf('ｹｲｻﾝ')).toContain('inline-calc');
  });
});

/**
 * 🔴 **普通の言い方で探しても、本命の操作が出る**(#1087 の見直し 2026-10-17)。
 * ⚠ 直す前は「削除」で「ゴミ箱へ移す」が出ず、「名前変更」「新規」「やり直し」は 0 件だった
 *   (画面の名前が「〜する」の動詞の形なので、名詞の形で打つと 1 字もかすらない)。
 */
describe('普通の言い方で探す(#1087)', () => {
  it.each([
    ['削除', 'filer-trash'],
    ['名前変更', 'filer-rename'],
    ['改名', 'dual-rename'],
    ['リネーム', 'filer-rename'],
    ['新規', 'create-entry'],
    ['作成', 'dual-new-note'],
    ['保存', 'commit-edit'],
    ['やり直し', 'redo'],
  ])('「%s」で %s が出る', (q, id) => {
    expect(idsOf(q)).toContain(id);
  });
});
