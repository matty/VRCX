# Headless Remote Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless VRCX collector and manual desktop pull-sync for same-account VRChat presence history with strict no-duplicate imports.

**Architecture:** Build the idempotent sync layer first, then expose it through a headless HTTP service, then add desktop pairing and manual sync UI. The sync registry explicitly lists allowed tables; desktop provenance tables record every remote row so repeated and overlapping syncs never duplicate data.

**Tech Stack:** Vue 3, Pinia, Vite/Vitest, Electron main process, Node.js HTTP/crypto/readline, .NET interop for SQLite/WebApi/VRCXStorage, existing VRCX database modules.

---

## File Structure

Create:

- `src/services/remoteSync/syncRegistry.js` - syncable table definitions, row key builders, row hash builders, cursor metadata.
- `src/services/remoteSync/provenance.js` - creates and queries remote sync provenance tables.
- `src/services/remoteSync/exporter.js` - reads remote delta batches from SQLite using the registry.
- `src/services/remoteSync/importer.js` - imports remote rows into desktop SQLite with idempotency and provenance.
- `src/services/remoteSync/client.js` - desktop HTTP client for status, pairing, manifest, and delta calls.
- `src/services/remoteSync/__tests__/syncRegistry.test.js`
- `src/services/remoteSync/__tests__/importer.test.js`
- `src/services/remoteSync/__tests__/pairingProtocol.test.js`
- `src-headless/cliArgs.js` - parses headless command-line arguments.
- `src-headless/consoleLogin.js` - prompts for credentials and 2FA in console.
- `src-headless/headlessRuntime.js` - initializes VRCX services and collection loops without UI.
- `src-headless/syncAuth.js` - token generation, hashing, rotation, client credential validation.
- `src-headless/syncServer.js` - HTTP sync server endpoints.
- `src-headless/main.js` - headless runtime module entrypoint used by the Electron main process after bundling.
- `src-headless/__tests__/syncAuth.test.js`
- `src-headless/__tests__/syncServer.test.js`
- `src/stores/remoteSync.js` - desktop remote sync state/actions.
- `src/views/Settings/components/Tabs/RemoteSyncTab.vue` - desktop settings UI.
- `src/views/Settings/components/Tabs/__tests__/RemoteSyncTab.test.js`

Modify:

- `src/services/database/index.js` - initialize provenance tables during global DB initialization.
- `src/App.vue` - initialize remote sync store if needed by settings/status.
- `src/views/Settings/Settings.vue` - add the Remote Sync tab.
- `src/views/Settings/components/Tabs/AdvancedTab.vue` or settings tab list owner - link to `RemoteSyncTab.vue` if settings tabs are centralized there.
- `src/stores/index.js` - export/create `useRemoteSyncStore`.
- `src-electron/main.js` - add headless entrypoint dispatch and package-accessible path.
- `package.json` - add development scripts for headless mode and include `src-headless` in build formatting/linting.
- `src/vite.config.js` - add a headless build target that emits `build/headless/vrcx-headless.cjs` for Electron to load.
- `src/types/globals.d.ts` - add any new desktop/headless globals if required.
- localization files, starting with `src/localization/en.json` - add user-facing Remote Sync strings.

Do not modify for v1:

- `src/services/database/gameLog.js`
- `src/services/database/notifications.js`
- game log coordinators
- notification sync behavior

## Task 1: Add Sync Registry

**Files:**

- Create: `src/services/remoteSync/syncRegistry.js`
- Test: `src/services/remoteSync/__tests__/syncRegistry.test.js`

- [ ] **Step 1: Write failing registry tests**

```js
import { describe, expect, test } from 'vitest';

import {
    REMOTE_SYNC_SCHEMA_VERSION,
    buildSourceRowHash,
    buildSourceRowKey,
    getSyncTableDefinitions
} from '../syncRegistry';

describe('remote sync registry', () => {
    test('exposes only v1 approved tables', () => {
        const names = getSyncTableDefinitions().map((table) => table.name);

        expect(names).toEqual([
            'feed_gps',
            'feed_status',
            'feed_bio',
            'feed_avatar',
            'feed_online_offline',
            'friend_log_history',
            'cache_world',
            'cache_avatar'
        ]);
        expect(names).not.toContain('gamelog_location');
        expect(names).not.toContain('notifications');
        expect(names).not.toContain('notifications_v2');
    });

    test('resolves user-prefixed table names', () => {
        const feedGps = getSyncTableDefinitions().find(
            (table) => table.name === 'feed_gps'
        );

        expect(feedGps.resolveTableName('usrabc')).toBe('usrabc_feed_gps');
    });

    test('builds stable row keys independent of sqlite row id', () => {
        const left = buildSourceRowKey('feed_online_offline', {
            id: 1,
            created_at: '2026-05-08T10:00:00.000Z',
            user_id: 'usr_friend',
            display_name: 'Friend',
            type: 'Online',
            location: 'wrld_1:123',
            world_name: 'World',
            time: '',
            group_name: ''
        });
        const right = buildSourceRowKey('feed_online_offline', {
            id: 99,
            created_at: '2026-05-08T10:00:00.000Z',
            user_id: 'usr_friend',
            display_name: 'Friend',
            type: 'Online',
            location: 'wrld_1:123',
            world_name: 'World',
            time: '',
            group_name: ''
        });

        expect(left).toBe(right);
    });

    test('hash changes when row content changes', async () => {
        const row = {
            created_at: '2026-05-08T10:00:00.000Z',
            user_id: 'usr_friend',
            display_name: 'Friend',
            type: 'Online',
            location: 'wrld_1:123',
            world_name: 'World',
            time: '',
            group_name: ''
        };

        await expect(buildSourceRowHash('feed_online_offline', row)).resolves.not.toBe(
            await buildSourceRowHash('feed_online_offline', {
                ...row,
                world_name: 'Other World'
            })
        );
    });

    test('exports a positive schema version', () => {
        expect(REMOTE_SYNC_SCHEMA_VERSION).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run registry tests and verify failure**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/syncRegistry.test.js
```

Expected: fail because `src/services/remoteSync/syncRegistry.js` does not exist.

- [ ] **Step 3: Implement registry**

Create `src/services/remoteSync/syncRegistry.js`:

```js
export const REMOTE_SYNC_SCHEMA_VERSION = 1;

const normalizeValue = (value) => {
    if (value === null || typeof value === 'undefined') {
        return '';
    }
    return String(value);
};

const keyFrom = (row, fields) =>
    fields.map((field) => normalizeValue(row[field])).join('|');

const stableJson = (value) => {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
};

const hashString = async (input) => {
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
};

const definitions = [
    {
        name: 'feed_gps',
        userPrefixed: true,
        cursorColumn: 'created_at',
        conflict: 'insert-or-ignore',
        columns: [
            'id',
            'created_at',
            'user_id',
            'display_name',
            'location',
            'world_name',
            'previous_location',
            'time',
            'group_name'
        ],
        keyFields: [
            'created_at',
            'user_id',
            'location',
            'previous_location',
            'world_name'
        ]
    },
    {
        name: 'feed_status',
        userPrefixed: true,
        cursorColumn: 'created_at',
        conflict: 'insert-or-ignore',
        columns: [
            'id',
            'created_at',
            'user_id',
            'display_name',
            'status',
            'status_description',
            'previous_status',
            'previous_status_description'
        ],
        keyFields: [
            'created_at',
            'user_id',
            'status',
            'status_description',
            'previous_status',
            'previous_status_description'
        ]
    },
    {
        name: 'feed_bio',
        userPrefixed: true,
        cursorColumn: 'created_at',
        conflict: 'insert-or-ignore',
        columns: [
            'id',
            'created_at',
            'user_id',
            'display_name',
            'bio',
            'previous_bio'
        ],
        keyFields: ['created_at', 'user_id', 'bio', 'previous_bio']
    },
    {
        name: 'feed_avatar',
        userPrefixed: true,
        cursorColumn: 'created_at',
        conflict: 'insert-or-ignore',
        columns: [
            'id',
            'created_at',
            'user_id',
            'display_name',
            'owner_id',
            'avatar_name',
            'current_avatar_image_url',
            'current_avatar_thumbnail_image_url',
            'previous_current_avatar_image_url',
            'previous_current_avatar_thumbnail_image_url'
        ],
        keyFields: [
            'created_at',
            'user_id',
            'owner_id',
            'avatar_name',
            'current_avatar_image_url'
        ]
    },
    {
        name: 'feed_online_offline',
        userPrefixed: true,
        cursorColumn: 'created_at',
        conflict: 'insert-or-ignore',
        columns: [
            'id',
            'created_at',
            'user_id',
            'display_name',
            'type',
            'location',
            'world_name',
            'time',
            'group_name'
        ],
        keyFields: ['created_at', 'user_id', 'type', 'location', 'world_name']
    },
    {
        name: 'friend_log_history',
        userPrefixed: true,
        cursorColumn: 'created_at',
        conflict: 'insert-or-ignore',
        columns: [
            'id',
            'created_at',
            'type',
            'user_id',
            'display_name',
            'previous_display_name',
            'trust_level',
            'previous_trust_level',
            'friend_number'
        ],
        keyFields: [
            'created_at',
            'type',
            'user_id',
            'display_name',
            'previous_display_name',
            'trust_level',
            'previous_trust_level'
        ]
    },
    {
        name: 'cache_world',
        userPrefixed: false,
        cursorColumn: 'updated_at',
        conflict: 'replace-if-newer',
        columns: [
            'id',
            'added_at',
            'author_id',
            'author_name',
            'created_at',
            'description',
            'image_url',
            'name',
            'release_status',
            'thumbnail_image_url',
            'updated_at',
            'version'
        ],
        keyFields: ['id']
    },
    {
        name: 'cache_avatar',
        userPrefixed: false,
        cursorColumn: 'updated_at',
        conflict: 'replace-if-newer',
        columns: [
            'id',
            'added_at',
            'author_id',
            'author_name',
            'created_at',
            'description',
            'image_url',
            'name',
            'release_status',
            'thumbnail_image_url',
            'updated_at',
            'version'
        ],
        keyFields: ['id']
    }
].map((definition) => ({
    ...definition,
    resolveTableName(userPrefix) {
        return definition.userPrefixed
            ? `${userPrefix}_${definition.name}`
            : definition.name;
    }
}));

const definitionsByName = new Map(
    definitions.map((definition) => [definition.name, definition])
);

export function getSyncTableDefinitions() {
    return definitions;
}

export function getSyncTableDefinition(name) {
    const definition = definitionsByName.get(name);
    if (!definition) {
        throw new Error(`Unknown remote sync table: ${name}`);
    }
    return definition;
}

export function buildSourceRowKey(tableName, row) {
    const definition = getSyncTableDefinition(tableName);
    return keyFrom(row, definition.keyFields);
}

export async function buildSourceRowHash(tableName, row) {
    const definition = getSyncTableDefinition(tableName);
    const content = {};
    for (const column of definition.columns) {
        if (column === 'id') continue;
        content[column] = row[column] ?? '';
    }
    return hashString(stableJson({ tableName, content }));
}
```

