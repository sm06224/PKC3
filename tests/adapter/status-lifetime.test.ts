/** @vitest-environment happy-dom */
/**
 * 🔴 **画面下の知らせの寿命と、進行中の置き場**(#1017 C5。裁定 2026-10-02 の Q1 / Q2 / Q3)。
 *
 * 守るのは:
 * ① 結果の知らせは**数秒で消え**、注意・問題と**押す口を持つ知らせ**は消えない(Q1 / Q2)
 * ② 新しい知らせが来たら前の時計は捨てる(古い時計が新しい字を消さない / 寿命を縮めない)
 * ③ 進行中(`…`)は**別の欄**へ出て、結果の知らせに置き換わらず、終わりの合図で空になる(Q3)
 * ④ 進行中は行の中で知らせより**先**に出て、読み上げの対象にならない
 * ⑤ 全体の処理を出す側の**全数**(下の表)が、終わりの合図を持っている
 *
 * ⚠ 守っていないもの:`main.ts` の配線(原文で pin する ── 弱い)と、実ブラウザでの見え方
 *   (`tests/smoke/copy-history.smoke.spec.ts` 等が道中で見る)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import {
  composeStatusLine,
  paintStatusText,
  type StatusLineParts,
} from '../../src/adapter/ui/render/status-line';
import {
  createStatusNotices,
  routeStatusText,
  STATUS_RESULT_VISIBLE_MS,
  type StatusNotices,
} from '../../src/adapter/ui/render/status-lifetime';
import { CORRUPT_REFUSAL } from '../../src/features/storage/db-corruption';
import type { StatusOptions } from '../../src/adapter/ui/render/status-notice';

/** 描いた回数・降ろした字・積んだ字を取る台。⚠ 描く側は `noticeLine()` を読む(本物の `paint` と同じ向き)。 */
function rig(over: { actionShown?: () => boolean } = {}) {
  const painted: Array<{ notice: string; progress: string }> = [];
  const expired: string[] = [];
  const posted: Array<{ text: string; opts: StatusOptions | undefined }> = [];
  const timers: number[] = [];
  let actionShown = false;
  const n: StatusNotices = createStatusNotices({
    post: (text, opts) => void posted.push({ text, opts }),
    paint: () => void painted.push({ notice: n.noticeLine(), progress: n.progressLine() }),
    paintActions: () => (over.actionShown ? over.actionShown() : actionShown),
    expire: (text) => void expired.push(text),
    // ⚠ 時計は vitest の偽物(`setTimeout`)をそのまま使う ── 渡された長さだけ控える
    setTimer: (fn, ms) => {
      timers.push(ms);
      return setTimeout(fn, ms);
    },
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return {
    n,
    painted,
    expired,
    posted,
    timers,
    setAction: (v: boolean) => {
      actionShown = v;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Q1 結果の知らせは数秒で消える', () => {
  it('🔴 結果(既定)は MS 後に消え、消えるまでは出ている(対照群)', () => {
    const r = rig();
    r.n.show('コピーしました');
    expect(r.n.noticeLine()).toBe('コピーしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 1);
    expect(r.n.noticeLine(), '時間が来る前に消えた').toBe('コピーしました');
    vi.advanceTimersByTime(1);
    expect(r.n.noticeLine(), '時間が来たのに居座る').toBe('');
    expect(r.expired, 'state に載っている知らせを降ろす合図が出ていない').toEqual(['コピーしました']);
    // 消えた後の行は空の字で描き直される(他の欄に戻る)
    expect(r.painted.at(-1)).toEqual({ notice: '', progress: '' });
  });

  it('🔴 長さは 1 つの定数で、読み終える前に消えず、居座りもしない範囲', () => {
    const r = rig();
    r.n.show('コピーしました');
    expect(r.timers, '時計の長さが定数と違う').toEqual([STATUS_RESULT_VISIBLE_MS]);
    expect(STATUS_RESULT_VISIBLE_MS).toBeGreaterThanOrEqual(3000);
    expect(STATUS_RESULT_VISIBLE_MS).toBeLessThanOrEqual(10000);
  });

  it('🔴 積む口は結果にも通る(消えても一覧に在る)。⚠ 積むのは出す前', () => {
    const r = rig();
    r.n.show('コピーしました', { kind: 'result' });
    expect(r.posted).toEqual([{ text: 'コピーしました', opts: { kind: 'result' } }]);
  });

  it('🔴 注意・問題は消えない(読むべき字)。対照:結果は同じ時間で消える', () => {
    for (const kind of ['caution', 'problem'] as const) {
      const r = rig();
      r.n.show('保存できません', { kind });
      vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS * 100);
      expect(r.n.noticeLine(), `${kind} が時間で消えた`).toBe('保存できません');
      expect(r.expired).toEqual([]);
    }
    const ctl = rig();
    ctl.n.show('コピーしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS);
    expect(ctl.n.noticeLine(), '対照群が消えていない(上の検査が何も見ていない)').toBe('');
  });
});

describe('Q2 操作のボタンを持つ知らせは次が来るまで残る', () => {
  it('🔴 押す口が出ている結果は消えない。⚠ 出す条件は status-open の描く関数の返り値', () => {
    const r = rig();
    r.setAction(true);
    r.n.show('「見積.pdf」を添付にしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS * 100);
    expect(r.n.noticeLine(), '「開く」のある知らせが消えた').toBe('「見積.pdf」を添付にしました');
    expect(r.expired).toEqual([]);
  });

  it('🔴 押す口が引っ込んだら(そのノートを開いた等)、そこから数え始めて消える', () => {
    const r = rig();
    r.setAction(true);
    r.n.show('「見積.pdf」を添付にしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS * 3);
    r.setAction(false);
    r.n.settle();
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 1);
    expect(r.n.noticeLine(), '引っ込んだ瞬間に消えた(数え始めていない)').not.toBe('');
    vi.advanceTimersByTime(1);
    expect(r.n.noticeLine()).toBe('');
  });

  it('🔴 `settle` は押す口が出ている間は時計を動かさない(対照:出ていなければ動く)', () => {
    const r = rig();
    r.setAction(true);
    r.n.show('塊を動かしました');
    r.n.settle();
    r.n.settle();
    expect(r.timers, '押す口が出ているのに時計を動かした').toEqual([]);
    r.setAction(false);
    r.n.settle();
    expect(r.timers, '対照:引っ込んだのに時計が動いていない').toEqual([STATUS_RESULT_VISIBLE_MS]);
  });

  it('🔴 `settle` を重ねても時計は 1 本のまま(寿命が延びない)', () => {
    const r = rig();
    r.n.show('コピーしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 10);
    r.n.settle();
    r.n.settle();
    vi.advanceTimersByTime(10);
    expect(r.n.noticeLine(), '状態が動くたびに寿命が延びた').toBe('');
    expect(r.timers).toHaveLength(1);
  });

  it('🔴 保存領域の点検への断り書きは、結果の種類で来ても消えない', () => {
    const r = rig();
    r.n.show(`${CORRUPT_REFUSAL}(open で検出: x)`);
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS * 100);
    expect(r.n.noticeLine(), '点検の入口がある断り書きが消えた').toContain(CORRUPT_REFUSAL);
  });
});

describe('新しい知らせが来たら、前の時計は捨てる', () => {
  it('🔴 古い時計が新しい字を消さない(字が違う)', () => {
    const r = rig();
    r.n.show('A');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 1000);
    r.n.show('B');
    vi.advanceTimersByTime(1000); // A の時計が鳴るはずだった時刻
    expect(r.n.noticeLine(), '古い時計が新しい字を消した').toBe('B');
    expect(r.expired, 'A が先に降ろされた').toEqual([]);
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 1000);
    expect(r.n.noticeLine()).toBe('');
    expect(r.expired).toEqual(['B']);
  });

  it('🔴 同じ字がもう一度来ても寿命は新しく数える(古い時計が縮めない)', () => {
    const r = rig();
    r.n.show('コピーしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 1000);
    r.n.show('コピーしました');
    vi.advanceTimersByTime(1000);
    expect(r.n.noticeLine(), '2 回目の寿命が最初の時計に縮められた').toBe('コピーしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 1000);
    expect(r.n.noticeLine()).toBe('');
  });

  it('🔴 消えない知らせ(注意)が来たら、前の結果の時計も止まる', () => {
    const r = rig();
    r.n.show('コピーしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS - 1);
    r.n.show('保存できません', { kind: 'problem' });
    vi.advanceTimersByTime(10);
    expect(r.n.noticeLine(), '前の結果の時計が注意を消した').toBe('保存できません');
  });

  it('🔴 押す口を持つ知らせの後に来た結果は、また消える側へ戻る', () => {
    const r = rig();
    r.setAction(true);
    r.n.show('塊を動かしました');
    r.setAction(false);
    r.n.show('コピーしました');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS);
    expect(r.n.noticeLine()).toBe('');
  });
});

describe('Q3 全体の処理の進行中は別の欄', () => {
  it('🔴 進行中の字は進行中の欄に入り、知らせの欄には入らない。時間では消えない', () => {
    const r = rig();
    r.n.show('書き出しています…');
    expect(r.n.progressLine()).toBe('書き出しています…');
    expect(r.n.noticeLine(), '進行中が知らせの欄に入った').toBe('');
    expect(r.posted, '進行中を結果として積んだ').toEqual([]);
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS * 100);
    expect(r.n.progressLine(), '進行中が時間で消えた').toBe('書き出しています…');
  });

  it('🔴 終わりの合図(空の字)で進行中だけが空になる。知らせは巻き込まない', () => {
    const r = rig();
    r.n.show('書き出しています…');
    r.n.show('コピーしました'); // 進行中の間に別の結果が来る
    expect(r.n.progressLine(), '別の知らせが進行中を置き換えた').toBe('書き出しています…');
    r.n.show('');
    expect(r.n.progressLine(), '終わりの合図で消えていない').toBe('');
    expect(r.n.noticeLine(), '終わりの合図が結果を巻き込んだ').toBe('コピーしました');
    expect(r.posted.map((p) => p.text), '空の字を積んだ').toEqual(['コピーしました']);
  });

  it('🔴 進行中の間に結果の時計が鳴っても、進行中は残る', () => {
    const r = rig();
    r.n.show('コピーしました');
    r.n.show('取り込んでいます…'); // 進行中は前の知らせを置き換える
    expect(r.n.noticeLine(), '進行中が前の知らせを置き換えていない').toBe('');
    r.n.show('もう 1 つの結果');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS);
    expect(r.n.noticeLine()).toBe('');
    expect(r.n.progressLine(), '結果の時計が進行中まで消した').toBe('取り込んでいます…');
  });

  it('🔴 進行中が前の結果を置き換えたら、その結果の時計は止まる(後で何も消さない)', () => {
    const r = rig();
    r.n.show('コピーしました');
    r.n.show('書き出しています…');
    vi.advanceTimersByTime(STATUS_RESULT_VISIBLE_MS);
    expect(r.expired, '置き換えられた結果の時計が鳴った').toEqual([]);
  });

  it('🔴 終わりの合図は何も進行中でなくても害が無い', () => {
    const r = rig();
    r.n.show('コピーしました');
    r.n.show('');
    expect(r.n.noticeLine()).toBe('コピーしました');
    expect(r.n.progressLine()).toBe('');
  });

  it('🔴 行き先の判定 ── 進行中 / 終わり / 知らせ', () => {
    expect(routeStatusText('書き出しています…')).toBe('progress');
    expect(routeStatusText('取込中…(12 件を書き込んでいます)')).toBe('progress');
    expect(routeStatusText('')).toBe('progress-end');
    expect(routeStatusText('コピーしました')).toBe('notice');
    // 対照:途中に `…` があっても末尾でなければ結果(「…」を含む題名を結果に出す)
    expect(routeStatusText('「あ…い」を取り込みました')).toBe('notice');
  });
});

describe('行の組み立て ── 進行中は知らせより先に出て、読み上げの外', () => {
  const parts = (extra: Partial<StatusLineParts> = {}): StatusLineParts => ({
    phase: 'ready',
    statusBase: '',
    sync: '',
    portableAssetNote: '',
    persistState: '',
    savingLine: '',
    progressLine: '',
    noticeLine: '',
    errorLine: '',
    ...extra,
  });

  it('🔴 進行中が在れば知らせの前に出る(エラーの前でもある)', () => {
    const t = composeStatusLine(
      parts({ progressLine: '書き出しています…', noticeLine: 'コピーしました', errorLine: '⚠ エラー: x' }),
    );
    expect(t).toBe('書き出しています… — コピーしました — ⚠ エラー: x');
  });

  it('🔴 消えた後は他の欄(状態語 / 保存先)だけに戻る', () => {
    const t = composeStatusLine(parts({ phase: 'editing', statusBase: '保存先の注意' }));
    expect(t).toBe('編集中 — 保存先の注意');
  });

  it('🔴 進行中は読み上げの子に入らない(知らせとエラーだけ)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    paintStatusText(
      regions.statusText,
      parts({ progressLine: '書き出しています…', noticeLine: 'コピーしました' }),
    );
    const live = regions.statusText.querySelector('[data-pkc-field="status-live"]') as HTMLElement;
    expect(live.textContent, '読み上げが進行中を含んでいる').toBe('コピーしました');
    expect(regions.statusText.textContent).toBe('書き出しています… — コピーしました');
    // 進行中だけのとき、読み上げの子は空
    paintStatusText(regions.statusText, parts({ progressLine: '書き出しています…' }));
    expect(live.textContent, '進行中だけで読み上げが起きる').toBe('');
    expect(regions.statusText.textContent).toBe('書き出しています…');
  });
});

describe('reducer: NOTICE_EXPIRED', () => {
  const withNotice = (message: string) =>
    reduce(initialState, { type: 'OP_NOTICE', message, open: 'x', createDate: '2026-10-15' }).state;

  it('🔴 載っている知らせと同じ字なら降ろす(身元の組も)', () => {
    const s = reduce(withNotice('見つかりませんでした'), {
      type: 'NOTICE_EXPIRED',
      message: '見つかりませんでした',
    }).state;
    expect(s.notice).toBeNull();
    expect(s.noticeOpen).toBeNull();
    expect(s.noticeCreate).toBeNull();
  });

  it('🔴 字が違うなら何もしない(古い時計が、後から来た別の知らせを降ろさない)', () => {
    const before = withNotice('B');
    const after = reduce(before, { type: 'NOTICE_EXPIRED', message: 'A' }).state;
    expect(after, '別の知らせを降ろした').toBe(before);
  });
});

describe('main.ts の配線(原文 pin ── 弱い。`main.ts` は走らないため)', () => {
  const code = readFileSync('src/main.ts', 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');

  it('🔴 時間が切れた知らせは state からも降ろす(NOTICE_EXPIRED)', () => {
    expect(code).toContain("dispatcher.dispatch({ type: 'NOTICE_EXPIRED', message: text })");
  });

  it('🔴 降ろされたら出した字の記憶も捨てる(同じ字の知らせがもう一度来ても出る)', () => {
    expect(code).toMatch(/if \(state\.notice === null\) noticeShown = null;/);
  });

  it('🔴 状態が動いたら寿命を見直す(押す口が引っ込んだ知らせは、そこから数える)', () => {
    expect(code).toContain('statusNotices?.settle();');
  });

  it('🔴 行へ進行中の欄を渡している', () => {
    expect(code).toContain('progressLine: progressLine(),');
  });
});

/**
 * 🔴 **全体の処理の出す側の全数**(#1017 C5 Q3)。
 *
 * ⚠ 出す側は `…` で終わる字を `notify` / `showStatus` へ渡す形で書く ── その形が `progressLine` へ
 *   行く唯一の入口である(`routeStatusText`)。**足した人が「終わりの合図」を忘れる**と、失敗の回に
 *   「…」が居座る(#1017 C5 の直す前の症状)。だから**出す側を表で数え**、表に無い出す側が
 *   増えたら落ちる / 表の側が**終わりの合図(`notify('')` 系)**を持っていることを見る。
 *
 * 局所の進行中(設定の画面・本文・ボタンの字)は対象外 ── `textContent` に直に書く物で、
 * `notify` / `showStatus` を通らない(下の走査はその呼び出しだけを拾う)。
 */
describe('全体の処理の出す側の全数', () => {
  const strip = (f: string): string =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

  /** file → [始まりの字(原文にこの形で在る)の数, 終わりの合図の形] */
  const SITES: ReadonlyArray<{
    file: string;
    /** 進行中を出す呼び出し(原文の断片)。 */
    starts: readonly string[];
    /** 終わりの合図(原文の断片)。 */
    end: RegExp;
  }> = [
    {
      file: 'src/adapter/ui/actions/export-archive.ts',
      starts: ['deps.notify?.(EXPORT_STARTING[kind]);', 'deps.notify?.(`${target.app} で書き出しています…`);'],
      end: /deps\.notify\?\.\(''\)/,
    },
    {
      file: 'src/adapter/ui/actions/export-portable.ts',
      starts: ["deps.notify('可搬 HTML を書き出しています…');"],
      end: /deps\.notify\(''\)/,
    },
    {
      file: 'src/adapter/ui/actions/import-pkc2.ts',
      starts: ["deps.notify?.('取込中…(ファイルを読んでいます)');", 'deps.notify?.(`取込中…(${rows.length} 件を書き込んでいます)`);'],
      end: /deps\.notify\?\.\(''\)/,
    },
    {
      file: 'src/adapter/ui/actions/capture-trim.ts',
      starts: ["deps.notify('切り出しています…');"],
      end: /deps\.notify\(''\)/,
    },
    {
      file: 'src/adapter/ui/actions/capture-transcribe.ts',
      starts: ['deps.notify(`「${item.name}」を文字にしています…(${ready.part.label}の部品)`);'],
      end: /deps\.notify\(''\)/,
    },
    {
      file: 'src/adapter/ui/actions/selfhost.ts',
      starts: ["deps.notify('自分のパソコンで動かす一式を組んでいます…');"],
      end: /finally \{[\s\S]*deps\.notify\(''\)/,
    },
    {
      file: 'src/adapter/platform/view-window.ts',
      starts: ['deps.notify?.(VIEW_WINDOW_OPENING);'],
      end: /deps\.notify\?\.\(''\)/,
    },
    {
      file: 'src/adapter/ui/actions/binder.ts',
      starts: ['services.showStatus?.(`外部の画像 ${urls.length} 枚を取りに行っています…`);'],
      end: /services\.showStatus\?\.\(''\)/,
    },
  ];

  it('🔴 表の出す側は、始まりの字と終わりの合図を持つ', () => {
    for (const s of SITES) {
      const code = strip(s.file);
      for (const start of s.starts) {
        expect(code, `${s.file}: 表の始まりが原文に無い(直したなら表も直す): ${start}`).toContain(start);
      }
      expect(code, `${s.file}: 終わりの合図が無い(失敗の回に進行中が居座る)`).toMatch(s.end);
    }
  });

  it('🔴 `…` つきの字を notify / showStatus へ渡す呼び出しは、src のどこにも表の外に増えていない', () => {
    const files = readdirRecursive('src').filter((f) => f.endsWith('.ts'));
    // 字面(`…` を含む)か、進行中の字を持つ定数 2 つ(`EXPORT_STARTING` / `VIEW_WINDOW_OPENING`)を渡す呼び出し
    const call =
      /\b(?:notify|showStatus|say)\??\.?\(\s*(?:`[^`]*…[^`]*`|'[^']*…[^']*'|"[^"]*…[^"]*"|EXPORT_STARTING\[kind\]|VIEW_WINDOW_OPENING)\s*\)/g;
    const perFile = new Map<string, number>();
    for (const f of files) {
      const n = [...strip(f).matchAll(call)].length;
      if (n > 0) perFile.set(f, n);
    }
    const expected = new Map<string, number>();
    for (const s of SITES) expected.set(s.file, s.starts.length);
    expect(Object.fromEntries([...perFile].sort()), '表に無い出す側が増えた / 減った(表と終わりの合図を直す)').toEqual(
      Object.fromEntries([...expected].sort()),
    );
    // 空振り防止:合計が 10(表の始まりの数)。⚠ 0 件なら走査が何も見ていない
    expect([...perFile.values()].reduce((a, b) => a + b, 0)).toBe(10);
  });
});

function readdirRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...readdirRecursive(p));
    else out.push(p);
  }
  return out;
}
