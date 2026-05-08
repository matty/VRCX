import { afterEach, describe, expect, test, vi } from 'vitest';

import { createSyncServer } from '../syncServer.js';

let server;

afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
});

describe('headless sync server', () => {
    test('pairs matching user through auth service', async () => {
        const pairClient = vi.fn(async () => ({
            remoteUserId: 'usr_owner',
            remoteDisplayName: 'Owner',
            clientId: 'rsc_1',
            clientSecret: 'vrcx_cs_1'
        }));
        server = createSyncServer({
            syncAuth: { pairClient },
            getStatus: () => ({ loggedIn: true }),
            exportDeltaBatch: vi.fn()
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();

        const response = await fetch(`http://127.0.0.1:${port}/sync/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'vrcx_rt_1',
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            clientId: 'rsc_1',
            clientSecret: 'vrcx_cs_1'
        });
        expect(pairClient).toHaveBeenCalledWith({
            token: 'vrcx_rt_1',
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });
    });

    test('returns user_mismatch conflict', async () => {
        const error = new Error('mismatch');
        error.code = 'user_mismatch';
        error.remoteUserId = 'usr_remote';
        error.localUserId = 'usr_local';
        server = createSyncServer({
            syncAuth: {
                pairClient: vi.fn(async () => {
                    throw error;
                })
            },
            getStatus: () => ({ loggedIn: true }),
            exportDeltaBatch: vi.fn()
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();

        const response = await fetch(`http://127.0.0.1:${port}/sync/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'vrcx_rt_1',
                localUserId: 'usr_local'
            })
        });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            code: 'user_mismatch',
            remoteUserId: 'usr_remote',
            localUserId: 'usr_local'
        });
    });
});
