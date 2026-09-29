# Provider usage sidebar — OpenCode v2 CLI plugin

The `codex-usage` package renders a **Provider Usage** panel for every provider
that qualifies through OpenCode's authoritative provider, integration, runtime,
and recent session/model state. It is not a four-provider allowlist and it does
not decide login state by parsing
the legacy `auth.json` file. A server role resolves provider activation,
integration, and connection state from OpenCode v2's provider/integration APIs
and runtime provider services, then exposes only sanitized rows through the
`provider.usage.snapshot` RPC.

The panel is therefore provider-universal: current and future providers can
participate without a new hard-coded sidebar branch. Optional usage adapters
share the same pipeline. The current adapters cover Codex quota and DeepSeek
balance; providers without a usage API use the default status-only adapter and
remain governed by OpenCode runtime readiness.

## Visibility and identity

The server filters rows before the TUI receives them:

- `disabled` providers are never displayed;
- working providers are displayed when OpenCode reports an active credential or
  environment connection, when the authoritative `Provider.Info` shape is
  `activation: "enabled"` with a nonempty static provider key or no matching
  integration requirement (the general ambient capability signal), or when an
  observed runtime model path is still authoritative, including providers
  without a quota adapter;
- disconnected providers are displayed as `OFFLINE` only when metadata-only
  OpenCode session/model activity for that provider is within the inclusive,
  rolling two-hour window (`lastUsedAt >= now - 2h`);
- model inventory, configured credentials, aliases, and the current clock alone
  never establish recent use;
- absent providers and disconnected providers with no qualifying recent use do
  not produce an `OFFLINE` placeholder;
- when there are zero visible providers, the entire Provider Usage section is
  hidden; the collapsed summary counts only visible rows.

Canonical provider aliases are merged into one row. Activity is matched by
exact canonical/provider ID, and the merged row uses the configured display
name, so aliases cannot duplicate a provider or qualify an unrelated provider.

## Status and usage

The server applies these status rules to each visible row:

- a connected provider with a verified usage probe is `READY` and may include
  the verified usage value;
- a connected provider without a usage adapter is `READY` without invented
  quota, balance, percentage, or limit data;
- a provider without an authoritative working connection is `OFFLINE` only
  after the visibility recency check qualifies it;
- a failed optional usage probe, including an HTTP `401` or `403`, never
  overrides an otherwise working provider's authoritative readiness;
- an HTTP `429` or other rate-limit result is `COOLING`;
- a transient failure with retained last-good values is `STALE`;
- a verified exhausted quota or balance is `EMPTY`.

When more than one signal is present, probe outcomes take precedence for usage
detail in this order: rate limiting (`COOLING`), transient failure with a
retained value (`STALE`), verified exhaustion (`EMPTY`), then a verified
successful probe (`READY`). Authentication failure in an optional probe is
diagnostic only when OpenCode's provider/integration state is already working.
With no probe result, active connectivity, the enabled-without-integration
provider capability, or an observed ready runtime path produces `READY`; a
qualifying disconnected provider produces `OFFLINE`. Runtime readiness is not
aged out by the two-hour offline window; a later authoritative failed runtime
response supersedes the earlier ready observation.

Credentials never cross the RPC boundary and never appear in logs. The RPC
contains sanitized provider identity, status, bounded detail, optional
verified usage, and (only when an adapter has a trustworthy denominator) a
normalized `remainingRatio`; activity timestamps, session IDs, and message
text remain server-owned and never cross the RPC boundary.

## Interaction

The panel is registered from `cli.json` and is visible independently of the
active session model. Its header is mouse- and keyboard-activatable. The
command palette provides **Refresh provider usage** and **Provider usage
details**; `/provider-usage` opens the same details dialog, while
`/codex-usage` and `/usage-left` remain aliases.

Provider Usage is inserted before the native `sidebar.footer`, as is Source
Control. This preserves the native working-directory item as the final entry
at the bottom of the sidebar.

The panel starts collapsed as one native-sized summary line, for example
`Provider Usage · 2 ready · 1 empty · 1 offline`. Expanded view renders exactly
one non-wrapping row per visible provider, ordered as provider label, optional
compact usage or balance, and status. Illustrative rows are `OpenAI · Weekly
67% · READY` and `DeepSeek · USD 12.50 · READY`. Missing measurements are
omitted rather than inferred. Full reset times, balances, stale-state
explanations, diagnostics, and the shared update timestamp remain in the
details dialog opened through the palette or `/provider-usage`.

Rows stay on one line at narrow widths and truncate overflow rather than
wrapping adjacent native content. The optional middle measurement may be
omitted first to preserve the provider label and status. An empty summary does
not emit a dangling separator, and the panel remains hidden when there are no
provider rows.

