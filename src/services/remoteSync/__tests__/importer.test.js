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
        expect(sqliteService.statements.join('\n')).toContain(
            'remote_sync_items_local_lookup'
        );
    });
});
