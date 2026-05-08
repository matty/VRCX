import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRemoteSyncClient } from '../../src/services/remoteSync/client.js';
import { createSyncAuthService } from '../syncAuth.js';
import { createSyncServer } from '../syncServer.js';

let server;

afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
});

describe('headless sync server over local HTTP', () => {
    let storage;
    let syncAuth;
    let client;

    beforeEach(() => {
        storage = new Map();
        syncAuth = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_owner',
                displayName: 'Owner'
            })
        });
        client = createRemoteSyncClient({
            execute: async ({ url, method, headers, body }) => {
                const response = await fetch(url, { method, headers, body });
                return {
                    status: response.status,
                    data: await response.text()
                };
            }
        });
    });

    test('pairs same account and rejects mismatched account over HTTP', async () => {
        server = createSyncServer({
            syncAuth,
            getStatus: () => ({ loggedIn: true, ownerUserId: 'usr_owner' }),
            exportDeltaBatch: vi.fn(),
            getUserPrefix: () => 'usrowner'
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const remoteUrl = `http://127.0.0.1:${server.address().port}`;
        const { token } = await syncAuth.ensureRemoteToken();

        await expect(
            client.pair({
                remoteUrl,
                token,
                localUserId: 'usr_other',
                localDisplayName: 'Other'
            })
        ).rejects.toMatchObject({
            code: 'user_mismatch'
        });

        await expect(
            client.pair({
                remoteUrl,
                token,
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        ).resolves.toMatchObject({
            remoteUserId: 'usr_owner',
            clientId: expect.stringMatching(/^rsc_/),
            clientSecret: expect.stringMatching(/^vrcx_cs_/)
        });
    });

    test('requires paired client bearer credentials for delta', async () => {
        const exportDeltaBatch = vi.fn(async () => ({
            schemaVersion: 1,
            tables: {}
        }));
        server = createSyncServer({
            syncAuth,
            getStatus: () => ({ loggedIn: true, ownerUserId: 'usr_owner' }),
            exportDeltaBatch,
            getUserPrefix: () => 'usrowner'
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const remoteUrl = `http://127.0.0.1:${server.address().port}`;
        const { token } = await syncAuth.ensureRemoteToken();
        const paired = await client.pair({
            remoteUrl,
            token,
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        await expect(
            client.delta({
                remoteUrl,
                clientId: paired.clientId,
                clientSecret: 'wrong',
                sinceByTable: {},
                limit: 500
            })
        ).rejects.toMatchObject({
            code: 'unauthorized'
        });

        await expect(
            client.delta({
                remoteUrl,
                clientId: paired.clientId,
                clientSecret: paired.clientSecret,
                sinceByTable: {
                    feed_online_offline: '2026-05-07T12:00:00.000Z'
                },
                limit: 123
            })
        ).resolves.toMatchObject({
            schemaVersion: 1
        });
        expect(exportDeltaBatch).toHaveBeenCalledWith({
            userPrefix: 'usrowner',
            sinceByTable: {
                feed_online_offline: '2026-05-07T12:00:00.000Z'
            },
            limit: 123
        });
    });
});
