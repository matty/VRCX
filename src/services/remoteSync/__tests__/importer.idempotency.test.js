import { beforeEach, describe, expect, test, vi } from 'vitest';

const tables = vi.hoisted(() => ({
    feedOnlineOffline: [],
    cacheWorld: new Map(),
    remoteSyncItems: new Map(),
    remoteSyncBatches: new Map()
}));

vi.mock('../../sqlite.js', () => {
    function provenanceKey(args) {
        return `${args['@remoteId']}|${args['@sourceTable']}|${args['@sourceRowKey']}`;
    }

    return {
        default: {
            tables,
            async execute(callback, sql, args) {
                if (sql.includes('FROM remote_sync_items')) {
                    const key = provenanceKey(args);
                    if (tables.remoteSyncItems.has(key)) {
                        callback({ 1: 1 });
                    }
                }
            },
            async executeNonQuery(sql, args) {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
                    return 1;
                }

                if (
                    sql.includes('INSERT OR REPLACE INTO remote_sync_batches')
                ) {
                    tables.remoteSyncBatches.set(args['@batch_id'], {
                        batchId: args['@batch_id'],
                        remoteId: args['@remote_id'],
                        startedAt: args['@started_at'],
                        status: 'running'
                    });
                    return 1;
                }

                if (sql.includes('UPDATE remote_sync_batches')) {
                    const batch = tables.remoteSyncBatches.get(
                        args['@batch_id']
                    );
                    tables.remoteSyncBatches.set(args['@batch_id'], {
                        ...batch,
                        finishedAt: args['@finished_at'],
                        status: args['@status'],
                        rowsReceived: args['@rows_received'],
                        rowsImported: args['@rows_imported'],
                        rowsSkipped: args['@rows_skipped'],
                        errorMessage: args['@error_message']
                    });
                    return 1;
                }

                if (
                    sql.includes(
                        'INSERT OR IGNORE INTO usrowner_feed_online_offline'
                    )
                ) {
                    const exists = tables.feedOnlineOffline.some(
                        (row) =>
                            row.created_at === args['@created_at'] &&
                            row.user_id === args['@user_id'] &&
                            row.type === args['@type'] &&
                            row.location === args['@location'] &&
                            row.world_name === args['@world_name']
                    );
                    if (!exists) {
                        tables.feedOnlineOffline.push({
                            created_at: args['@created_at'],
                            user_id: args['@user_id'],
                            display_name: args['@display_name'],
                            type: args['@type'],
                            location: args['@location'],
                            world_name: args['@world_name'],
                            time: args['@time'],
                            group_name: args['@group_name']
                        });
                    }
                    return 1;
                }

                if (sql.includes('INSERT INTO cache_world')) {
                    const existing = tables.cacheWorld.get(args['@id']);
                    if (
                        !existing ||
                        args['@updated_at'] >= existing.updated_at
                    ) {
                        tables.cacheWorld.set(args['@id'], {
                            id: args['@id'],
                            name: args['@name'],
                            updated_at: args['@updated_at'],
                            version: args['@version']
                        });
                    }
                    return 1;
                }

                if (sql.includes('INSERT INTO remote_sync_items')) {
                    const key = provenanceKey({
                        '@remoteId': args['@remoteId'],
                        '@sourceTable': args['@sourceTable'],
                        '@sourceRowKey': args['@sourceRowKey']
                    });
                    if (!tables.remoteSyncItems.has(key)) {
                        tables.remoteSyncItems.set(key, {
                            remoteId: args['@remoteId'],
                            sourceTable: args['@sourceTable'],
                            sourceRowKey: args['@sourceRowKey'],
                            sourceRowHash: args['@sourceRowHash'],
                            localTable: args['@localTable'],
                            localRowKey: args['@localRowKey']
                        });
                    }
                    return 1;
                }

                return 1;
            }
        }
    };
});

const { importDeltaBatch } = await import('../importer.js');
const { buildSourceRowKey } = await import('../syncRegistry.js');

const feedRow = {
    id: 1,
    created_at: '2026-05-08T10:00:00.000Z',
    user_id: 'usr_friend',
    display_name: 'Friend',
    type: 'Online',
    location: 'wrld_1:123',
    world_name: 'World',
    time: '10:00',
    group_name: ''
};

function cacheWorldRow(overrides = {}) {
    return {
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
        source_row_hash: 'hash-world-v1',
        ...overrides
    };
}

function createBatch(tables) {
    return {
        schemaVersion: 1,
        tables
    };
}

async function importBatch(batch) {
    return importDeltaBatch({
        remoteId: 'remote-1',
        remoteOwnerUserId: 'usr_owner',
        userPrefix: 'usrowner',
        batch
    });
}

describe('remote sync importer idempotency', () => {
    beforeEach(() => {
        tables.feedOnlineOffline.length = 0;
        tables.cacheWorld.clear();
        tables.remoteSyncItems.clear();
        tables.remoteSyncBatches.clear();
    });

    test('does not duplicate immutable feed rows across repeated imports', async () => {
        const row = {
            ...feedRow,
            source_row_key: buildSourceRowKey('feed_online_offline', feedRow),
            source_row_hash: 'hash-online'
        };
        const batch = createBatch({
            feed_online_offline: {
                rows: [row]
            }
        });

        const first = await importBatch(batch);
        const second = await importBatch(batch);

        expect(first.rowsImported).toBe(1);
        expect(second.rowsImported).toBe(0);
        expect(second.rowsSkipped).toBe(1);
        expect(tables.feedOnlineOffline).toHaveLength(1);
        expect(tables.remoteSyncItems).toHaveLength(1);
        expect(
            [...tables.remoteSyncBatches.values()].every(
                (batch) => batch.status === 'success'
            )
        ).toBe(true);
    });

    test('does not re-import identical cache versions', async () => {
        const row = cacheWorldRow();
        const batch = createBatch({
            cache_world: {
                rows: [row]
            }
        });

        const first = await importBatch(batch);
        const second = await importBatch(batch);

        expect(first.rowsImported).toBe(1);
        expect(second.rowsImported).toBe(0);
        expect(second.rowsSkipped).toBe(1);
        expect(tables.cacheWorld).toHaveLength(1);
        expect(tables.remoteSyncItems).toHaveLength(1);
    });

    test('imports newer cache version without duplicating local cache row', async () => {
        const firstRow = cacheWorldRow();
        const secondRow = cacheWorldRow({
            name: 'Updated World',
            updated_at: '2026-05-09T10:00:00.000Z',
            version: 2,
            source_row_hash: 'hash-world-v2'
        });

        const first = await importBatch(
            createBatch({
                cache_world: {
                    rows: [firstRow]
                }
            })
        );
        const second = await importBatch(
            createBatch({
                cache_world: {
                    rows: [secondRow]
                }
            })
        );

        expect(first.rowsImported).toBe(1);
        expect(second.rowsImported).toBe(1);
        expect(tables.cacheWorld).toHaveLength(1);
        expect(tables.cacheWorld.get('wrld_1')).toMatchObject({
            name: 'Updated World',
            version: 2
        });
        expect(tables.remoteSyncItems).toHaveLength(2);
    });
});
