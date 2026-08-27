# DOPAGAKI TOWN

PLAYER vs PLAYER vs CITY — 街そのものが試合へ介入する、ローカルファーストのマルチプレイヤー鬼ごっこです。

現在のM2縦切りでは、500m×500mの3×3低ポリ街区へブラウザから1人で入場するとRival Botが3体補充されます。Match Serverが移動、鬼、タッチ、鬼時間、勝敗、MapVersionを確定し、CITY COREは予告隆起後に道路障害物を切り替えます。Botは5×5交差点の道路グラフをA*で移動し、改築後は閉鎖edgeを避けて再経路選択します。

## 必要環境

- Node.js 22
- npm 10以降
- PCブラウザ（Chrome推奨）

外部APIキー、Docker、Google Cloud、Firestore Emulatorは不要です。

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

500m LOWプリセットを実時間10分間動かすM2 soak:

```bash
npm run test:soak:m2
```

E2Eは試合時間とCITY CORE間隔を短縮した専用Match Serverを起動し、システムのGoogle ChromeをHeadlessで操作します。

## 構成

```text
apps/game-client       Babylon.jsによる低ポリ都市とHUD
apps/match-server      authoritative WebSocket Match Server
packages/contracts     ZodによるRuntime Schema
packages/game-core     決定論的なゲームルールとBot
tests/e2e              ブラウザ操作の受入テスト
tests/soak             500m街区の実時間10分性能試験
```

ローカルMVPを外部サービスから独立させるため、AI、鉄道、永続化は今後adapterとして追加します。
