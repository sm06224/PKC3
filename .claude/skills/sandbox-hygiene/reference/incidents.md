# sandbox-hygiene の経緯と実測

本体 `SKILL.md` から退避した経緯・実測・手順(2026-11-22 のスリム化。知見は削らずにここへ移した)。

### 🔴 作り直しの引き金は**ディスク**らしい ── 落としたら消す

4 回目の直後に測ったら **`/tmp` に 11 GB** 溜まっていた(過去のビルド試行の
`qt-host` 2.2G / `lo-core` 2.0G / `emsdk` 1.4G / `qt-wasm` 986M …、加えて
LO の一式 4 本)。この箱の書き込み領域は**セッションごとの固定枠**で、
`df` は「Used 19G / Avail 19G」= **枠の半分**を示していた。掃除して
**8.3 GB 解放(51% → 29%)**。

⚠ **`df` の見かけに騙されない** ── 「252G 中 19G 使用」に見えても、
効いているのは**枠**のほうである。

🔑 規律: **一式(数百 MB)は「落とす → 測る → 消す」を 1 セットにする。**
測り終えた `/tmp/lo-*` を残さない。ビルド木(`lo-core` / `qt-*` / `emsdk`)も
用が済んだら消す ── **次に要るときは取り直せる**。

戻し方:

```bash
git fetch --prune origin
git checkout -B <branch> origin/<branch>
ls node_modules/.bin/vitest >/dev/null 2>&1 || npm ci
```

## 🔴 probe は **repo の外を cwd にして**走らせる(2026-09-16)

`cd /home/user/PKC3 && node probe.mjs` で DuckDB の probe を回したら、
その中の **`COPY (…) TO 'out.csv'`** が **repo の中に本物の file を書いた**
(`out.csv` / `tmp_out.csv` が untracked で残り、stop hook が拾って初めて気づいた)。

⚠ **「器の中の file」だと思っていた物が、実 FS に落ちる**のが罠である ──
wasm の VFS は runtime によって実 FS へ写る(node では写る)。
⚠ 同じ形は sqlite(`ATTACH 'x.db'`)・Office(書き出し)・playwright(screenshot /
trace / video)にも在る ── **相対 path を渡す probe は全部これ**である。

🔑 **手順は 1 つ:probe は scratchpad を cwd にして打つ。**

```bash
cd "$SCRATCH/ddb" && timeout -k 5 100 node probe.mjs > probe.log 2>&1; echo "exit=$?"
```

⚠ 🔑 **repo の絶対 path で import するのは構わない**
(`import x from '/home/user/PKC3/node_modules/…'`)── 危ないのは**書き出しの相対 path**で、
それを決めるのは **cwd** である。

⚠ `.gitignore` に足して隠さない ── 症状が見えなくなるだけで、**次は別の名前で落ちる**。

### 🔴 **同じ日の 2 時間後に、また踏んだ**(2026-09-16、#682 段④c)

⚠ 上の節を書いた本人が、**その 2 時間後**に `cd /home/user/PKC3 && npx tsx probe.mjs` で
DuckDB の probe を回し、`COPY (…) TO 'out.parquet'` が **`out.parquet` / `ref.parquet` を
repo の中に書いた**(`git status` の untracked で気づいた ── 危うく `git add -A` で
commit するところだった)。

🔑 **覚えていたのは「話」であって、「書いている今がその場面だ」とは気づかない**
(CLAUDE.md §1 の 10 度目と同じ形)。だから**合図を時点で書く**:

> 🔴 **`node` / `npx tsx` で probe を打とうとした瞬間に、`cd` の行き先を見る。**
> 行き先が repo なら、**その場で scratchpad へ書き換える。**

⚠ **`npx tsx` は `cd` を変えると解決が壊れることがある** ── scratchpad を cwd にすると
`node_modules` を見失う。🔑 そのときは **cwd は scratchpad のまま、`--tsconfig` や
絶対 path の import で解決を repo へ向ける**(逆にしない ── 書き出しのほうが危ない)。

### 🔴 同期で取りに行く相手に、**同じプロセスの server を立てない**(2026-09-16)

DuckDB(node 版)へ拡張を配るために、**同じ probe の中で** `http.createServer` を
立てたら **120 秒で 1 行も返らず、殺すまでぶら下がった**。

