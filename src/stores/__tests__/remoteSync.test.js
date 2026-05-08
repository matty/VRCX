import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const configRepository = vi.hoisted(() => ({
    getObject: vi.fn(async () => null),
    setObject: vi.fn(),
    remove: vi.fn()
}));

const remoteSyncClient = vi.hoisted(() => ({
    pair: vi.fn(),
    delta: vi.fn()
}));

const importDeltaBatch = vi.hoisted(() => vi.fn());

vi.mock('../../services/config.js', () => ({
    default: configRepository
}));

vi.mock('../../services/remoteSync/client.js', () => ({
    remoteSyncClient
}));

vi.mock('../../services/remoteSync/importer.js', () => ({
    importDeltaBatch
}));

vi.mock('../../services/database/index.js', () => ({
    dbVars: {
        userPrefix: 'usrowner'
    }
}));

vi.mock('../user.js', () => ({
    useUserStore: () => ({
        currentUser: {
            id: 'usr_owner',
            displayName: 'Owner'
        }
    })
}));

import { useRemoteSyncStore } from '../remoteSync.js';

describe('useRemoteSyncStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    test('pairs and persists a matching remote', async () => {
        remoteSyncClient.pair.mockResolvedValue({
            remoteUserId: 'usr_owner',
            remoteDisplayName: 'Owner',
            clientId: 'rsc_1',
            clientSecret: 'vrcx_cs_1'
        });
        const store = useRemoteSyncStore();

        await store.pair({
            remoteUrl: 'http://127.0.0.1:14590',
            token: 'vrcx_rt_1'
        });

        expect(remoteSyncClient.pair).toHaveBeenCalledWith({
            remoteUrl: 'http://127.0.0.1:14590',
            token: 'vrcx_rt_1',
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });
        expect(configRepository.setObject).toHaveBeenCalledWith(
            'VRCX_remoteSyncSource',
            expect.objectContaining({
                remoteUrl: 'http://127.0.0.1:14590',
                clientId: 'rsc_1',
                clientSecret: 'vrcx_cs_1'
            })
        );
    });

    test('downloads and imports a remote delta batch', async () => {
        remoteSyncClient.delta.mockResolvedValue({
            schemaVersion: 1,
            tables: {}
        });
        importDeltaBatch.mockResolvedValue({
            rowsReceived: 0,
            rowsImported: 0,
            rowsSkipped: 0
        });
        const store = useRemoteSyncStore();
        store.remote = {
            remoteUrl: 'http://127.0.0.1:14590',
            remoteUserId: 'usr_owner',
            clientId: 'rsc_1',
            clientSecret: 'vrcx_cs_1'
        };

        await store.syncNow();

        expect(importDeltaBatch).toHaveBeenCalledWith(
            expect.objectContaining({
                remoteId: 'rsc_1',
                remoteOwnerUserId: 'usr_owner',
                userPrefix: 'usrowner',
                batch: {
                    schemaVersion: 1,
                    tables: {}
                }
            })
        );
    });
});
