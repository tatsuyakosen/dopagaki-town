# Public repository safety

This repository and its branches/PRs are public. Source code, README text, commit messages,
screenshots, comments and build artifacts must all be suitable for public release.
Do not copy personal conversations, employment/customer information, private project identifiers,
account/billing details, service-account credentials, API keys, session tokens or signed URLs here.

## Before every commit or PR

```sh
npm run check:publish
npm run check:publish -- --staged
```

The guard scans tracked and eligible untracked files (or staged blobs), rejects credential/data
paths and files over 1MiB, and detects selected credential patterns and literal assignments.
Only the path and finding category are printed; matched values are never printed.
It is a heuristic safeguard, not a proof that no confidential information exists.
Review the exact staged diff manually. Do not use `git add .` for data-heavy workflows.

Optional local hook setup:

```sh
git config core.hooksPath .githooks
```

The hook must be executable. It is not installed automatically on clone and can be bypassed;
CI performs independent checks. The workflow uses read-only repository permissions,
does not persist checkout credentials, and does not upload arbitrary logs or artifacts.
Make its check required via repository branch protection/rulesets if appropriate; this PR
does not change repository administration settings or automatically merge changes.

## Credentials and city assets

- `.env`, `.env.*`, keys, common credential JSON paths, raw/processed city data, traces and local
  artifacts are ignored. Only a deliberately sanitized `.env.example` may be committed.
- `.gitignore` does not untrack files already committed. The content guard checks those too.
- Never put secrets in `VITE_*`: browser bundles and public assets are readable by users.
- Production source maps are disabled to avoid publishing extra source/debug context.
  This does **not** make browser source or application behavior secret.
- Runtime city data is stored outside Git and obtained from reviewed public sources separately.
  Files under a web server's public directory are public even when ignored by Git.
- The walk mode needs no keys, authentication, cloud account, telemetry or paid API.
- Existing Gemini/Cloud Run settings stay server-side; do not paste environment dumps into PRs.
- Keep any nonpublic diagnostic logs locally under `.local/` or `artifacts/`, not in issue uploads.

## History and incidents

```sh
npm run check:publish -- --history
```

History checking covers reachable blob contents in the locally available refs. Fetch full history
first where authorized. It does not scan inaccessible refs, deleted remote objects, issues, PR
comments, GitHub Actions artifacts, author metadata or every possible secret format.
Use GitHub's provider-supported secret scanning/push protection where available, and manually
review personal or business-sensitive prose. A zero result is not a confidentiality guarantee.

If a credential has already been public, revoke/rotate it first and inform its owner through a
private channel. Never paste the value into a public issue. Removing the working-tree file does
not erase history, caches or forks. Do not rewrite history or change repository visibility
without the owner's explicit agreement.
