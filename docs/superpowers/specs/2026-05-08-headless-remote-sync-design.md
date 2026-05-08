# Headless Remote Sync Design

## Goal

Run a headless VRCX collector on a server so it can gather VRChat API and WebSocket-derived data while the desktop app is offline. When desktop VRCX is opened later, the user can manually sync missing remote data into the local database without duplicating rows.

Game log data is out of scope. The collector is for information available without VRChat running, such as friend presence, user status, locations, instances, and related history.

## Scope

In scope:

- Headless server runtime for VRCX collection.
- Console login for the headless runtime, including username, password, and 2FA.
- One-time remote pairing token generation and rotation.
- Account-bound pairing between desktop and headless VRCX.
- Pull-based desktop sync from remote.
- Sync provenance tracking so imported rows can be identified later.
- Idempotent import behavior where repeated syncs never duplicate data.

Out of scope for the first version:

- `gamelog_*` tables.
- Local settings sync.
- Saved credentials sync.
- Memos, notes, favorites, registry backups, UI layout, and other local-authored data.
- Notification sync.
- Remote push into desktop VRCX.
- Multi-account sync from one headless collector.

## Existing System Context

VRCX uses a Vue frontend with Pinia stores and coordinators. The app persists most long-term history in SQLite through `src/services/database/*`, while the .NET host owns SQLite, cookies, storage, and WebApi access.

Relevant existing boundaries:

- `Dotnet/SQLite.cs` opens the SQLite database and provides query execution.
- `Dotnet/WebApi.cs` manages HTTP requests, cookies, and cookie persistence.
- `Dotnet/VRCXStorage.cs` stores local JSON configuration.
- `src/services/database/index.js` creates global and user-prefixed SQLite tables.
- `src/stores/updateLoop.js` performs periodic API refreshes.
- `src/services/websocket.js` handles live VRChat WebSocket events.
- `src/coordinators/*` convert API/WebSocket data into application state and database writes.

The design should reuse these collection pathways where practical, but the headless runtime should not depend on UI-only services such as dialogs, toast notifications, tray behavior, Discord, VR overlay, or game process monitoring.

## Headless Runtime

The headless runtime starts from a dedicated command, for example:

```bash
vrcx-headless --config-dir /var/lib/vrcx-headless --sync-port 14590
```

The runtime initializes:

- VRCX config directory.
- `VRCXStorage`.
- SQLite.
- WebApi and cookie storage.
- VRChat auth.
- user-specific database tables.
- API polling needed for presence and history.
- VRChat WebSocket connection.
- remote sync HTTP server.

The runtime does not initialize:

- Electron windows.
- CEF windows.
- Discord rich presence.
- VR overlay.
- tray icons.
- local game process checks.
- local game log watching.

The sync HTTP server should bind to `127.0.0.1` by default. Users must explicitly configure a public/listening host if they want to expose it beyond localhost, preferably behind SSH, VPN, or a reverse proxy with HTTPS.

## Headless Login

On startup, the headless runtime checks whether existing cookies represent a valid VRChat session.

If no valid session exists, or if the process is started with `--login`, it prompts in the console:

```text
VRChat username/email:
VRChat password:
2FA code:
```

Password input must be hidden. 2FA is requested only when VRChat requires it. After successful login, the runtime stores cookies using the existing VRCX cookie mechanism and records the authenticated owner user ID.

The sync server should only accept pairing or sync requests once the headless runtime is authenticated and has a known owner user ID.

## Remote Token

The headless runtime maintains a one-time pairing token for adding new desktop clients.

Startup behavior:

- If no remote token exists, generate one and print it once.
- If a token already exists, do not print it again.
- If `--new-remote-token` is passed, generate a replacement token, invalidate existing pairings, and print the new token once.

Only a hash of the token is stored. If the plaintext token is lost, the user must rotate it.

Example first-run output:

```text
Remote sync token created.
Use this token once from desktop VRCX to pair:
vrcx_rt_...
```

Example rotation:

```bash
vrcx-headless --config-dir /var/lib/vrcx-headless --new-remote-token
```

Rotation invalidates the old token and all existing paired client credentials. The user must update desktop VRCX by pairing again.

There should not be a `--print-remote-token` command. Reprinting long-lived bootstrap secrets weakens the operational model.

## Account-Bound Pairing