- [ ] **Step 4: Run registry tests and verify pass**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/syncRegistry.test.js
```

Expected: pass.

- [ ] **Step 5: Commit registry**

```bash
git add src/services/remoteSync/syncRegistry.js src/services/remoteSync/__tests__/syncRegistry.test.js
git commit -m "feat: add remote sync table registry"
```

## Task 2: Add Provenance Tables

**Files:**

- Create: `src/services/remoteSync/provenance.js`
- Modify: `src/services/database/index.js`
- Test: `src/services/remoteSync/__tests__/importer.test.js`

- [ ] **Step 1: Write failing provenance initialization tests**

Append to `src/services/remoteSync/__tests__/importer.test.js`:

```js
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../sqlite.js', () => {
    const statements = [];
    return {
        default: {
            statements,
            async execute(callback, sql) {
                statements.push(sql);
                if (sql.startsWith('SELECT')) return;
                callback?.([]);
            },
            async executeNonQuery(sql) {
                statements.push(sql);
                return 1;
            }
        }
    };
});

const sqliteService = (await import('../../sqlite.js')).default;
const { initRemoteSyncTables } = await import('../provenance.js');

describe('remote sync provenance', () => {
    beforeEach(() => {
        sqliteService.statements.length = 0;
    });

    test('creates source, batch, and item tables with duplicate guard', async () => {
        await initRemoteSyncTables();

        expect(sqliteService.statements.join('\n')).toContain(
            'CREATE TABLE IF NOT EXISTS remote_sync_sources'
        );
        expect(sqliteService.statements.join('\n')).toContain(
            'CREATE TABLE IF NOT EXISTS remote_sync_batches'
        );
        expect(sqliteService.statements.join('\n')).toContain(
            'CREATE TABLE IF NOT EXISTS remote_sync_items'
        );
        expect(sqliteService.statements.join('\n')).toContain(
            'remote_sync_items_unique_remote_source'
        );
    });
});
```

- [ ] **Step 2: Run provenance test and verify failure**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/importer.test.js
```

Expected: fail because `provenance.js` does not exist.

- [ ] **Step 3: Implement provenance table creation**

Create `src/services/remoteSync/provenance.js`:

```js
import sqliteService from '../sqlite.js';

export async function initRemoteSyncTables() {
    await sqliteService.executeNonQuery(`
        CREATE TABLE IF NOT EXISTS remote_sync_sources (
            remote_id TEXT PRIMARY KEY,
            remote_owner_user_id TEXT NOT NULL,
            remote_url TEXT NOT NULL,
            paired_at TEXT NOT NULL,
            last_sync_at TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT ''
        )
    `);
    await sqliteService.executeNonQuery(`
        CREATE TABLE IF NOT EXISTS remote_sync_batches (
            batch_id TEXT PRIMARY KEY,
            remote_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            rows_received INTEGER NOT NULL DEFAULT 0,
            rows_imported INTEGER NOT NULL DEFAULT 0,
            rows_skipped INTEGER NOT NULL DEFAULT 0,
            error_message TEXT NOT NULL DEFAULT ''
        )
    `);
    await sqliteService.executeNonQuery(`
        CREATE TABLE IF NOT EXISTS remote_sync_items (
            remote_id TEXT NOT NULL,
            remote_owner_user_id TEXT NOT NULL,
            source_table TEXT NOT NULL,
            source_row_id TEXT NOT NULL DEFAULT '',
            source_row_key TEXT NOT NULL,
            source_row_hash TEXT NOT NULL,
            local_table TEXT NOT NULL,
            local_row_id TEXT NOT NULL DEFAULT '',
            local_row_key TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            PRIMARY KEY (remote_id, source_table, source_row_key)
        )
    `);
    await sqliteService.executeNonQuery(`
        CREATE UNIQUE INDEX IF NOT EXISTS remote_sync_items_unique_remote_source
        ON remote_sync_items (remote_id, source_table, source_row_key)
    `);
    await sqliteService.executeNonQuery(`
        CREATE INDEX IF NOT EXISTS remote_sync_items_local_lookup
        ON remote_sync_items (local_table, local_row_key)
    `);
}
```

- [ ] **Step 4: Initialize provenance tables from database init**

Modify `src/services/database/index.js`:

```js
import { initRemoteSyncTables } from '../remoteSync/provenance.js';
```

Then inside `initTables()` after existing global table creation:

```js
        await initRemoteSyncTables();
```

- [ ] **Step 5: Run tests and verify pass**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/importer.test.js
```

Expected: pass.

- [ ] **Step 6: Commit provenance tables**

```bash
git add src/services/database/index.js src/services/remoteSync/provenance.js src/services/remoteSync/__tests__/importer.test.js
git commit -m "feat: add remote sync provenance tables"
```

## Task 3: Add Delta Exporter

**Files:**

- Create: `src/services/remoteSync/exporter.js`
- Test: `src/services/remoteSync/__tests__/exporter.test.js`

- [ ] **Step 1: Write failing exporter tests**

Create `src/services/remoteSync/__tests__/exporter.test.js`:

```js
import { beforeEach, describe, expect, test, vi } from 'vitest';

const calls = [];
const rows = [
    [
        3,
        '2026-05-08T10:00:00.000Z',
        'usr_friend',
        'Friend',
        'Online',
        'wrld_1:123',
        'World',
        '',
        ''
    ]
];

vi.mock('../../sqlite.js', () => ({
    default: {
        async execute(callback, sql, args) {
            calls.push({ sql, args });
            for (const row of rows) callback(row);
        }
    }
}));

const { exportDeltaBatch } = await import('../exporter.js');

describe('remote sync exporter', () => {
    beforeEach(() => {
        calls.length = 0;
    });

    test('exports rows through registry columns and cursor overlap', async () => {
        const batch = await exportDeltaBatch({
            userPrefix: 'usrabc',
            sinceByTable: {
                feed_online_offline: '2026-05-07T10:00:00.000Z'
            },
            limit: 50
        });

        expect(calls[0].sql).toContain('FROM usrabc_feed_online_offline');
        expect(calls[0].sql).toContain('created_at >= @since');
        expect(batch.tables.feed_online_offline.rows[0]).toMatchObject({
            id: 3,
            created_at: '2026-05-08T10:00:00.000Z',
            user_id: 'usr_friend',
            type: 'Online'
        });
        expect(batch.tables.feed_online_offline.rows[0].source_row_key).toBe(
            '2026-05-08T10:00:00.000Z|usr_friend|Online|wrld_1:123|World'
        );
    });
});
```

- [ ] **Step 2: Run exporter test and verify failure**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/exporter.test.js
```

Expected: fail because `exporter.js` does not exist.

- [ ] **Step 3: Implement exporter**

Create `src/services/remoteSync/exporter.js`:

```js
import sqliteService from '../sqlite.js';

import {
    REMOTE_SYNC_SCHEMA_VERSION,
    buildSourceRowHash,
    buildSourceRowKey,
    getSyncTableDefinitions
} from './syncRegistry.js';

function rowFromDb(definition, dbRow) {
    const row = {};
    definition.columns.forEach((column, index) => {
        row[column] = dbRow[index];
    });
    return row;
}

export async function exportDeltaBatch({
    userPrefix,
    sinceByTable = {},
    limit = 500
}) {
    const tables = {};
    for (const definition of getSyncTableDefinitions()) {
        const tableName = definition.resolveTableName(userPrefix);
        const rows = [];
        const since = sinceByTable[definition.name] || '';
        const where = since ? `WHERE ${definition.cursorColumn} >= @since` : '';
        await sqliteService.execute(
            (dbRow) => {
                rows.push(rowFromDb(definition, dbRow));
            },
            `SELECT ${definition.columns.join(', ')}
             FROM ${tableName}
             ${where}
             ORDER BY ${definition.cursorColumn} ASC, id ASC
             LIMIT @limit`,
            {
                '@since': since,
                '@limit': limit
            }
        );
        for (const row of rows) {
            row.source_row_key = buildSourceRowKey(definition.name, row);
            row.source_row_hash = await buildSourceRowHash(
                definition.name,
                row
            );
        }
        tables[definition.name] = {
            cursorColumn: definition.cursorColumn,
            rows
        };
    }
    return {
        schemaVersion: REMOTE_SYNC_SCHEMA_VERSION,
        exportedAt: new Date().toJSON(),
        tables
    };
}
```

