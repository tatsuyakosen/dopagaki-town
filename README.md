# DOPAGAKI TOWN

PLAYER vs PLAYER vs CITY — 街そのものが試合へ介入する、ローカルファーストのマルチプレイヤー鬼ごっこです。

現在のM8では、アカウント登録なしのGuest Modeから、固定Seedの3分デモまたは10分通常試合へ入城できます。最初のGuestが選んだモードをMatch ServerがRoom設定として確定し、後から参加するクライアントがSeedや試合時間を上書きすることはできません。

5km×5kmを250m角の400論理チャンクとして構成します。クライアントは進行方向の5×5を先読みし、3×3だけを低ポリ建物・簡略Colliderのactive範囲として実体化します。後方チャンクは破棄され、遠方参加者は441 nodeの広域道路グラフ上だけで更新されます。

Match Serverが移動、鬼、タッチ、鬼時間、勝敗、MapVersionを確定します。既定のFixture Directorまたは任意のGemini／ADK Director APIは最大3件の都市介入候補を生成し、VerifierがF-01〜F-08、A*経路探索、3戦略rolloutで検証して1件だけを採用します。外部応答はSeed、requestId、MapVersionを照合し、2回の再計画でも安全候補がなければFixtureへ戻ります。CITY COREは5秒以上前に範囲・理由・期待効果を告知し、`raise_barrier`、`open_alley`、`spawn_rooftop_bridge`をprepare後に一括commitします。クライアントchecksumが一致しない場合は直前の地図へrollbackします。

全員が1,000円を持って開始し、大阪・福島・天満・中崎町・京橋・西九条のFixture鉄道を利用できます。Seedから現実1秒＝ゲーム内6秒の時刻表を生成し、予約時の運賃hold、発車時の確定減算、乗り遅れ・取消時の解除を`reservationId`で冪等化します。乗車中はタッチ不可、到着後3秒間は保護されます。

ブラウザは`playerToken`をsession storageへ保持し、通信断またはreloadから30秒以内なら同じプレイヤーへ自動復帰します。切断中の人間は停止してタッチ対象外になり、鬼が切断した場合は10秒後にBotが引き継ぎます。入力sequence、event ID、MapVersionで再送を冪等化し、クライアント予測＋server reconciliation、10Hz snapshot、RTT P95診断を備えます。既定のローカル起動は外部サービスや秘密情報を使いません。

## 必要環境

- Node.js 22
- npm 10以降
- PCブラウザ（Chrome推奨）

外部APIキー、Docker、Google Cloud、Firestore Emulatorは不要です。

環境変数はすべて任意です。未設定時はMatch Serverのポート、3分デモ固定Seed、10分通常Seed、各試合時間、CITY CORE間隔、LOW描画倍率にコード内の既定値が使われます。上書き例は `.env.example` にあります。従来の`MATCH_SEED`と`MATCH_DURATION_MS`は通常試合の上書きとして引き続き利用できます。

## 起動

```bash
npm ci
npm run dev
```

表示された `http://localhost:5173` を開き、3分デモまたは10分通常を選んで「ゲストで入城する」を押します。メールアドレス、実名、外部ログインは不要です。

### 任意のDirector API

Director APIのFixture境界だけをcredential-freeで起動できます。別terminalで次を実行してから、Match ServerへHTTP adapterを指定します。Director APIがFixtureを返した場合も、最終的なfallback候補はMatch Serverが同じSeedからローカル生成します。

```bash
PORT=8080 DIRECTOR_PROVIDER=fixture npm run dev:director
DIRECTOR_ADAPTER=http DIRECTOR_URL=http://127.0.0.1:8080 npm run dev:server
```

