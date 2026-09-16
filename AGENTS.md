# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. This app is public-facing with real abuse protection. A secondary goal is attempting AI/ML processing in the cloud on AWS.

**Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the "why" behind every stack choice, and [`RUNBOOK.md`](RUNBOOK.md) for local dev/ops commands before making changes.**

- **Don't overengineer.** Solve the problem in front of you, not the general case it might become. No new abstraction, config option, or extensibility hook for a second use case that doesn't exist yet — add it when that use case actually shows up.
- **Each fact lives in exactly one of the three docs.**
  - [`ARCHITECTURE.md`](ARCHITECTURE.md) is why — decisions, alternatives rejected, costs accepted.
  - [`RUNBOOK.md`](RUNBOOK.md) is how to run and operate it.
  - This file is what breaks if you don't know it: gotchas, conventions, and current state. Where a gotcha needs its rationale, name the other file instead of restating it.
- **Docs and code comments describe current behavior only** — not prior libraries, old version numbers, or "this used to fail with X." Use `git log` for this instead.
- **Be human readable — fact plus the non-obvious reason.** Shortest accurate statement; no walkthrough of alternatives or restating the same point from multiple angles.
- **Cut anything the reader wouldn't act on differently.**
  - A sentence that only reassures — that nothing goes wrong, or that a service accepts what the code already does — costs the reader attention and changes nothing they do.
  - Mechanism a reader never invokes themselves costs the same: name the requirement it implies and drop the mechanism.
- **When asked why something is the way it is, answer in the conversation rather than by growing the doc.** Edit the doc only when the answer is a fact a reader needs at that spot, and then write the shortest version of it.
- **Write comments as real sentences, not em-dash-fused fragments.**
  - Each independent clause gets its own sentence with a period; don't join two of them with ` — ` where a period would do.
  - An em dash is fine for a single aside inside one sentence, not as a substitute for ending it.
- **One idea per sentence.**
  - When a comment has two reasons, two caveats, or a reason plus a caveat, give each its own sentence rather than nesting one inside the other's clause.
  - A sentence stacking multiple qualifiers is harder to parse than the same content split, even when every word is accurate.
- **Keep parallel facts in parallel shapes, and prefer positive verbs.**
  - Several facts hung off one subject only read cleanly when they're the same kind of fact. A failure condition, an action, and a conditional action need their own sentences.
  - Don't coordinate a negated verb with a positive one, as in "won't run unless you're signed in, and prints the account". The reader has to work out that the second half applies in the case the first half rules out.
- **Reference files by their full package-relative path, not a bare filename** — `web/proxy.ts`, not `proxy.ts`. Do this every time the file is named, even right next to an earlier mention that already gave the full path; don't rely on the reader having seen that earlier sentence.
- **Name the subject instead of pointing at it.** The full-path rule applies to every subject, not just files.
  - "the root module", "this app", and "this config" all make the reader work out which thing is meant, and each one goes stale the moment that thing is renamed or split. Write `infra/`, or the ECS task, or whichever it is.
  - A bare "one" or "the AWS ones" standing in for a noun from an earlier sentence has the same problem. Repeat the noun.
  - A demonstrative pointing at the immediately preceding noun in the same sentence is fine.
- **When prose names another section — in the same doc or a different one — link it, don't just quote or bold the name.**
  - Use `[Section name](#section-name)` for a same-file reference and `[Section name](OTHER.md#section-name)` across files, with the anchor GitHub/VS Code derive from the heading (lowercase, spaces to hyphens, punctuation stripped).
  - A plain quoted or bolded name silently goes stale the moment the target heading is renamed; a broken link is easier to spot in review.
- **A bare mention of one of the other root docs (`AGENTS.md`, `RUNBOOK.md`, `ARCHITECTURE.md`, `README.md`) gets linked to the file too** — `` [`AGENTS.md`](AGENTS.md) ``, not just backtick text.
  - This doesn't extend to code file paths: those stay as inline code per the rule above, since linking every one would be churn for no navigational benefit.

## Structure

Monorepo, three independent packages:

- `web/` — Next.js 16 (App Router) + MUI + SWR + Zustand + react-three-fiber, **and** the REST API as Route Handlers under `app/api/v1/` backed by Drizzle.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per job.
- `infra/` — Terraform. Network, registry, data, worker IAM, web, and budgets in separate `.tf` files, one state.

Server-only code lives in `web/lib/server/` — never import it from a `"use client"` file. The one shared client-safe module is `web/lib/types.ts` (status-value tuples for Drizzle `pgEnum`s); import runs types → schema, never the reverse.

## Auth (Clerk)

`web/proxy.ts` default exports `clerkMiddleware()`. It reads the Clerk cookie so later code can tell who is signed in, if anyone. Sign-in checks happen later using `auth.protect()` on pages and `requireUser()` / `requireClerkUserId()` on API routes.

`config.matcher` in `web/proxy.ts` is the list of URL patterns that decide whether `clerkMiddleware()` is run. Keep it covering pages and `/api/*` — if not run the Clerk cookie isn't read and any later `auth()` calls will throw instead of sending the visitor to sign-in.

- **`web/proxy.ts` only loads from `web/`'s root, beside `app/`** — not the repo root, not inside `app/`.
  - Next reads it from nowhere else and says nothing when it's misplaced; the symptom is every authenticated route 500ing with "clerkMiddleware() was not run".
  - Confirm `ƒ Proxy (Middleware)` appears in `next build`'s route table.
