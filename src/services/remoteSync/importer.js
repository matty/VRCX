import sqliteService from '../sqlite.js';
import { addRemoteSyncItem, hasRemoteSyncItem } from './provenance.js';
import {
    REMOTE_SYNC_SCHEMA_VERSION,
    getSyncTableDefinition
} from './syncRegistry.js';

const INSERT_OR_IGNORE = 'insert-or-ignore';
const REPLACE_IF_NEWER = 'replace-if-newer';

async function importDeltaBatch({
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

    const batchId = createBatchId();
    const result = {
        batchId,
        rowsReceived: 0,
        rowsImported: 0,
        rowsSkipped: 0
    };

    await sqliteService.executeNonQuery('BEGIN');

    try {
        for (const [logicalTable, tableBatch] of Object.entries(
            batch.tables || {}
        )) {
            const definition = getSyncTableDefinition(logicalTable);
            const localTable = definition.resolveTableName(userPrefix);
            const rows = tableBatch.rows || [];

            for (const row of rows) {
                result.rowsReceived++;

                const isReplaceIfNewer =
                    definition.conflict === REPLACE_IF_NEWER;
                const provenanceSourceRowKey = getProvenanceSourceRowKey(
                    definition,
                    row
                );

                if (
                    await hasRemoteSyncItem(
                        remoteId,
                        logicalTable,
                        provenanceSourceRowKey
                    )
                ) {
                    result.rowsSkipped++;
                    continue;
                }

                await insertLocalRow(definition, localTable, row);
                const remoteSyncItem = {
                    remoteId,
                    remoteOwnerUserId,
                    sourceTable: logicalTable,
                    sourceRowId: row.id ?? '',
                    sourceRowKey: provenanceSourceRowKey,
                    sourceRowHash: row.source_row_hash,
                    localTable,
                    localRowId: '',
                    localRowKey: row.source_row_key,
                    batchId,
                    importedAt: new Date().toJSON()
                };
                await addRemoteSyncItem(remoteSyncItem);
                result.rowsImported++;
            }
        }

        await sqliteService.executeNonQuery('COMMIT');
    } catch (error) {
        await sqliteService.executeNonQuery('ROLLBACK');
        throw error;
    }

    return result;
}

function getProvenanceSourceRowKey(definition, row) {
    if (definition.conflict === REPLACE_IF_NEWER) {
        return `${row.source_row_key}:${row.source_row_hash}`;
    }

    return row.source_row_key;
}

async function insertLocalRow(definition, localTable, row) {
    if (definition.conflict === INSERT_OR_IGNORE) {
        const columns = definition.columns.filter((column) => column !== 'id');
        await sqliteService.executeNonQuery(
            `INSERT OR IGNORE INTO ${localTable} (${columns.join(', ')})
             VALUES (${placeholdersForColumns(columns).join(', ')})`,
            argsForColumns(columns, row)
        );
        return;
    }

    if (definition.conflict === REPLACE_IF_NEWER) {
        const columns = [...definition.columns];
        const updateColumns = columns.filter((column) => column !== 'id');
        await sqliteService.executeNonQuery(
            `INSERT INTO ${localTable} (${columns.join(', ')})
             VALUES (${placeholdersForColumns(columns).join(', ')})
             ON CONFLICT(id) DO UPDATE SET ${updateColumns
                 .map((column) => `${column} = excluded.${column}`)
                 .join(', ')}
             WHERE excluded.updated_at >= ${localTable}.updated_at`,
            argsForColumns(columns, row)
        );
        return;
    }

    throw new Error(
        `Unsupported remote sync conflict mode: ${definition.conflict}`
    );
}

function argsForColumns(columns, row) {
    return Object.fromEntries(
        columns.map((column) => [`@${column}`, row[column] ?? null])
    );
}

function placeholdersForColumns(columns) {
    return columns.map((column) => `@${column}`);
}

function createBatchId() {
    if (globalThis.crypto?.randomUUID) {
        return `rsb_${globalThis.crypto.randomUUID()}`;
    }

    return `rsb_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2)}`;
}

export { importDeltaBatch };