The remote token alone is not enough to pair. Pairing must also prove that desktop VRCX and headless VRCX are logged into the same VRChat account.

Pairing flow:

1. Desktop VRCX is logged in locally.
2. User enters the remote URL and one-time remote token.
3. Desktop calls `POST /sync/pair` with:
   - remote token.
   - local logged-in VRChat user ID.
   - optional local display name for audit logging.
4. Headless validates:
   - token hash matches.
   - headless runtime is logged in.
   - headless owner user ID equals the desktop-provided user ID.
5. If validation fails, no client credential is created.
6. If validation succeeds, headless returns:
   - remote server ID.
   - remote owner user ID.
   - client ID.
   - client secret.

If user IDs mismatch, the server returns a specific `user_mismatch` response. Desktop VRCX should display both user IDs when available:

```text
Remote account mismatch.
Desktop is logged in as SomeUser (usr_a).
Remote collector is logged in as OtherUser (usr_b).
Log into the same VRChat account on both clients, then pair again.
```

Future sync requests use the issued client credential, not the one-time remote token.

## Sync API Security

All sync endpoints except minimal health checks require authentication.

Recommended endpoint shape:

- `GET /sync/status`
- `POST /sync/pair`
- `GET /sync/manifest`
- `POST /sync/delta`

`/sync/status` may be unauthenticated only if it returns no sensitive data. It can report basic service availability and whether the remote is logged in. Any endpoint that returns user IDs, table names, row counts, or data must require authentication.

Client credentials should be stored hashed on the headless side. Desktop VRCX stores the returned client ID and secret in its local config. Bearer authentication is acceptable for the first version if HTTPS, SSH tunnel, VPN, or localhost binding is used. HMAC-signed requests can be added later if needed.

The headless runtime should log:

- token creation.
- token rotation.
- pairing attempts.
- failed account mismatch pairings.
- successful pairings.
- sync batch completion.
- sync batch failure.

Logs must not contain plaintext tokens, client secrets, passwords, or cookies.

## Syncable Data

The first version syncs data obtained while VRChat is not running:

- user-prefixed feed tables:
  - `*_feed_gps`
  - `*_feed_status`
  - `*_feed_bio`
  - `*_feed_avatar`
  - `*_feed_online_offline`
- `*_friend_log_history`
- cache rows needed to render synced history cleanly, if the current schema has them:
  - world cache
  - avatar cache

The first version excludes:

- all `gamelog_*` tables.
- `*_notifications`.
- `*_notifications_v2`.
- `cookies`.
- saved credentials.
- VRCX settings.
- memos and notes.
- favorites.
- registry backups.
- local UI state.

## Sync Registry

Add an explicit sync registry rather than generic table mirroring. Each syncable table definition includes:

- logical table name.
- whether it is user-prefixed.
- local table name resolver.
- primary conflict strategy.
- cursor column.
- stable row key builder.
- row hash builder.
- allowed import columns.

This prevents accidental syncing of sensitive or local-authored data and gives each table clear conflict behavior.

## No-Duplicate Requirement

The import process must be idempotent. Re-running sync with unchanged remote data must import zero new rows after the first successful sync.

Do not rely only on local SQLite autoincrement IDs. Local and remote row IDs can differ.

Add provenance tables to the desktop database:

```text
remote_sync_sources
remote_sync_batches
remote_sync_items
```

`remote_sync_sources` tracks known remotes:

```text
remote_id
remote_owner_user_id
remote_url
paired_at
last_sync_at
display_name
```

`remote_sync_batches` tracks each sync attempt:

```text
batch_id
remote_id
started_at
finished_at
status
rows_received
rows_imported
rows_skipped
error_message
```

`remote_sync_items` tracks every imported remote row:

```text
remote_id
remote_owner_user_id
source_table
source_row_id
source_row_key
source_row_hash
local_table
local_row_id
local_row_key
batch_id
imported_at
```

`remote_sync_items` must have a unique constraint:

```text
(remote_id, source_table, source_row_key)
```

Import flow:

1. Desktop requests a delta batch from the remote.
2. Desktop stages received rows in memory or a temporary table.
3. For each row, compute the stable `source_row_key`.
4. Check `remote_sync_items` for `(remote_id, source_table, source_row_key)`.
5. If present, skip the row.
6. If absent, insert the local row using the table's conflict strategy.
7. Record the provenance row in `remote_sync_items`.
8. Commit the imported row and provenance row in the same transaction.