実Gemini／ADKはDirector API processだけNode.js 24.13以上で起動し、`DIRECTOR_PROVIDER=gemini-adk`を設定します。Gemini APIの`GEMINI_API_KEY`、またはVertex AIの`GOOGLE_GENAI_USE_VERTEXAI=1`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`をversion管理外で渡します。未設定、timeout、不正JSON、Schema違反、Verifier全拒否では試合を止めずFixtureへ縮退します。

操作:

- `W` `A` `S` `D`: 移動
- `Shift`: ダッシュ
- `E`: 駅付近で次の便を予約／予約を取消
- `AI REPLAY`: CITY FEEDから監査ログを開き、候補拒否・採用・Rollback・鬼交代・鉄道・概算費用を確認
- タッチされた参加者が新しい鬼
- 鬼交代後3秒間は再タッチ不可
- 試合終了時に累計鬼時間が最も短い参加者が勝利

## 検証

```bash
npm run lint
npm run typecheck
npm run test:faults
npm test
npm run test:headless
npm run build
npm run test:e2e
```

全検証をまとめて実行する場合:

```bash
npm run verify:local
```

5km streaming、鉄道、都市介入、途中再接続を実時間10分間動かすM6 soak:

```bash
npm run test:soak:m6
```

同じブラウザとRoomで再試合を繰り返すM7連続soakは、先に約1分のharness smokeを実行します。提出gateは10分×20試合です。時間を短縮して継続劣化を確認する場合は、10分×10試合を`M7_SHORTENED` gateとして実行できます。

```bash
npm run test:soak:smoke
npm run test:soak -- --matches=10 --preset=LOW
npm run test:soak -- --matches=20 --preset=LOW
```

提出gateは実時間で約3時間20分、短縮gateは約1時間40分に加えて起動・集計時間が必要です。通常の`verify:local`には含めません。各試合で終了、Seed更新、同一player維持、MapVersion進行、checksum一致、rollback 0、残高非負を確認します。10分LOW実行では試合数にかかわらず、全体で平均20fps以上、下位10%点18fps以上、先頭3試合と末尾3試合のheap増加64MB未満、loaded最大25／active最大9を自動判定します。中間試合では通信断も1回注入します。`M7_SHORTENED`は提出gate完了の代替にはなりません。

実行中は`M7_CONTINUOUS_SOAK_PROGRESS`として試合開始・完了と既定60秒ごとのheartbeatを出力します。現在の試合番号、Seed、全体／試合経過時間、sample進捗、直近のFPS・heap・chunk・reconciliationをJSONで確認できます。間隔は例として`--progress-ms=30000`のように変更できます。

E2Eは試合時間とCITY CORE間隔を短縮した専用Match Serverを起動し、システムのGoogle ChromeをHeadlessで操作します。Guest Mode、サーバー確定のデモ設定、独立した2 browser contextでの同期、鉄道予約、通信断からの自動復帰、reload後の同一player復帰、乗車・到着、AI Replayの候補拒否・採用・鉄道監査、5km移動、CITY CORE警告、patch適用、checksum一致、試合終了までを検証します。

### 必須異常系 T-01〜T-10

`npm run test:faults`は、要件定義書の必須異常系だけを個別に実行します。`verify:local`にも同じgateを含めています。

| ID | 注入する障害 | サーバー／game-coreの期待結果 | 自動テスト |
|---|---|---|---|
| T-01 | 同一tickで鬼が2人の逃走者へ接触 | 鬼交代eventは1件、鬼は常に1人 | `packages/game-core/test/game.test.ts` |
| T-02 | 運賃未満の残高で予約 | 予約拒否、残高不変、徒歩継続 | `packages/game-core/test/game.test.ts` |
| T-03 | 予約直後に切断・再接続 | holdと`reservationId`を重複・消失させない | `apps/match-server/test/room.test.ts` |
| T-04 | 乗車中のRoom checkpointを復元 | 到着時刻、残高、交通状態を維持 | `apps/match-server/test/room.test.ts` |
| T-05 | 駅構内を対象にするPatch候補 | F-06で拒否し、安全な別候補を採用 | `packages/verifier/test/verifier.test.ts` |
| T-06 | 1人だけの最短経路を50%以上悪化 | F-04で拒否し、安全な別候補を採用 | `packages/verifier/test/verifier.test.ts` |
| T-07 | 古い`baseMapVersion`／再利用`patchId` | 状態を変えずVERSION／DUPLICATEとして拒否 | `packages/verifier/test/verifier.test.ts` |
| T-08 | クライアントchecksumを改変 | 直前MapVersionへRollback | `packages/game-core/test/game.test.ts` |
| T-09 | Director timeout／不正JSON | 同じSeedのルールベースFixtureへfallback | `packages/verifier/test/verifier.test.ts` |
| T-10 | Transit Adapter timeout | 6駅のFixture Graphへfallbackし試合を継続可能 | `packages/transit-core/test/transit.test.ts` |

## トラブルシュート

| 症状 | 確認と対処 |
|---|---|
| `npm run dev`直後も`SERVER OFFLINE`と表示される | Node.js 22を使用し、Match Serverのport 3001が空いているか確認します。別portを使う場合は`PORT`と`VITE_MATCH_PORT`を同じ値にします。 |
| ブラウザをreloadすると`SESSION EXPIRED`になる | 再接続windowは30秒です。再度「ゲストで入城する」を押すと新しい参加者として開始します。 |
| 鉄道ボタンが有効にならない | 駅から180m以内へ移動し、残高と次の便を確認します。駅付近ではボタンまたは`E`キーで予約できます。 |
| E2EがChrome executableエラーで開始しない | `/usr/bin/google-chrome`を利用できるPC環境で実行するか、Playwright設定の`executablePath`を手元のChromeへ合わせます。 |
| FPSが20を下回る | `.env.example`の`VITE_RENDER_SCALE`を大きくして内部解像度を下げ、Chrome以外の重いタブを閉じます。LOWでは影を使用しません。 |
| portを変更したらクライアントだけ接続できない | `VITE_MATCH_WS_URL=ws://127.0.0.1:<port>/ws`を明示し、clientを再起動します。 |