⚠ 原因は簡単で、**engine が同期(blocking)で取りに行く**からである ── 同じ event loop に
居る server は、その間 1 バイトも応答できない(**自分で自分を待つ**)。
🔑 **server は別プロセスで立てる**(`spawn(process.execPath, ['-e', SERVER, ROOT])`、
port は `0` にして stdout で受け取る)。
⚠ 同じ形は **wasm の同期 XHR を使う相手**全部に在る(LibreOffice wasm・sqlite の
同期 VFS)── 「取りに行く側が同期か」を先に問う。

⚠ そして **`happy-dom` の `XMLHttpRequest` を掴ませない** ── vitest の既定環境では
node 版 DuckDB が happy-dom の XHR を掴み、「同期の要求で `responseType` は変えられない」で
落ちる。🔑 その test file には **`/** @vitest-environment node *\/`** を書く。

### 🔴 worktree だけではない ── scratchpad と `/tmp` の「落とした物」が枠を使い切る(2026-10-06 実測)

症状は 2 つの顔で出た:① `isolation: "worktree"` の起動が
`error: unable to write file 'tests/…'` / `fatal: Could not reset index file` で落ちる
② 走っていた runner が「`tasks/` が満杯(0MB)で全部 `ENOSPC`」と**何も回せずに**戻る。
`df` は **Avail 6.5M / 100%**(Used 39G ── 枠は 40G 弱と読める)。

何が食っていたか(`du` は**全体に掛けると 120 秒で終わらない** ── 深さ 2 で止める):

| 置き場 | 中身 | 量 |
|---|---|---|
| `scratchpad/` | LO の一式の zip 2 本 / 一式を展開した probe 用の木 10 本(`121h`〜`121r`)/ 作業ツリーの複製(`682` `merge`) | **約 900MB** |
| `/tmp/lo-ar` `/tmp/lo-1228-x` | LO の調査で落とした一式 | **740MB** |
| `/tmp/playwright-transform-cache-0` / `/tmp/node-compile-cache` | 再生成される cache | **830MB** |
| `/tmp/pkc3-*` | smoke が置いた profile / site | 100MB × 3 |
| `.claude/worktrees/agent-*` | runner の複製(`node_modules` 込み) | 720MB / 本 |

🔑 **全部「落とし直せる物」である** ── 消す順は **worktree の残骸 → `/tmp/lo-*` →
scratchpad の一式 / 展開した木 → cache**。これで **6.5M → 5.1G** に戻った。
⚠ `git worktree remove --force` が `Directory not empty` で断ることがある(終わった
エージェントの `node_modules` の symlink)── `rm -rf` してから `git worktree prune`。
⚠ 枠が尽きると**途中で落ちた worktree の残骸**(`agent-<id>/` の一部と
`worktree-agent-<id>` branch)も残るので、それも消す。

🔑 **合図を 1 つ足す**:**一式(数百 MB)を落としたら、その issue が済んだ時点で消す**
(上の「測ったら消す」と同じ)── ⚠ この日は 2 週間前の一式が 10 本以上残っていた。
runner を 1 本投げるたびに 700MB 要るので、**投げる前に `df -h /` を 1 行見る**。

### 🔴 `/tmp` の **24 GB** は vitest の捨て忘れだった ── 殺した走りの数だけ 84 MB 残る(2026-10-07 実測)

上の表(2026-10-06)の翌日、空きが **1.1 GB** まで減った。`du -sh /tmp` は **25 GB**。
中身は **ランダムな名前(nanoid 21 字)のディレクトリが 1,755 本**、どれも `client/` と `ssr/`
(sha1 名の file)を持ち、1 本 **84 MB**(`client` 60 + `ssr` 25)。

| 何か | vitest 5(`node_modules/vitest/dist/chunks/index.*.js`)の **プロジェクトごとの一時置き場** `join(tmpdir(), nanoid())` ── 変換した module の source を `<env>/<sha1>` に書く |
|---|---|
| **いつ消えるか** | `project.close()` の `rm(tmpDir)` **だけ** |
| **なぜ残るか** | 走りが **途中で殺される**と `close()` が来ない ── `timeout -k` / 箱の作り直し / 背景で回して放置 / `pkill` / `npm test` を中断。⚠ **1 回の `npm test` ごとに 1 本**なので、変異試験や smoke の build + test の対でもっとも速く溜まる |
| 今回 | 10/01〜10/07 の 6 日で 1,755 本 = **約 24 GB**(`/tmp` の 25 GB のうち) |

🔑 消し方(走っている vitest が無いことを `pgrep -c -f 'vite[s]t'` で見てから):

```bash
for x in /tmp/*; do [ -d "$x" ] || continue
  case "$(ls -A "$x" | tr '\n' ' ')" in "ssr "|"client "|"client ssr "|"ssr client ") rm -rf "$x";; esac
done
```

