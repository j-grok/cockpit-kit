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

## Themes: Light, Dark, System

The starter knowledge repo ships a light and a dark palette and a theme switcher in the navigation of every starter page.

- **System** (default) follows the operating system's `prefers-color-scheme`, including changes while the page is open. **Light** and **Dark** pin a palette.
- The choice is a non-private display preference stored only in the browser's `localStorage` under `cockpit-theme`. Nothing is sent anywhere.
- `cockpit-theme.js` is a tiny same-origin script loaded synchronously in `<head>`, right after `cockpit.css`. It sets `<html data-theme="system|light|dark">` and the `color-scheme` meta before the body is painted, so a stored choice does not flash the wrong palette. No inline script is required.
- `cockpit.css` defines the palettes as custom-property token sets: `:root` / `:root[data-theme="light"]`, `:root[data-theme="dark"]`, and a `@media (prefers-color-scheme: dark)` block for System. Without JavaScript, pages still follow the operating system and the switcher stays hidden.

When writing or rendering pages, use the tokens (`var(--bg)`, `var(--surface)`, `var(--ink)`, `var(--ink-soft)`, `var(--accent)`, `var(--rule)`, and so on) instead of literal colors so the page follows the theme. Add new color tokens to every theme block with the same name. To opt a page into the switcher, copy the `<head>` script tag and the `fieldset.theme-switch` markup from a starter page. See the page contract for the full guidance.

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
- Proposed design, not implemented: [Operator comments and capture lifecycle](docs/design/operator-comments-and-capture.md) ([#10](https://github.com/autojeremy/cockpit-kit/issues/10)).

## Security

Cockpit Kit operates on local, private knowledge repositories. Do not publish your knowledge repo unless you have separately sanitized it.

Report suspected security issues through GitHub security advisories for this repository. See [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).