- [ ] **Step 4: Run exporter tests and verify pass**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/exporter.test.js src/services/remoteSync/__tests__/syncRegistry.test.js
```

Expected: pass.

- [ ] **Step 5: Commit exporter**

```bash
git add src/services/remoteSync/exporter.js src/services/remoteSync/__tests__/exporter.test.js
git commit -m "feat: export remote sync delta batches"
```

## Task 4: Add Idempotent Importer

**Files:**

- Create: `src/services/remoteSync/importer.js`
- Modify: `src/services/remoteSync/provenance.js`
- Test: `src/services/remoteSync/__tests__/importer.test.js`

- [ ] **Step 1: Extend importer tests for idempotency**

Replace `src/services/remoteSync/__tests__/importer.test.js` with a test harness that records SQL calls and simulates provenance hits:

```js
import { beforeEach, describe, expect, test, vi } from 'vitest';

let provenanceHit = false;
const statements = [];

vi.mock('../../sqlite.js', () => ({
    default: {
        async execute(callback, sql) {
            statements.push(sql);
            if (
                sql.includes('FROM remote_sync_items') &&
                provenanceHit === true
            ) {
                callback(['existing']);
            }
        },
        async executeNonQuery(sql) {
            statements.push(sql);
            return 1;
        }
    }
}));

const { importDeltaBatch } = await import('../importer.js');
const { initRemoteSyncTables } = await import('../provenance.js');

describe('remote sync importer', () => {
    beforeEach(() => {
        provenanceHit = false;
        statements.length = 0;
    });

    test('creates source, batch, and item tables with duplicate guard', async () => {
        await initRemoteSyncTables();

        expect(statements.join('\n')).toContain(
            'CREATE TABLE IF NOT EXISTS remote_sync_sources'
        );
        expect(statements.join('\n')).toContain(
            'remote_sync_items_unique_remote_source'
        );
    });

    test('inserts row and provenance in one transaction', async () => {
        await importDeltaBatch({
            remoteId: 'remote_1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch: {
                schemaVersion: 1,
                tables: {
                    feed_online_offline: {
                        rows: [
                            {
                                id: 10,
                                created_at: '2026-05-08T10:00:00.000Z',
                                user_id: 'usr_friend',
                                display_name: 'Friend',
                                type: 'Online',
                                location: 'wrld_1:123',
                                world_name: 'World',
                                time: '',
                                group_name: '',
                                source_row_key:
                                    '2026-05-08T10:00:00.000Z|usr_friend|Online|wrld_1:123|World',
                                source_row_hash: 'abc'
                            }
                        ]
                    }
                }
            }
        });

        const sql = statements.join('\n');
        expect(sql).toContain('BEGIN');
        expect(sql).toContain('INSERT OR IGNORE INTO usrowner_feed_online_offline');
        expect(sql).toContain('INSERT OR REPLACE INTO remote_sync_items');
        expect(sql).toContain('COMMIT');
    });

    test('skips row when provenance already exists', async () => {
        provenanceHit = true;

        const result = await importDeltaBatch({
            remoteId: 'remote_1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch: {
                schemaVersion: 1,
                tables: {
                    feed_online_offline: {
                        rows: [
                            {
                                id: 10,
                                created_at: '2026-05-08T10:00:00.000Z',
                                user_id: 'usr_friend',
                                display_name: 'Friend',
                                type: 'Online',
                                location: 'wrld_1:123',
                                world_name: 'World',
                                time: '',
                                group_name: '',
                                source_row_key:
                                    '2026-05-08T10:00:00.000Z|usr_friend|Online|wrld_1:123|World',
                                source_row_hash: 'abc'
                            }
                        ]
                    }
                }
            }
        });

        expect(result.rowsImported).toBe(0);
        expect(result.rowsSkipped).toBe(1);
        expect(statements.join('\n')).not.toContain(
            'INSERT OR IGNORE INTO usrowner_feed_online_offline'
        );
    });
});
```

- [ ] **Step 2: Run importer tests and verify failure**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/importer.test.js
```

Expected: fail because importer functions are missing.

- [ ] **Step 3: Add provenance helpers**

Append to `src/services/remoteSync/provenance.js`:

```js
export async function hasRemoteSyncItem(remoteId, sourceTable, sourceRowKey) {
    let found = false;
    await sqliteService.execute(
        () => {
            found = true;
        },
        `SELECT 1 FROM remote_sync_items
         WHERE remote_id = @remote_id
           AND source_table = @source_table
           AND source_row_key = @source_row_key
         LIMIT 1`,
        {
            '@remote_id': remoteId,
            '@source_table': sourceTable,
            '@source_row_key': sourceRowKey
        }
    );
    return found;
}

export async function addRemoteSyncItem(item) {
    await sqliteService.executeNonQuery(
        `INSERT OR REPLACE INTO remote_sync_items (
            remote_id,
            remote_owner_user_id,
            source_table,
            source_row_id,
            source_row_key,
            source_row_hash,
            local_table,
            local_row_id,
            local_row_key,
            batch_id,
            imported_at
        ) VALUES (
            @remote_id,
            @remote_owner_user_id,
            @source_table,
            @source_row_id,
            @source_row_key,
            @source_row_hash,
            @local_table,
            @local_row_id,
            @local_row_key,
            @batch_id,
            @imported_at
        )`,
        {
            '@remote_id': item.remoteId,
            '@remote_owner_user_id': item.remoteOwnerUserId,
            '@source_table': item.sourceTable,
            '@source_row_id': item.sourceRowId || '',
            '@source_row_key': item.sourceRowKey,
            '@source_row_hash': item.sourceRowHash,
            '@local_table': item.localTable,
            '@local_row_id': item.localRowId || '',
            '@local_row_key': item.localRowKey,
            '@batch_id': item.batchId,
            '@imported_at': item.importedAt
        }
    );
}
```

- [ ] **Step 4: Implement importer**

Create `src/services/remoteSync/importer.js`:

```js
import sqliteService from '../sqlite.js';

import {
    REMOTE_SYNC_SCHEMA_VERSION,
    getSyncTableDefinition
} from './syncRegistry.js';
import { addRemoteSyncItem, hasRemoteSyncItem } from './provenance.js';

function randomId(prefix) {
    if (crypto?.randomUUID) {
        return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function argsForColumns(columns, row) {
    const args = {};
    for (const column of columns) {
        if (column === 'id') continue;
        args[`@${column}`] = row[column] ?? '';
    }
    return args;
}

async function insertLocalRow(definition, tableName, row) {
    const columns = definition.columns.filter((column) => column !== 'id');
    const placeholders = columns.map((column) => `@${column}`);
    if (definition.conflict === 'replace-if-newer') {
        await sqliteService.executeNonQuery(
            `INSERT INTO ${tableName} (${columns.join(', ')})
             VALUES (${placeholders.join(', ')})
             ON CONFLICT(id) DO UPDATE SET
             ${columns
                 .filter((column) => column !== 'id')
                 .map((column) => `${column} = excluded.${column}`)
                 .join(', ')}
             WHERE excluded.updated_at >= ${tableName}.updated_at`,
            argsForColumns(definition.columns, row)
        );
        return;
    }
    await sqliteService.executeNonQuery(
        `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})`,
        argsForColumns(definition.columns, row)
    );
}

export async function importDeltaBatch({
    remoteId,
    remoteOwnerUserId,
    userPrefix,
    batch
}) {
    if (batch.schemaVersion !== REMOTE_SYNC_SCHEMA_VERSION) {
        throw new Error(
            `Unsupported remote sync schema version: ${batch.schemaVersion}`
        );
    }

    const batchId = randomId('rsb');
    const importedAt = new Date().toJSON();
    const result = {
        batchId,
        rowsReceived: 0,
        rowsImported: 0,
        rowsSkipped: 0
    };

    await sqliteService.executeNonQuery('BEGIN');
    try {
        for (const [logicalTable, tableBatch] of Object.entries(batch.tables)) {
            const definition = getSyncTableDefinition(logicalTable);
            const localTable = definition.resolveTableName(userPrefix);
            for (const row of tableBatch.rows || []) {
                result.rowsReceived++;
                const sourceRowKey = row.source_row_key;
                if (
                    await hasRemoteSyncItem(
                        remoteId,
                        logicalTable,
                        sourceRowKey
                    )
                ) {
                    result.rowsSkipped++;
                    continue;
                }

                await insertLocalRow(definition, localTable, row);
                await addRemoteSyncItem({
                    remoteId,
                    remoteOwnerUserId,
                    sourceTable: logicalTable,
                    sourceRowId: row.id,
                    sourceRowKey,
                    sourceRowHash: row.source_row_hash,
                    localTable,
                    localRowKey: sourceRowKey,
                    batchId,
                    importedAt
                });
                result.rowsImported++;
            }
        }
        await sqliteService.executeNonQuery('COMMIT');
    } catch (err) {
        await sqliteService.executeNonQuery('ROLLBACK');
        throw err;
    }

    return result;
}
```

