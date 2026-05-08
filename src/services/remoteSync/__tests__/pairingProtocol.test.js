import { describe, expect, test, vi } from 'vitest';

import { createRemoteSyncClient } from '../client.js';

describe('remote sync client', () => {
    test('pairs with token and local user id', async () => {
        const execute = vi.fn(async () => ({
            status: 200,
            data: JSON.stringify({
                remoteUserId: 'usr_owner',
                clientId: 'rsc_1',
                clientSecret: 'vrcx_cs_1'
            })
        }));
        const client = createRemoteSyncClient({ execute });

        const result = await client.pair({
            remoteUrl: 'http://127.0.0.1:14590',
            token: 'vrcx_rt_1',
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        expect(result.clientId).toBe('rsc_1');
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'http://127.0.0.1:14590/sync/pair',
                method: 'POST'
            })
        );
    });

    test('surfaces user mismatch', async () => {
        const execute = vi.fn(async () => ({
            status: 409,
            data: JSON.stringify({
                code: 'user_mismatch',
                remoteUserId: 'usr_remote',
                localUserId: 'usr_local'
            })
        }));
        const client = createRemoteSyncClient({ execute });

        await expect(
            client.pair({
                remoteUrl: 'http://127.0.0.1:14590',
                token: 'vrcx_rt_1',
                localUserId: 'usr_local'
            })
        ).rejects.toMatchObject({
            code: 'user_mismatch'
        });
    });
});
