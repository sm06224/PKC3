/**
 * ジョブの**可視化**(P8 段⑩)。
 *
 * > user 指示 2026-08-03「**ジョブスケジューラーは可視化機構とセットでお願いします /
 * > ログもみたい**」
 *
 * 🔑 見えないスケジューラは直せない ── 「なんか重い」を「どのワーカーが何件
 * 抱えていて、1 件あたり何 ms か」に変えるのがここ。
 *
 * ⚠ **可視化そのものが重くなってはいけない**:
 *  - ログは輪(固定長)。伸び続けない
 *  - 所要時間の標本も固定長(中央値を出すぶんだけ)
 *  - 通知は**まとめて 1 回**(購読側が自分で間引く)
 *
 * 🔴 **設計 doc §7、段②b**:ワーカーの動きは「メッセージ」の種類「処理」でもある
 * (裁定 2026-09-20「フラグではなく、メッセージの一種。5,000 件保管」)。
 * ⚠ **`settings.ts` の「処理(ワーカー)── 開発者向け」節はここで廃止した** ──
 * 代わりの入口は「システム → メッセージ → 処理の記録を開く」(system 領域の
 * ノート `sys-jobs`)。この file の輪(`LOG_CAP` 200)は**この class 自身の
 * 単体 test のためだけ**に残す(読み手は無い ── いずれ丸ごと削ってよい)。
 * `record()` は `messagePost`(既定は `appMessagePost`)へ 1 件流す。
 * ⚠ **既定は `null`**(送らない)── `new JobMonitor()` を使う既存の test /
 *   `worker-lease` / `*-client` の test は messaging を知らないので、
 *   ここで real の `appMessagePost` を既定にすると、書けない環境
 *   (indexedDB を持たない test)で無駄な控え書込・実タイマーが走る
 *   (CLAUDE.md §7「片側を直したら…」と同型の巻き添え)。
 *   **本体の `appJobMonitor` だけ**、末尾で明示的に配線する。
 */
import { appMessagePost, type MessagePost } from './message-post';

export type JobPhase = 'spawn' | 'enqueue' | 'dispatch' | 'done' | 'fail' | 'kill' | 'dispose';

export interface JobEvent {
  /** 何時か(epoch ms)。 */
  at: number;
  /** どのワーカー群か(`markdown` など)。 */
  lane: string;
  phase: JobPhase;
  /** ジョブ番号(lane 内で一意)。lane 全体の出来事には付かない。 */
  id?: number;
  /** 何をしたか(`38KB` のような手掛かり)。 */
  note?: string;
  /** かかった時間(done / fail のみ)。 */
  ms?: number;
}

export interface LaneStats {
  lane: string;
  alive: boolean;
  /** まだ投げていない(起動待ちで溜まっている)。 */
  queued: number;
  /** 投げて返っていない。 */
  running: number;
  done: number;
  failed: number;
  /** 起動した回数(アイドル kill のたびに増える = 使い捨ての回数)。 */
  spawns: number;
  kills: number;
  /** 直近の所要時間の中央値(ms)。標本が無ければ null。 */
  medianMs: number | null;
  maxMs: number | null;
}

/** ログの本数。⚠ 伸ばすと可視化のほうが重くなる。 */
const LOG_CAP = 200;
/** 所要時間の標本数(中央値・最大を出すぶん)。 */
const SAMPLE_CAP = 50;

/**
 * 🔴 メッセージへ流す文の見出し語(設計 doc §7、段②b)。
 * ⚠ **正本はここ 1 か所**(かつて `settings.ts` の表示にだけ在ったものを移した)。
 */
const PHASE_LABEL: Readonly<Record<JobPhase, string>> = {
  spawn: '起動',
  enqueue: '受付',
  dispatch: '実行開始',
  done: '完了',
  fail: '失敗',
  kill: '終了(しばらく使われないため)',
  dispose: '破棄',
};

interface LaneState {
  alive: boolean;
  queued: number;
  running: number;
  done: number;
  failed: number;
  spawns: number;
  kills: number;
  samples: number[];
}