- [ ] **Step 5: Run importer tests and verify pass**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/importer.test.js
```

Expected: pass.

- [ ] **Step 6: Commit importer**

```bash
git add src/services/remoteSync/importer.js src/services/remoteSync/provenance.js src/services/remoteSync/__tests__/importer.test.js
git commit -m "feat: import remote sync batches idempotently"
```

## Task 5: Add Headless Token and Client Credential Service

**Files:**

- Create: `src-headless/syncAuth.js`
- Test: `src-headless/__tests__/syncAuth.test.js`

- [ ] **Step 1: Write failing sync auth tests**

Create `src-headless/__tests__/syncAuth.test.js`:

```js
import { beforeEach, describe, expect, test } from 'vitest';

import {
    createSyncAuthService,
    hashSecretForTest
} from '../syncAuth.js';

describe('headless sync auth', () => {
    let storage;

    beforeEach(() => {
        storage = new Map();
    });

    test('creates a one-time token when missing', async () => {
        const service = createSyncAuthService({ storage });
        const result = await service.ensureRemoteToken();

        expect(result.created).toBe(true);
        expect(result.token).toMatch(/^vrcx_rt_/);
        expect(storage.get('remoteTokenHash')).toBeTruthy();
        expect(storage.get('remoteTokenHash')).not.toBe(result.token);
    });

    test('does not reprint existing token', async () => {
        storage.set('remoteTokenHash', await hashSecretForTest('vrcx_rt_existing'));

        const service = createSyncAuthService({ storage });
        const result = await service.ensureRemoteToken();

        expect(result.created).toBe(false);
        expect(result.token).toBe('');
    });

    test('rotates token and clears clients', async () => {
        storage.set('pairedClients', JSON.stringify([{ clientId: 'old' }]));

        const service = createSyncAuthService({ storage });
        const result = await service.rotateRemoteToken();

        expect(result.token).toMatch(/^vrcx_rt_/);
        expect(storage.get('pairedClients')).toBe('[]');
    });

    test('pairs only when token and user id match', async () => {
        const service = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_owner',
                displayName: 'Owner'
            })
        });
        const { token } = await service.ensureRemoteToken();

        const paired = await service.pairClient({
            token,
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        expect(paired.clientId).toMatch(/^rsc_/);
        expect(paired.clientSecret).toMatch(/^vrcx_cs_/);
    });

    test('rejects account mismatch', async () => {
        const service = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_remote',
                displayName: 'Remote'
            })
        });
        const { token } = await service.ensureRemoteToken();

        await expect(
            service.pairClient({
                token,
                localUserId: 'usr_local',
                localDisplayName: 'Local'
            })
        ).rejects.toMatchObject({
            code: 'user_mismatch'
        });
    });
});
```

- [ ] **Step 2: Run auth tests and verify failure**

Run:

```bash
npm test -- src-headless/__tests__/syncAuth.test.js
```

Expected: fail because `syncAuth.js` does not exist.

- [ ] **Step 3: Implement sync auth service**

Create `src-headless/syncAuth.js`:

```js
import { webcrypto } from 'node:crypto';

const encoder = new TextEncoder();

async function sha256(input) {
    const digest = await webcrypto.subtle.digest(
        'SHA-256',
        encoder.encode(input)
    );
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function randomToken(prefix) {
    const bytes = new Uint8Array(32);
    webcrypto.getRandomValues(bytes);
    return `${prefix}_${Buffer.from(bytes).toString('base64url')}`;
}

function readClients(storage) {
    try {
        return JSON.parse(storage.get('pairedClients') || '[]');
    } catch {
        return [];
    }
}

function writeClients(storage, clients) {
    storage.set('pairedClients', JSON.stringify(clients));
}

export async function hashSecretForTest(secret) {
    return sha256(secret);
}

export function createSyncAuthService({ storage, getOwnerUser = () => null }) {
    return {
        async ensureRemoteToken() {
            if (storage.get('remoteTokenHash')) {
                return { created: false, token: '' };
            }
            const token = randomToken('vrcx_rt');
            storage.set('remoteTokenHash', await sha256(token));
            return { created: true, token };
        },

        async rotateRemoteToken() {
            const token = randomToken('vrcx_rt');
            storage.set('remoteTokenHash', await sha256(token));
            writeClients(storage, []);
            return { token };
        },

        async pairClient({ token, localUserId, localDisplayName }) {
            const tokenHash = storage.get('remoteTokenHash');
            if (!tokenHash || (await sha256(token)) !== tokenHash) {
                const error = new Error('Invalid remote token');
                error.code = 'invalid_token';
                throw error;
            }
            const owner = getOwnerUser();
            if (!owner?.id) {
                const error = new Error('Remote is not logged in');
                error.code = 'remote_not_logged_in';
                throw error;
            }
            if (owner.id !== localUserId) {
                const error = new Error('Remote account mismatch');
                error.code = 'user_mismatch';
                error.remoteUserId = owner.id;
                error.remoteDisplayName = owner.displayName || '';
                error.localUserId = localUserId;
                error.localDisplayName = localDisplayName || '';
                throw error;
            }

            const client = {
                clientId: randomToken('rsc'),
                clientSecret: randomToken('vrcx_cs'),
                clientSecretHash: '',
                localDisplayName: localDisplayName || '',
                pairedAt: new Date().toJSON()
            };
            client.clientSecretHash = await sha256(client.clientSecret);
            const clients = readClients(storage);
            clients.push({
                ...client,
                clientSecret: undefined
            });
            writeClients(storage, clients);
            return {
                remoteUserId: owner.id,
                remoteDisplayName: owner.displayName || '',
                clientId: client.clientId,
                clientSecret: client.clientSecret
            };
        },

        async validateClient({ clientId, clientSecret }) {
            const clients = readClients(storage);
            const client = clients.find((item) => item.clientId === clientId);
            if (!client) return false;
            return (await sha256(clientSecret)) === client.clientSecretHash;
        }
    };
}
```

- [ ] **Step 4: Run auth tests and verify pass**

Run:

```bash
npm test -- src-headless/__tests__/syncAuth.test.js
```

Expected: pass.

- [ ] **Step 5: Commit sync auth**

```bash
git add src-headless/syncAuth.js src-headless/__tests__/syncAuth.test.js
git commit -m "feat: add headless sync token auth"
```

## Task 6: Add Headless CLI and Console Login

**Files:**

- Create: `src-headless/cliArgs.js`
- Create: `src-headless/consoleLogin.js`
- Create: `src-headless/__tests__/cliArgs.test.js`

- [ ] **Step 1: Write failing CLI tests**

Create `src-headless/__tests__/cliArgs.test.js`:

```js
import { describe, expect, test } from 'vitest';

import { parseHeadlessArgs } from '../cliArgs.js';

describe('headless cli args', () => {
    test('uses safe defaults', () => {
        expect(parseHeadlessArgs([])).toMatchObject({
            listenHost: '127.0.0.1',
            syncPort: 14590,
            login: false,
            newRemoteToken: false
        });
    });

    test('parses config, login, token rotation, and host', () => {
        expect(
            parseHeadlessArgs([
                '--config-dir',
                '/tmp/vrcx',
                '--sync-host',
                '0.0.0.0',
                '--sync-port',
                '16000',
                '--login',
                '--new-remote-token'
            ])
        ).toMatchObject({
            configDir: '/tmp/vrcx',
            listenHost: '0.0.0.0',
            syncPort: 16000,
            login: true,
            newRemoteToken: true
        });
    });
});
```

- [ ] **Step 2: Run CLI tests and verify failure**

Run:

```bash
npm test -- src-headless/__tests__/cliArgs.test.js
```

Expected: fail because `cliArgs.js` does not exist.

- [ ] **Step 3: Implement CLI parser**

Create `src-headless/cliArgs.js`:

```js
export function parseHeadlessArgs(argv) {
    const args = {
        configDir: '',
        listenHost: '127.0.0.1',
        syncPort: 14590,
        login: false,
        newRemoteToken: false
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--config-dir') {
            args.configDir = argv[++index] || '';
        } else if (arg === '--sync-host') {
            args.listenHost = argv[++index] || args.listenHost;
        } else if (arg === '--sync-port') {
            args.syncPort = Number.parseInt(argv[++index], 10);
        } else if (arg === '--login') {
            args.login = true;
        } else if (arg === '--new-remote-token') {
            args.newRemoteToken = true;
        }
    }

    if (!Number.isInteger(args.syncPort) || args.syncPort <= 0) {
        throw new Error('--sync-port must be a positive integer');
    }

    return args;
}
```

- [ ] **Step 4: Implement console login prompt helper**

Create `src-headless/consoleLogin.js`:

```js
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

async function hiddenQuestion(rl, prompt) {
    const mutableOutput = output;
    const originalWrite = mutableOutput.write;
    mutableOutput.write = function maskedWrite(chunk, encoding, callback) {
        if (typeof chunk === 'string' && chunk.includes(prompt)) {
            return originalWrite.call(this, chunk, encoding, callback);
        }
        return originalWrite.call(this, '*', encoding, callback);
    };
    try {
        return await rl.question(prompt);
    } finally {
        mutableOutput.write = originalWrite;
        output.write('\n');
    }
}

export async function promptForCredentials() {
    const rl = readline.createInterface({ input, output });
    try {
        const username = await rl.question('VRChat username/email: ');
        const password = await hiddenQuestion(rl, 'VRChat password: ');
        return { username, password };
    } finally {
        rl.close();
    }
}

