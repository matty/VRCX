import { beforeEach, describe, expect, test, vi } from 'vitest';

const onlineOfflineRow = [
    7,
    '2026-05-08T10:00:00.000Z',
    'usr_friend',
    'Friend',
    'Online',
    'wrld_1:123',
    'World',
    '10:00',
    'Group'
];

vi.mock('../../sqlite.js', () => {
    const calls = [];

    return {
        default: {
            calls,
            async execute(callback, sql, args) {
                calls.push({ sql, args });

                if (sql.includes('FROM usrabc_feed_online_offline')) {
                    callback(onlineOfflineRow);
                }
            }
        }
    };
});

const sqliteService = (await import('../../sqlite.js')).default;
const { exportDeltaBatch } = await import('../exporter.js');
const { REMOTE_SYNC_SCHEMA_VERSION, buildSourceRowKey } =
    await import('../syncRegistry.js');

describe('remote sync delta exporter', () => {
    beforeEach(() => {
        sqliteService.calls.length = 0;
    });

    test('exports delta rows using registry table metadata', async () => {
        const batch = await exportDeltaBatch({
            userPrefix: 'usrabc',
            sinceByTable: {
                feed_online_offline: '2026-05-07T10:00:00.000Z'
            },
            limit: 50
        });

        const onlineOfflineCall = sqliteService.calls.find(({ sql }) =>
            sql.includes('FROM usrabc_feed_online_offline')
        );

        expect(onlineOfflineCall).toBeDefined();
        expect(onlineOfflineCall.sql).toContain('WHERE created_at >= @since');
        expect(onlineOfflineCall.args).toEqual({
            '@since': '2026-05-07T10:00:00.000Z',
            '@limit': 50
        });
        expect(batch.schemaVersion).toBe(REMOTE_SYNC_SCHEMA_VERSION);
        expect(batch.tables.feed_online_offline.cursorColumn).toBe(
            'created_at'
        );
        const expectedRow = {
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
        expect(batch.tables.feed_online_offline.rows).toEqual([
            expect.objectContaining({
                ...expectedRow,
                source_row_key: buildSourceRowKey(
                    'feed_online_offline',
                    expectedRow
                ),
                source_row_hash: expect.any(String)
            })
        ]);
        expect(batch.tables.feed_gps.rows).toEqual([]);
    });
});