⚠ `ls -A` の中身で見分ける(名前は読めない)── `client` **だけ**の物(22 MB)も在る。
⚠ `du -sh /tmp/*` は上位 25 本しか見ないと **84 MB × 23 本** にしか見えず、**残り 1,700 本**が
見えない ── 「大きい物」ではなく「**同じ形の物の数**」で読む
(`ls /tmp | sed 's/[0-9A-Za-z_-]\{15,\}/X/g' | sort | uniq -c`)。
🔑 **箱が作り直される引き金はディスク**(上の節)なので、**test を背景で回して殺した日は、
この掃除を同じ日に 1 回**やる。

### ⚠ **同じセッションの中でも起きる**(2026-09-16、2 度目)

⚠ 上は「前のセッションの残骸」だが、**同じセッションの 2 時間半前の走り**でも同じである ──
`g-full.log` という名前を使い回し、**05:52 に走らせた**つもりで **03:26 の中身**を読んだ。
🔴 **そこには「590 passed / 10853」と書いてあり、いまの木では通らない古い件数だった**
(その日の木では 591 / 10893 ── 件数は毎日動くので、見るのは「減ったか」だけ)── ⚠ **件数が「減った」形**に見えるので、CLAUDE.md §9 の
「検査が消えた」と読み違える向きに効く。

🔑 気づけたのは `ls -la --time-style=full-iso` の**1 回**である。
🔑 **手順にする:log を読む前に、その file の mtime を見る** ── 走らせた時刻より
**前**なら、それは前の走りである(中身をどれだけ読んでも見分けは付かない)。

### 🔴 背景で起動した重い物を、**4 時間半止め忘れた**(2026-09-15)

⚠ 下の 2 つは「**探し方 / 殺し方**」の話だが、こちらは**そもそも止めるのを忘れた**話である。

実測:`node tests/probe/run-duckdb-memory-probe.mjs --rounds=3`(pid 2516)が
**14:04 から 18:15 まで**生き続け、配下に chromium 群を抱えていた
(`/proc/2516/cwd` は `/home/user/PKC3`、elapsed 14,962 秒)。

🔴 **害は「箱が遅くなる」ではない ── 測定を汚した。**
#878(メインスレッドの停止時間。超過はこれまで **3ms と 18ms**)の全量 smoke を、
**「箱が静かなときに」という条件を自分で書いたうえで**回したのに、
その条件が**実は満たされていなかった**。

🔑 **気づけたのは、依頼文に「回す前に箱で何が走っているかを見て、報告に書け」と
入れておいたからだけ**である。⚠ 入れていなければ、
「**全量でも落ちませんでした**」という**嘘に近い結論**がそのまま issue に残った。

⚠ そして**捨てる判断も要る** ── 結果が「通った」だったので
「混んでいたのに通ったのだから、むしろ強い証拠だ」と読みたくなるが、
🔴 **それは結果を見てから判定規則を緩めること**である(CLAUDE.md §4)。
回し直したら、**静かな箱のほうが値が高かった**(`over` 25/23 → 26/35)──
混雑を主因とする読みは、実測で支持されなかった。

#### 手順(3 つ)

1. 🔑 **背景で重い物を起動したら、その turn のうちに「終わったか」を確かめる**
   ── ⚠ とくに**入れ子の背景実行**(自分で `&` した物)は完了通知が当てにならない
2. 🔑 **止めるのはハーネスの口(`TaskStop`)** ── 🚫 名前走査で探さない(下の節)。
   pid が分かっているなら **pid を名指しで** `/proc/<pid>/cmdline` を読む
3. 🔑 **時間を測る検査の前に、箱の状態を記録に残させる**(`uptime` + 走っている重い物)
   ── ⚠ 書かせないと、**混雑した回の値が、静かな回の値として台帳に残る**

### ⚠ 「走っているエージェントが居ない」は `pgrep` では確かめられない

`pgrep -af "vite[s]t|playwright"` は**自分の命令行に当たる**(CLAUDE.md §6 ──
ブラケットを入れても、`|` で並べた**別の語**が素通りする)。
🔑 **cwd で引く**:

```bash
for p in /proc/[0-9]*; do
  cw=$(readlink "$p/cwd" 2>/dev/null) || continue
  case "$cw" in */\.claude/worktrees/*) echo "$p $cw";; esac
done
```

⚠ 0 件を確かめてから消す ── 走っている最中の `node_modules` を抜くと、
そのエージェントは**原因の分からない失敗**を返す。