The panel follows the native MCP block's disclosure grammar. Provider labels
use the default foreground, optional measurements use the muted foreground,
and the status token is the only colored field: `READY` uses the theme's
success role, `EMPTY` its error role, and `COOLING`, `OFFLINE`, and `STALE` a
subdued role. Usage and monetary balances remain muted regardless of numeric
value, currency, or remaining ratio. The sidebar omits verbose details,
diagnostic prose, and updated timestamps; `/provider-usage` retains them.

## Refresh and adapters

The server refreshes on `credential.updated`, `credential.switched`,
`integration.updated`, and `provider.updated`, plus session/model activity
events and a periodic server poll. The poll defaults to 60 seconds and can
never be shorter than 30 seconds. RPC/manual refresh requests are
server-throttled; authoritative provider, integration, and session events
coalesce into one in-flight refresh. The 30-second floor applies to the
periodic poll, not to every individual adapter probe. A refresh is shared across
providers, while an individual adapter may retain its last-good value when a
later optional probe fails.

The server plugin context does not expose a global session-list/message-list
API. The implementation therefore records only bounded, metadata-only activity
from the supported session model hooks and event stream; it does not scan all
history or inspect message text. The message-model reader retains only provider
and model identity plus the selected model `variant` when the message supplies
one; assistant-message `cost` and token counts are not read. The newest 512
normalized provider IDs and timestamps are persisted in the profile-owned
`$XDG_STATE_HOME/opencode/codex-usage/activity.json` file, falling back to
`$XDG_DATA_HOME` and then `~/.local/share`; entries older than two hours are
pruned. The file is limited to 64 KiB and 512 entries, must be a regular
non-symlink file, and is written atomically with a 0600 file mode in a 0700
state directory. Corrupt, oversized, or unsafe state fails closed.
Observed activity therefore survives a shared-service restart while it remains
inside the rolling window. The irreducible limitation is activity from before
the plugin's first installation or before this plugin has ever observed it;
V2 exposes no supported global history API to reconstruct that activity.

Codex quota and DeepSeek balance are optional adapters on that shared pipeline.
The status-only default adapter lets every working provider participate even
when no usage endpoint exists.

### Sidebar data and theme-role contract

Provider identity and status come from the sanitized `provider.usage.snapshot`
row. The optional middle value comes only from that row's non-empty `usage`
field: a current verified adapter measurement has precedence, followed by an
explicitly retained last-good value when the status is `STALE`. Missing or
unverified values are omitted. The display does not derive a measurement from
`remainingRatio`, `detail`, or a formatted status string.

The provider label uses the active theme's default-foreground role and the
usage/balance middle field always uses its muted role. Status alone carries
color: `READY` uses the semantic success role, `EMPTY` uses the semantic error
role, and `COOLING`, `OFFLINE`, and `STALE` use the subdued role. This rule is
independent of ratios and monetary amounts; no usage or balance token is
health-colored. The plugin resolves these semantic roles from the active theme
and contains no fixed palette literals.

The versioned, machine-readable contract is exported by the private local
package as `opencode-codex-usage-v2-local/design-ledger`. Its `schemaVersion`
is `1`; downstream workspace consumers can import the JSON subpath or read
`design-ledger.json` directly. The package README documents JSON consumption,
the semantic role names, truncation behavior, source precedence, and the
`/provider-usage` detail-command fallback.

## Data and security

The server role resolves provider, integration, and connection state from
OpenCode v2's authoritative provider/integration APIs and runtime hooks. In the
installed V2 declarations, `Provider.Info` supplies `activation`, optional
`integrationID`, and provider `settings`, while `ConnectionInfo` supplies
credential/environment connections; there is no ambient connection kind. The
current live Zen shape is enabled with a nonempty static `settings.apiKey`, so
the pipeline derives only an ambient-ready boolean and never retains or
forwards that setting. The other generic path is `activation: "enabled"` with
no `integrationID` and no provider/canonical ID matching any
`integration.list()` definition; an integration-backed provider without an
active connection remains hidden. No provider ID is special-cased. The panel
no longer treats legacy `auth.json` as the source of truth, so a Codex login
stored by OpenCode v2 cannot be incorrectly reported as offline merely because
that legacy file is absent or stale. Session IDs, model IDs, message text,
credentials, and exact activity timestamps remain server-owned and never cross
`provider.usage.snapshot`.

Only sanitized rows cross `provider.usage.snapshot`; raw credentials,
environment values, ambient connection material, and access tokens never cross
RPC or appear in logs. Persistence contains only normalized provider IDs and
timestamps; it contains no session IDs, model IDs, message text, or
credentials. The panel does not write the connection store or move a provider
credential to another provider.

DeepSeek balances remain bounded and sanitized before display: the documented
`https://api.deepseek.com/user/balance` endpoint is the production default,
while `deepSeekEndpoint` is available only for compatible test transports.
The fallback state reader remains read-only, size-bounded to 1 MiB, and limited
to 512 cooldown entries. No unverified balance, percentage, subscription state,
or limit is invented for any provider.

## Verification

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage run check
```

The protected package README remains the historical Codex-specific component
reference. This document is the current provider-universal behavior reference.
