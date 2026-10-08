# Office(LibreOffice wasm)の固まり・停止を割る probe

Office の窓で、文書を開いて決まった操作を当て、**固まったか / 落ちたか / どこで止まったか**を記録する道具一式
(#1408 / #1402 の stack はこれで取った)。1 本ずつ実ブラウザ(Playwright の Chromium)を起こし、
並列に何十本も回して「何本中何本で起きたか」を数えるために使う。

⚠ 一式(Office の本体)と文書は repo に入っていない。下の手順で用意する。

## 用意するもの

1. **一式(pack)**: Office を焼いた release 資産を落として、配布用の形に組む。
   手順は `.claude/skills/office-oracle/SKILL.md` §1(`curl` で落とす。tag は焼きの種類で変わる)と、
   `node build/office-wasm/make-pages-bundle.mjs <展開した dir> <出力先>`。出力先がそのまま `PKC3_PROBE_PACK` になる
   (中に `pack.json` が在る dir)。
2. **文書(fixture)**: `$PKC3_PROBE_DIR/fx/` に置く。サンプルの jobs が使う `slide.odp` は自作できる:
   `mkdir -p fx && python3 build/office-wasm/probe/make-odp.py fx/slide.odp`
3. **chromium**: 既定は `/opt/pw-browsers/chromium`。違う物を使うなら `PKC3_CHROMIUM=<path>`。
   Playwright は repo の `node_modules` の物を使う(`npm ci` 済みであること)。

## 回し方

1 本(タグ `t1`、文書 `slide.odp`、手順は JSON):

    export PKC3_PROBE_DIR=/tmp/probe-work PKC3_PROBE_PACK=/tmp/lo-pack PKC3_PROBE_OUT=/tmp/probe-out
    build/office-wasm/probe/go.sh t1 slide.odp '[{"press":"Tab","wait":2000,"name":"Tab"}]'

複数本を並列で(jobs file の各行 = `tag<TAB>doc<TAB>steps-json`。最後の数が同時に走らせる本数、既定 3):

    build/office-wasm/probe/batch.sh build/office-wasm/probe/jobs-sample.txt "" 3

`jobs-sample.txt` は例(タグ `sample-1..3`。File メニューから「閉じる」を押す手順)。
手順の書き方は `run.mjs`: `click` `[x,y]` / `dbl` / `press` / `type` / `seed` `seedhtml` `readclip`(クリップボード)に、
`wait`(ms)`shot`(撮る名前)`name` を付ける。⚠ 座標は 1280x800 の画面基準。

`go.sh` は 1 本 500 秒で打ち切る。

## 環境変数

| 名前 | 意味 |
|---|---|
| `PKC3_PROBE_DIR` | 作業 dir。既定はカレント。文書は `$PKC3_PROBE_DIR/fx/` |
| `PKC3_PROBE_PACK` | 一式の dir(`go.sh` / `batch.sh` で PACK を省いたとき) |
| `PKC3_PROBE_OUT` | 出力先。既定 `$PKC3_PROBE_DIR/logs` |
| `PKC3_JSBEAT=<ms>` | main の JS が生きているかの鼓動を、その間隔で console に出す |
| `PKC3_STACKDUMP=1` | 固まったとき main の stack を取る(CDP の pause)|
| `PKC3_STACKDUMP=all` | 上に加えて、worker(Office 本体のスレッド)にも attach して全部の stack を同時に取る |
| `PKC3_CHROMIUM` | chromium の実行 file |
| `CONSOLE_LOG` | console を書き出す file(`go.sh` が自動で設定する) |

## 出力(`$PKC3_PROBE_OUT`)

- `TAG.json` ── 手順ごとの観測(生きているか / 窓の数 / 版面の hash / 落ちた形 `faults`)
- `TAG.console.log` ── console の行(非 ASCII の行は捨てる)。`[STEP @時刻] 手順の名前` が手順の境目
- `TAG.log` ── run 自体の出力。最後の `exit=N`(124 は時間切れ)と、完走したときの `done`
- `shots/TAG-*.png` ── 手順ごとの画面

console.log の印の読み方:

| 印 | 意味 |
|---|---|
| `PKC3-JSBEAT #n` | main の JS の鼓動。止まれば main の JS が止まっている |
| `PKC3-STACKDUMP …` | 固まったと判断した時点の stack(`#0 $funcN …` が上から)|
| `PKC3-STACKDUMP-ALL … sessions=N` | `all` のとき、取れた target の数。`NO PAUSE` は止められなかった(待ち中か休み中) |
| `PKC3-YIELDWAIT: enter / leave` | main が Office 本体の処理を待った区間。`waited=ms` が待ち時間 |
| `PKC3-TIMERMUTEX: skipped / ran under mutex` | タイマーの処理を本体が使っている間は見送った回数 |
| `PKC3-TASKGONE` `LAYOUTGUARD` `TOOLTIPGUARD` `VIEWDATAGONE` `GRIPGUARD` | 各 patch の門が働いた印 |

印は、その印を入れた焼きの一式でしか出ない。出ていなければ「その門に入らなかった」か「その焼きではない」。

## stack を名前に解く

dump の `$funcN` は番号だけ。名前は**名前つきで焼いた同じ版(`lo_sha` が同じ)の一式**から引く。

    # 1. dump に出た番号を集める
    grep -o '\$func[0-9]*' out/t1.console.log | sed 's/\$func//' | sort -un > idx.txt
    # 2. 名前の表にする(番号<TAB>名前)
    python3 build/office-wasm/wasm-names.py --wasm names-pack/soffice.wasm --lo-sha <dump を取った一式の lo_sha> $(cat idx.txt) > names.tsv
    # 3. dump の行に名前を足して読む
    python3 build/office-wasm/probe/resolve-dump.py names.tsv out/t1.console.log

⚠ 計装を足した一式は、途中の範囲から番号が名前つき一式と 1 つずれることがある(#1408 の dump では −1)。
既に名前が分かっている関数(`QtTimer::timeoutActivated` など)が正しく出るかで確かめ、ずれているときは
手順 2 の番号に同じ数を足してから表を作り、手順 3 の末尾にその数を渡す(`resolve-dump.py names.tsv log -1`)。
範囲ごとに違うずれは 1 つの数では直らない ── 出た名前が呼び出しとして自然かを見る。

`wasm-funcs.py --wasm soffice.wasm <offset>` は、CDP の `columnNumber`(wasm 内のバイト位置)から `wasm-function[N]` を引く。

## 集計

並列に回した群を数える(落ちた形の表 / 印の本数 / YIELDWAIT の桁の検算 / waited の分布 / 固まった run の読み):

    PKC3_PROBE_OUT=/tmp/probe-out python3 build/office-wasm/probe/report.py <tag の前置き> [<対照群の前置き>]

前置き `y9-IDm` は tag `y9-IDm-1`, `y9-IDm-2` … を拾う(末尾が `-数字` の tag だけ)。
`4-after6s` の shot を最後の手順の目印にしているので、`jobs-sample.txt` と同じ形の手順で使うこと。