### 🔴 殺すときは、**自分と親を除く**(2026-09-14 に踏んだ ── 同じ罠の 3 度目)

上の「cwd で引く」は**探す**ための形である。⚠ そのまま**殺す**側へ持っていくと落ちる ──

```bash
# 🚫 これは自分ごと死ぬ(exit 144)
for p in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < "$p/cmdline"); case "$c" in *"vitest list"*) kill "${p#/proc/}";; esac
done
```

🔑 **理由は 1 つ:探す語を書いた行そのものが、自分の `cmdline` に入っている。**
⚠ `pkill -f` のブラケット逃れ(`vite[s]t`)は**引数の中の語**にしか効かない ──
`/proc` を自分で走査する形では、語は**この shell の命令行に丸ごと**在るので、
どんな書き方をしても自分に当たる。

🔑 **除くのは 2 つ**:

```bash
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" = "$$" ] && continue          # 自分
  [ "$pid" = "$PPID" ] && continue       # 包んでいる shell
  ...
done
```

## 🔴 孫は名前が違う ── 親を止めても生き残る(2026-09-16。実測)

⚠ 上は「**自分を殺さない**」話だが、こちらは「**相手を殺しきれない**」話である。

`npx vitest` を回すと、木はこう伸びる:

```
npx → sh -c vitest → node …/vitest → forks.js × N   ← worker
```

🔴 **worker の命令行は `forks.js` で、`vitest run` の字を持っていない。**
だから `vitest run` で探して止めても、**worker は名前が違うので残る**。

実測の被害(2026-09-16):

| | 値 |
|---|---|
| 居残った worker | **4 本**(38 / 34 / 29 / 21 分) |
| load average | 🔴 **11.5**(4 コア = **3 倍の過負荷**) |
| その状態で回した全量 | 🔴 **24 件落ち。うち 23 件が `Test timed out in 5000ms`** |
| 静かな箱で回し直し | 🟢 **439 件すべて緑・16.79 秒** |

⚠ **23 件は無関係な 17 file に散っていた**ので、**製品の欠陥に見えた**
── 1 つの欠陥が無関係な 17 file を同時に壊すことはない、が見分ける鍵である。

🔑 **直しは「名前で探すのをやめる」** ── 子に**自分の process group** を持たせて、
**group ごと**殺す。これで「孫は名前が違う」問題が**構造から消える**:

```python
proc = subprocess.Popen(cmd, shell=True, start_new_session=True, ...)   # 🔑 group の長にする
try:
    out, err = proc.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    for sig in (signal.SIGTERM, signal.SIGKILL):      # ⚠ TERM → 待つ → KILL
        os.killpg(os.getpgid(proc.pid), sig)
        ...
```

⚠ **`start_new_session=True` が無いと `killpg` は自分たちまで巻き込む。**
🔑 雛形は `.claude/skills/mutation-testing/templates/mutate.py` の `run()` に入れてある。

### ⚠ 測り方でも 2 度外した(計器の側)

「本当に孫まで死ぬか」を測る probe が **2 稿とも空振り**した:

| 稿 | 何が起きたか |
|---|---|
| 1 | `sh -c "<単一命令>"` は **exec するので木が伸びない** ── 孫が生まれず、対照群が回ごとに 1 本 / 0 本とぶれた |
| 2 | `exec -a` は **dash に無い** ── 🔑 **前提の assert が「判定不能」と言って、嘘の数字を止めた** |
| 3 | `& wait` で fork させ、**孫の PID を控えて生死を直に見る** → **直す前 1 本残る / 直した後 0 本** |

🔑 **`& wait` が要る** ── 孫を作る fixture は、**fork を強制**しないと成立しない。
🔑 そして**数で数えず PID で見る** ── 名前で数えると、自分や別の残骸に当たる。

⚠ **いちばん良いのは殺さないこと** ── 背景で回した物の完了は**通知で届く**ので、
待ちも後始末も要らない(CLAUDE.md「`sleep` / ポーリングで待たない」)。
⚠ それでも殺すなら、**掴んでいる資源で引く**(`ss -ltnp` の port / `/proc/*/cwd`)──
名前で引く限り、この罠は形を変えて戻ってくる。

### ⚠ worktree が指定 branch を掴んでいて checkout できないことがある

終わったエージェントの worktree が `claude/<branch>` を持ったままだと、
`git checkout <branch>` が **`is already used by worktree at …`** で断られる。
🔑 **`git switch --ignore-other-worktrees <branch>`** で通る(worktree を消さなくてよい)。