- **The matcher skips static files by file extension (`.js`, `.png`, …), not by "the path contains a dot".** A page like `/splats/my.splat.v2` still needs `clerkMiddleware()` to run.
- **API routes check auth themselves.** Each authenticated handler calls `requireUser()` or `requireClerkUserId()` (`web/lib/server/auth.ts`). Public routes (`public/splats/[splatId]`, healthz, the worker's token callback) simply don't call those.
- **`auth.protect()` in `web/app/(authenticated)/layout.tsx` only redirects unsigned visitors to sign-in.**
  - The API is protected by `requireUser()` / `requireClerkUserId()` in each handler, not by this layout.
  - Next reuses layouts when navigating between sibling routes (`/splats/[id]/point-cloud` → `/splats/[id]/splat`, both under `web/app/(authenticated)/splats/[id]/layout.tsx`), so `auth.protect()` will not re-run.
  - If a page starts rendering protected data on the server, that page needs its own `auth.protect()`.
- **This Clerk SDK has no `<SignedIn>` / `<SignedOut>`.** Use `<Show when="signed-in">` (`web/components/layout/NavMenu.tsx`).
  - Pass `fallback` for the signed-out UI.
  - While Clerk is still loading the session, `<Show>` renders nothing — not the fallback.
- **Use the Clerk MCP `clerk_sdk_snippet` tool before writing or answering Clerk SDK questions, not a raw docs fetch.** Same reasoning as the MUI MCP tools above: training data lags the API and the MCP is already scoped to this project's installed SDK.
  - Call it with one feature slug (`use-user`, `use-auth`). Never pass a bundle (`b2b-saas`, `custom-flows`, `organizations`, `auth-basics`, `server-side`).
  - Skip `list_clerk_sdk_snippets` when the slug is known. A bundle is a whole guide. Fetching one is how these servers exhaust the context window.
- **Set `NEXT_PUBLIC_CLERK_SIGN_IN_URL` and `NEXT_PUBLIC_CLERK_SIGN_UP_URL` at build time**, or Clerk sends users to its hosted Account Portal instead of the app's own sign-in pages.
  - The paths never change, so `web/Dockerfile` bakes them in as `ENV`.
  - Both pages need an optional catch-all (`web/app/(public)/sign-in/[[...sign-in]]/page.tsx`) because Clerk puts verification and SSO steps on sub-paths; a plain `page.tsx` 404s mid-sign-in.
- **A dummy Clerk publishable key still has to look like a real one.** `clerkMiddleware()` parses the key and rejects a malformed string. CI uses `pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk` (base64 of `"example.clerk.accounts.dev$"`), which parses without contacting Clerk.
- **Turn off telemetry with `NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED`** (set in `.github/workflows/ci.yml`, `web/Dockerfile`, and the `web/.env` template in `scripts/lib/env-files.sh`).
  - The package reads that name on the server and also bakes it into the browser bundle. `CLERK_TELEMETRY_DISABLED` (no `NEXT_PUBLIC_`) only covers the server collector.
  - `isCI()` hides the console notice; it does not stop reporting.
  - A `pk_test_*` key still reports from CI and local container builds; a `pk_live_*` key does not.
- **`NEXT_PUBLIC_*` values are baked into the JS at `next build` time.**
  - Setting `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as a container env var at runtime does nothing. Pass it as `docker build --build-arg`.
  - `CLERK_SECRET_KEY` is the real secret and is injected at runtime from Secrets Manager.

## Next.js & TypeScript

- **Prefer `function` declarations over arrow functions**, except closures assigned to a local (`const handleClick = () => {...}`) or inline arguments (`.map(x => ...)`, `useEffect(() => {...})`). Top-level: `export function foo() {}`, not `export const foo = () => {}`.
- **`if`/`for`/`while`/`do` bodies always use a `{ }` block** — never `if (x) return;`. Biome `style/useBlockStatements` (enabled in `biome.json`; not in `recommended`).
- **`next typegen` before `tsc --noEmit` on a clean checkout.**
  - Route Handlers use `RouteContext<"/path">`; Next writes those helpers into gitignored `web/.next/types/` during `next dev`/`build`. Without them: `TS2304: Cannot find name 'RouteContext'`.
  - CI and the root `web:check` script run `typegen` first.
- **`web/` uses TypeScript `^7.0.2` (no JS Compiler API).**
  - Next's typecheck needs `useTypeScriptCli` (default on as of Next `16.3.0`). Without it Next can't load `typescript`, including `web/next.config.ts`.
  - `infra/` has no TypeScript dependency.
- **There is deliberately no `start` script — `next start` is unsupported under `output: "standalone"`.**
  - Next says so and then serves anyway, so a re-added `pnpm start` looks like it works.
  - `next build` emits `.next/standalone/server.js` (the container's `CMD`), which omits `.next/static`, so running it by hand serves pages with no CSS or JS unless that directory is copied in as `web/Dockerfile` does. Run the container instead ([`RUNBOOK.md`](RUNBOOK.md)).
- **Server Components reading request-time data need `export const dynamic = "force-dynamic"`**, or `next build` statically prerenders them. They call `web/lib/server/data.ts` directly — not the Route Handlers under `web/app/api/v1/`.
- **Playwright `page.route()` can't intercept SSR** (different Node process). Share pages read the DB via `web/lib/server/data.ts`, so HTTP mocks don't help. Seed a test DB instead; see Known gaps.

## MUI & React Server Components

- **Don't pass a component reference as a prop across the Server→Client boundary** (e.g. `<CardActionArea component={Link}>` from an async Server Component). Nest `<Link>` around the component instead.
- **`ThemeProvider` must live inside a dedicated Client Component that imports the theme itself** (`web/components/layout/ThemeRegistry.tsx`), not one fed the theme object as a prop from a Server Component.
  - The root layout (`web/app/layout.tsx`) is a Server Component; passing the `theme` object (it carries functions like `theme.breakpoints.up`) as a prop into `<ThemeProvider theme={theme}>` there crosses the RSC boundary with non-serializable values and fails the build with "Functions cannot be passed directly to Client Components."
  - Reading a primitive off `theme` (e.g. `theme.zIndex.appBar`, `theme.spacing(2)`) inside a Server Component's own `sx` object is fine — only passing the whole theme object itself as a prop is the problem.
- **Use the MUI MCP `fetchDocs` tool before writing or answering MUI API questions, not a raw `llms.txt` fetch.** Training data lags the API. The MCP sources the same `llms.txt` files but resolves the version.
  - Pass the `@mui/material` version from `web/package.json` rather than trusting its default.
  - Call `fetchDocs` with exactly one URL. Prefer the API page (`https://mui.com/material-ui/api/<name>/`) over the overview (`https://mui.com/material-ui/react-<name>/`).
  - Skip `useMuiDocs` when the URL is already known. That tool returns the whole package catalog (~25k tokens). One overview page can be larger than the rest of the chat.
- **Size things in rem, not raw px, so the UI scales with a user's browser zoom/font-size setting.**
  - `web/theme.ts` overrides `theme.spacing()` to emit rem instead of MUI's px default, so any `sx`/`spacing` prop that goes through it (`p`, `m`, `gap`, `<Stack spacing={n}>`) already scales correctly.
  - A free-standing pixel value inside a `style={{}}`/`sx={{}}` object doesn't go through that — wrap it with `web/lib/rem.ts`'s `rem()` export instead of hand-writing a `"…rem"` string.
  - The exception is a value that has to match a browser API that only accepts raw pixels — `Element.scrollBy()`, or arithmetic against `PointerEvent.clientY` in a drag handler — where there is nothing to convert.
- **`Stack` and `Box` in this MUI version have no `alignItems`/`justifyContent`/`flexWrap` shorthand props** — only `direction`, `spacing`, `divider`, and `sx` are real props on `Stack`; everything else goes through `sx`.
  - Passing them as bare JSX props type-checks as a totally unrelated overload error (`Property 'alignItems' does not exist on type '...'`), not a missing-prop error, so the fix is easy to miss on first read.
- **Prefer `Box` + `sx` over a raw `<div>`/`<button>` for layout and styling.**
  - There's no dedicated `Flex` component — a flex container is `Box`/`Stack` with `sx={{ display: "flex", ... }}`.
  - `ButtonBase` is a real `<button>` with MUI's styling hooks but the default button chrome (border, background, padding) already stripped, for a button that needs its own look.
  - Reach for a plain element only where the semantics genuinely need to differ, e.g. a real `<img>` rather than `next/image`'s fallback behavior.

## CI & repo tooling

- **Renaming/removing a CI job blocks merges until branch protection is updated too.**
  - Required checks name jobs (`lint-format`, `worker`, `web`, `infra`); a missing context leaves PRs unmergeable — `enforce_admins` is on, so `--admin` does not override either.
  - Rules live in GitHub Settings → Branches, not `.github/workflows/ci.yml`.
  - List: `gh api repos/kamyy/ai-gaussian-splatter/branches/main/protection`.
- **The deploy steps live in `.github/workflows/deploy.yml`, a `workflow_call` workflow run only by `.github/workflows/ci.yml`'s `deploy` job.**
  - That caller keeps the `needs` on the check jobs, the `if:` gate, and the `id-token: write` grant.
  - The grant can't move into `.github/workflows/deploy.yml`, because a called workflow can only narrow its caller's permissions and this repo's default token is read-only.
  - A job run through a called workflow reports its check as `<caller job> / <called job>`, so moving a required one (`lint-format`, `worker`, `web`, `infra`) into its own file is a rename as far as branch protection is concerned.
- **Biome does not format Markdown, YAML, Dockerfiles, or shell scripts** (`@biomejs/biome@2.5.10`, pinned in both root and `web/`). Keep those consistent by hand.
  - It doesn't lint `.sh` either. `scripts:check` runs shellcheck instead.
  - `biome.json` sets `lineWidth: 120`. One measure holds repo-wide.
  - When hand-wrapping comments in the files Biome skips, including comments inside a Markdown fenced code block, treat 120 as the fill target: greedily pack each line with words up to that width before wrapping to the next, the same way a `fmt`/text-fill pass would, not an early wrap at whatever width feels readable.
  - Markdown *prose* is the exception: no max width, since GitHub reflows paragraphs and fixed wraps only add diff noise. One line per paragraph/list item.
- **Operational scripts in `scripts/dev/` (local) and `scripts/prod/` (the deployed account) are committed executable (`100755`); helpers in `scripts/lib/` are sourced, so they stay `100644`.**
  - Each helper starts with `# shellcheck shell=bash` in place of a shebang.
  - A script that uses the AWS CLI as a signed-in admin sources `scripts/lib/require-aws-login.sh`, and calls `require_aws_login` before any other AWS CLI invocation.
  - A script that tags the AWS resources it creates sources `scripts/lib/terraform.sh` and assigns `PROJECT_TAG=$(tf_local_var project_tag)`. That reads `local.project_tag` from `infra/locals.tf` so the tag matches `infra/providers.tf`'s `default_tags`.
  - The Spot service-linked role and GitHub OIDC provider are account-wide and stay untagged.
  - A script that creates or deletes anything sources `scripts/lib/confirm.sh` and calls `confirm` first.
  - A script that uses the GitHub CLI sources `scripts/lib/github.sh` and calls `require_gh_login` before its first `gh` call. Otherwise a logged-out `gh` reads the same as an unset repository variable.
  - `scripts/prod/terraform-plan.sh`, `scripts/prod/terraform-destroy.sh`, `scripts/prod/delete-tf-state-bucket.sh`, and `scripts/prod/push-worker-image.sh` act on the deployed account, so they also call `require_aws_deploy_account`, which checks the signed-in account against the `AWS_ACCOUNT_ID` repository variable.
  - The worker scripts run as the dev IAM user from `web/.env` instead, so `use_dev_aws_credentials` in `scripts/lib/worker.sh` checks those keys.
  - Local Terraform is `$HOME/.local/bin/terraform` (`scripts/prod/install-terraform.sh`). Scripts that run it assign `TERRAFORM=$(tf_bin)`, which prefers that path over PATH, because a different CLI earlier on PATH still satisfies `command -v terraform`. CI has no copy there: `hashicorp/setup-terraform` in `.github/workflows/ci.yml` and `.github/workflows/deploy.yml` installs whatever `tf_required_version` reads from `infra/providers.tf`.
  - `scripts:check` (run by the pre-commit hook and CI's `lint-format` job) shellchecks them with `scripts/dev/shellcheck.sh`, which runs shellcheck's container image.
  - The image is pinned by digest, so neither a new shellcheck release nor a re-pushed tag can change the result for an unchanged tree.
  - The repo is mounted read-only with `--security-opt label=disable`, because a `:Z` mount relabels the whole checkout for SELinux.
- **Node is pinned in root `.nvmrc` (`24.18.0`); CI jobs use `node-version-file`.** Run `nvm use` from repo root. Nothing executes `.ts` via Node directly (Next/Vitest/Playwright transform; root `scripts/*.js` are plain JavaScript).

## Git workflow

- **`main` is push-protected.** All changes land via PR, including docs/config/`.gitignore`.
- **Branch names are type-prefixed** (`chore/`, `refactor/`, `docs/`, `fix/`, …). Commit messages are a separate convention.
- **Merge with `gh pr merge --merge`**, not squash/rebase — preserves scoped commits on `main`.
- **Update a stale PR with `git rebase main`** then `push --force-with-lease`, not merge `origin/main` into the branch.

## Worker (GPU pipeline)

- **Local pipeline runs are a Podman container: they need an NVIDIA GPU, the NVIDIA driver, and `nvidia-container-toolkit`.**
  - CUDA (including `nvcc`), COLMAP, and gsplat live in the worker image — don't install those on the host.
  - Setup and the run scripts are in [`RUNBOOK.md`](RUNBOOK.md#worker-local-pipeline-run).
- **The worker container is two hops from IMDS, so `RunInstances` sets `HttpPutResponseHopLimit: 2`** (`web/lib/server/ec2Launcher.ts`).
  - At EC2's default of 1 the token PUT in `worker/pipeline/instance.py` gets no reply, `get_self_instance_id()` returns `None`, and the instance never terminates itself — logging one INFO line indistinguishable from a local run while a `g5.xlarge` keeps billing.
  - `HttpTokens: "required"` is paired with it and depends on it: on its own it removes the IMDSv1 fallback and breaks credentials too, not just self-termination.
- **Typical agent sandboxes have none of that** (a GPU driver alone isn't enough — `gsplat` needs `nvcc` to JIT). `worker/pipeline/train.py` is structurally validated but unproven on real hardware; don't claim the training loop "works" without that.

## Infra (Terraform / AWS)

### Structure & state

- **All of `infra/` shares one state.** Its six logical areas (network, registry, data, worker IAM, web, budgets) live in separate `.tf` files for readability, not separate Terraform states — there's no CloudFormation-style cross-stack export/import to keep in sync, so moving a resource between files or renaming one of the six areas is a file-organization change only.
- **Never add the state bucket as a resource in `infra/`.** Skip creating it ([Creating account prerequisites](RUNBOOK.md#creating-account-prerequisites)) and `terraform init` fails.
- **`infra/tests/*.tftest.hcl` run fully offline via `mock_provider "aws" {}`.**
  - Every file needs two `mock_provider "aws"` blocks — one default, one `alias = "billing"` — since a bare `mock_provider "aws" {}` only covers the unaliased provider configuration and `providers.tf` declares a second one for `us-east-1`.
  - An assertion that a value follows a variable has to run against a second value of that variable, in a `run` block with its own `variables {}`. Written against the file-level fixture, `"ai-gaussian-splatter.${var.domain_zone_name}"` and `"ai-gaussian-splatter.example.com"` are the same string, so the assertion passes whether the resource reads `local.app_hostname` or hardcodes the hostname. `hostnames_follow_the_zone_variable` (`infra/tests/web.tftest.hcl`) and `cors_origins_follow_the_zone_variable` (`infra/tests/data.tftest.hcl`) are the runs that own that fact.
- **Terraform reads `aws login` credentials only through a recent AWS provider.**
  - An older `hashicorp/aws` fails at the first `plan` with `No valid credential sources found`, even though `terraform init` succeeds, because the S3 backend reads the credentials itself.
  - `terraform version` in `infra/` names the provider version actually installed.

### Networking & TLS

- **The ACM cert (`infra/web.tf`) takes no explicit `provider`**, so it inherits the default provider's `var.aws_region` — required, since an ALB can only reference a certificate in its own region.
  - Same hostname in another region is normal (certs are free).
- **Set the HTTPS listener's `ssl_policy` explicitly** (`ELBSecurityPolicy-TLS13-1-2-2021-06`). Leaving it unset defaults to the weak `ELBSecurityPolicy-2016-08` (TLS 1.0/1.1), not the console's strong default.
- **The Route 53 zone is referenced by ID only (`var.hosted_zone_id`), never looked up with a `data "aws_route53_zone"` block.** This config only ever adds records to the zone; it never manages the zone itself, so there's nothing a lookup would add beyond an extra API call on every plan.
- **The ALB's `0.0.0.0/0` ingress rules are explicit resources** (`aws_vpc_security_group_ingress_rule.alb_https`/`alb_http` in `infra/network.tf`). Deleting these two resources still applies cleanly and refuses every connection, so their presence is what actually matters, not an assumption that some other resource implies them.
- **A second ingress rule on `aws_security_group.web` opens a path from the internet.**
  - Tasks are in public subnets with a public IP and no NAT.
  - That group's single rule, `aws_vpc_security_group_ingress_rule.web_from_alb` (`infra/web.tf`), sourced from the ALB security group on `local.container_port`, is the only network control ([`ARCHITECTURE.md`](ARCHITECTURE.md)).
  - `infra/tests/network.tftest.hcl` and `web.tftest.hcl` assert this; tripping it is a security change.
- **`KEEP_ALIVE_TIMEOUT` must exceed the ALB idle timeout (60s), or healthy deploys serve intermittent 502s.**
  - Node's default keep-alive is 5s; Next standalone only overrides via `KEEP_ALIVE_TIMEOUT`. ALB then hands requests to sockets the app already closed — no app log entry.
  - `infra/locals.tf` sets `65000` ms. Raising ALB idle without raising this reopens the gap.

### IAM & secrets

- **`ec2:RunInstances` needs two separate IAM statements, not one** (`infra/web.tf`'s `aws_iam_role_policy.task`, `Sid`s `RunInstances`/`RunInstancesTagged`).
  - IAM authorizes it against each resource the request touches; `web/lib/server/ec2Launcher.ts` tags only the instance, so `aws:RequestTag` is absent for the AMI, subnet, and security group and a single conditioned statement denies the whole call.
  - `ec2:CreateTags` (scoped by `ec2:CreateAction`) is a separate statement that tagging-on-launch also requires. `infra/tests/web.tftest.hcl` pins all three staying split.
  - Every role's grants live in one `aws_iam_role_policy` resource per role, one `Sid`-tagged statement per grant — not one resource per grant — so tests address statements by `Sid` instead of by a dedicated resource name.
- **The Clerk secret is referenced by ARN (`var.clerk_secret_key_arn`), never created.** It must exist before the first apply ([`RUNBOOK.md`](RUNBOOK.md)).
  - ECS resolves a task definition's `valueFrom` against the six-character suffix Secrets Manager assigns, so a partial ARN applies clean and only fails at task start.
  - A variable validation checks the ARN's shape and names this secret specifically, and `aws_iam_role_policy.execution`'s precondition checks it names this deploy's own account/region, but neither can confirm it's the actual right secret's value — check with `aws secretsmanager describe-secret` before applying rather than trusting a clean `terraform apply` to have caught a copy-paste of the wrong environment's secret.
- **The RDS master credentials come from `manage_master_user_password = true`** (`infra/data.tf`), not a hand-rolled secret.
  - RDS creates and rotates its own Secrets Manager secret holding both `username` and `password`; `infra/web.tf` reads both fields off `aws_db_instance.main.master_user_secret[0].secret_arn`.

### Deploy: image tags

- **Image tags are `<commit-sha>-web` and `<commit-sha>-migrate`, and the ECR repository (`infra/registry.tf`) is `IMMUTABLE`.**
  - One repository (`ai-gaussian-splatter`) holds both build targets of `web/Dockerfile`; the suffix is what tells them apart, and `infra/web.tf` appends it.
  - `var.web_image_tag`/`var.migrate_image_tag` take a bare SHA; a variable `validation` block in `infra/variables.tf` refuses any other shape before `terraform plan` ever reaches AWS.
  - A pushed tag can never be repointed, so rebuilding an already-pushed commit fails at `podman push` with `ImageTagAlreadyExists`. Commit again rather than retagging.
  - Both exist to keep the deployment circuit breaker's rollback meaningful: with a moving tag every release shares one task definition, and a rollback re-pulls the image that just failed.
- **Two separate image-tag variables, one default.**
  - `web_image_tag` is the Fargate service's own image; `migrate_image_tag` is the migration task definition's, and falls back to `web_image_tag` when left empty (`infra/variables.tf`'s `local.migrate_image_tag`).
  - Every existing `terraform apply -var web_image_tag=$SHA` invocation with no `migrate_image_tag` keeps deploying one build that serves both roles.
  - `.github/workflows/deploy.yml` is the one caller that ever diverges the two — see [`ARCHITECTURE.md`](ARCHITECTURE.md) for why.
  - `ai-gaussian-splatter-migrate` (task family), `ai-gaussian-splatter-migrate-task` (migration task role), and `ai-gaussian-splatter-execution` (execution role) are fixed literal names for the same reason `CLUSTER_NAME`/`SERVICE_NAME` are: rotating the Clerk secret is a write plus `aws ecs update-service --force-new-deployment`, not a `terraform apply`, so that command needs a cluster/service name it can write out literally rather than looking up from a Terraform-assigned one.
- **The worker image lives in its own ECR repository (`ai-gaussian-splatter-worker`, `infra/registry.tf`), separate from the web repository above, and `var.worker_image_tag` has no default.**
  - Unlike `web_image_tag`/`migrate_image_tag`, nothing rebuilds and pushes it automatically — GPU worker deployment stays manual (`RUNBOOK.md`) — so this variable only changes when someone hand-builds and pushes a new one.
  - Its lifecycle policy keeps far fewer images (`local.worker_releases_kept`, currently 2) than the web repository's `RELEASES_KEPT` (10): at ~19 GB each the worker image isn't cheap to retain, and it isn't part of any ECS rollback mechanism anyway — `web/lib/server/ec2Launcher.ts` just reads whatever `WORKER_IMAGE_URI` currently names.

### Variables & state backend

- **No placeholder-value fallback for required variables.**
  - `terraform validate` and `terraform test` (`mock_provider`) never touch real AWS, so required variables (`worker_ami_id`, `alert_email`, `domain_zone_name`, `hosted_zone_id`, `clerk_secret_key_arn`, `web_image_tag`, `worker_image_tag`) simply have no default in `infra/variables.tf`. CI's `infra` job never has to supply one.
  - A real `terraform plan`/`apply` fails immediately when one is unset.
  - `.github/workflows/deploy.yml` maps each from a GitHub repository variable, though, and an unset repository variable arrives as `""`, which Terraform accepts as a value. There only a `validation` block catches it, so every required variable has one that rejects `""`. Give any new required variable one too.
- **`var.aws_region`'s default in `infra/variables.tf` is the only place the region is written.** `scripts/lib/terraform.sh`'s `tf_aws_region` reads it, and every AWS CLI call in `scripts/` plus the `Resolve region` step in `.github/workflows/deploy.yml` take it from there.
  - Two places keep their own copy, neither of which reaches AWS. `scripts/dev/create-dev-resources.sh` uses `web/.env`'s own `AWS_REGION`, so the dev buckets match the region `web/lib/server/env.ts` signs upload URLs for; a new `web/.env` is seeded from the same default. `.github/workflows/ci.yml`'s web job sets it as a fixture beside `AWS_ACCESS_KEY_ID: testing`.
  - The Budgets provider (`infra/budgets.tf`) stays pinned to `us-east-1` — see [Stack construction](#stack-construction).
  - Moving the region means a teardown, then the whole of [Deploying to production](RUNBOOK.md#deploying-to-production) again. Nothing migrates an ALB, an RDS instance, or an ECR repository across regions. The state bucket, the Clerk secret, the CI role's ARNs, and `WORKER_AMI_ID` are region-specific as well.
  - Tear down before editing the default. `terraform init` looks for the state bucket in whatever the default currently says, so an edited default points `scripts/prod/terraform-destroy.sh` at a bucket that doesn't exist while the old stack keeps billing.
- **The account id used to build IAM/ARN resources comes from `data.aws_caller_identity.current`**, evaluated fresh on every real plan or apply.
  - `.github/workflows/deploy.yml` still validates its own `AWS_ACCOUNT_ID` repository variable, but only to build the CI role's ARN and the state bucket name — nothing in `infra/` itself reads that environment variable.
- **The state bucket name (`ai-gaussian-splatter-tfstate-<account-id>`) is passed to `terraform init` via `-backend-config`, never hardcoded in `infra/providers.tf`.**
  - The bucket is account-specific and created once by hand; baking its name into the shared `backend "s3"` block would make the whole config account-specific too.

### Stack construction

- **A single Terraform state means no cross-stack export/import to manage.** Moving a resource between the six logical `.tf` files, or renaming one of the areas, is purely a file-organization change — nothing references another file by name, only by resource address within the one shared state.
- **The billing/budgets resources (`infra/budgets.tf`) use a second, aliased `provider = aws.billing` (`us-east-1`).** The Budgets API only exists in `us-east-1`, regardless of where the rest of the app runs.

## Database

### Schema & migrations (Drizzle)

- **Schema edits don't write SQL — always `pnpm db:generate`.**
  - Types update on save of `web/lib/server/db/schema.ts`, so `tsc` stays green while the DB drifts.
  - Flow: edit → `db:generate` → review `web/drizzle/` → `db:migrate`. Don't hand-edit `drizzle/meta/`. `web/drizzle/` is Biome-excluded.
- **Write column names explicitly (`uuid("user_id")`); don't use `casing: "snake_case"`.**
  - That option must match in both `web/drizzle.config.ts` and the runtime `drizzle()` call, or schema and queries disagree silently. It affects identifiers only, not enum values.
- **Enum values are snake_case in Postgres, TypeScript, and JSON.**
  - `pgEnum` labels *are* the DB labels; tuples live in `web/lib/types.ts`, imported by `web/lib/server/db/schema.ts`. Worker emits the same strings — no translation on the callback route.
- **Migrations must be safe to run against the *previous* release's code.**
  - CI applies each migration before rolling the service forward (`.github/workflows/deploy.yml`), but a circuit-breaker rollback of the *service* does not undo an already-applied migration — the two are orthogonal once the migration has committed.
  - Expand/contract only: add a nullable column, backfill, add the constraint in a *later* release. Never a same-release drop, rename, or `NOT NULL` with no default.

### Query patterns

- **UUID-check path params before the DB** — `uuid` columns turn `/api/v1/splats/abc` into Postgres `22P02` → 500. Use `requireUuid()` (routes) or `isUuid()` (`web/lib/server/data.ts`, null → `notFound()`).
- **Missing row is `undefined`, not `null`.** Idiom: `const [row] = await getDb().select()…limit(1)` then `if (row === undefined)`.
- **`onConflictDoNothing()` returns zero rows from `.returning()`.** `getOrCreateUser` uses `onConflictDoUpdate` with no-op `set: { clerkUserId }` so Postgres returns the existing row.
- **Upsert `set` must reference the column, not a pre-read JS value** — e.g. ``count: sql`${rateLimitCounters.count} + 1` ``. A plain `{ count: n + 1 }` reopens the race. Confirm real SQL with `log_statement='all'` or `drizzle(pool, { logger: true })`.
- **`.$onUpdate(() => new Date())` drives `updatedAt`** — no DB trigger; raw `sql` UPDATE skips it.

### Local dev & tests

- **`await closeDb()` in `afterAll`** or Vitest hangs (open `pg` Pool). `web/tests/migrate-test-db.ts` closes its own migration pool in `finally`.
- **The `server` Vitest project fails outright when `TEST_DATABASE_URL` is unset**, so a green run means the DB tests actually ran.
  - `web/tests/migrate-test-db.ts` throws before any test starts, including the server tests that never touch Postgres.
  - CI sets it and starts Postgres as a `podman run` step in `.github/workflows/ci.yml`, not a `services:` container — see [`ARCHITECTURE.md`](ARCHITECTURE.md).
  - Locally `web/vitest.config.mts` reads it from `web/.env`. Run `scripts/dev/db-up.sh` if Postgres seems missing ([`RUNBOOK.md`](RUNBOOK.md#web-frontend--rest-api)).
- **`fileParallelism: false` in `web/vitest.config.mts`.**
  - DB-backed files share one DB and clear tables in `beforeEach`; parallel runs delete each other's fixtures. Per-worker DBs would restore parallelism.
  - Transaction-per-test can't cover the real concurrency tests (`getOrCreateUser` race, rate-limit atomicity) — one connection serializes queries.

### Connecting to RDS in production

- **Connection string assembly.** RDS secrets are JSON (`username`/`password`); ECS can inject only one JSON field at a time — no formatted `postgresql://` URL.
  - `infra/web.tf` projects `DATABASE_USER` from the secret for both containers and passes `DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_NAME` as env.
  - `web/scripts/db-migrate.cjs` calls `web/lib/server/databaseUrl.ts`'s `resolveDatabaseUrl()` to reassemble and percent-encode a full URL from those plus a password; local dev, CI, and the migration task all take that same path. The long-lived web service doesn't — see the next bullet.
  - Tests: `infra/tests/web.tftest.hcl`, `web/lib/server/tests/databaseUrl.test.ts`.
- **The web service fetches its own DB password at connect time; the migration task doesn't.** RDS rotates its managed master-password secret every 7 days by default ([`ARCHITECTURE.md`](ARCHITECTURE.md)).
  - A password ECS injects once as an env var at task start goes stale for anything long-lived, since Postgres doesn't re-authenticate already-open connections but does reject new ones with the old one.
  - `infra/web.tf` gives the web task only `DATABASE_USER` as a secret, plus a plain `DATABASE_SECRET_ARN` env var naming (not holding) the RDS secret.
  - `web/lib/server/db/index.ts`'s `getDb()` passes `pg.Pool` a `password` **function** (`web/lib/server/databaseUrl.ts`'s `fetchDatabasePassword`, cached 5 minutes) instead of a string, so it re-fetches on every new physical connection rather than once.
  - A rotation makes that cached copy wrong straight away, so `getDb()` builds a `SecretPasswordPool` that clears the cache and retries once when Postgres rejects the password (`28P01`).
  - `pg`'s dynamic password only works with `Pool`'s discrete `host`/`port`/`database`/`user`/`password` fields, not a `connectionString`, which is why `getDb()` no longer builds one the way `web/scripts/db-migrate.cjs` still does.
  - The migration task keeps the old static `DATABASE_PASSWORD` secret unchanged — it runs for seconds and exits, well inside the rotation window, so it has nothing to go stale against, and giving it Secrets Manager read access instead would cost an IAM grant for no benefit.
- **TLS.** RDS forces SSL (`rds.force_ssl = 1`); `pg` defaults to no TLS → `no pg_hba.conf entry ... no encryption`.
  - `/api/v1/healthz` never hits the DB, so ECS can look healthy while queries 500.
  - Node's `?sslmode=require` is `verify-full`, not libpq's encrypt-only. Without Amazon's CA you get `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
  - Fix: bake the RDS CA bundle in `web/Dockerfile`, set `DATABASE_SSL_CA` from `infra/web.tf`, pass `ssl: { ca }` in `web/lib/server/databaseUrl.ts`; leave `rejectUnauthorized` at default `true`. Do not use `rejectUnauthorized: false`. (Node's `sslmode` behavior was checked empirically; libpq docs don't transfer.)
  - Local dev and CI run a plain, TLS-less Postgres — `DATABASE_SSL_CA` unset makes `databaseSsl()` return undefined and the connection plain — so this whole path is otherwise unexercised until a real AWS deploy.
- **`drizzle-kit`'s CLI driver silently ignores a sibling `ssl` field in `dbCredentials` whenever `url` is also set** (checked against `drizzle-kit/bin.cjs`: `"url" in credentials ? new pg.Pool({connectionString: credentials.url}) : new pg.Pool({...credentials, ssl})`). The `url` branch never even looks at `ssl`.
  - `web/drizzle.config.ts`'s `dbCredentials` sets both, so this is dead code there. It only matters for `pnpm db:studio` against a TLS-required database, which fails loudly (the server refuses the plaintext connection) rather than connecting insecurely.
  - `pnpm db:migrate` is unaffected: `web/scripts/db-migrate.cjs` builds its own `Pool` directly, bypassing drizzle-kit's CLI driver entirely.

## Testing

- `scripts/dev/run-tests.sh` runs every lint, typecheck, and test suite.
  - Postgres-dependent web tests need `TEST_DATABASE_URL` (see [`RUNBOOK.md`](RUNBOOK.md#full-test-suite)). Run the relevant subset of its commands after changes.
- `scripts:check` also runs `scripts/dev/test-terraform-lib.sh`, which checks the HCL scrapers in `scripts/lib/terraform.sh` against `infra/`'s real files and against fixtures. `.github/workflows/deploy.yml` signs with `tf_aws_region` and smoke-tests the origin `tf_app_hostname` builds, so a spelling in `infra/variables.tf` or `infra/locals.tf` that they no longer read breaks a deploy rather than a plan.
- `pnpm biome:ci` is a single workspace-wide command (root's `biome.json` covers `scripts/*.js`, `web/**`, and `infra/`'s own config files in one pass), used by CI's `lint-format` job and by the pre-commit hook.
  - `web:check`/`worker:check`/`infra:check` are root package.json scripts, one per package — the same scripts CI's `web`/`worker`/`infra` jobs call. `infra:check` runs `scripts/dev/terraform-check.sh` so it uses the pinned CLI in `scripts/lib/terraform.sh`, not whichever `terraform` is first on PATH.
  - The pre-commit hook runs `biome:ci` plus these three (`scripts:check` included), so `web`'s and `scripts/`'s Biome checks run twice there — harmless, and worth it since `biome:ci` is what actually reaches `infra/`'s and root's own config files, which none of the per-package scripts cover.

## State / what's next

Scaffolding (three packages + CI) is in place. Host-run `next dev` can 500 with `ECONNREFUSED ::1` in sandboxes that block loopback to the Next proxy process — use the container (own netns); not an app bug.

- **CI's `deploy` job is disabled** (`if: false && …` in `.github/workflows/ci.yml`) while the AWS account is torn down.
  - Nothing it deploys to exists: no state bucket, no CI role, no stack.
  - Re-enable it by deleting `false && ` only after redoing [Creating account prerequisites](RUNBOOK.md#creating-account-prerequisites) and [Configuring continuous deployment](RUNBOOK.md#configuring-continuous-deployment), including the `WORKER_IMAGE_TAG` repository variable. [Going live](RUNBOOK.md#going-live) covers the switch.
  - The job's first run deploys the whole stack, and the worker image is pushed after that ([Building and pushing the worker image](RUNBOOK.md#building-and-pushing-the-worker-image)).

Known gaps, priority order:

1. **No E2E coverage.** `web/e2e/` has no specs; share/view pages SSR from the DB with no seeded test DB to run against. Seed one and add a spec.
2. **`web/Dockerfile` never run on AWS** — local podman only; ECS/ECR path unproven.
3. **Training rasterizes at full photo resolution.**
   - `_load_views` (`worker/pipeline/train.py`) resizes each photo to its COLMAP camera's `width`/`height`, which are the *original* dimensions — COLMAP downsamples for feature detection only and keeps intrinsics in original pixels — so that resize is a no-op and a 12 MP phone photo trains at 12 MP against the reference implementation's ~1600px longest edge.
   - Two consequences: training dominates job wall clock, and every ground-truth image sits in VRAM at full size (~5.9 GB for 40 × 12 MP), so a large enough set OOMs the A10G.
   - Fix is a longest-edge cap in `_load_views` scaling `fx`/`fy`/`cx`/`cy` and `width`/`height` by the same factor, or `K` no longer matches the pixels.
4. **No maximum photo count or upload size.**
   - `MIN_PHOTOS_PER_SPLAT` has no counterpart and the presign body schema (`web/app/api/v1/splats/[splatId]/photos/presign/route.ts`) is `.min(1)` only.
   - COLMAP's exhaustive matching is O(n²) pairs and the instance runs until `worker/run_job.py` returns, so an oversized upload is unbounded GPU spend.
   - The global daily cap in `process` bounds job count, not job cost ([`ARCHITECTURE.md`](ARCHITECTURE.md)).
5. **The worker's max-lifetime safety net has no alerting, and a real gap it can't close.**
   - `web/lib/server/ec2Launcher.ts` schedules `shutdown -h +WORKER_MAX_LIFETIME_MINUTES` as the first thing user-data does, paired with `InstanceInitiatedShutdownBehavior = "terminate"` on the launch, so a failed `docker login`/pull or a hang that never reaches `worker/pipeline/instance.py`'s own self-terminate still can't bill past that ceiling — *if user-data runs at all*.
   - If cloud-init itself never starts (bad AMI, a boot/networking failure), the `shutdown` is never scheduled and nothing inside the instance can catch it; only an external, instance-runtime CloudWatch alarm checking instance age independent of anything running on it would. That alarm still doesn't exist.
   - Also unaddressed either way: nothing notifies anyone when the ceiling *does* fire, so a legitimately slow job gets killed exactly the same silent way a real hang does, and nothing updates `jobs.status` when the instance disappears out from under it, so the row stays stuck rather than moving to `failed`.
   - The budgets email (`infra/budgets.tf`) is the only signal for any of this, and only in aggregate, weeks later.
   - `WORKER_MAX_LIFETIME_MINUTES`'s 2 hours is also a guess made before M0 has run on real hardware, not a measured ceiling.
6. **A well-formed but wrong `alertEmail` still deploys green.**
   - `infra/variables.tf`'s validation now catches a non-email string outright (a blank value, a stray flag, a copy-paste mistake), but a typo'd-and-still-email-shaped address (`alert+email@gmial.com`) is syntactically fine and passes it.
   - Deliverability can't be checked at apply time either way. The AWS Budget emails that address directly, with no subscription-confirmation state to check via the CLI, so the first sign of that class of typo is a budget alert that never arrives.
   - Watching for a real alert once spend crosses a threshold, or temporarily lowering `monthly_budget_limit_usd` to force one, is the only way to check.
7. **`_densify_and_prune` discards optimizer state.** `worker/pipeline/train.py` rebuilds the Adam optimizer after each densification round, dropping its moment estimates every `iterations // 10` steps. Suspect this before raising the iteration count if 10k under-converges — raising it is the expensive fix.

**M0 is next:** photograph a real object per [Capture](RUNBOOK.md#capture), then COLMAP→gsplat on real hardware. Needs the user, not an agent.
