import { beforeEach, describe, expect, test } from 'vitest';

import { createSyncAuthService } from '../syncAuth.js';

describe('headless remote token lifecycle', () => {
    let storage;

    beforeEach(() => {
        storage = new Map();
    });

    test('rotating remote token invalidates old token and paired clients', async () => {
        const service = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_owner',
                displayName: 'Owner'
            })
        });

        const first = await service.ensureRemoteToken();
        const paired = await service.pairClient({
            token: first.token,
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        await expect(
            service.validateClient({
                clientId: paired.clientId,
                clientSecret: paired.clientSecret
            })
        ).resolves.toBe(true);

        const rotated = await service.rotateRemoteToken();

        await expect(
            service.pairClient({
                token: first.token,
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        ).rejects.toMatchObject({
            code: 'invalid_token'
        });
        await expect(
            service.validateClient({
                clientId: paired.clientId,
                clientSecret: paired.clientSecret
            })
        ).resolves.toBe(false);
        await expect(
            service.pairClient({
                token: rotated.token,
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        ).resolves.toMatchObject({
            remoteUserId: 'usr_owner'
        });
    });
});
