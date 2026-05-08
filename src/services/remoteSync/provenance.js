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

async function hasRemoteSyncItem(remoteId, sourceTable, sourceRowKey) {
    let exists = false;

    await sqliteService.execute(
        () => {
            exists = true;
        },
        `SELECT 1 FROM remote_sync_items
         WHERE remote_id = @remoteId
           AND source_table = @sourceTable
           AND source_row_key = @sourceRowKey
         LIMIT 1`,
        {
            '@remoteId': remoteId,
            '@sourceTable': sourceTable,
            '@sourceRowKey': sourceRowKey
        }
    );

    return exists;
}

async function addRemoteSyncItem(item) {
    await sqliteService.executeNonQuery(
        `INSERT INTO remote_sync_items (
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
            @remoteId,
            @remoteOwnerUserId,
            @sourceTable,
            @sourceRowId,
            @sourceRowKey,
            @sourceRowHash,
            @localTable,
            @localRowId,
            @localRowKey,
            @batchId,
            @importedAt
        )`,
        {
            '@remoteId': item.remoteId,
            '@remoteOwnerUserId': item.remoteOwnerUserId,
            '@sourceTable': item.sourceTable,
            '@sourceRowId': item.sourceRowId,
            '@sourceRowKey': item.sourceRowKey,
            '@sourceRowHash': item.sourceRowHash,
            '@localTable': item.localTable,
            '@localRowId': item.localRowId,
            '@localRowKey': item.localRowKey,
            '@batchId': item.batchId,
            '@importedAt': item.importedAt
        }
    );
}

async function startRemoteSyncBatch({ batchId, remoteId, startedAt }) {
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

async function finishRemoteSyncBatch({
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

export {
    addRemoteSyncItem,
    finishRemoteSyncBatch,
    hasRemoteSyncItem,
    initRemoteSyncTables,
    startRemoteSyncBatch
};
