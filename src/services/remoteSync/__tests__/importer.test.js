import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../sqlite.js', () => {
    const calls = [];

    return {
        default: {
            calls,
            provenanceHit: false,
            provenanceKeys: new Set(),
            throwOnInsert: false,
            async execute(callback, sql, args) {
                calls.push({ sql, args });

                if (
                    sql.includes('FROM remote_sync_items') &&
                    (this.provenanceHit ||
                        this.provenanceKeys.has(args['@sourceRowKey']))
                ) {
                    callback({ 1: 1 });
                }
            },
            async executeNonQuery(sql, args) {
                calls.push({ sql, args });
                if (
                    this.throwOnInsert &&
                    sql.includes('INSERT OR IGNORE INTO')
                ) {
                    throw new Error('insert failed');
                }
                return 1;
            }
        }
    };
});

const sqliteService = (await import('../../sqlite.js')).default;
const { importDeltaBatch } = await import('../importer.js');
const { initRemoteSyncTables } = await import('../provenance.js');
const { buildSourceRowKey } = await import('../syncRegistry.js');

const onlineOfflineRow = {
    id: 7,
    created_at: '2026-05-08T10:00:00.000Z',
    user_id: 'usr_friend',
    display_name: 'Friend',
    type: 'Online',
    location: 'wrld_1:123',
    world_name: 'World',
    time: '10:00',
    group_name: 'Group'
};

const cacheWorldRow = {
    id: 'wrld_1',
    added_at: '2026-05-08T10:00:00.000Z',
    author_id: 'usr_author',
    author_name: 'Author',
    created_at: '2026-05-01T10:00:00.000Z',
    description: 'World description',
    image_url: 'https://example.com/image.png',
    name: 'World',
    release_status: 'public',
    thumbnail_image_url: 'https://example.com/thumb.png',
    updated_at: '2026-05-08T10:00:00.000Z',
    version: 1,
    source_row_key: '["wrld_1"]',
    source_row_hash: 'hash-world'
};

const cacheWorldVersionKey = `${cacheWorldRow.source_row_key}:${cacheWorldRow.source_row_hash}`;

function createBatch(tables) {
    return {
        schemaVersion: 1,
        tables
    };
}

function statements() {
    return sqliteService.calls.map(({ sql }) => sql).join('\n');
}

