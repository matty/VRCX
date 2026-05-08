import sqliteService from '../sqlite.js';

async function initRemoteSyncTables() {
    await sqliteService.executeNonQuery(
        `CREATE TABLE IF NOT EXISTS remote_sync_sources (
            remote_id TEXT PRIMARY KEY,
            remote_owner_user_id TEXT NOT NULL,
            remote_url TEXT NOT NULL,
            paired_at TEXT NOT NULL,
            last_sync_at TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT ''
        )`
    );
    await sqliteService.executeNonQuery(
        `CREATE TABLE IF NOT EXISTS remote_sync_batches (
            batch_id TEXT PRIMARY KEY,
            remote_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            rows_received INTEGER NOT NULL DEFAULT 0,
            rows_imported INTEGER NOT NULL DEFAULT 0,
            rows_skipped INTEGER NOT NULL DEFAULT 0,
            error_message TEXT NOT NULL DEFAULT ''
        )`
    );
    await sqliteService.executeNonQuery(
        `CREATE TABLE IF NOT EXISTS remote_sync_items (
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
        )`
    );
    await sqliteService.executeNonQuery(
        `CREATE UNIQUE INDEX IF NOT EXISTS remote_sync_items_unique_remote_source ON remote_sync_items (remote_id, source_table, source_row_key)`
    );
    await sqliteService.executeNonQuery(
        `CREATE INDEX IF NOT EXISTS remote_sync_items_local_lookup ON remote_sync_items (local_table, local_row_key)`
    );
}

export { initRemoteSyncTables };