## 既知の制約

- ローカルMatch Serverは単一のin-memory Roomです。マッチメイク、複数Room、ランキングは対象外です。
- Room checkpointは同一プロセス内の復元用です。Match Serverプロセス再起動後の永続復旧は未対応です。
- Directorと鉄道は既定で決定論的Fixtureを使用します。Gemini／ADK Directorは任意のfeature flagであり、実ダイヤ、遅延・運休、駅すぱあとMCPにはまだ接続しません。
- 都市はLOW向け低ポリ表示です。大阪Photorealistic 3D Tilesと駅構内3Dは未統合です。
- 操作対象はPCブラウザとキーボードです。モバイル操作、ゲームパッド、音声チャットは対象外です。
- 外部APIキー、Docker、Google Cloud、Firestore Emulatorを使わないローカルMVPです。

## 構成

```text
apps/game-client       Babylon.jsによる低ポリ都市とHUD
apps/match-server      authoritative WebSocket Match Server、再接続session、Room checkpoint
apps/director-api      Fixture／Gemini ADK切替、2回再計画、HTTP境界
packages/contracts     ZodによるRuntime Schema
packages/game-core     決定論的なゲームルールとBot
packages/transit-core  Fixture Transit Graph、Seed時刻表、外部adapter fallback
packages/verifier      F-01〜F-08検証、A*、rollout、Fixture Director
packages/world-core    400チャンク、広域道路グラフ、streaming、Patch commit
tests/e2e              ブラウザ操作の受入テスト
tests/soak             5km streamingの実時間10分性能試験
```

ローカルMVPを外部サービスから独立させるため、Directorと鉄道は固定SeedのFixtureを既定値とします。生成AI、駅すぱあとMCP、永続化はM7のローカル提出品質が合格した後に既存adapter境界へ追加します。
