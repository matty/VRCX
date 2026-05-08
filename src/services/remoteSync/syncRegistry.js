export const REMOTE_SYNC_SCHEMA_VERSION = 1;

const INSERT_OR_IGNORE = 'insert-or-ignore';
const REPLACE_IF_NEWER = 'replace-if-newer';
const SQLITE_ROW_ID_COLUMNS = ['id'];

const CACHE_IMPORT_COLUMNS = [
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
];

const SYNC_TABLE_DEFINITIONS = Object.freeze([
    {
        name: 'feed_gps',
        userPrefixed: true,
        conflict: INSERT_OR_IGNORE,
        cursorColumn: 'created_at',
        keyFields: ['created_at', 'user_id', 'location', 'previous_location', 'world_name'],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
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
        ]
    },
    {
        name: 'feed_status',
        userPrefixed: true,
        conflict: INSERT_OR_IGNORE,
        cursorColumn: 'created_at',
        keyFields: [
            'created_at',
            'user_id',
            'status',
            'status_description',
            'previous_status',
            'previous_status_description'
        ],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
        columns: [
            'id',
            'created_at',
            'user_id',
            'display_name',
            'status',
            'status_description',
            'previous_status',
            'previous_status_description'
        ]
    },
    {
        name: 'feed_bio',
        userPrefixed: true,
        conflict: INSERT_OR_IGNORE,
        cursorColumn: 'created_at',
        keyFields: ['created_at', 'user_id', 'bio', 'previous_bio'],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
        columns: [
            'id',
            'created_at',
            'user_id',
            'display_name',
            'bio',
            'previous_bio'
        ]
    },
    {
        name: 'feed_avatar',
        userPrefixed: true,
        conflict: INSERT_OR_IGNORE,
        cursorColumn: 'created_at',
        keyFields: [
            'created_at',
            'user_id',
            'owner_id',
            'avatar_name',
            'current_avatar_image_url'
        ],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
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
        ]
    },
    {
        name: 'feed_online_offline',
        userPrefixed: true,
        conflict: INSERT_OR_IGNORE,
        cursorColumn: 'created_at',
        keyFields: ['created_at', 'user_id', 'type', 'location', 'world_name'],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
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
        ]
    },
    {
        name: 'friend_log_history',
        userPrefixed: true,
        conflict: INSERT_OR_IGNORE,
        cursorColumn: 'created_at',
        keyFields: [
            'created_at',
            'type',
            'user_id',
            'display_name',
            'previous_display_name',
            'trust_level',
            'previous_trust_level'
        ],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
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
        ]
    },
    {
        name: 'cache_world',
        userPrefixed: false,
        conflict: REPLACE_IF_NEWER,
        cursorColumn: 'updated_at',
        keyFields: ['id'],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
        columns: CACHE_IMPORT_COLUMNS
    },
    {
        name: 'cache_avatar',
        userPrefixed: false,
        conflict: REPLACE_IF_NEWER,
        cursorColumn: 'updated_at',
        keyFields: ['id'],
        hashExcludedColumns: SQLITE_ROW_ID_COLUMNS,
        columns: CACHE_IMPORT_COLUMNS
    }
].map((definition) => Object.freeze({
    name: definition.name,
    userPrefixed: definition.userPrefixed,
    conflict: definition.conflict,
    cursorColumn: definition.cursorColumn,
    keyFields: Object.freeze([...definition.keyFields]),
    hashExcludedColumns: Object.freeze([...definition.hashExcludedColumns]),
    columns: Object.freeze([...definition.columns]),
    allowedImportColumns: Object.freeze([...definition.columns]),
    resolveTableName: (userPrefix) =>
        definition.userPrefixed ? `${userPrefix}_${definition.name}` : definition.name
})));

const SYNC_TABLE_DEFINITION_BY_NAME = new Map(
    SYNC_TABLE_DEFINITIONS.map((definition) => [definition.name, definition])
);

export function getSyncTableDefinitions() {
    return SYNC_TABLE_DEFINITIONS;
}

export function getSyncTableDefinition(name) {
    const definition = SYNC_TABLE_DEFINITION_BY_NAME.get(name);
    if (!definition) {
        throw new Error(`Unknown remote sync table: ${name}`);
    }
    return definition;
}

export function buildSourceRowKey(tableName, row) {
    const definition = getSyncTableDefinition(tableName);
    return stableJson(definition.keyFields.map((field) => row[field] ?? null));
}

export async function buildSourceRowHash(tableName, row) {
    const definition = getSyncTableDefinition(tableName);
    return sha256(stableJson({
        tableName,
        row: projectHashRow(row, definition)
    }));
}

function projectHashRow(row, definition) {
    const hashedColumns = definition.columns.filter(
        (column) => !definition.hashExcludedColumns.includes(column)
    );
    return Object.fromEntries(
        hashedColumns.map((column) => [column, row[column] ?? null])
    );
}

function stableJson(value) {
    return JSON.stringify(toStableValue(value));
}

function toStableValue(value) {
    if (Array.isArray(value)) {
        return value.map(toStableValue);
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, toStableValue(value[key])])
        );
    }

    return value;
}

async function sha256(value) {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const bytes = new TextEncoder().encode(value);
        const digest = await subtle.digest('SHA-256', bytes);
        return bytesToHex(new Uint8Array(digest));
    }

    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(value).digest('hex');
}

function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
