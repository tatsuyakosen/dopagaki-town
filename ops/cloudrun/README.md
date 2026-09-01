# Cloud Run staging

M8の最小stagingは、Web Clientを同梱したpublic Match Serverと、Gemini／ADKを呼ぶprivate Director APIの2サービスです。ローカル既定のFixture経路は変更しません。

## 前提

- billingを有効にした専用staging project
- Cloud Run、Cloud Build、Artifact Registry、Vertex AI API
- `asia-northeast1`のDocker形式Artifact Registry repository（既定名`dopagaki`）
- Match Server用とDirector用の専用Service Account
- Director Service Accountの`roles/aiplatform.user`
- deploy実行者／Cloud Build Service Accountに必要な最小権限

Service Account key JSONは作成しません。Cloud Run上ではApplication Default Credentialsを使い、Match ServerにはDirectorだけの`roles/run.invoker`を付与します。Directorはunauthenticated accessを許可しません。

## ローカルcontainer smoke

```bash
docker build -f ops/cloudrun/Dockerfile.match -t dopagaki-match:local .
docker build -f ops/cloudrun/Dockerfile.director -t dopagaki-director:local .
docker run --rm -p 38080:8080 -e DIRECTOR_PROVIDER=fixture dopagaki-director:local
docker run --rm -p 33001:8080 dopagaki-match:local
```

それぞれ`/healthz`と`/health`を確認します。実GeminiはNode 24.13のDirector imageだけで動作し、Match imageは検証済みのNode 22を維持します。

## staging deploy

このスクリプトはimage build／push、Cloud Run revision更新、DirectorへのInvoker bindingを行うため課金と外部状態変更を伴います。変数を明示してから手動実行します。

```bash
export GOOGLE_CLOUD_PROJECT=your-staging-project
export MATCH_SERVICE_ACCOUNT=match-staging@your-staging-project.iam.gserviceaccount.com
export DIRECTOR_SERVICE_ACCOUNT=director-staging@your-staging-project.iam.gserviceaccount.com
export GOOGLE_CLOUD_REGION=asia-northeast1
export GOOGLE_CLOUD_LOCATION=asia-northeast1
export ARTIFACT_REPOSITORY=dopagaki
ops/cloudrun/deploy-staging.sh
```

Match Serverは`min-instances=0`、`max-instances=1`、30分timeout、session affinity、HTTP/1、concurrency 80です。単一in-memory Roomなのでstagingでは1 instanceを厳守します。Directorは`max-instances=1`、30秒timeout、concurrency 8で、Match ServerがGoogle署名ID tokenを付けて呼び出します。

Cloud Runの`max-instances`はrevision単位であり、revision切替中は旧版と新版が一時的に並存し得ます。Match Serverの更新は試合間に行い、FirestoreによるRoom復元を実装するまでは無停止更新を前提にしません。session affinityもbest effortであり、永続化の代替ではありません。

## staging gate

1. public Match URLからGuest入城し、WSSで10分試合を完走する。
2. Director logで`source=GEMINI_ADK`、attempt、latency、failure codeを確認する。
3. Gemini timeout／Schema違反／Verifier全拒否を注入し、Fixtureへ縮退して試合が継続することを確認する。
4. WebSocket切断とrevision restart後、30秒以内の再接続挙動を確認する。プロセスを越えるRoom復元はFirestore実装まで未対応であることを明示する。
5. Cloud MonitoringでP95 latency、token／費用、instance数、5xxを記録する。
6. `@google/adk`推移依存のaudit警告を解消してからpublic提出環境へ昇格する。
