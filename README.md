# Cockpit Kit

Cockpit Kit is a global AI skill and script kit for operating a local-first knowledge repo from any supported AI environment.

It is an AI-agent local memory kit, not the Red Hat Cockpit Linux server administration console. The naming overlap is intentional for now, and this project is not affiliated with Red Hat Cockpit.

## What it does

- Installs one canonical `SKILL.md` into supported AI environments.
- Resolves a configured local knowledge repo from any working directory.
- Creates or links a starter Cockpit-compatible static HTML knowledge repo.
- Lints pages against the Cockpit Kit page contract.
- Generates a deterministic static search index.
- Serves the local repo over a loopback-only HTTP server with token auth by default.
- Optionally accepts operator page comments and captures through an opt-in write service.

## Requirements

- Node.js 20 or newer.
- Git, when creating a new starter knowledge repo with the default initial commit.
- macOS or Linux for v1.

No package-manager install is required for v1. Runtime code uses Node.js built-in modules only.

## Install

Clone the kit wherever you want it to live. The documented convention is:

```bash
git clone https://github.com/autojeremy/cockpit-kit ~/.local/share/cockpit-kit
```

Create a new starter knowledge repo and install adapters:

```bash
node ~/.local/share/cockpit-kit/skill/scripts/setup.mjs \
  --cockpit-root ~/cockpit \
  --adapters agents,hermes,claude \
  --yes
```

Or link an existing Cockpit-compatible knowledge repo:

```bash
node ~/.local/share/cockpit-kit/skill/scripts/setup.mjs \
  --cockpit-root /path/to/knowledge-repo \
  --adapters agents,hermes,claude \
  --yes
```

Setup writes machine-local config to `${XDG_CONFIG_HOME:-~/.config}/cockpit/config.toml`. The knowledge repo stays separate from the kit repo.

## Common commands

Resolve the configured knowledge repo:

```bash
node ~/.local/share/cockpit-kit/skill/scripts/where.mjs --json
```

Generate search index data:

```bash
node ~/.local/share/cockpit-kit/skill/scripts/search-index.mjs --root /path/to/knowledge-repo
```

Lint a knowledge repo strictly:

```bash
node ~/.local/share/cockpit-kit/skill/scripts/lint.mjs --root /path/to/knowledge-repo --strict
```

Serve a knowledge repo locally:

```bash
node ~/.local/share/cockpit-kit/skill/scripts/serve.mjs --root /path/to/knowledge-repo
```

`serve.mjs` binds to loopback by default and prints a tokenized URL. Use `--no-auth` only on a trusted machine.

## Operator comments and capture (MVP, opt-in)

An optional write service lets the operator leave page comments and quick captures from the browser and follow them to an agent's outcome. It is off by default; plain `serve.mjs` stays read-only and static sites are unaffected.

- **Widget:** starter pages include `cockpit-intents.js` (plus `cockpit-intents.css`). It probes `GET /api/cockpit/v1/capabilities` and stays hidden when the service is absent. It offers Comment (on this page), Capture, and a Requests panel with Active and Done views (status, outcome, page link, commit id).
- **State:** one private JSON file per knowledge repo at `${XDG_STATE_HOME:-~/.local/state}/cockpit-kit/<repo-hash>/intents.json` (mode `0600`, atomic temp+rename), never inside the served tree, `.cockpit/`, or the search index.
- **Trust:** only `operator_message` and operator follow-ups are instructions; quotes, captured text, and URLs go in `payload` as untrusted data. Mutations require an exact `Origin`, a CSRF token from `capabilities`, `application/json`, and a body of 32 KiB or less. Client output paths and service-controlled fields are rejected; comment targets must be existing pages inside the root.

Local write mode, behind the existing cookie auth (`--write --no-auth` is refused):

```bash
node ~/.local/share/cockpit-kit/skill/scripts/serve.mjs --root /path/to/knowledge-repo --write
```

Behind an authenticating reverse proxy, run the standalone loopback service and route `/api/cockpit/v1/*` to it. The proxy must inject `X-Cockpit-Proxy-Secret` (contents of the printed secret file) and optionally `X-Cockpit-Principal`, and must strip both from client requests:

```bash
node ~/.local/share/cockpit-kit/skill/scripts/intents-service.mjs \
  --root /path/to/knowledge-repo --origin https://cockpit.example --port 18767
```

Agents process the queue with the consumer CLI (see `skill/SKILL.md`, "Operator Request Queue"):

```bash
node ~/.local/share/cockpit-kit/skill/scripts/intents.mjs summary
node ~/.local/share/cockpit-kit/skill/scripts/intents.mjs claim --json
node ~/.local/share/cockpit-kit/skill/scripts/intents.mjs resolve <id> --claim <token> \
  --outcome changed --summary "..." --page /route/ --commit <sha>
```

Optional wake hook: `--webhook-url <url>` or `COCKPIT_INTENTS_WEBHOOK_URL` makes either server POST `{"event","intent_id","kind","at"}` (no request content) when a new intent or operator reply arrives. Failures are logged and ignored.

This is a lean first version of the [design](docs/design/operator-comments-and-capture.md); see its "MVP implementation status" section for what is deferred.

## AI adapters

Setup can install symlinked adapters. Each adapter symlink points at the kit's `skill/` directory (the isolated AI-skill payload), not the repo root:

- Generic agents: `~/.agents/skills/cockpit -> /absolute/path/to/cockpit-kit/skill`
- Hermes: `${HERMES_HOME:-~/.hermes}/skills/productivity/cockpit -> /absolute/path/to/cockpit-kit/skill`
- Claude Code: `~/.claude/skills/cockpit -> /absolute/path/to/cockpit-kit/skill`

Symlinked adapters are live agent policy. Review diffs before pulling updates into an installed kit clone, and prefer tagged releases for stable installs.

## Development

Run the test suite with Node's built-in test runner:

```bash
node --test
```

Check whitespace before committing:

```bash
git diff --check
```

The GitHub Actions workflow runs `node --test` on Ubuntu and macOS with Node 20 and 22.

## Documentation

- Page contract: [`skill/reference/page-contract.md`](skill/reference/page-contract.md)
- Design (lean MVP implemented, hardening deferred): [Operator comments and capture lifecycle](docs/design/operator-comments-and-capture.md) ([#10](https://github.com/autojeremy/cockpit-kit/issues/10)).

## Security

Cockpit Kit operates on local, private knowledge repositories. Do not publish your knowledge repo unless you have separately sanitized it.

Report suspected security issues through GitHub security advisories for this repository. See [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).