If a local equivalent already exists but has no provenance record, the importer should avoid creating a duplicate local row. It should detect the local row through the table's natural key or unique constraint, then add a provenance record pointing to that local row. This handles cases where the desktop already collected the same event independently.

Stable source row keys should use deterministic natural fields. Examples:

- online/offline feed: `created_at | user_id | type | location | world_name`
- GPS feed: `created_at | user_id | location | previous_location | world_name`
- status feed: `created_at | user_id | status | status_description | previous_status | previous_status_description`
- bio feed: `created_at | user_id | bio | previous_bio`
- avatar feed: `created_at | user_id | owner_id | avatar_name | current_avatar_image_url`
- friend log history: `created_at | type | user_id | display_name | previous_display_name | trust_level | previous_trust_level`

Row hashes are used for diagnostics and future mismatch detection. They are not the primary duplicate prevention mechanism.

## Cursor Strategy

Each table uses cursor-based deltas, typically by `created_at` or `updated_at`.

Desktop should request an overlap window rather than only strict greater-than cursor values. For example, request data newer than the last successful cursor minus 24 hours. The provenance table prevents duplicates from overlapping windows.

This protects against:

- out-of-order event arrival.
- clock precision differences.
- failed sync retries.
- batches committed near a cursor boundary.

## Conflict Rules

Append-only history tables:

- import unseen rows only.
- skip rows already present in provenance.
- if an equivalent local row exists, record provenance without inserting a duplicate.

Cache tables:

- use conservative upsert rules.
- never overwrite newer local cache data with older remote data.

Local-authored tables:

- excluded from the first version.

## Desktop User Experience

Add a Remote Sync settings area:

- remote URL.
- pair with token.
- connection status.
- paired remote identity.
- remote owner user ID.
- last sync time.
- last sync result.
- Sync from remote button.
- Forget remote button.

Manual sync is enough for the first version. Scheduled sync can be added after the import model is proven reliable.

Desktop VRCX must refuse pairing unless the local app is logged in. If pairing fails due to account mismatch, it should display a specific mismatch message instead of a generic connection failure.

## Error Handling

Pairing failures:

- invalid token returns an authentication error.
- account mismatch returns `user_mismatch`.
- unauthenticated remote returns `remote_not_logged_in`.
- unauthenticated desktop blocks before sending the request.

Sync failures:

- failed batches are recorded in `remote_sync_batches`.
- partially imported batches must be transactionally safe.
- if a row import fails, the batch should fail without recording a successful cursor advancement.
- retrying the same batch must not duplicate data.

Schema/version failures:

- remote manifest includes app version and sync schema version.
- desktop refuses sync if the remote schema is incompatible.
- compatible additive changes are allowed only when table registry versions permit them.

## Testing Requirements

Add tests around two temporary SQLite databases: one remote and one desktop.

Required test cases:

- pairing succeeds when token is valid and user IDs match.
- pairing rejects when user IDs differ.
- token rotation invalidates old token and existing pairings.
- syncing the same batch twice imports rows only once.
- overlapping cursor windows do not duplicate rows.
- rows already collected locally are linked through provenance instead of duplicated.
- every remotely imported or linked row has a `remote_sync_items` record.
- failed batch does not advance the cursor.
- excluded tables are not present in the sync manifest.

The key invariant:

```text
Running Sync from remote repeatedly with unchanged remote data must result in zero new local rows after the first successful sync.
```

## Implementation Notes

Prefer extracting shared collection logic from UI-bound stores into pure service/coordinator modules where needed. The headless runtime should reuse API request, WebSocket, auth, and database behavior without requiring Vue components or UI-only services.

Build the sync registry and idempotent importer before exposing the desktop UI. The importer is the highest-risk part of the feature because data duplication is unacceptable.

## Decisions

- The first version syncs presence/feed/friend-history data only. Notifications are deferred.
- The first version includes only cache tables already present in the current schema and needed by synced rows, starting with world and avatar cache data.
- The headless collector is packaged as a dedicated `vrcx-headless` entrypoint in the existing distribution rather than a separate product.
- One desktop profile can pair with one remote collector for the same account in the first version. Multiple remotes can be added later after the provenance model is proven.