export class JobMonitor {
  private readonly log: JobEvent[] = [];
  private readonly lanes = new Map<string, LaneState>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(
    now: () => number = () => Date.now(),
    /**
     * メッセージの口(既定は `null` = 送らない)。⚠ **`appJobMonitor` だけ**
     * 末尾で `appMessagePost` を明示的に渡す ── 既定を real にしない理由は
     * 冒頭の docstring のとおり。
     */
    private readonly messagePost: Pick<MessagePost, 'post'> | null = null,
  ) {
    this.now = now;
  }

  /** 出来事を 1 件記録する。⚠ ここは**ホットパス**なので軽く保つ。 */
  record(lane: string, phase: JobPhase, opts: { id?: number; note?: string; ms?: number } = {}): void {
    const s = this.lane(lane);
    switch (phase) {
      case 'spawn':
        s.alive = true;
        s.spawns += 1;
        break;
      case 'enqueue':
        s.queued += 1;
        break;
      case 'dispatch':
        // ⚠ 起動待ちを経由せず直に投げた分もここへ来る ── 下振れさせない
        if (s.queued > 0) s.queued -= 1;
        s.running += 1;
        break;
      case 'done':
      case 'fail': {
        if (s.running > 0) s.running -= 1;
        if (phase === 'done') s.done += 1;
        else s.failed += 1;
        if (typeof opts.ms === 'number') {
          s.samples.push(opts.ms);
          if (s.samples.length > SAMPLE_CAP) s.samples.shift();
        }
        break;
      }
      case 'kill':
        s.alive = false;
        s.kills += 1;
        break;
      case 'dispose':
        s.alive = false;
        s.queued = 0;
        s.running = 0;
        break;
    }
    this.log.push({ at: this.now(), lane, phase, ...opts });
    if (this.log.length > LOG_CAP) this.log.shift();
    /**
     * 🔴 **メッセージ(種類「処理」)へも 1 件流す**(設計 doc §7、段②b)。
     * ⚠ 本文は入れない(`note` は既に内部の語だけ ── worker-lease.ts の
     *   `describe`/`sizeOf` が文字数しか渡さない)。`postMessage` 側が
     *   `sanitizeMessageText` を通すので、ここでは組むだけでよい。
     * ⚠ **束ねは呼び先(`MessagePost`)の仕事**。ここで間引かない
     *   (間引くと、束ねが「溜まっているか」を見誤る)。
     */
    if (this.messagePost) {
      const parts = [PHASE_LABEL[phase]];
      if (opts.note) parts.push(opts.note);
      if (typeof opts.ms === 'number') parts.push(`${opts.ms}ms`);
      this.messagePost.post({ kind: 'job', source: lane, text: parts.join(' ') });
    }
    for (const fn of this.listeners) fn();
  }

  /** いまの状態(lane 名順)。 */
  stats(): LaneStats[] {
    return [...this.lanes.entries()]
      .map(([lane, s]) => {
        const sorted = [...s.samples].sort((a, b) => a - b);
        return {
          lane,
          alive: s.alive,
          queued: s.queued,
          running: s.running,
          done: s.done,
          failed: s.failed,
          spawns: s.spawns,
          kills: s.kills,
          medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
          maxMs: sorted.length ? sorted[sorted.length - 1]! : null,
        };
      })
      .sort((a, b) => a.lane.localeCompare(b.lane));
  }

  /** 新しい順のログ(表示用)。 */
  recent(limit = LOG_CAP): JobEvent[] {
    return this.log.slice(-limit).reverse();
  }

  /** 変化の通知。返り値を呼ぶと解除。⚠ 購読側が**自分で間引く**こと。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private lane(name: string): LaneState {
    let s = this.lanes.get(name);
    if (!s) {
      s = { alive: false, queued: 0, running: 0, done: 0, failed: 0, spawns: 0, kills: 0, samples: [] };
      this.lanes.set(name, s);
    }
    return s;
  }
}

/**
 * アプリで 1 個だけ使う monitor。⚠ **注入もできる**ようにしておく
 * (test が実物を使えないと、可視化が壊れても誰も気づかない)。
 *
 * 🔴 **ここでだけ `appMessagePost` を明示的に渡す**(段②b)── 既定を real に
 *   しない理由は `JobMonitor` の docstring のとおり。本体で使う唯一の
 *   monitor だけが、実際にメッセージへ書く。
 */
export const appJobMonitor = new JobMonitor(undefined, appMessagePost);
