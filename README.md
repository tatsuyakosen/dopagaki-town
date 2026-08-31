# DOPAGAKI TOWN

PLAYER vs PLAYER vs CITY — 街そのものが試合へ介入する、ローカルファーストのマルチプレイヤー鬼ごっこです。

現在のM6縦切りでは、5km×5kmを250m角の400論理チャンクとして構成します。クライアントは進行方向の5×5を先読みし、3×3だけを低ポリ建物・簡略Colliderのactive範囲として実体化します。後方チャンクは破棄され、遠方参加者は441 nodeの広域道路グラフ上だけで更新されます。

Match Serverが移動、鬼、タッチ、鬼時間、勝敗、MapVersionを確定します。Fixture Directorは最大3件の都市介入候補を生成し、VerifierがF-01〜F-08、A*経路探索、3戦略rolloutで検証して1件だけを採用します。CITY COREは5秒以上前に範囲・理由・期待効果を告知し、`raise_barrier`、`open_alley`、`spawn_rooftop_bridge`をprepare後に一括commitします。クライアントchecksumが一致しない場合は直前の地図へrollbackします。

全員が1,000円を持って開始し、大阪・福島・天満・中崎町・京橋・西九条のFixture鉄道を利用できます。Seedから現実1秒＝ゲーム内6秒の時刻表を生成し、予約時の運賃hold、発車時の確定減算、乗り遅れ・取消時の解除を`reservationId`で冪等化します。乗車中はタッチ不可、到着後3秒間は保護されます。

ブラウザは`playerToken`をsession storageへ保持し、通信断またはreloadから30秒以内なら同じプレイヤーへ自動復帰します。切断中の人間は停止してタッチ対象外になり、鬼が切断した場合は10秒後にBotが引き継ぎます。入力sequence、event ID、MapVersionで再送を冪等化し、クライアント予測＋server reconciliation、10Hz snapshot、RTT P95診断を備えます。外部サービスや秘密情報は使いません。

## 必要環境

- Node.js 22
- npm 10以降
- PCブラウザ（Chrome推奨）

外部APIキー、Docker、Google Cloud、Firestore Emulatorは不要です。

環境変数はすべて任意です。未設定時はMatch Serverのポート、固定Seed、10分試合、CITY CORE間隔、LOW描画倍率にコード内の既定値が使われます。上書き例は `.env.example` にあります。

## 起動

```bash
npm ci
npm run dev
```

表示された `http://localhost:5173` を開き、「入城する」を選択します。

操作:

- `W` `A` `S` `D`: 移動
- `Shift`: ダッシュ
- `E`: 駅付近で次の便を予約／予約を取消
- タッチされた参加者が新しい鬼
- 鬼交代後3秒間は再タッチ不可
- 試合終了時に累計鬼時間が最も短い参加者が勝利

## 検証

```bash
npm run typecheck
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

E2Eは試合時間とCITY CORE間隔を短縮した専用Match Serverを起動し、システムのGoogle ChromeをHeadlessで操作します。独立した2 browser contextでの同期、鉄道予約、通信断からの自動復帰、reload後の同一player復帰、乗車・到着、5km移動、CITY CORE警告、patch適用、checksum一致、試合終了までを検証します。

## 構成

```text
apps/game-client       Babylon.jsによる低ポリ都市とHUD
apps/match-server      authoritative WebSocket Match Server、再接続session、Room checkpoint
packages/contracts     ZodによるRuntime Schema
packages/game-core     決定論的なゲームルールとBot
packages/transit-core  Fixture Transit Graph、Seed時刻表、外部adapter fallback
packages/verifier      F-01〜F-08検証、A*、rollout、Fixture Director
packages/world-core    400チャンク、広域道路グラフ、streaming、Patch commit
tests/e2e              ブラウザ操作の受入テスト
tests/soak             5km streamingの実時間10分性能試験
```

ローカルMVPを外部サービスから独立させるため、Directorと鉄道は固定SeedのFixtureを既定値とします。生成AI、駅すぱあとMCP、永続化はM7のローカル提出品質が合格した後に既存adapter境界へ追加します。