export async function promptForTwoFactorCode(method = '2FA') {
    const rl = readline.createInterface({ input, output });
    try {
        return await rl.question(`${method} code: `);
    } finally {
        rl.close();
    }
}
```

- [ ] **Step 5: Run CLI tests and verify pass**

Run:

```bash
npm test -- src-headless/__tests__/cliArgs.test.js
```

Expected: pass.

- [ ] **Step 6: Commit CLI helpers**

```bash
git add src-headless/cliArgs.js src-headless/consoleLogin.js src-headless/__tests__/cliArgs.test.js
git commit -m "feat: add headless CLI helpers"
```

## Task 7: Add Headless Sync Server

**Files:**

- Create: `src-headless/syncServer.js`
- Test: `src-headless/__tests__/syncServer.test.js`

- [ ] **Step 1: Write failing sync server tests**

Create `src-headless/__tests__/syncServer.test.js`:

```js
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createSyncServer } from '../syncServer.js';

let server;

afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
});

describe('headless sync server', () => {
    test('pairs matching user through auth service', async () => {
        const pairClient = vi.fn(async () => ({
            remoteUserId: 'usr_owner',
            remoteDisplayName: 'Owner',
            clientId: 'rsc_1',
            clientSecret: 'vrcx_cs_1'
        }));
        server = createSyncServer({
            syncAuth: { pairClient },
            getStatus: () => ({ loggedIn: true }),
            exportDeltaBatch: vi.fn()
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();

        const response = await fetch(`http://127.0.0.1:${port}/sync/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'vrcx_rt_1',
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            clientId: 'rsc_1',
            clientSecret: 'vrcx_cs_1'
        });
        expect(pairClient).toHaveBeenCalledWith({
            token: 'vrcx_rt_1',
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });
    });

    test('returns user_mismatch conflict', async () => {
        const error = new Error('mismatch');
        error.code = 'user_mismatch';
        error.remoteUserId = 'usr_remote';
        error.localUserId = 'usr_local';
        server = createSyncServer({
            syncAuth: {
                pairClient: vi.fn(async () => {
                    throw error;
                })
            },
            getStatus: () => ({ loggedIn: true }),
            exportDeltaBatch: vi.fn()
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();

        const response = await fetch(`http://127.0.0.1:${port}/sync/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'vrcx_rt_1',
                localUserId: 'usr_local'
            })
        });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            code: 'user_mismatch',
            remoteUserId: 'usr_remote',
            localUserId: 'usr_local'
        });
    });
});
```

- [ ] **Step 2: Run server tests and verify failure**

Run:

```bash
npm test -- src-headless/__tests__/syncServer.test.js
```

Expected: fail because `syncServer.js` does not exist.

- [ ] **Step 3: Implement server endpoints**

Create `src-headless/syncServer.js`:

```js
import http from 'node:http';

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
    });
    res.end(data);
}

function bearer(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) return null;
    const [clientId, clientSecret] = match[1].split(':');
    return { clientId, clientSecret };
}

export function createSyncServer({
    syncAuth,
    getStatus,
    exportDeltaBatch,
    getUserPrefix
}) {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');

            if (req.method === 'GET' && url.pathname === '/sync/status') {
                sendJson(res, 200, getStatus());
                return;
            }

            if (req.method === 'POST' && url.pathname === '/sync/pair') {
                const body = await readJson(req);
                try {
                    const result = await syncAuth.pairClient({
                        token: body.token,
                        localUserId: body.localUserId,
                        localDisplayName: body.localDisplayName || ''
                    });
                    sendJson(res, 200, result);
                } catch (err) {
                    if (err.code === 'user_mismatch') {
                        sendJson(res, 409, {
                            code: err.code,
                            remoteUserId: err.remoteUserId,
                            remoteDisplayName: err.remoteDisplayName || '',
                            localUserId: err.localUserId,
                            localDisplayName: err.localDisplayName || ''
                        });
                        return;
                    }
                    sendJson(res, 401, { code: err.code || 'unauthorized' });
                }
                return;
            }

            const auth = bearer(req);
            if (
                !auth ||
                !(await syncAuth.validateClient({
                    clientId: auth.clientId,
                    clientSecret: auth.clientSecret
                }))
            ) {
                sendJson(res, 401, { code: 'unauthorized' });
                return;
            }

            if (req.method === 'POST' && url.pathname === '/sync/delta') {
                const body = await readJson(req);
                const batch = await exportDeltaBatch({
                    userPrefix: getUserPrefix(),
                    sinceByTable: body.sinceByTable || {},
                    limit: body.limit || 500
                });
                sendJson(res, 200, batch);
                return;
            }

            sendJson(res, 404, { code: 'not_found' });
        } catch (err) {
            sendJson(res, 500, {
                code: 'server_error',
                message: err.message || String(err)
            });
        }
    });
}
```

- [ ] **Step 4: Run server tests and verify pass**

Run:

```bash
npm test -- src-headless/__tests__/syncServer.test.js src-headless/__tests__/syncAuth.test.js
```

Expected: pass.

- [ ] **Step 5: Commit sync server**

```bash
git add src-headless/syncServer.js src-headless/__tests__/syncServer.test.js
git commit -m "feat: add headless sync server"
```

## Task 8: Add Headless Runtime Entrypoint

**Files:**

- Create: `src-headless/headlessRuntime.js`
- Create: `src-headless/main.js`
- Modify: `src-electron/main.js`
- Modify: `package.json`
- Modify: `src/vite.config.js`

- [ ] **Step 1: Add runtime orchestration**

Create `src-headless/headlessRuntime.js`:

```js
import { exportDeltaBatch } from '../src/services/remoteSync/exporter.js';
import { database } from '../src/services/database/index.js';
import { createSyncAuthService } from './syncAuth.js';
import { createSyncServer } from './syncServer.js';

function storageAdapter(VRCXStorage) {
    return {
        get(key) {
            return VRCXStorage.Get(`RemoteSync_${key}`);
        },
        set(key, value) {
            VRCXStorage.Set(`RemoteSync_${key}`, value);
            VRCXStorage.Save();
        }
    };
}

function userPrefixFromUserId(userId) {
    let prefix = userId.replaceAll('-', '').replaceAll('_', '');
    if (/^\d/.test(prefix)) {
        prefix = `_${prefix}`;
    }
    return prefix;
}

export async function startHeadlessRuntime({
    args,
    dotnet,
    ownerUser,
    loginIfNeeded
}) {
    dotnet.VRCXStorage.Load();
    dotnet.SQLite.Init();
    dotnet.WebApi.Init();

    const currentUser = await loginIfNeeded({ forceLogin: args.login });
    await database.initTables();
    await database.initUserTables(currentUser.id);

    const storage = storageAdapter(dotnet.VRCXStorage);
    const syncAuth = createSyncAuthService({
        storage,
        getOwnerUser: () => ownerUser.current
    });

    if (args.newRemoteToken) {
        const { token } = await syncAuth.rotateRemoteToken();
        console.log('Remote sync token rotated.');
        console.log('Use this token once from desktop VRCX to pair:');
        console.log(token);
    } else {
        const { created, token } = await syncAuth.ensureRemoteToken();
        if (created) {
            console.log('Remote sync token created.');
            console.log('Use this token once from desktop VRCX to pair:');
            console.log(token);
        }
    }

    const server = createSyncServer({
        syncAuth,
        getStatus: () => ({
            loggedIn: Boolean(ownerUser.current?.id),
            ownerUserId: ownerUser.current?.id || ''
        }),
        exportDeltaBatch,
        getUserPrefix: () => userPrefixFromUserId(ownerUser.current.id)
    });

    await new Promise((resolve) =>
        server.listen(args.syncPort, args.listenHost, resolve)
    );
    console.log(
        `VRCX headless sync server listening on ${args.listenHost}:${args.syncPort}`
    );

    return { server };
}
```

- [ ] **Step 2: Add main entrypoint**

Create `src-headless/main.js`:

```js
import { parseHeadlessArgs } from './cliArgs.js';
import { startHeadlessRuntime } from './headlessRuntime.js';

const args = parseHeadlessArgs(process.argv.slice(2));

await startHeadlessRuntime({
    args,
    dotnet: globalThis.VRCXDotNet,
    ownerUser: globalThis.VRCXHeadlessOwnerUser,
    loginIfNeeded: globalThis.VRCXHeadlessLogin
});
```

- [ ] **Step 3: Add headless bundle build target**

Modify `src/vite.config.js` so production builds can emit a CommonJS headless bundle. Keep the existing UI build behavior intact and gate the headless build with an environment variable:

```js
const isHeadlessBuild = process.env.VRCX_HEADLESS_BUILD === 'true';
```

Inside `defineConfig`, extract the existing `build: { ... }` object into a local `const appBuildConfig = { ... }` before the returned object. Then include this branch in the returned config:

```js
build: isHeadlessBuild
    ? {
          outDir: '../build/headless',
          emptyOutDir: false,
          lib: {
              entry: resolve(__dirname, '../src-headless/main.js'),
              formats: ['cjs'],
              fileName: () => 'vrcx-headless.cjs'
          },
          rollupOptions: {
              external: [
                  'node:http',
                  'node:crypto',
                  'node:readline/promises',
                  'node:process'
              ]
          }
      }
    : appBuildConfig
