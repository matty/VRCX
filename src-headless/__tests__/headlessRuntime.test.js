import { beforeEach, describe, expect, test, vi } from 'vitest';

const databaseMock = vi.hoisted(() => ({
    initTables: vi.fn(),
    initUserTables: vi.fn()
}));

const syncServerMock = vi.hoisted(() => ({
    listen: vi.fn((_port, _host, callback) => callback())
}));

const createSyncServerMock = vi.hoisted(() => vi.fn(() => syncServerMock));

vi.mock('../../src/services/database/index.js', () => ({
    database: databaseMock
}));

vi.mock('../syncServer.js', () => ({
    createSyncServer: createSyncServerMock
}));

vi.mock('../../src/services/remoteSync/exporter.js', () => ({
    exportDeltaBatch: vi.fn()
}));

import { startHeadlessRuntime } from '../headlessRuntime.js';

describe('headless runtime', () => {
    beforeEach(() => {
        databaseMock.initTables.mockReset();
        databaseMock.initUserTables.mockReset();
        syncServerMock.listen.mockClear();
        createSyncServerMock.mockClear();
    });

    test('logs in, initializes user tables, creates token, and starts server', async () => {
        const storage = new Map();
        const logs = [];
        const dotnet = {
            VRCXStorage: {
                Load: vi.fn(),
                Get: vi.fn((key) => storage.get(key) || ''),
                Set: vi.fn((key, value) => storage.set(key, value)),
                Save: vi.fn()
            },
            SQLite: { Init: vi.fn() },
            WebApi: { Init: vi.fn() }
        };
        const ownerUser = { current: null };

        const result = await startHeadlessRuntime({
            args: {
                listenHost: '127.0.0.1',
                syncPort: 14590,
                login: true,
                newRemoteToken: false
            },
            dotnet,
            ownerUser,
            loginIfNeeded: vi.fn(async () => ({
                id: 'usr_owner',
                displayName: 'Owner'
            })),
            log: (message) => logs.push(message)
        });

        expect(ownerUser.current.id).toBe('usr_owner');
        expect(databaseMock.initTables).toHaveBeenCalled();
        expect(databaseMock.initUserTables).toHaveBeenCalledWith('usr_owner');
        expect(storage.get('RemoteSync_remoteTokenHash')).toBeTruthy();
        expect(logs).toContain('Remote sync token created.');
        expect(syncServerMock.listen).toHaveBeenCalledWith(
            14590,
            '127.0.0.1',
            expect.any(Function)
        );
        expect(result.server).toBe(syncServerMock);
    });
});
