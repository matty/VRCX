import sqliteService from '../sqlite.js';
import {
    REMOTE_SYNC_SCHEMA_VERSION,
    buildSourceRowHash,
    buildSourceRowKey,
    getSyncTableDefinitions
} from './syncRegistry.js';

export async function exportDeltaBatch({
    userPrefix,
    sinceByTable = {},
    limit = 500
}) {
    const tables = {};

    for (const definition of getSyncTableDefinitions()) {
        const tableName = definition.resolveTableName(userPrefix);
        const since = sinceByTable[definition.name] || '';
        const where = since ? `WHERE ${definition.cursorColumn} >= @since` : '';
        const rows = [];
        const sql = [
            `SELECT ${definition.columns.join(', ')}`,
            `FROM ${tableName}`,
            where,
            `ORDER BY ${definition.cursorColumn} ASC, id ASC`,
            'LIMIT @limit'
        ]
            .filter(Boolean)
            .join(' ');

        await sqliteService.execute(
            (dbRow) => {
                rows.push(rowFromColumns(definition.columns, dbRow));
            },
            sql,
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

function rowFromColumns(columns, dbRow) {
    if (!Array.isArray(dbRow)) {
        return Object.fromEntries(
            columns.map((column) => [column, dbRow[column]])
        );
    }

    return Object.fromEntries(
        columns.map((column, index) => [column, dbRow[index]])
    );
}