```

The extracted `appBuildConfig` should contain the current `target`, `outDir`, `license`, `emptyOutDir`, `copyPublicDir`, `reportCompressedSize`, `chunkSizeWarningLimit`, `sourcemap`, `assetsInlineLimit`, and `rolldownOptions` values unchanged.

- [ ] **Step 4: Dispatch from Electron main when headless flag is present**

Modify `src-electron/main.js` near argument parsing:

```js
const headless = args.includes('--headless');
```

After .NET interop initialization and before creating windows, add:

```js
if (headless) {
    const headlessBundle = path.join(rootDir, 'build/headless/vrcx-headless.cjs');
    const { parseHeadlessArgs, startHeadlessRuntime } = require(headlessBundle);
    const headlessArgs = parseHeadlessArgs(args);
    const ownerUser = { current: null };
    await startHeadlessRuntime({
        args: headlessArgs,
        dotnet: {
            VRCXStorage: interopApi.getDotNetObject('VRCXStorage'),
            SQLite: interopApi.getDotNetObject('SQLite'),
            WebApi: interopApi.getDotNetObject('WebApi')
        },
        ownerUser,
        loginIfNeeded: async () => {
            throw new Error('Headless console login is wired in Task 9');
        }
    });
    return;
}
```

Adjust the surrounding function to permit `await` if needed. If the current file cannot use top-level `await`, wrap the startup body in `async function main() { ... }` and call `main().catch(...)`.

- [ ] **Step 5: Add package scripts and lint paths**

Modify `package.json`:

```json
"start-headless": "electron . --headless",
"build-headless": "cross-env VRCX_HEADLESS_BUILD=true PLATFORM=linux vite build src",
"format": "oxfmt src src-headless src-electron eslint.config.mjs vitest.config.js vitest.setup.js",
"format:check": "oxfmt --check src src-headless src-electron eslint.config.mjs vitest.config.js vitest.setup.js"
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- src-headless/__tests__/cliArgs.test.js src-headless/__tests__/syncAuth.test.js src-headless/__tests__/syncServer.test.js
```

Expected: pass.

- [ ] **Step 7: Commit headless runtime shell**

```bash
git add src-headless/headlessRuntime.js src-headless/main.js src-electron/main.js src/vite.config.js package.json
git commit -m "feat: add headless runtime entrypoint"
```

## Task 9: Wire Headless VRChat Login

**Files:**

- Modify: `src-headless/headlessRuntime.js`
- Modify: `src-headless/consoleLogin.js`
- Create: `src-headless/headlessLogin.js`

- [ ] **Step 1: Add headless login module**

Create `src-headless/headlessLogin.js`:

```js
import { promptForCredentials, promptForTwoFactorCode } from './consoleLogin.js';

async function requestJson(WebApi, endpoint, options = {}) {
    const url = `https://api.vrchat.cloud/api/1/${endpoint}`;
    const responseJson = await WebApi.ExecuteJson(
        JSON.stringify({
            url,
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json;charset=utf-8'
            },
            body: options.body ? JSON.stringify(options.body) : undefined
        })
    );
    const response = JSON.parse(responseJson);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(response.message || `VRChat API ${response.status}`);
    }
    return JSON.parse(response.message);
}

async function loginWithPassword(WebApi) {
    const credentials = await promptForCredentials();
    const basic = Buffer.from(
        `${credentials.username}:${credentials.password}`
    ).toString('base64');
    const responseJson = await WebApi.ExecuteJson(
        JSON.stringify({
            url: 'https://api.vrchat.cloud/api/1/auth/user',
            method: 'GET',
            headers: {
                Authorization: `Basic ${basic}`
            }
        })
    );
    const response = JSON.parse(responseJson);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(response.message || `VRChat API ${response.status}`);
    }
    return JSON.parse(response.message);
}

async function completeTwoFactor(WebApi, currentUserResponse) {
    const methods = currentUserResponse.requiresTwoFactorAuth || [];
    if (!methods.length) {
        return currentUserResponse;
    }
    const method = methods.includes('totp')
        ? 'totp'
        : methods.includes('otp')
          ? 'otp'
          : 'emailotp';
    const code = await promptForTwoFactorCode(method.toUpperCase());
    const endpoint =
        method === 'emailotp'
            ? 'auth/twofactorauth/emailotp/verify'
            : `auth/twofactorauth/${method}/verify`;
    await requestJson(WebApi, endpoint, {
        method: 'POST',
        body: { code }
    });
    return requestJson(WebApi, 'auth/user');
}

export async function loginHeadlessIfNeeded({ WebApi, forceLogin }) {
    if (!forceLogin) {
        try {
            const current = await requestJson(WebApi, 'auth/user');
            if (current?.id) {
                return current;
            }
        } catch {
            // fall through to console login
        }
    }

    const loginResponse = await loginWithPassword(WebApi);
    return completeTwoFactor(WebApi, loginResponse);
}
```

- [ ] **Step 2: Wire login into runtime**

Modify the headless runtime startup call so `ownerUser.current` is set after login:

```js
    const currentUser = await loginIfNeeded({ forceLogin: args.login });
    ownerUser.current = currentUser;
```

In `src-electron/main.js`, replace the temporary `loginIfNeeded` implementation with:

```js
const { loginHeadlessIfNeeded } = require('../src-headless/headlessLogin.js');
```

and:

```js
loginIfNeeded: ({ forceLogin }) =>
    loginHeadlessIfNeeded({
        WebApi: interopApi.getDotNetObject('WebApi'),
        forceLogin
    })
```

- [ ] **Step 3: Manual smoke test headless login**

Run with a temporary config directory:

```bash
npm run start-headless -- --config-dir /tmp/vrcx-headless-test --login
```

Expected:

- prompts for username/password.
- prompts for 2FA if required.
- logs in.
- prints a remote token if none exists.
- starts sync server on `127.0.0.1:14590`.

- [ ] **Step 4: Commit headless login**

```bash
git add src-headless/headlessLogin.js src-headless/headlessRuntime.js src-electron/main.js
git commit -m "feat: support headless VRChat login"
```

## Task 10: Add Desktop Remote Sync Client

**Files:**

- Create: `src/services/remoteSync/client.js`
- Test: `src/services/remoteSync/__tests__/pairingProtocol.test.js`

- [ ] **Step 1: Write failing desktop client tests**

Create `src/services/remoteSync/__tests__/pairingProtocol.test.js`:

```js
import { describe, expect, test, vi } from 'vitest';

import { createRemoteSyncClient } from '../client.js';

describe('remote sync client', () => {
    test('pairs with token and local user id', async () => {
        const execute = vi.fn(async () => ({
            status: 200,
            data: JSON.stringify({
                remoteUserId: 'usr_owner',
                clientId: 'rsc_1',
                clientSecret: 'vrcx_cs_1'
            })
        }));
        const client = createRemoteSyncClient({ execute });

        const result = await client.pair({
            remoteUrl: 'http://127.0.0.1:14590',
            token: 'vrcx_rt_1',
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        expect(result.clientId).toBe('rsc_1');
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'http://127.0.0.1:14590/sync/pair',
                method: 'POST'
            })
        );
    });

    test('surfaces user mismatch', async () => {
        const execute = vi.fn(async () => ({
            status: 409,
            data: JSON.stringify({
                code: 'user_mismatch',
                remoteUserId: 'usr_remote',
                localUserId: 'usr_local'
            })
        }));
        const client = createRemoteSyncClient({ execute });

        await expect(
            client.pair({
                remoteUrl: 'http://127.0.0.1:14590',
                token: 'vrcx_rt_1',
                localUserId: 'usr_local'
            })
        ).rejects.toMatchObject({
            code: 'user_mismatch'
        });
    });
});
```

- [ ] **Step 2: Run client tests and verify failure**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/pairingProtocol.test.js
```

Expected: fail because `client.js` does not exist.

- [ ] **Step 3: Implement desktop remote sync client**

Create `src/services/remoteSync/client.js`:

```js
import webApiService from '../webapi.js';

function joinUrl(remoteUrl, path) {
    return `${remoteUrl.replace(/\/+$/, '')}${path}`;
}

function parseResponse(response) {
    const data = response.data ? JSON.parse(response.data) : {};
    if (response.status >= 200 && response.status < 300) {
        return data;
    }
    const error = new Error(data.code || `Remote sync HTTP ${response.status}`);
    Object.assign(error, data);
    throw error;
}

export function createRemoteSyncClient({ execute = webApiService.execute } = {}) {
    return {
        async status({ remoteUrl }) {
            return parseResponse(
                await execute({
                    url: joinUrl(remoteUrl, '/sync/status'),
                    method: 'GET'
                })
            );
        },

        async pair({ remoteUrl, token, localUserId, localDisplayName = '' }) {
            return parseResponse(
                await execute({
                    url: joinUrl(remoteUrl, '/sync/pair'),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8'
                    },
                    body: JSON.stringify({
                        token,
                        localUserId,
                        localDisplayName
                    })
                })
            );
        },

        async delta({
            remoteUrl,
            clientId,
            clientSecret,
            sinceByTable,
            limit
        }) {
            return parseResponse(
                await execute({
                    url: joinUrl(remoteUrl, '/sync/delta'),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8',
                        Authorization: `Bearer ${clientId}:${clientSecret}`
                    },
                    body: JSON.stringify({
                        sinceByTable,
                        limit
                    })
                })
            );
        }
    };
}

export const remoteSyncClient = createRemoteSyncClient();
```