describe('remote sync importer', () => {
    beforeEach(() => {
        sqliteService.calls.length = 0;
        sqliteService.provenanceHit = false;
        sqliteService.provenanceKeys.clear();
        sqliteService.throwOnInsert = false;
    });

    test('creates source, batch, and item tables with both lookup indexes', async () => {
        await initRemoteSyncTables();

        expect(statements()).toContain(
            'CREATE TABLE IF NOT EXISTS remote_sync_sources'
        );
        expect(statements()).toContain(
            'CREATE TABLE IF NOT EXISTS remote_sync_batches'
        );
        expect(statements()).toContain(
            'CREATE TABLE IF NOT EXISTS remote_sync_items'
        );
        expect(statements()).toContain(
            'remote_sync_items_unique_remote_source'
        );
        expect(statements()).toContain('remote_sync_items_local_lookup');
    });

    test('imports row and provenance in one transaction', async () => {
        const sourceRowKey = buildSourceRowKey(
            'feed_online_offline',
            onlineOfflineRow
        );
        const batch = createBatch({
            feed_online_offline: {
                rows: [
                    {
                        ...onlineOfflineRow,
                        source_row_key: sourceRowKey,
                        source_row_hash: 'hash-online'
                    }
                ]
            }
        });

        const result = await importDeltaBatch({
            remoteId: 'remote-1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch
        });

        expect(statements()).toContain('BEGIN');
        expect(statements()).toContain(
            'INSERT OR IGNORE INTO usrowner_feed_online_offline'
        );
        expect(statements()).toContain('INSERT INTO remote_sync_items');
        expect(statements()).not.toContain(
            'INSERT OR REPLACE INTO remote_sync_items'
        );
        expect(statements()).toContain('COMMIT');
        expect(result).toEqual({
            batchId: expect.stringMatching(/^rsb_/),
            rowsReceived: 1,
            rowsImported: 1,
            rowsSkipped: 0
        });
    });

    test('skips row when provenance already exists', async () => {
        sqliteService.provenanceHit = true;
        const batch = createBatch({
            feed_online_offline: {
                rows: [
                    {
                        ...onlineOfflineRow,
                        source_row_key: '["existing"]',
                        source_row_hash: 'hash-online'
                    }
                ]
            }
        });

        const result = await importDeltaBatch({
            remoteId: 'remote-1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch
        });

        expect(result.rowsImported).toBe(0);
        expect(result.rowsSkipped).toBe(1);
        expect(statements()).not.toContain(
            'INSERT OR IGNORE INTO usrowner_feed_online_offline'
        );
    });

    test('rejects unsupported schema version before opening transaction', async () => {
        await expect(
            importDeltaBatch({
                remoteId: 'remote-1',
                remoteOwnerUserId: 'usr_owner',
                userPrefix: 'usrowner',
                batch: createBatch({})
            })
        ).resolves.toBeDefined();

        sqliteService.calls.length = 0;

        await expect(
            importDeltaBatch({
                remoteId: 'remote-1',
                remoteOwnerUserId: 'usr_owner',
                userPrefix: 'usrowner',
                batch: {
                    schemaVersion: 999,
                    tables: {}
                }
            })
        ).rejects.toThrow('Unsupported remote sync schema version');

        expect(statements()).not.toContain('BEGIN');
    });

    test('uses replace-if-newer upsert with id column for cache tables', async () => {
        const batch = createBatch({
            cache_world: {
                rows: [cacheWorldRow]
            }
        });

        await importDeltaBatch({
            remoteId: 'remote-1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch
        });

        const cacheWorldInsert = sqliteService.calls.find(({ sql }) =>
            sql.includes('INSERT INTO cache_world')
        );

        expect(cacheWorldInsert.sql).toContain(
            'INSERT INTO cache_world (id, added_at'
        );
        expect(cacheWorldInsert.sql).toContain('ON CONFLICT(id) DO UPDATE');
        expect(cacheWorldInsert.sql).toContain(
            'WHERE excluded.updated_at >= cache_world.updated_at'
        );
        expect(statements()).toContain('INSERT INTO remote_sync_items');
        expect(statements()).not.toContain(
            'INSERT OR REPLACE INTO remote_sync_items'
        );

        const provenanceInsert = sqliteService.calls.find(({ sql }) =>
            sql.includes('INSERT INTO remote_sync_items')
        );
        expect(provenanceInsert.args['@sourceRowKey']).toBe(
            cacheWorldVersionKey
        );
        expect(provenanceInsert.args['@localRowKey']).toBe(
            cacheWorldRow.source_row_key
        );
    });

    test('imports cache rows even when stable id provenance already exists', async () => {
        sqliteService.provenanceKeys.add(cacheWorldRow.source_row_key);
        const batch = createBatch({
            cache_world: {
                rows: [cacheWorldRow]
            }
        });

        const result = await importDeltaBatch({
            remoteId: 'remote-1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch
        });

        expect(statements()).toContain('INSERT INTO cache_world');
        expect(result.rowsImported).toBe(1);
        expect(result.rowsSkipped).toBe(0);
    });

    test('skips cache row when same version was already imported', async () => {
        sqliteService.provenanceKeys.add(cacheWorldVersionKey);
        const batch = createBatch({
            cache_world: {
                rows: [cacheWorldRow]
            }
        });

        const result = await importDeltaBatch({
            remoteId: 'remote-1',
            remoteOwnerUserId: 'usr_owner',
            userPrefix: 'usrowner',
            batch
        });

        expect(result.rowsImported).toBe(0);
        expect(result.rowsSkipped).toBe(1);
        expect(statements()).not.toContain('INSERT INTO cache_world');
    });

    test('records failed batch without a success update', async () => {
        sqliteService.throwOnInsert = true;

        await expect(
            importDeltaBatch({
                remoteId: 'remote-1',
                remoteOwnerUserId: 'usr_owner',
                userPrefix: 'usrowner',
                batch: createBatch({
                    feed_online_offline: {
                        rows: [
                            {
                                ...onlineOfflineRow,
                                source_row_key: buildSourceRowKey(
                                    'feed_online_offline',
                                    onlineOfflineRow
                                ),
                                source_row_hash: 'hash-online'
                            }
                        ]
                    }
                })
            })
        ).rejects.toThrow('insert failed');

        expect(statements()).toContain('ROLLBACK');
        expect(statements()).toContain('@status');
        expect(
            sqliteService.calls.some(
                ({ args }) => args?.['@status'] === 'failed'
            )
        ).toBe(true);
        expect(
            sqliteService.calls.some(
                ({ args }) => args?.['@status'] === 'success'
            )
        ).toBe(false);
    });
});
