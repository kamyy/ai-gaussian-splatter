# AI Gaussian Splatter

Upload multi-angle photos of a physical object, get back a real-time 3D Gaussian Splat viewable and shareable in-browser. This app is public-facing with real abuse protection. A secondary goal is attempting AI/ML processing in the cloud on AWS.

**Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the "why" behind every stack choice, and [`RUNBOOK.md`](RUNBOOK.md) for local dev/ops commands before making changes.**

**Don't overengineer.** Solve the problem in front of you, not the general case it might become. No new abstraction, config option, or extensibility hook for a second use case that doesn't exist yet — add it when that use case actually shows up.

- [1. Writing docs and comments](#1-writing-docs-and-comments)
- [2. Structure](#2-structure)
- [3. Auth (Clerk)](#3-auth-clerk)
- [4. Next.js & TypeScript](#4-nextjs--typescript)
- [5. MUI & React Server Components](#5-mui--react-server-components)
- [6. CI & repo tooling](#6-ci--repo-tooling)
  - [6.1 Workflows & branch protection](#61-workflows--branch-protection)
  - [6.2 Formatting & linting](#62-formatting--linting)
  - [6.3 Shell scripts](#63-shell-scripts)
  - [6.4 Git workflow](#64-git-workflow)
  - [6.5 Testing](#65-testing)
- [7. Worker (GPU pipeline)](#7-worker-gpu-pipeline)
- [8. Infra (Terraform / AWS)](#8-infra-terraform--aws)
  - [8.1 Structure & state](#81-structure--state)
  - [8.2 Networking & TLS](#82-networking--tls)
  - [8.3 IAM & secrets](#83-iam--secrets)
  - [8.4 Deploy: image tags](#84-deploy-image-tags)
  - [8.5 Variables & state backend](#85-variables--state-backend)
  - [8.6 Stack construction](#86-stack-construction)
- [9. Database](#9-database)
  - [9.1 Schema & migrations (Drizzle)](#91-schema--migrations-drizzle)
  - [9.2 Query patterns](#92-query-patterns)
  - [9.3 Local dev & tests](#93-local-dev--tests)
  - [9.4 Connecting to RDS in production](#94-connecting-to-rds-in-production)
- [10. State / what's next](#10-state--whats-next)

---

## 1. Writing docs and comments

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
- **A sentence naming more than one file path becomes a bulleted list instead, sorted, one path per line** — even where that costs a sub-bullet under the sentence introducing them.
  - Each path is then greppable, and adding or removing one touches one line of diff.
  - Write that introducing sentence as the rule the listed files share, rather than as a subject made of their names.
- **Name the subject instead of pointing at it.** The full-path rule applies to every subject, not just files.
  - "the root module", "this app", and "this config" all make the reader work out which thing is meant, and each one goes stale the moment that thing is renamed or split. Write `infra/`, or the ECS task, or whichever it is.
  - A bare "one" or "the AWS ones" standing in for a noun from an earlier sentence has the same problem. Repeat the noun.
  - A demonstrative pointing at the immediately preceding noun in the same sentence is fine.
- **Never write a bare "job".** Two unrelated things are called that, often in the same paragraph.
  - A GitHub Actions job is named: the `deploy` job, CI's `web` job, `capture-deploy-enabled`.
  - A **worker job** is one splat's run through the pipeline: a `jobs` row, plus a GPU spot instance per stage. Say "worker job" for the run, "worker instance" for the EC2 instance, and "stage" for the reconstruct or train half that one instance runs.
- **Every heading is numbered — `## 2.`, `### 2.3` — and a `---` rule goes immediately before every `##`.**
  - The number is what tells the reader which section a subsection belongs to once its parent has scrolled off. The rule marks where each top-level section starts.
  - Headings stop at `###`, because GitHub renders `####` at body size, where it stops reading as a heading at all. Where a section needs steps, each step becomes a `###` of its own and the parent opens with an ordered list linking them, as [Deploying to production](RUNBOOK.md#2-deploying-to-production) and [Configuring continuous deployment](RUNBOOK.md#23-configuring-continuous-deployment) do.
  - Renumbering moves every anchor below the change, so inserting or reordering a section means repointing the links into the ones after it. The ToC labels carry the number; prose links keep the plain section name.
  - Put the rule under a blank line. Directly below text, `---` turns that text into a heading instead.
- **When prose names another section — in the same doc or a different one — link it, don't just quote or bold the name.**
  - Use `[Section name](#section-name)` for a same-file reference and `[Section name](OTHER.md#section-name)` across files, with the anchor GitHub/VS Code derive from the heading (lowercase, spaces to hyphens, punctuation stripped).
  - A plain quoted or bolded name silently goes stale the moment the target heading is renamed; a broken link is easier to spot in review.
- **A bare mention of one of the other root docs (`AGENTS.md`, `RUNBOOK.md`, `ARCHITECTURE.md`, `README.md`) gets linked to the file too** — `` [`AGENTS.md`](AGENTS.md) ``, not just backtick text.
  - This doesn't extend to code file paths: those stay as inline code per the rule above, since linking every one would be churn for no navigational benefit.

---

## 2. Structure

Monorepo, three independent packages:

- `web/` — Next.js 16 (App Router) + MUI + SWR + Zustand + react-three-fiber, **and** the REST API as Route Handlers under `app/api/v1/` backed by Drizzle.
- `worker/` — COLMAP + gsplat pipeline, runs on an EC2 GPU spot instance per worker-job stage.
- `infra/` — Terraform. Network, registry, data, worker IAM, web, and budgets in separate `.tf` files, one state.

Server-only code lives in `web/lib/server/` — never import it from a `"use client"` file. The one shared client-safe module is `web/lib/types.ts` (status-value tuples for Drizzle `pgEnum`s); import runs types → schema, never the reverse.

---

## 3. Auth (Clerk)

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
- **Turn off telemetry with `NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED`** (set in `.github/workflows/ci.yml`, `web/Dockerfile`, and `web/.env.example`).
  - The package reads that name on the server and also bakes it into the browser bundle. `CLERK_TELEMETRY_DISABLED` (no `NEXT_PUBLIC_`) only covers the server collector.
  - `isCI()` hides the console notice; it does not stop reporting.
  - A `pk_test_*` key still reports from CI and local container builds; a `pk_live_*` key does not.
- **`NEXT_PUBLIC_*` values are baked into the JS at `next build` time.**
  - Setting `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as a container env var at runtime does nothing. Pass it as `docker build --build-arg`.
  - `CLERK_SECRET_KEY` is the real secret and is injected at runtime from Secrets Manager.

---

## 4. Next.js & TypeScript

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
  - `next build` emits `.next/standalone/server.js` (the container's `CMD`), which omits `.next/static`, so running it by hand serves pages with no CSS or JS unless that directory is copied in as `web/Dockerfile` does. Run the container instead ([Building and running the splat-web container locally](RUNBOOK.md#13-building-and-running-the-splat-web-container-locally)).
- **Server Components reading request-time data need `export const dynamic = "force-dynamic"`**, or `next build` statically prerenders them. They call `web/lib/server/data.ts` directly — not the Route Handlers under `web/app/api/v1/`.
- **Playwright `page.route()` can't intercept SSR** (different Node process). Share pages read the DB via `web/lib/server/data.ts`, so HTTP mocks don't help. Seed a test DB instead ([State / what's next](#10-state--whats-next)).

---

## 5. MUI & React Server Components

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

---

## 6. CI & repo tooling

Node is pinned in root `.nvmrc` (`24.18.0`); CI jobs use `node-version-file`. Run `nvm use` from repo root. Nothing executes `.ts` via Node directly (Next/Vitest/Playwright transform; root `scripts/*.js` are plain JavaScript).

### 6.1 Workflows & branch protection

- **Renaming/removing a CI job blocks merges until branch protection is updated too.**
  - Required checks name jobs (`lint-format`, `worker`, `web`, `infra`); a missing context leaves PRs unmergeable — `enforce_admins` is on, so `--admin` does not override either.
  - `capture-deploy-enabled` is not one of them. It only runs on push to `main`. Making it required would block every PR.
  - Rules live in GitHub Settings → Branches, not `.github/workflows/ci.yml`.
  - List: `gh api repos/kamyy/ai-gaussian-splatter/branches/main/protection`.
- **The deploy steps live in `.github/workflows/deploy.yml`, a `workflow_call` workflow run only by `.github/workflows/ci.yml`'s `deploy` job.**
  - That caller keeps the `needs` on the check jobs plus `capture-deploy-enabled`, the `if:` gate, and the `id-token: write` grant.
  - The `if:` reads `needs.capture-deploy-enabled.outputs.enabled`, not live `vars.DEPLOY_ENABLED`. `scripts/prod/set-deploy-enabled.sh` is the switch ([Going live](RUNBOOK.md#26-going-live)). Git does not record whether that variable is set ([CI/CD](ARCHITECTURE.md#11-cicd)).
  - The grant can't move into `.github/workflows/deploy.yml`, because a called workflow can only narrow its caller's permissions and this repo's default token is read-only.
  - A job run through a called workflow reports its check as `<caller job> / <called job>`, so moving a required one (`lint-format`, `worker`, `web`, `infra`) into its own file is a rename as far as branch protection is concerned.

### 6.2 Formatting & linting

- **Biome does not format Markdown, YAML, Dockerfiles, or shell scripts** (`@biomejs/biome@2.5.10`, pinned in both root and `web/`). Keep those consistent by hand.
  - It doesn't lint `.sh` either. `scripts:check` runs shellcheck instead.
  - `biome.json` sets `lineWidth: 120`. One measure holds repo-wide.
  - When hand-wrapping comments in the files Biome skips, including comments inside a Markdown fenced code block, treat 120 as the fill target: greedily pack each line with words up to that width before wrapping to the next, the same way a `fmt`/text-fill pass would, not an early wrap at whatever width feels readable.
  - Markdown *prose* is the exception: no max width, since GitHub reflows paragraphs and fixed wraps only add diff noise. One line per paragraph/list item.
  - **The fill target governs comments, not the shell Biome skips.** Shell in `scripts/` and in a Dockerfile `RUN` is laid out to be read, so packing it to 120 is the wrong instinct.
  - **A list a loop iterates gets one item per line, sorted, once it outgrows a single line.** Each name is then greppable, and adding or removing one touches one line of diff. `worker/Dockerfile`'s prune list is the example.
  - **A guard inside that shell is `if ... then ... fi`, not `test ... || { ...; exit 1; }`.** The condition, the message and the exit each get their own line, which is how `scripts/` already writes them.

### 6.3 Shell scripts

Operational scripts live in `scripts/dev/` (local) and `scripts/prod/` (the deployed account), and are committed executable (`rwxr-xr-x`). Helpers in `scripts/lib/` are sourced, so they stay `rw-r--r--`.

- Every operational script accepts `-h`/`--help`, prints usage on stdout, exits 0, and does that before login, confirm, or any other work.
- Each helper starts with `# shellcheck shell=bash` in place of a shebang.
- Operational scripts that share a subject use topic-then-action kebab-case (`terraform-*`, `worker-*`, `db-*`).
- A one-off procedure stays verb-object (`create-account-prereqs`, `configure-ci-role`).
- Lib files are a domain:
  - `scripts/lib/aws.sh`
  - `scripts/lib/env.sh`
  - `scripts/lib/github.sh`
  - `scripts/lib/terraform.sh`
  - `scripts/lib/worker.sh`
- `scripts/lib/confirm.sh` is named after its one function.
- Lib functions take that file's prefix (`aws_`, `gh_`, `tf_`, `env_`, `worker_`) then a verb.
- Fail-fast helpers are `*_require_*`.
- A function defined in an operational script itself, rather than in a sourced `scripts/lib/` file, has no prefix.
- Assign each positional argument to a named variable before using it, so a later `$1` doesn't leave the reader guessing which argument it is.
  - That assignment is `local` inside a function and an ordinary variable at script top, where `local` is invalid.
  - `"$@"` is only for leftover arguments forwarded to another command.
- A script that uses the AWS CLI as a signed-in admin sources `scripts/lib/aws.sh`, and calls `aws_require_login` before any other AWS CLI invocation.
- A script that tags the AWS resources it creates sets `Project` to `ai-gaussian-splatter`, the same string as `local.project_tag` in `infra/locals.tf` (`infra/providers.tf`'s `default_tags`). The name does not change, so the scripts do not scrape it.
  - The Spot service-linked role and GitHub OIDC provider are account-wide and stay untagged.
- A script that creates or deletes anything sources `scripts/lib/confirm.sh` and calls `confirm` first.
- A script that uses the GitHub CLI sources `scripts/lib/github.sh` and calls `gh_require_login` before its first `gh` call. Otherwise a logged-out `gh` reads the same as an unset repository variable.
- A script that acts on the deployed account also calls `gh_require_aws_deploy_account`, which checks the signed-in account against the `AWS_ACCOUNT_ID` repository variable:
  - `scripts/prod/terraform-delete-state-bucket.sh`
  - `scripts/prod/terraform-destroy.sh`
  - `scripts/prod/terraform-plan.sh`
  - `scripts/prod/worker-push-image.sh`
- The worker scripts run as the dev IAM user from `web/.env` instead, so `worker_use_dev_aws` in `scripts/lib/worker.sh` checks those keys.
- Local Terraform is `$HOME/.local/bin/terraform` (`scripts/dev/terraform-install.sh`). Scripts that run it assign `TERRAFORM=$(tf_get_bin)`, which prefers that path over PATH, because a different CLI earlier on PATH still satisfies `command -v terraform`.
  - CI has no copy there. `hashicorp/setup-terraform` in `.github/workflows/ci.yml` and `.github/workflows/deploy.yml` installs whatever `tf_get_required_version` reads from `infra/providers.tf`.
- `scripts:check` (run by the pre-commit hook and CI's `lint-format` job) shellchecks them with `scripts/dev/shellcheck.sh`, which runs shellcheck's container image.
  - The image is pinned by digest, so neither a new shellcheck release nor a re-pushed tag can change the result for an unchanged tree.
  - The repo is mounted read-only with `--security-opt label=disable`, because a `:Z` mount relabels the whole checkout for SELinux.

### 6.4 Git workflow

- **`main` is push-protected.** All changes land via PR, including edits to docs, config, and `.gitignore`.
- **Branch names are type-prefixed** (`chore/`, `refactor/`, `docs/`, `fix/`, …). Commit messages are a separate convention.
- **Merge with `gh pr merge --merge`**, not squash/rebase — preserves scoped commits on `main`.
- **Update a stale PR with `git rebase main`** then `push --force-with-lease`, not merge `origin/main` into the branch.

### 6.5 Testing

- `scripts/dev/run-tests.sh` runs every lint, typecheck, and test suite.
  - Postgres-dependent web tests need `TEST_DATABASE_URL` (see [`RUNBOOK.md`](RUNBOOK.md#19-full-test-suite)). Run the relevant subset of its commands after changes.
- `scripts:check` also runs `scripts/dev/terraform-test-lib.sh`, which checks the HCL scrapers in `scripts/lib/terraform.sh` against `infra/variables.tf` and against fixtures. `.github/workflows/deploy.yml` signs with `tf_get_aws_region`, so a spelling in `infra/variables.tf` that it no longer reads breaks a deploy rather than a plan.
- `pnpm biome:ci` is a single workspace-wide command (root's `biome.json` covers `scripts/*.js` and `web/**` in one pass), used by CI's `lint-format` job and by the pre-commit hook.
  - `web:check`/`worker:check`/`infra:check` are root package.json scripts, one per package — the same scripts CI's `web`/`worker`/`infra` jobs call. `infra:check` runs `scripts/dev/terraform-check.sh` so it uses the pinned CLI in `scripts/lib/terraform.sh`, not whichever `terraform` is first on PATH.
  - The pre-commit hook runs `biome:ci` plus these three (`scripts:check` included), so `web`'s and `scripts/`'s Biome checks run twice there — harmless, and worth it since `biome:ci` is what actually reaches root's own config files, which none of the per-package scripts cover.

---

## 7. Worker (GPU pipeline)

- **Local pipeline runs are a Podman container: they need an NVIDIA GPU, the NVIDIA driver, and `nvidia-container-toolkit`.**
  - The CUDA runtime lives in both worker images. COLMAP lives in `worker/Dockerfile`'s `reconstruct` target and gsplat in its `train` target. Don't install any of them on the host. `worker/Dockerfile` compiles gsplat's kernels in a build stage, so neither shipped image carries `nvcc`.
  - Setup and the run scripts are in [`RUNBOOK.md`](RUNBOOK.md#14-worker-local-pipeline-run).
- **The worker container is two hops from IMDS, so `RunInstances` sets `HttpPutResponseHopLimit: 2`** (`web/lib/server/ec2Launcher.ts`).
  - At EC2's default of 1 the token PUT in `worker/pipeline/instance.py` gets no reply, `get_self_instance_id()` returns `None`, and the instance never terminates itself — logging one INFO line indistinguishable from a local run while a `g5.xlarge` keeps billing.
  - `HttpTokens: "required"` is paired with it and depends on it: on its own it removes the IMDSv1 fallback and breaks credentials too, not just self-termination.
- **Typical agent sandboxes have none of that**, so an agent can't run the pipeline itself and has to hand a real run back to the user.

---

## 8. Infra (Terraform / AWS)

### 8.1 Structure & state

- **All of `infra/` shares one state**, with its six logical areas (network, registry, data, worker IAM, web, budgets) split across separate `.tf` files for readability ([Infra](ARCHITECTURE.md#8-infra)). Nothing references another file by name, only by resource address in that one state, so moving a resource between files or renaming an area is a file-organization change only.
- **Never add the state bucket as a resource in `infra/`.** Skip creating it ([Creating account prerequisites](RUNBOOK.md#22-creating-account-prerequisites)) and `terraform init` fails.
- **`infra/tests/*.tftest.hcl` run fully offline via `mock_provider "aws" {}`.**
  - Every file needs two `mock_provider "aws"` blocks — one default, one `alias = "billing"` — since a bare `mock_provider "aws" {}` only covers the unaliased provider configuration and `providers.tf` declares a second one for `us-east-1`.
  - An assertion that a value follows a variable has to run against a second value of that variable, in a `run` block with its own `variables {}`.
    - Written against the file-level fixture, `"ai-gaussian-splatter.${var.domain_zone_name}"` and `"ai-gaussian-splatter.example.com"` are the same string. The assertion then passes whether the resource reads `local.app_hostname` or hardcodes the hostname.
    - `hostnames_follow_the_zone_variable` (`infra/tests/web.tftest.hcl`) and `cors_origins_follow_the_zone_variable` (`infra/tests/data.tftest.hcl`) are the runs that own that fact.
- **Terraform reads `aws login` credentials only through a recent AWS provider.**
  - An older `hashicorp/aws` fails at the first `plan` with `No valid credential sources found`, even though `terraform init` succeeds, because the S3 backend reads the credentials itself.
  - `terraform version` in `infra/` names the provider version actually installed.

### 8.2 Networking & TLS

- **The ACM cert (`infra/web.tf`) takes no explicit `provider`**, so it inherits the default provider's `var.aws_region` — required, since an ALB can only reference a certificate in its own region.
  - Same hostname in another region is normal (certs are free).
- **Set the HTTPS listener's `ssl_policy` explicitly** (`ELBSecurityPolicy-TLS13-1-2-2021-06`). Leaving it unset defaults to the weak `ELBSecurityPolicy-2016-08` (TLS 1.0/1.1), not the console's strong default.
- **Don't add a `data "aws_route53_zone"` block.** The zone is referenced by ID only (`var.hosted_zone_id`), for the reason in [TLS & DNS](ARCHITECTURE.md#93-tls--dns).
- **The ALB's `0.0.0.0/0` ingress rules are explicit resources** (`aws_vpc_security_group_ingress_rule.alb_https`/`alb_http` in `infra/network.tf`). Deleting these two resources still applies cleanly and refuses every connection, so their presence is what actually matters, not an assumption that some other resource implies them.
- **A second ingress rule on `aws_security_group.web` opens a path from the internet.**
  - Tasks are in public subnets with a public IP and no NAT.
  - That group's single rule, `aws_vpc_security_group_ingress_rule.web_from_alb` (`infra/web.tf`), sourced from the ALB security group on `local.container_port`, is the only network control ([Networking](ARCHITECTURE.md#92-networking)).
  - `infra/tests/network.tftest.hcl` and `web.tftest.hcl` assert this; tripping it is a security change.
- **`KEEP_ALIVE_TIMEOUT` must exceed the ALB idle timeout (60s), or healthy deploys serve intermittent 502s.**
  - Node's default keep-alive is 5s; Next standalone only overrides via `KEEP_ALIVE_TIMEOUT`. ALB then hands requests to sockets the app already closed — no app log entry.
  - `infra/locals.tf` sets `65000` ms. Raising ALB idle without raising this reopens the gap.

### 8.3 IAM & secrets

- **`ec2:RunInstances` needs two separate IAM statements, not one** (`infra/web.tf`'s `aws_iam_role_policy.task`, `Sid`s `RunInstances`/`RunInstancesTagged`).
  - IAM authorizes it against each resource the request touches; `web/lib/server/ec2Launcher.ts` tags only the instance, so `aws:RequestTag` is absent for the AMI, subnet, and security group and a single conditioned statement denies the whole call.
  - `ec2:CreateTags` (scoped by `ec2:CreateAction`) is a separate statement that tagging-on-launch also requires. `infra/tests/web.tftest.hcl` pins all three staying split.
  - Every role's grants live in one `aws_iam_role_policy` resource per role, one `Sid`-tagged statement per grant — not one resource per grant — so tests address statements by `Sid` instead of by a dedicated resource name.
- **The Clerk secret is referenced by ARN (`var.clerk_secret_key_arn`), never created.** It must exist before the first apply ([Creating account prerequisites](RUNBOOK.md#22-creating-account-prerequisites)).
  - A partial ARN applies clean and only fails at task start, because ECS resolves `valueFrom` at task start rather than at apply ([Clerk secret](ARCHITECTURE.md#94-clerk-secret)).
  - A variable validation checks the ARN's shape and names this secret specifically. `aws_iam_role_policy.execution`'s precondition checks it names this deploy's own account and region.
  - Neither confirms the value behind the ARN, so a copy-paste of the wrong environment's secret still applies clean. Check with `aws secretsmanager describe-secret` before applying.
- **The RDS master credentials come from `manage_master_user_password = true`** (`infra/data.tf`), not a hand-rolled secret.
  - RDS creates and rotates its own Secrets Manager secret holding both `username` and `password`; `infra/web.tf` reads both fields off `aws_db_instance.main.master_user_secret[0].secret_arn`.

### 8.4 Deploy: image tags

- **Image tags are `<web-tree-id>-web` and `<web-tree-id>-migrate`, not commit SHAs, and the ECR repository (`infra/registry.tf`) is `IMMUTABLE`.** `scripts/lib/terraform.sh`'s `tf_get_web_image_tag` is the one definition, used by `.github/workflows/deploy.yml` and by the no-service fallback in the same file.
  - It truncates to a fixed 12 characters rather than calling `git rev-parse --short`, whose length tracks the local object count and so differs between CI's shallow checkout and a full clone. `scripts/dev/terraform-test-lib.sh` pins the width.
  - One repository (`ai-gaussian-splatter`) holds both build targets of `web/Dockerfile`; the suffix is what tells them apart, and `infra/web.tf` appends it.
  - `var.web_image_tag`/`var.migrate_image_tag` take a bare abbreviated hex object id; a variable `validation` block in `infra/variables.tf` refuses any other shape before `terraform plan` ever reaches AWS.
  - A pushed tag can never be repointed, so the deploy job skips any build whose tag is already in the repository. That is what makes it re-runnable from any step, and what keeps an unchanged `web/` from rebuilding.
  - Per-build tags exist to keep the deployment circuit breaker's rollback meaningful: with a moving tag every release shares one task definition, and a rollback re-pulls the image that just failed.
- **A push that leaves `web/` byte-identical builds nothing and leaves the service's *image* unchanged. It does not mean the service keeps running.** `aws_ecs_service.web` names `aws_ecs_task_definition.web.arn`, a revision-qualified ARN with no `ignore_changes`, so any task-definition change registers a new revision and ECS replaces the tasks.
  - The image is one field among many in that task definition. `WORKER_RECONSTRUCT_IMAGE_URI`, `WORKER_TRAIN_IMAGE_URI`, `KEEP_ALIVE_TIMEOUT`, `cpu`/`memory`, `APP_PUBLIC_URL`, and the Clerk and RDS wiring all live there too, and all of them are editable from `infra/` alone.
  - That rollout is load-bearing, not a leak. The worker-image flow depends on it: a deploy carries a new `WORKER_IMAGE_TAG` into both worker image URIs, and only a task replacement puts them in front of `web/lib/server/ec2Launcher.ts` ([Building and pushing the worker image](RUNBOOK.md#27-building-and-pushing-the-worker-image)).
  - It lands in the *first* apply, which is untargeted. The roll-forward apply is the no-op on such a push, not the other way round.
  - **The migration task still runs, and gating it on the tag is a trap** ([Migration ordering](ARCHITECTURE.md#113-migration-ordering)).
  - `HEAD:web` is tree-root relative, so the `working-directory: infra` on "Resolve tags" doesn't change what it reads.
  - **Keep the truncation a parameter expansion, not a pipe through `cut`.** `git rev-parse` echoes an argument it cannot resolve back to stdout before exiting non-zero.
    - A pipeline reports only its last command's status unless the caller set pipefail. `.github/workflows/deploy.yml` names no `shell:`, so its steps run under Actions' default `bash -e {0}`, which leaves pipefail off.
    - A piped helper would therefore return 0 and tag images `HEAD:web-web`. `scripts/dev/terraform-test-lib.sh` drops pipefail to pin this.
  - The files `web/.dockerignore` excludes (`web/e2e/`, `web/tests/`, `web/playwright.config.ts`, `**/*.test.ts`) still change the tree id, so touching one costs a rebuild and a rollout of identical bytes. That is the safe direction to be wrong in.
- **A build input outside `web/` reaches production only through a change under `web/`**, and `gh run rerun` resolves the same tag and so rebuilds nothing. What that covers, and how to map a tag back to a commit, are in [Image tags](ARCHITECTURE.md#111-image-tags).
- **Two separate image-tag variables, one default.**
  - `web_image_tag` is the Fargate service's own image; `migrate_image_tag` is the migration task definition's, and falls back to `web_image_tag` when left empty (`infra/locals.tf`'s `local.migrate_image_tag`).
  - Every existing `terraform apply -var web_image_tag=$TAG` invocation with no `migrate_image_tag` keeps deploying one build that serves both roles.
  - `.github/workflows/deploy.yml` is the one caller that ever diverges the two — see [Migration ordering](ARCHITECTURE.md#113-migration-ordering) for why.
  - `ai-gaussian-splatter-migrate` (task family), `ai-gaussian-splatter-migrate-task` (migration task role), and `ai-gaussian-splatter-execution` (execution role) are fixed literal names, for the same reason `CLUSTER_NAME`/`SERVICE_NAME` are.
    - Rotating the Clerk secret is a write plus `aws ecs update-service --force-new-deployment`, not a `terraform apply`. That command needs names someone can write out literally rather than look up from a Terraform-assigned one.
- **The worker image lives in its own ECR repository (`ai-gaussian-splatter-worker`, `infra/registry.tf`), separate from the web repository above, and `var.worker_image_tag` has no default.**
  - No deploy ever rebuilds and pushes it, so this variable only changes when someone hand-builds and pushes a new one ([Building and pushing the worker image](RUNBOOK.md#27-building-and-pushing-the-worker-image)). It stays a commit SHA, because `scripts/prod/worker-push-image.sh` tags the image with the checked-out commit rather than a tree.
  - Re-running that script on an already-pushed commit fails at `podman push` with `ImageTagAlreadyExists`. Commit again rather than retagging.
  - Its lifecycle policy keeps far fewer images (`local.worker_releases_kept`, currently 2) than the web repository's `local.releases_kept` (10).
    - The worker images cost real money to retain at ~1.9 GB and ~8.0 GB. They are also part of no ECS rollback mechanism, since `web/lib/server/ec2Launcher.ts` just reads whichever URI it is handed.
    - The count is per tag suffix, with one rule each for `-reconstruct` and `-train`, so both halves of a release expire together.

### 8.5 Variables & state backend

- **No placeholder-value fallback for required variables.**
  - `terraform validate` and `terraform test` (`mock_provider`) never touch real AWS, so required variables (`worker_ami_id`, `alert_email`, `domain_zone_name`, `hosted_zone_id`, `clerk_secret_key_arn`, `web_image_tag`, `worker_image_tag`) simply have no default in `infra/variables.tf`. CI's `infra` job never has to supply one.
  - A real `terraform plan`/`apply` fails immediately when one is unset.
  - `.github/workflows/deploy.yml` maps each from a GitHub repository variable, though, and an unset repository variable arrives as `""`, which Terraform accepts as a value. There only a `validation` block catches it, so every required variable has one that rejects `""`. Give any new required variable one too.
- **`var.aws_region`'s default in `infra/variables.tf` is the only place the region is written.** `scripts/lib/terraform.sh`'s `tf_get_aws_region` reads it, and every AWS CLI call in `scripts/` plus the `Resolve region` step in `.github/workflows/deploy.yml` take it from there.
  - Two places keep their own copy, neither of which reaches AWS. `scripts/dev/create-resources.sh` uses `web/.env`'s own `AWS_REGION`, so the dev buckets match the region `web/lib/server/env.ts` signs upload URLs for; a new `web/.env` is seeded from the same default. `.github/workflows/ci.yml`'s web job sets it as a fixture beside `AWS_ACCESS_KEY_ID: testing`.
  - The Budgets provider (`infra/budgets.tf`) stays pinned to `us-east-1` — see [Stack construction](#86-stack-construction).
  - Moving the region means a teardown, then the whole of [Deploying to production](RUNBOOK.md#2-deploying-to-production) again. Nothing migrates an ALB, an RDS instance, or an ECR repository across regions. The state bucket, the Clerk secret, the CI role's ARNs, and `WORKER_AMI_ID` are region-specific as well.
  - Tear down before editing the default. `terraform init` looks for the state bucket in whatever the default currently says, so an edited default points `scripts/prod/terraform-destroy.sh` at a bucket that doesn't exist while the old stack keeps billing.
- **The account id used to build IAM/ARN resources comes from `data.aws_caller_identity.current`**, evaluated fresh on every real plan or apply.
  - `.github/workflows/deploy.yml` still validates its own `AWS_ACCOUNT_ID` repository variable, but only to build the CI role's ARN and the state bucket name — nothing in `infra/` itself reads that environment variable.
- **The state bucket name (`ai-gaussian-splatter-tfstate-<account-id>`) is passed to `terraform init` via `-backend-config`, never hardcoded in `infra/providers.tf`.**
  - The bucket is account-specific and created once by hand; baking its name into the shared `backend "s3"` block would make the whole config account-specific too.

### 8.6 Stack construction

- **The billing/budgets resources (`infra/budgets.tf`) use a second, aliased `provider = aws.billing` (`us-east-1`).** The Budgets API only exists in `us-east-1`, regardless of where the rest of the app runs.

---

## 9. Database

### 9.1 Schema & migrations (Drizzle)

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

### 9.2 Query patterns

- **UUID-check path params before the DB** — `uuid` columns turn `/api/v1/splats/abc` into Postgres `22P02` → 500. Use `requireUuid()` (routes) or `isUuid()` (`web/lib/server/data.ts`, null → `notFound()`).
- **Missing row is `undefined`, not `null`.** Idiom: `const [row] = await getDb().select()…limit(1)` then `if (row === undefined)`.
- **`onConflictDoNothing()` returns zero rows from `.returning()`.** `getOrCreateUser` uses `onConflictDoUpdate` with no-op `set: { clerkUserId }` so Postgres returns the existing row.
- **Upsert `set` must reference the column, not a pre-read JS value** — e.g. ``count: sql`${rateLimitCounters.count} + 1` ``. A plain `{ count: n + 1 }` reopens the race. Confirm real SQL with `log_statement='all'` or `drizzle(pool, { logger: true })`.
- **`.$onUpdate(() => new Date())` drives `updatedAt`** — no DB trigger; raw `sql` UPDATE skips it.

### 9.3 Local dev & tests

- **`await closeDb()` in `afterAll`** or Vitest hangs (open `pg` Pool). `web/tests/migrate-test-db.ts` closes its own migration pool in `finally`.
- **The `server` Vitest project fails outright when `TEST_DATABASE_URL` is unset**, so a green run means the DB tests actually ran.
  - `web/tests/migrate-test-db.ts` throws before any test starts, including the server tests that never touch Postgres.
  - CI sets it and starts Postgres as a `podman run` step in `.github/workflows/ci.yml`, not a `services:` container — see [Postgres connectivity & TLS](ARCHITECTURE.md#7-postgres-connectivity--tls).
  - Locally `web/vitest.config.mts` reads it from `web/.env`. Run `scripts/dev/db-up.sh` if Postgres seems missing ([`RUNBOOK.md`](RUNBOOK.md#12-web-frontend--rest-api)).
- **`fileParallelism: false` in `web/vitest.config.mts`.**
  - DB-backed files share one DB and clear tables in `beforeEach`; parallel runs delete each other's fixtures. Per-worker DBs would restore parallelism.
  - Transaction-per-test can't cover the real concurrency tests (`getOrCreateUser` race, rate-limit atomicity) — one connection serializes queries.

### 9.4 Connecting to RDS in production

- **Connection string assembly.** RDS secrets are JSON (`username`/`password`); ECS can inject only one JSON field at a time — no formatted `postgresql://` URL.
  - `infra/web.tf` projects `DATABASE_USER` from the secret for both containers and passes `DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_NAME` as env.
  - `web/scripts/db-migrate.cjs` calls `web/lib/server/databaseUrl.ts`'s `resolveDatabaseUrl()` to reassemble and percent-encode a full URL from those plus a password; local dev, CI, and the migration task all take that same path. The long-lived web service doesn't — see the next bullet.
  - Tests: `infra/tests/web.tftest.hcl`, `web/lib/server/tests/databaseUrl.test.ts`.
- **The web service fetches its own DB password at connect time; the migration task doesn't.** RDS rotates its managed master-password secret on a schedule ([Master password refresh](ARCHITECTURE.md#71-master-password-refresh)).
  - A password ECS injects once as an env var at task start goes stale for anything long-lived, since Postgres doesn't re-authenticate already-open connections but does reject new ones with the old one.
  - `infra/web.tf` gives the web task only `DATABASE_USER` as a secret, plus a plain `DATABASE_SECRET_ARN` env var naming (not holding) the RDS secret.
  - `web/lib/server/db/index.ts`'s `getDb()` passes `pg.Pool` a `password` **function** (`web/lib/server/databaseUrl.ts`'s `fetchDatabasePassword`, cached 5 minutes) instead of a string, so it re-fetches on every new physical connection rather than once.
  - A rotation makes that cached copy wrong straight away, so `getDb()` builds a `SecretPasswordPool` that clears the cache and retries once when Postgres rejects the password (`28P01`).
  - `pg`'s dynamic password only works with `Pool`'s discrete `host`/`port`/`database`/`user`/`password` fields, not a `connectionString`, which is why `getDb()` no longer builds one the way `web/scripts/db-migrate.cjs` still does.
  - The migration task keeps the old static `DATABASE_PASSWORD` secret unchanged — it runs for seconds and exits, well inside the rotation window, so it has nothing to go stale against, and giving it Secrets Manager read access instead would cost an IAM grant for no benefit.
- **TLS.** RDS forces SSL, and `pg` defaults to no TLS → `no pg_hba.conf entry ... no encryption`.
  - Nothing in `infra/` sets this. RDS's default Postgres parameter group carries `rds.force_ssl = 1`, and `infra/data.tf` declares no parameter group of its own, so attaching one later would have to keep it.
  - `/api/v1/healthz` never hits the DB, so ECS can look healthy while queries 500.
  - Node's `?sslmode=require` is `verify-full`, not libpq's encrypt-only. Without Amazon's CA you get `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
  - Fix: bake the RDS CA bundle in `web/Dockerfile`, set `DATABASE_SSL_CA` from `infra/web.tf`, pass `ssl: { ca }` in `web/lib/server/databaseUrl.ts`; leave `rejectUnauthorized` at default `true`. Do not use `rejectUnauthorized: false`. (Node's `sslmode` behavior was checked empirically; libpq docs don't transfer.)
  - Local dev and CI run a plain, TLS-less Postgres — `DATABASE_SSL_CA` unset makes `databaseSsl()` return undefined and the connection plain — so this whole path is otherwise unexercised until a real AWS deploy.
- **`drizzle-kit`'s CLI driver silently ignores a sibling `ssl` field in `dbCredentials` whenever `url` is also set** (checked against `drizzle-kit/bin.cjs`: `"url" in credentials ? new pg.Pool({connectionString: credentials.url}) : new pg.Pool({...credentials, ssl})`). The `url` branch never even looks at `ssl`.
  - `web/drizzle.config.ts`'s `dbCredentials` sets both, so this is dead code there. It only matters for `pnpm db:studio` against a TLS-required database, which fails loudly (the server refuses the plaintext connection) rather than connecting insecurely.
  - `pnpm db:migrate` is unaffected: `web/scripts/db-migrate.cjs` builds its own `Pool` directly, bypassing drizzle-kit's CLI driver entirely.

---

## 10. State / what's next

Scaffolding (three packages + CI) is in place. Host-run `next dev` can 500 with `ECONNREFUSED ::1` in sandboxes that block loopback to the Next proxy process — use the container (own netns); not an app bug.

- **The AWS account is torn down.** Nothing the `deploy` job deploys to exists: no state bucket, no CI role, no stack.
  - Turn the `deploy` job on only after redoing [Creating account prerequisites](RUNBOOK.md#22-creating-account-prerequisites) and [Configuring continuous deployment](RUNBOOK.md#23-configuring-continuous-deployment), including the `WORKER_IMAGE_TAG` repository variable. [Going live](RUNBOOK.md#26-going-live) covers the switch.
  - The `deploy` job's first run deploys the whole stack, and the worker image is pushed after that ([Building and pushing the worker image](RUNBOOK.md#27-building-and-pushing-the-worker-image)).

Known gaps, priority order:

1. **No E2E coverage.** `web/e2e/` has no specs; share/view pages SSR from the DB with no seeded test DB to run against. Seed one and add a spec.
2. **`web/Dockerfile` never run on AWS** — local podman only; ECS/ECR path unproven.
3. **No maximum photo count or upload size.**
   - `MIN_PHOTOS_PER_SPLAT` has no counterpart and the presign body schema (`web/app/api/v1/splats/[splatId]/photos/presign/route.ts`) is `.min(1)` only.
   - COLMAP's exhaustive matching is O(n²) pairs and the instance runs until `worker/run_job.py` returns, so an oversized upload is unbounded GPU spend.
   - The global daily cap in `process` bounds how many worker jobs run, not what each one costs ([Abuse protection](ARCHITECTURE.md#10-abuse-protection)).
4. **The worker's max-lifetime safety net has no alerting, and a real gap it can't close.**
   - `web/lib/server/ec2Launcher.ts` schedules `shutdown -h +WORKER_MAX_LIFETIME_MINUTES` as the first thing user-data does, paired with `InstanceInitiatedShutdownBehavior = "terminate"` on the launch, so a failed `docker login`/pull or a hang that never reaches `worker/pipeline/instance.py`'s own self-terminate still can't bill past that ceiling — *if user-data runs at all*.
   - If cloud-init itself never starts (bad AMI, a boot/networking failure), the `shutdown` is never scheduled and nothing inside the instance can catch it; only an external, instance-runtime CloudWatch alarm checking instance age independent of anything running on it would. That alarm still doesn't exist.
   - Two things are unaddressed either way. Nothing notifies anyone when the ceiling *does* fire, so a legitimately slow worker job dies exactly as silently as a real hang.
   - Nothing updates `jobs.status` when the instance disappears out from under it either, so the row stays stuck rather than moving to `failed`.
   - The budgets email (`infra/budgets.tf`) is the only signal for any of this, and only in aggregate, weeks later.
   - `WORKER_MAX_LIFETIME_MINUTES`'s 2 hours is also a guess, not a ceiling measured against a real worker job's wall clock.
5. **A well-formed but wrong `alertEmail` still deploys green.**
   - `infra/variables.tf`'s validation now catches a non-email string outright (a blank value, a stray flag, a copy-paste mistake), but a typo'd-and-still-email-shaped address (`alert+email@gmial.com`) is syntactically fine and passes it.
   - Deliverability can't be checked at apply time either way. The AWS Budget emails that address directly, with no subscription-confirmation state to check via the CLI, so the first sign of that class of typo is a budget alert that never arrives.
   - Watching for a real alert once spend crosses a threshold, or temporarily lowering `monthly_budget_limit_usd` to force one, is the only way to check.
6. **`_densify_and_prune` discards optimizer state.** `worker/pipeline/train.py` rebuilds the Adam optimizer after each densification round, dropping its moment estimates every `iterations // 10` steps. Suspect this before raising the iteration count if 10k under-converges — raising it is the expensive fix.

**M0 has run locally:** a real capture has been through COLMAP→gsplat and opened in the viewer on a local GPU, via the `scripts/dev/worker-*.sh` runs in [Worker (local pipeline run)](RUNBOOK.md#14-worker-local-pipeline-run). Nothing has run on AWS (gap 2), and no run's wall clock has been recorded.
