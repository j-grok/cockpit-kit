# Cockpit Kit page contract v1

This document is the normative contract for every HTML page in a Cockpit Kit compatible knowledge repo. It also pins the manifest schemas and TOML subset that v1 scripts build against.

V1 keeps the contract deliberately small: static HTML, same-origin assets, embedded data where the page owns its source, predictable navigation, and mobile-safe layout. The lint tool enforces the mechanical parts of the contract. Agents and operators still own the quality of the content and visual design.

## Scope

The contract applies to every `*.html` page in the shared page-discovery scope: recursively under the configured Cockpit root, excluding files inside `.git/`, `.cockpit/`, `.agents/`, `.claude/`, `node_modules/`, and `attachments/`. Directory symlinks that resolve outside the Cockpit root are not followed.

This is a closed list for v1. `lint.mjs` and `search-index.mjs` must use the same discovery helper and this exact scope so lint findings, generated index membership, and `stale-search-index` path-set comparisons operate on the same page set.

The contract does not prescribe a universal information architecture. Operators may choose their own sections, page kinds, data shapes, and visual register after the starter files are copied.

## Requirement 1: local-first structure

A page must render its structure and styling without cross-origin CSS or JavaScript.

Allowed:

- Inline CSS in `<style>` blocks.
- Same-origin stylesheets, including the starter `/cockpit.css` file.
- Inline JavaScript for page-local behavior.
- Same-origin script files that live inside the Cockpit root.
- External images, with caution. They are tolerated because a missing image degrades the page less severely than missing CSS or JavaScript.
- The optional operator request widget, `<script src="/cockpit-intents.js" defer></script>` (or a depth-correct relative path). It is generic code: it fetches private request data from the same-origin `/api/cockpit/v1` service after authentication and hides itself when that service is absent. Pages must never embed request contents, counts, receipt IDs, or other queue-derived data.

Forbidden:

- Cross-origin stylesheets such as `https://cdn.example.com/site.css` or `//cdn.example.com/site.css`.
- Cross-origin scripts such as `https://cdn.example.com/app.js` or `//cdn.example.com/app.js`.
- Dynamic navigation loaded from a remote service.

Lint codes:

| Code | Severity | Meaning |
|---|---|---|
| `external-stylesheet` | error | A stylesheet URL is cross-origin. |
| `external-script` | error | A script URL is cross-origin. |

## Requirement 2: source declaration

Every page declares how it can be regenerated:

```html
<meta name="cockpit:source" content="self">
```

Allowed values:

- `self`: the page is Cockpit-native and owns its durable data in the `cockpit-data` block.
- `upstream:<source-id>`: the page is a render cache of a source registered in `.cockpit/sources.toml`.

For `upstream:<source-id>`, `<source-id>` must match a `[sources.<id>]` entry in the sources manifest. The lint tool verifies the registration exists. It does not verify that an external file, MCP server, or git remote is reachable at render time.

Lint codes:

| Code | Severity | Meaning |
|---|---|---|
| `missing-source-meta` | error | No `cockpit:source` meta tag exists. |
| `invalid-source-value` | error | The source value is neither `self` nor `upstream:<id>`. |
| `invalid-upstream-source` | error | The upstream id is empty or malformed. |
| `unknown-upstream-source` | error | The upstream id is not registered in `.cockpit/sources.toml`. |

## Requirement 3: embedded data for self-sourced pages

A `self` page must contain exactly one durable data block:

```html
<script type="application/json" id="cockpit-data">
{
  "kind": "example-page",
  "schema_version": 1
}
</script>
```

Rules:

- The script element must have `id="cockpit-data"` and `type="application/json"`.
- The body must parse as a JSON object.
- The object must contain `kind` as a non-empty string.
- `kind` values are free-form kebab-case. Lint checks that the field exists and is non-empty, but does not enforce a closed registry.
- The object must contain `schema_version` as an integer greater than or equal to `1`.
- `schema_version` is owned by the page kind and operator. Bump it when that page kind changes shape in a non-additive way.
- Any other fields are page-specific data.