- [ ] **Step 4: Run client tests and verify pass**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/pairingProtocol.test.js
```

Expected: pass.

- [ ] **Step 5: Commit client**

```bash
git add src/services/remoteSync/client.js src/services/remoteSync/__tests__/pairingProtocol.test.js
git commit -m "feat: add desktop remote sync client"
```

## Task 11: Add Desktop Remote Sync Store

**Files:**

- Create: `src/stores/remoteSync.js`
- Modify: `src/stores/index.js`

- [ ] **Step 1: Implement store**

Create `src/stores/remoteSync.js`:

```js
import { defineStore } from 'pinia';
import { ref } from 'vue';

import configRepository from '../services/config.js';
import { importDeltaBatch } from '../services/remoteSync/importer.js';
import { remoteSyncClient } from '../services/remoteSync/client.js';
import { useUserStore } from './user.js';
import { dbVars } from '../services/database/index.js';

const CONFIG_KEY = 'VRCX_remoteSyncSource';

export const useRemoteSyncStore = defineStore('RemoteSync', () => {
    const remote = ref(null);
    const loading = ref(false);
    const lastError = ref('');
    const lastResult = ref(null);

    async function load() {
        remote.value = await configRepository.getObject(CONFIG_KEY, null);
    }

    async function saveRemote(value) {
        remote.value = value;
        await configRepository.setObject(CONFIG_KEY, value);
    }

    async function pair({ remoteUrl, token }) {
        const userStore = useUserStore();
        if (!userStore.currentUser?.id) {
            throw new Error('Remote sync requires a logged-in desktop user.');
        }
        loading.value = true;
        lastError.value = '';
        try {
            const result = await remoteSyncClient.pair({
                remoteUrl,
                token,
                localUserId: userStore.currentUser.id,
                localDisplayName: userStore.currentUser.displayName || ''
            });
            await saveRemote({
                remoteUrl,
                remoteUserId: result.remoteUserId,
                remoteDisplayName: result.remoteDisplayName || '',
                clientId: result.clientId,
                clientSecret: result.clientSecret,
                pairedAt: new Date().toJSON(),
                lastSyncAt: ''
            });
            return result;
        } catch (err) {
            lastError.value = err.code || err.message || String(err);
            throw err;
        } finally {
            loading.value = false;
        }
    }

    async function syncNow() {
        if (!remote.value) {
            throw new Error('No remote sync source is paired.');
        }
        loading.value = true;
        lastError.value = '';
        try {
            const batch = await remoteSyncClient.delta({
                remoteUrl: remote.value.remoteUrl,
                clientId: remote.value.clientId,
                clientSecret: remote.value.clientSecret,
                sinceByTable: {},
                limit: 500
            });
            const result = await importDeltaBatch({
                remoteId: remote.value.clientId,
                remoteOwnerUserId: remote.value.remoteUserId,
                userPrefix: dbVars.userPrefix,
                batch
            });
            lastResult.value = result;
            await saveRemote({
                ...remote.value,
                lastSyncAt: new Date().toJSON()
            });
            return result;
        } catch (err) {
            lastError.value = err.code || err.message || String(err);
            throw err;
        } finally {
            loading.value = false;
        }
    }

    async function forgetRemote() {
        remote.value = null;
        await configRepository.remove(CONFIG_KEY);
    }

    load();

    return {
        remote,
        loading,
        lastError,
        lastResult,
        load,
        pair,
        syncNow,
        forgetRemote
    };
});
```

- [ ] **Step 2: Register store**

Modify `src/stores/index.js`:

```js
import { useRemoteSyncStore } from './remoteSync';
```

Add to `createGlobalStores()`:

```js
        remoteSync: useRemoteSyncStore(),
```

Add to the export block:

```js
    useRemoteSyncStore,
```

- [ ] **Step 3: Run type/lint checks**

Run:

```bash
npm run typecheck:js
npm run lint:eslint -- src/stores/remoteSync.js src/stores/index.js
```

Expected: pass.

- [ ] **Step 4: Commit store**

```bash
git add src/stores/remoteSync.js src/stores/index.js
git commit -m "feat: add desktop remote sync store"
```

## Task 12: Add Desktop Remote Sync UI

**Files:**

- Create: `src/views/Settings/components/Tabs/RemoteSyncTab.vue`
- Create: `src/views/Settings/components/Tabs/__tests__/RemoteSyncTab.test.js`
- Modify: `src/views/Settings/Settings.vue`
- Modify: `src/localization/en.json`

- [ ] **Step 1: Write failing UI test**

Create `src/views/Settings/components/Tabs/__tests__/RemoteSyncTab.test.js`:

```js
import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';

import RemoteSyncTab from '../RemoteSyncTab.vue';

vi.mock('../../../../../stores/remoteSync', () => ({
    useRemoteSyncStore: () => ({
        remote: null,
        loading: false,
        lastError: '',
        lastResult: null,
        pair: vi.fn(),
        syncNow: vi.fn(),
        forgetRemote: vi.fn()
    })
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({ t: (key) => key })
}));

describe('RemoteSyncTab', () => {
    test('renders pairing fields', () => {
        const wrapper = mount(RemoteSyncTab);

        expect(wrapper.text()).toContain('view.settings.remote_sync.title');
        expect(wrapper.find('input[name="remoteUrl"]').exists()).toBe(true);
        expect(wrapper.find('input[name="remoteToken"]').exists()).toBe(true);
    });
});
```

- [ ] **Step 2: Run UI test and verify failure**

Run:

```bash
npm test -- src/views/Settings/components/Tabs/__tests__/RemoteSyncTab.test.js
```

Expected: fail because `RemoteSyncTab.vue` does not exist.

- [ ] **Step 3: Implement Remote Sync tab**

Create `src/views/Settings/components/Tabs/RemoteSyncTab.vue`:

```vue
<template>
    <div class="space-y-4">
        <SettingsGroup :title="t('view.settings.remote_sync.title')">
            <SettingsItem :label="t('view.settings.remote_sync.remote_url')">
                <Input
                    name="remoteUrl"
                    v-model="remoteUrl"
                    :disabled="store.loading || Boolean(store.remote)" />
            </SettingsItem>
            <SettingsItem
                v-if="!store.remote"
                :label="t('view.settings.remote_sync.remote_token')">
                <Input
                    name="remoteToken"
                    v-model="remoteToken"
                    :disabled="store.loading"
                    type="password" />
            </SettingsItem>
            <div class="flex gap-2">
                <Button
                    v-if="!store.remote"
                    :disabled="store.loading || !remoteUrl || !remoteToken"
                    @click="pair">
                    {{ t('view.settings.remote_sync.pair') }}
                </Button>
                <Button
                    v-if="store.remote"
                    :disabled="store.loading"
                    @click="syncNow">
                    {{ t('view.settings.remote_sync.sync_now') }}
                </Button>
                <Button
                    v-if="store.remote"
                    variant="outline"
                    :disabled="store.loading"
                    @click="forgetRemote">
                    {{ t('view.settings.remote_sync.forget') }}
                </Button>
            </div>
            <p v-if="store.remote" class="text-muted-foreground text-sm">
                {{ t('view.settings.remote_sync.paired') }}
                {{ store.remote.remoteDisplayName || store.remote.remoteUserId }}
            </p>
            <p v-if="store.lastError" class="text-destructive text-sm">
                {{ store.lastError }}
            </p>
            <p v-if="store.lastResult" class="text-muted-foreground text-sm">
                {{
                    t('view.settings.remote_sync.last_result', {
                        imported: store.lastResult.rowsImported,
                        skipped: store.lastResult.rowsSkipped
                    })
                }}
            </p>
        </SettingsGroup>
    </div>
</template>

<script setup>
    import { ref, watchEffect } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Button } from '../../../components/ui/button';
    import { Input } from '../../../components/ui/input';
    import SettingsGroup from '../SettingsGroup.vue';
    import SettingsItem from '../SettingsItem.vue';
    import { useRemoteSyncStore } from '../../../../stores/remoteSync';

    const { t } = useI18n();
    const store = useRemoteSyncStore();
    const remoteUrl = ref('');
    const remoteToken = ref('');

    watchEffect(() => {
        if (store.remote?.remoteUrl) {
            remoteUrl.value = store.remote.remoteUrl;
        }
    });

    async function pair() {
        await store.pair({
            remoteUrl: remoteUrl.value,
            token: remoteToken.value
        });
        remoteToken.value = '';
    }

    async function syncNow() {
        await store.syncNow();
    }

    async function forgetRemote() {
        await store.forgetRemote();
        remoteUrl.value = '';
        remoteToken.value = '';
    }
</script>
```

- [ ] **Step 4: Add settings tab wiring**

Open `src/views/Settings/Settings.vue` and follow its existing tab registration pattern. Add `RemoteSyncTab.vue` as a new tab labelled with:

```js
t('view.settings.remote_sync.title')
```

If settings tabs are declared in a child component, wire the tab there instead.

- [ ] **Step 5: Add English localization**

Modify `src/localization/en.json` under `view.settings`:

```json
"remote_sync": {
    "title": "Remote Sync",
    "remote_url": "Remote URL",
    "remote_token": "Remote token",
    "pair": "Pair remote",
    "sync_now": "Sync from remote",
    "forget": "Forget remote",
    "paired": "Paired remote:",
    "last_result": "Imported {imported}, skipped {skipped}"
}
```

- [ ] **Step 6: Run UI tests**

Run:

```bash
npm test -- src/views/Settings/components/Tabs/__tests__/RemoteSyncTab.test.js
```

Expected: pass.

- [ ] **Step 7: Commit UI**

```bash
git add src/views/Settings src/localization/en.json
git commit -m "feat: add remote sync settings UI"
```

## Task 13: Add Cursor Overlap and Batch Metadata

**Files:**

- Modify: `src/services/remoteSync/provenance.js`
- Modify: `src/services/remoteSync/importer.js`
- Modify: `src/stores/remoteSync.js`
- Test: `src/services/remoteSync/__tests__/importer.test.js`

- [ ] **Step 1: Add tests for failed batch and cursor overlap**

Extend the sqlite mock in `src/services/remoteSync/__tests__/importer.test.js`:

```js
let throwOnInsert = false;

