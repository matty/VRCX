import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { createSyncAuthService } from '../../../../src-headless/syncAuth.js';
import { createSyncServer } from '../../../../src-headless/syncServer.js';

const configRepository = vi.hoisted(() => ({
    getObject: vi.fn(async () => null),
    setObject: vi.fn(),
    remove: vi.fn()
}));
const importDeltaBatch = vi.hoisted(() => vi.fn());
const execute = vi.hoisted(() =>
    vi.fn(async ({ url, method, headers, body }) => {
        const response = await fetch(url, { method, headers, body });
        return {
            status: response.status,
            data: await response.text()
        };
    })
);

vi.mock('../importer.js', () => ({ importDeltaBatch }));
vi.mock('../../config.js', () => ({ default: configRepository }));
vi.mock('../../webapi.js', () => ({
    default: {
        execute
    }
}));
vi.mock('../../database/index.js', () => ({
    dbVars: { userPrefix: 'usrowner' }
}));
vi.mock('../../../stores/user.js', () => ({
    useUserStore: () => ({
        currentUser: { id: 'usr_owner', displayName: 'Owner' }
    })
}));

import { useRemoteSyncStore } from '../../../stores/remoteSync.js';

let server;

afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
});

describe('desktop sync from headless remote end-to-end', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    test('pairs and syncs a remote batch through local HTTP server', async () => {
        const syncAuth = createSyncAuthService({
            storage: new Map(),
            getOwnerUser: () => ({ id: 'usr_owner', displayName: 'Owner' })
        });
        const batch = {
            schemaVersion: 1,
            tables: {
                feed_online_offline: {
                    rows: [
                        {
                            id: 1,
                            created_at: '2026-05-08T10:00:00.000Z',
                            user_id: 'usr_friend',
                            display_name: 'Friend',
                            type: 'Online',
                            location: 'wrld_1:123',
                            world_name: 'World',
                            time: '10:00',
                            group_name: '',
                            source_row_key:
                                '["2026-05-08T10:00:00.000Z","usr_friend","Online","wrld_1:123","World"]',
                            source_row_hash: 'hash-online'
                        }
                    ]
                }
            }
        };
        server = createSyncServer({
            syncAuth,
            getStatus: () => ({ loggedIn: true, ownerUserId: 'usr_owner' }),
            exportDeltaBatch: vi.fn(async () => batch),
            getUserPrefix: () => 'usrowner'
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const remoteUrl = `http://127.0.0.1:${server.address().port}`;
        const { token } = await syncAuth.ensureRemoteToken();
        importDeltaBatch.mockResolvedValue({
            batchId: 'rsb_test',
            rowsReceived: 1,
            rowsImported: 1,
            rowsSkipped: 0
        });

        const store = useRemoteSyncStore();
        await store.pair({ remoteUrl, token });
        await store.syncNow();

        expect(importDeltaBatch).toHaveBeenCalledWith(
            expect.objectContaining({
                remoteOwnerUserId: 'usr_owner',
                userPrefix: 'usrowner',
                batch
            })
        );
        expect(store.lastResult).toMatchObject({
            rowsImported: 1
        });
    });
});
