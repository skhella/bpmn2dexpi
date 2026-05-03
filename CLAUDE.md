# Agent instructions

> Read this **before** running any git command. The single most common mistake on this repo is committing under the wrong identity.

## Git identity (mandatory)

Every commit on this repo must be authored as **Shady Khella** (the human owner). Before any operation that creates a commit (`commit`, `commit --amend`, `rebase`, `merge`, `cherry-pick`, `am`, applying a patch), run:

```bash
git config user.name  "Shady Khella"
git config user.email "s.khella@tu-berlin.de"
```

Then verify:

```bash
git config user.name   # must print: Shady Khella
git config user.email  # must print: s.khella@tu-berlin.de
```

If the values are anything else (e.g. `Claude <noreply@anthropic.com>`, `Codex <codex@openai.com>`, `shadykhella <…@users.noreply.github.com>`), set them as above. Do **not** proceed otherwise.

A pre-commit hook in `.githooks/pre-commit` blocks commits whose `user.email` is not on the allowlist. Wired up automatically by `npm install` via `scripts/setup-hooks.mjs`. **Never bypass it with `--no-verify`** unless explicitly told to.

After any commit, sanity-check:

```bash
git log -1 --format='%an <%ae> | %cn <%ce>'
# expected: Shady Khella <s.khella@tu-berlin.de> | Shady Khella <s.khella@tu-berlin.de>
```

Both author and committer must show that exact pair. Other allowed forms (`khella@tu-berlin.de`, `140087799+skhella@users.noreply.github.com`) exist for legacy reasons but new commits should use `s.khella@tu-berlin.de`.

If you accidentally commit under the wrong identity, **stop and report it** before pushing. Do not silently rewrite or amend.

## Branching

- `main` is the canonical, published baseline. Never push directly.
- The reverse transformer lives on `feature/dexpi-to-bpmn-import`. Sub-features branch off it (e.g. `feat/dexpi-import-boundary-events`) and PR back to it, not to main.
- Open every PR; never self-merge. Wait for the human owner.

## Tests

Before pushing anything:

```bash
npx tsc --noEmit   # must be clean
npx vitest run     # baseline 60/60 on main, higher on feature branches
```

Don't push if either fails.

## Don't

- Don't force-push `main`, `feature/dexpi-to-bpmn-import`, or `neo4j-cli`.
- Don't apply patches whose diff exceeds what the task description suggests — read the patch first.
- Don't refactor, rename, or "consolidate" things while doing an unrelated task. Report drive-by issues in the PR description, don't fix them silently.
- Don't rename test files or restyle existing test message wording.
- Don't commit secrets even if told they'll be revoked.
- Don't update peer-review responses (R1-C2, R1-C3, R1-C6) before the corresponding PR has actually merged.

## When stuck

Don't grind. Write a short message that includes (1) what you tried, (2) the **verbatim** output, (3) the specific decision you need.