// inside executeNonQuery mock, before returning success:
if (throwOnInsert && sql.includes('INSERT OR IGNORE INTO')) {
    statements.push(sql);
    throw new Error('insert failed');
}
```

Add this test using the same row shape as the earlier importer tests:

```js
test('records failed batch without a success update', async () => {
    throwOnInsert = true;

    await expect(
        importDeltaBatch({
            remoteId: 'remote_1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch: {
                schemaVersion: 1,
                tables: {
                    feed_online_offline: {
                        rows: [
                            {
                                id: 10,
                                created_at: '2026-05-08T10:00:00.000Z',
                                user_id: 'usr_friend',
                                display_name: 'Friend',
                                type: 'Online',
                                location: 'wrld_1:123',
                                world_name: 'World',
                                time: '',
                                group_name: '',
                                source_row_key:
                                    '2026-05-08T10:00:00.000Z|usr_friend|Online|wrld_1:123|World',
                                source_row_hash: 'abc'
                            }
                        ]
                    }
                }
            }
        })
    ).rejects.toThrow('insert failed');

    expect(statements.join('\n')).toContain('ROLLBACK');
    expect(statements.join('\n')).toContain("status = 'failed'");
    expect(statements.join('\n')).not.toContain("status = 'success'");
});
```

- [ ] **Step 2: Add batch helpers**

Append to `src/services/remoteSync/provenance.js`:

```js
export async function startRemoteSyncBatch({ batchId, remoteId, startedAt }) {
    await sqliteService.executeNonQuery(
        `INSERT OR REPLACE INTO remote_sync_batches (
            batch_id,
            remote_id,
            started_at,
            status
        ) VALUES (@batch_id, @remote_id, @started_at, 'running')`,
        {
            '@batch_id': batchId,
            '@remote_id': remoteId,
            '@started_at': startedAt
        }
    );
}

export async function finishRemoteSyncBatch({
    batchId,
    finishedAt,
    status,
    rowsReceived,
    rowsImported,
    rowsSkipped,
    errorMessage = ''
}) {
    await sqliteService.executeNonQuery(
        `UPDATE remote_sync_batches
         SET finished_at = @finished_at,
             status = @status,
             rows_received = @rows_received,
             rows_imported = @rows_imported,
             rows_skipped = @rows_skipped,
             error_message = @error_message
         WHERE batch_id = @batch_id`,
        {
            '@batch_id': batchId,
            '@finished_at': finishedAt,
            '@status': status,
            '@rows_received': rowsReceived,
            '@rows_imported': rowsImported,
            '@rows_skipped': rowsSkipped,
            '@error_message': errorMessage
        }
    );
}
```

- [ ] **Step 3: Use batch helpers in importer**

Modify `src/services/remoteSync/importer.js`:

```js
import {
    addRemoteSyncItem,
    finishRemoteSyncBatch,
    hasRemoteSyncItem,
    startRemoteSyncBatch
} from './provenance.js';
```

Before `BEGIN`:

```js
    await startRemoteSyncBatch({
        batchId,
        remoteId,
        startedAt: importedAt
    });
```

After successful `COMMIT`:

```js
    await finishRemoteSyncBatch({
        batchId,
        finishedAt: new Date().toJSON(),
        status: 'success',
        ...result
    });
```

In the `catch` block after `ROLLBACK`:

```js
        await finishRemoteSyncBatch({
            batchId,
            finishedAt: new Date().toJSON(),
            status: 'failed',
            ...result,
            errorMessage: err.message || String(err)
        });
```

- [ ] **Step 4: Request cursor overlap from desktop store**

Modify `src/stores/remoteSync.js` to compute overlap:

```js
function buildSinceByTable(remote) {
    if (!remote?.lastSyncAt) {
        return {};
    }
    const overlap = new Date(remote.lastSyncAt);
    overlap.setHours(overlap.getHours() - 24);
    const since = overlap.toJSON();
    return {
        feed_gps: since,
        feed_status: since,
        feed_bio: since,
        feed_avatar: since,
        feed_online_offline: since,
        friend_log_history: since,
        cache_world: since,
        cache_avatar: since
    };
}
```

Use it in `syncNow()`:

```js
sinceByTable: buildSinceByTable(remote.value),
```

- [ ] **Step 5: Run importer tests**

Run:

```bash
npm test -- src/services/remoteSync/__tests__/importer.test.js
```

Expected: pass.

- [ ] **Step 6: Commit batch metadata**

```bash
git add src/services/remoteSync/provenance.js src/services/remoteSync/importer.js src/stores/remoteSync.js src/services/remoteSync/__tests__/importer.test.js
git commit -m "feat: track remote sync batches and cursor overlap"
```

## Task 14: Verification and Hardening

- [ ] **Step 1: Run targeted remote sync tests**

Run:

```bash
npm test -- src/services/remoteSync src-headless
```

Expected: pass.

- [ ] **Step 2: Run broader unit tests likely affected by store/settings changes**

Run:

```bash
npm test -- src/views/Settings src/stores src/services/remoteSync src-headless
```

Expected: pass.

- [ ] **Step 3: Run static checks**

Run:

```bash
npm run typecheck:js
npm run lint
npm run format:check
```

Expected: pass.

- [ ] **Step 4: Manual duplicate sync smoke test**

Run headless with a test config:

```bash
npm run start-headless -- --config-dir /tmp/vrcx-headless-test --login
```

In desktop dev mode, pair with the printed token and click Sync from remote twice.

Expected:

- first sync imports available remote rows.
- second sync reports `rowsImported = 0` for unchanged remote data.
- `remote_sync_items` contains one row per imported remote source row.
- no `gamelog_*`, notification, cookie, settings, memo, or favorite tables are synced.

- [ ] **Step 5: Inspect provenance tables manually**

Use the configured desktop database and run:

```sql
SELECT remote_id, source_table, COUNT(*)
FROM remote_sync_items
GROUP BY remote_id, source_table;

SELECT status, rows_received, rows_imported, rows_skipped
FROM remote_sync_batches
ORDER BY started_at DESC
LIMIT 5;
```

Expected:

- source tables are only v1 approved tables.
- repeated sync shows skipped rows, not duplicate local inserts.
- failed batches, if any, are visible with `status = 'failed'`.

- [ ] **Step 6: Final commit hardening fixes**

If verification found issues, apply focused fixes to the files reported by the failing command, then commit the specific changed files shown by `git status --short`:

```bash
git status --short
git add docs/headless-remote-sync.md README.md src/services/remoteSync src-headless src/stores src/views/Settings src/vite.config.js src-electron/main.js package.json src/localization/en.json
git commit -m "fix: harden headless remote sync"
```

If no fixes were needed, no commit is required.

## Task 15: Documentation

**Files:**

- Create: `docs/headless-remote-sync.md`
- Modify: `README.md`

- [ ] **Step 1: Add user documentation**

Create `docs/headless-remote-sync.md`:

```md
# Headless Remote Sync

Headless Remote Sync runs VRCX on a server so it can collect VRChat API and WebSocket presence history while desktop VRCX is offline.

The first version syncs presence, status, location, avatar, bio, friend-history, world-cache, and avatar-cache data. It does not sync game logs, notifications, settings, credentials, memos, favorites, registry backups, or local UI state.

## Start Headless

```bash
vrcx-headless --config-dir /var/lib/vrcx-headless
```

On first login, the process prompts for VRChat credentials and 2FA if required. If no remote token exists, it prints one token that can be used once from desktop VRCX.

## Rotate Token

```bash
vrcx-headless --config-dir /var/lib/vrcx-headless --new-remote-token
```

Token rotation invalidates existing desktop pairings. Pair desktop VRCX again with the new token.

## Pair Desktop

Open Settings, Remote Sync, enter the remote URL and token, then pair. Pairing succeeds only when desktop and headless VRCX are logged into the same VRChat account.

## Sync

Click Sync from remote. Running sync repeatedly with unchanged remote data does not duplicate data.
```

- [ ] **Step 2: Link docs from README**

Add one line under the feature list or Miscellaneous section in `README.md`:

```md
- For headless server collection and desktop pull-sync, see [Headless Remote Sync](docs/headless-remote-sync.md).
```

- [ ] **Step 3: Commit docs**

```bash
git add docs/headless-remote-sync.md README.md
git commit -m "docs: document headless remote sync"
```

## Final Verification

- [ ] **Step 1: Run full project checks**

Run:

```bash
npm test
npm run typecheck:js
npm run lint
npm run format:check
```

Expected: all pass.

- [ ] **Step 2: Confirm git state**

Run:

```bash
git status --short
```

Expected: no uncommitted implementation changes except intentional local test artifacts outside the repo.

- [ ] **Step 3: Summarize implementation**

Report:

- commits created.
- verification commands and results.
- whether manual headless pairing/sync was smoke-tested.
- any remaining limitations, especially notifications being deferred and game logs excluded.
