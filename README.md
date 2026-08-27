# DOPAGAKI TOWN

PLAYER vs PLAYER vs CITY — 街そのものが試合へ介入する、ローカルファーストのマルチプレイヤー鬼ごっこです。

現在のM4縦切りでは、5km×5kmを250m角の400論理チャンクとして構成します。クライアントは進行方向の5×5を先読みし、3×3だけを低ポリ建物・簡略Colliderのactive範囲として実体化します。後方チャンクは破棄され、遠方参加者は441 nodeの広域道路グラフ上だけで更新されます。

Match Serverが移動、鬼、タッチ、鬼時間、勝敗、MapVersionを確定します。Fixture Directorは最大3件の都市介入候補を生成し、VerifierがF-01〜F-08、A*経路探索、3戦略rolloutで検証して1件だけを採用します。CITY COREは5秒以上前に範囲・理由・期待効果を告知し、`raise_barrier`、`open_alley`、`spawn_rooftop_bridge`をprepare後に一括commitします。クライアントchecksumが一致しない場合は直前の地図へrollbackします。外部サービスや秘密情報は使いません。

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

5km streamingと都市介入を実時間10分間動かすM4 soak:

```bash
npm run test:soak:m4
```

E2Eは試合時間とCITY CORE間隔を短縮した専用Match Serverを起動し、システムのGoogle ChromeをHeadlessで操作します。入城、2クライアント同期、5km横断、CITY CORE警告、patch適用、checksum一致、試合終了までを検証します。

## 構成

```text
apps/game-client       Babylon.jsによる低ポリ都市とHUD
apps/match-server      authoritative WebSocket Match Server
packages/contracts     ZodによるRuntime Schema
packages/game-core     決定論的なゲームルールとBot
packages/verifier      F-01〜F-08検証、A*、rollout、Fixture Director
packages/world-core    400チャンク、広域道路グラフ、streaming、Patch commit
tests/e2e              ブラウザ操作の受入テスト
tests/soak             5km streamingの実時間10分性能試験
```

ローカルMVPを外部サービスから独立させるため、生成AI、鉄道、永続化は今後adapterとして追加します。M4のDirectorは固定seedで再現できるローカルfixtureです。