An `upstream:<source-id>` page should not use a `cockpit-data` block as its source of truth. It may include small documentary metadata in the visible page, but the upstream system remains durable.

Lint codes:

| Code | Severity | Meaning |
|---|---|---|
| `missing-data-block` | error | A `self` page has no `cockpit-data` block. |
| `multiple-data-blocks` | error | A page has more than one `cockpit-data` block. |
| `invalid-data-block-json` | error | The block body is not valid JSON. |
| `data-block-not-object` | error | The parsed data is not a JSON object. |
| `data-block-missing-kind` | error | `kind` is absent, empty, or not a string. |
| `data-block-missing-schema-version` | error | `schema_version` is absent, not an integer, or less than `1`. |

## Requirement 4: rendered timestamp

Every page records when it was rendered:

```html
<meta name="cockpit:rendered-at" content="2026-07-05T18:00:00Z">
```

Rules:

- The value must be a valid ISO 8601 timestamp.
- UTC with `Z` is preferred.
- Numeric offsets such as `-06:00` are accepted.

Lint codes:

| Code | Severity | Meaning |
|---|---|---|
| `missing-rendered-at` | error | No `cockpit:rendered-at` meta tag exists. |
| `invalid-rendered-at` | error | The timestamp is not valid ISO 8601. |

## Requirement 5: manifest-backed navigation

Every page includes an inlined `<nav>` near the top of `<body>`. The nav contains the top-level sections from `.cockpit/nav.toml`.

Rules:

- `<nav>` exists and contains at least one link.
- The `(label, href)` pairs match the nav manifest after depth-aware path resolution.
- Exactly one link should carry `aria-current="page"`. On nested pages, mark the parent top-level section.
- A home link with label `Cockpit` is allowed and ignored during manifest matching.
- Breadcrumbs are recommended on non-root pages, but v1 lint does not enforce them.

Depth-aware href convention:

- `.cockpit/nav.toml` stores hrefs relative to the Cockpit root, without leading `./` or `/`, for example `inbox/`.
- A root page may render that as `./inbox/` or `inbox/`.
- A page one level deep renders `../inbox/`.
- A page two levels deep renders `../../inbox/`.
- Lint resolves these forms back to the manifest path before comparison.

Lint codes:

| Code | Severity | Meaning |
|---|---|---|
| `missing-nav` | error | No `<nav>` element exists. |
| `empty-nav` | error | The nav exists but contains no links. |
| `no-nav-manifest` | warning | `.cockpit/nav.toml` is missing or unreadable while checking nav freshness. |
| `stale-nav` | warning | The inlined nav does not match `.cockpit/nav.toml`. |
| `no-aria-current` | warning | No nav link has `aria-current="page"`. |
| `multiple-aria-current` | warning | More than one nav link has `aria-current="page"`. |

## Requirement 6: mobile-readable layout

Every page must be readable on a 320px wide phone-class viewport.

Rules:

- Include viewport meta: `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Additional viewport tokens are allowed.
- CSS must not contain a fixed `width: NNNpx` declaration where `NNN > 320`.
- `max-width: NNNpx` is allowed and is the recommended centering pattern.
- Body copy should be at least 16px. This is qualitative in v1 and not linted.
- Tap targets should be large enough for touch use. This is qualitative in v1 and not linted.

Lint codes:

| Code | Severity | Meaning |
|---|---|---|
| `missing-viewport` | error | No viewport meta tag exists. |
| `invalid-viewport` | error | The viewport meta is missing `width=device-width` or `initial-scale=1`. |
| `fixed-pixel-width` | error | A CSS `width: NNNpx` declaration exceeds 320px. |

## Requirement 7: static browser search artifacts

If a knowledge repo has pages, v1 expects a derived search index at `.cockpit/search-index.json` and a starter search page at `search/index.html` when the starter template is used.

Search index format:

```json
{
  "kind": "cockpit-search-index",
  "schema_version": 1,
  "generated_at": "2026-07-05T18:00:00Z",
  "page_count": 1,
  "pages": [
    {
      "title": "Home",
      "href": "/",
      "path": "index.html",
      "section": "Home",
      "headings": [{ "level": "h1", "text": "Home" }],
      "summary": "Starter home page.",
      "text": "Home Starter home page"
    }
  ]
}
```

Rules:

- `kind` is always `cockpit-search-index`.
- `schema_version` is an integer greater than or equal to `1`.
- Each page record's `href` is the server-absolute URL path for that page when the repo is served from the Cockpit root, always beginning with `/` (for example `/` for `index.html` and `/inbox/` for `inbox/index.html`). This is intentionally distinct from the root-relative, depth-prefixed hrefs in `nav.toml`: the search page renders result links from a single mounted origin and does not know its own depth, so absolute paths let those links resolve regardless of which page the search UI is served from. `path` remains the root-relative file path.
- Index membership is exactly the shared page-discovery scope above. Pages with missing or invalid `cockpit:rendered-at` values still appear in `pages[]` and still count toward `page_count`; those pages fail lint, but the generator does not silently drop them.
- `page_count` is always `pages.length`.
- `generated_at` is deterministic for identical page input. V1 derives it from the maximum valid `cockpit:rendered-at` timestamp among indexed pages rather than wall-clock time. Pages with missing or invalid timestamps do not contribute to that maximum. When no indexed page contributes a valid timestamp, including the empty page set, `generated_at` is the fixed sentinel `1970-01-01T00:00:00Z`.
- `root` is omitted because it leaks a private absolute path and breaks deterministic output.
- `tags` are omitted in v1 because unconstrained structured-data tags can leak too much private detail.
- The generator redacts token-like strings, caps indexed text per page, skips nav/footer/script/style text, and writes via temp file plus atomic rename.

Staleness rule:

- `stale-search-index` fires not only when a page's valid `cockpit:rendered-at` is newer than `generated_at`, but also when the shared page-discovery set differs from the set of `path` values in the index. Timestamp comparison alone misses a page added with a `rendered-at` no newer than the current maximum and misses a page deleted after generation (leaving a phantom index entry); comparing the two `path` sets closes both cases cheaply. Because lint and the generator share the same discovery helper, a regenerated index can clear the warning.

Serving rule:

- The search page fetches `.cockpit/search-index.json` over same-origin HTTP, so `serve.mjs` must expose that one path. `serve.mjs` serves only `.cockpit/search-index.json` from under `.cockpit/` and refuses every other path in that directory with 404. `sources.toml`, `serve.toml`, and any future manifests stay unservable, so moving the index out of the visible page tree does not turn `.cockpit/` into an HTTP-readable directory of private paths.

Lint codes:

| Code | Severity | Meaning |
|---|---|---|
| `missing-search-index` | warning | HTML pages exist but `.cockpit/search-index.json` does not. |
| `invalid-search-index` | warning | The search index exists but cannot be parsed or lacks required top-level fields. |
| `stale-search-index` | warning | A page has `cockpit:rendered-at` newer than the index `generated_at`, or the set of discovered pages does not match the set of indexed `path` values. |

## Valid Cockpit root

A valid Cockpit root is a directory that contains a `.cockpit/` directory holding `.cockpit/sources.toml`. `sources.toml` is the one required manifest; it may be empty but must exist. `.cockpit/nav.toml` and `.cockpit/serve.toml` are optional. Write-capable scripts, `serve.mjs`, and `lint.mjs` validate this before operating on the root.

Because `nav.toml` is optional, lint may run against a root that has none. When a page inlines a `<nav>` but `nav.toml` is missing or unreadable, lint emits `no-nav-manifest` (warning) rather than refusing to run.

## Manifest schemas

### `.cockpit/nav.toml`

Ordered top-level navigation sections.

```toml
[[nav]]
label = "Inbox"
href = "inbox/"

