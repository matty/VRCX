import { describe, expect, test } from 'vitest';

import {
    REMOTE_SYNC_SCHEMA_VERSION,
    buildSourceRowHash,
    buildSourceRowKey,
    getSyncTableDefinition,
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

    test('all table definitions expose required sync metadata', () => {
        for (const definition of getSyncTableDefinitions()) {
            expect(definition).toEqual(
                expect.objectContaining({
                    name: expect.any(String),
                    userPrefixed: expect.any(Boolean),
                    resolveTableName: expect.any(Function),
                    conflict: expect.any(String),
                    cursorColumn: expect.any(String),
                    keyFields: expect.any(Array),
                    hashExcludedColumns: expect.any(Array),
                    columns: expect.any(Array),
                    allowedImportColumns: expect.any(Array)
                })
            );
        }
    });

    test('feed_gps exposes expected import and merge metadata', () => {
        const feedGps = getSyncTableDefinition('feed_gps');

        expect(feedGps.userPrefixed).toBe(true);
        expect(feedGps.cursorColumn).toBe('created_at');
        expect(feedGps.conflict).toBe('insert-or-ignore');
        expect(feedGps.keyFields).toEqual([
            'created_at',
            'user_id',
            'location',
            'previous_location',
            'world_name'
        ]);
        expect(feedGps.hashExcludedColumns).toEqual(['id']);
        expect(feedGps.allowedImportColumns).toEqual([
            'id',
            'created_at',
            'user_id',
            'display_name',
            'location',
            'world_name',
            'previous_location',
            'time',
            'group_name'
        ]);
    });

    test('feed_online_offline exposes planned columns metadata', () => {
        expect(getSyncTableDefinition('feed_online_offline').columns).toEqual([
            'id',
            'created_at',
            'user_id',
            'display_name',
            'type',
            'location',
            'world_name',
            'time',
            'group_name'
        ]);
    });

    test('cache tables expose direct table and replace-if-newer metadata', () => {
        const cacheWorld = getSyncTableDefinition('cache_world');

        expect(cacheWorld.userPrefixed).toBe(false);
        expect(cacheWorld.resolveTableName('usrabc')).toBe('cache_world');
        expect(cacheWorld.cursorColumn).toBe('updated_at');
        expect(cacheWorld.conflict).toBe('replace-if-newer');
        expect(cacheWorld.keyFields).toEqual(['id']);
        expect(cacheWorld.hashExcludedColumns).toEqual(['id']);
        expect(cacheWorld.allowedImportColumns).toEqual([
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
        ]);
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

        await expect(
            buildSourceRowHash('feed_online_offline', row)
        ).resolves.not.toBe(
            await buildSourceRowHash('feed_online_offline', {
                ...row,
                world_name: 'Other World'
            })
        );
    });

    test('hash ignores properties outside declared synced columns', async () => {
        const row = {
            id: 1,
            created_at: '2026-05-08T10:00:00.000Z',
            user_id: 'usr_friend',
            display_name: 'Friend',
            type: 'Online',
            location: 'wrld_1:123',
            world_name: 'World',
            time: '',
            group_name: ''
        };

        await expect(
            buildSourceRowHash('feed_online_offline', {
                ...row,
                non_imported_column: 'must not affect hash'
            })
        ).resolves.toBe(await buildSourceRowHash('feed_online_offline', row));
    });

    test('hash is namespaced by logical table name', async () => {
        const row = {
            id: 'avtr_or_wrld_1',
            added_at: '2026-05-08T10:00:00.000Z',
            author_id: 'usr_author',
            author_name: 'Author',
            created_at: '2026-05-08T10:00:00.000Z',
            description: 'Description',
            image_url: 'https://example.com/image.png',
            name: 'Name',
            release_status: 'public',
            thumbnail_image_url: 'https://example.com/thumb.png',
            updated_at: '2026-05-08T11:00:00.000Z',
            version: 1
        };

        await expect(buildSourceRowHash('cache_world', row)).resolves.not.toBe(
            await buildSourceRowHash('cache_avatar', row)
        );
    });

    test('returned table definitions cannot mutate registry order or length', () => {
        const originalNames = getSyncTableDefinitions().map(
            (table) => table.name
        );
        const definitions = getSyncTableDefinitions();

        try {
            definitions.push({
                name: 'unexpected_table'
            });
        } catch {
            // Frozen arrays throw on mutation; copied arrays allow local mutation.
        }

        const currentNames = getSyncTableDefinitions().map(
            (table) => table.name
        );

        expect(currentNames).toEqual(originalNames);
        expect(currentNames).toHaveLength(originalNames.length);
    });

    test('exports a positive schema version', () => {
        expect(REMOTE_SYNC_SCHEMA_VERSION).toBeGreaterThan(0);
    });
});