[[nav]]
label = "Projects"
href = "projects/"
```

Schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `nav` | array of tables | yes | Each table is one top-level nav entry. |
| `nav[].label` | string | yes | Human-visible label. Non-empty. |
| `nav[].href` | string | yes | Path relative to the Cockpit root, no leading `./` or `/`. Folder URLs should end with `/`. |

V1 does not require a universal section list.

### `.cockpit/sources.toml`

Logical upstream source registry.

```toml
[sources.example-notes]
kind = "file"
path = "~/notes/example"
```

Schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `[sources.<id>]` | table | no | One table per upstream source. `<id>` is referenced by `upstream:<id>`. |
| `kind` | string | yes | Initial supported values: `file`, `mcp`, `git`. Future values may be added. |
| `path` | string | yes | Source path, ref, or locator. The meaning depends on `kind`. |

The sources manifest may be empty, but the file must exist in a valid Cockpit root.

### `.cockpit/serve.toml`

Optional local serving overrides.

```toml
host = "127.0.0.1"
port = 18765
auth = true
```

Schema:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `host` | string | no | `127.0.0.1` | Bind host for `serve.mjs`. V1 is loopback-first. |
| `port` | integer | no | `18765` | TCP port. |
| `auth` | boolean | no | `true` | Whether `serve.mjs` requires its per-session bearer token. |

## TOML subset for v1 manifests and config

V1 uses a small local TOML parser because Node.js has no built-in TOML parser and v1 has no third-party runtime dependencies.

The parser must reject unsupported syntax with a line-numbered error. It must never silently misparse a construct outside the subset.

Supported syntax:

- Blank lines and comments starting with `#`.
- Bare keys made of ASCII letters, digits, `_`, and `-`.
- Key/value pairs: `key = value`.
- Basic double-quoted strings with `\\`, `\"`, `\n`, and `\t` escapes.
- Integers.
- Booleans: `true` and `false`.
- Arrays of strings: `["a", "b"]`.
- Tables: `[name]`.
- Dotted table headers of exactly two segments: `[sources.example-notes]`.
- Arrays of tables: `[[nav]]`.

Unsupported syntax, all parse errors:

- Dotted keys such as `sources.example.kind = "file"`.
- Inline tables.
- Multi-line strings.
- Literal strings.
- Floats.
- Dates.
- Nested arrays.
- Arrays of tables with dotted or deeper names.
- Table headers deeper than two segments.
- Duplicate scalar keys in the same table.
- Type changes that turn a scalar into a table or array.

Writer behavior:

- `link.mjs` and `setup.mjs` may regenerate `config.toml`.
- The writer preserves unknown top-level keys where possible.
- The writer does not preserve comments.
- Generated config files include a header comment that states comments may be rewritten.

## Complete lint vocabulary

| Code | Severity | Contract area |
|---|---|---|
| `external-stylesheet` | error | Local-first structure |
| `external-script` | error | Local-first structure |
| `missing-source-meta` | error | Source declaration |
| `invalid-source-value` | error | Source declaration |
| `invalid-upstream-source` | error | Source declaration |
| `unknown-upstream-source` | error | Source declaration |
| `missing-data-block` | error | Embedded data |
| `multiple-data-blocks` | error | Embedded data |
| `invalid-data-block-json` | error | Embedded data |
| `data-block-not-object` | error | Embedded data |
| `data-block-missing-kind` | error | Embedded data |
| `data-block-missing-schema-version` | error | Embedded data |
| `missing-rendered-at` | error | Render stamp |
| `invalid-rendered-at` | error | Render stamp |
| `missing-nav` | error | Navigation |
| `empty-nav` | error | Navigation |
| `no-nav-manifest` | warning | Navigation |
| `stale-nav` | warning | Navigation |
| `no-aria-current` | warning | Navigation |
| `multiple-aria-current` | warning | Navigation |
| `missing-viewport` | error | Mobile layout |
| `invalid-viewport` | error | Mobile layout |
| `fixed-pixel-width` | error | Mobile layout |
| `missing-search-index` | warning | Search |
| `invalid-search-index` | warning | Search |
| `stale-search-index` | warning | Search |

Default lint exits nonzero when any error exists. `--strict` also exits nonzero on warnings.

## Contract versioning

This file defines Cockpit Kit page contract v1.

Future incompatible contract changes must update this file with a changelog entry and matching lint behavior. Page data `schema_version` remains page-kind specific and separate from the contract version.
