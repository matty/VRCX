import { beforeEach, describe, expect, test } from 'vitest';

import { createSyncAuthService, hashSecretForTest } from '../syncAuth.js';

describe('headless sync auth', () => {
    let storage;

    beforeEach(() => {
        storage = new Map();
    });

    test('creates a one-time token when missing', async () => {
        const service = createSyncAuthService({ storage });
        const result = await service.ensureRemoteToken();

        expect(result.created).toBe(true);
        expect(result.token).toMatch(/^vrcx_rt_/);
        expect(storage.get('remoteTokenHash')).toBeTruthy();
        expect(storage.get('remoteTokenHash')).not.toBe(result.token);
    });

    test('does not reprint existing token', async () => {
        storage.set(
            'remoteTokenHash',
            await hashSecretForTest('vrcx_rt_existing')
        );

        const service = createSyncAuthService({ storage });
        const result = await service.ensureRemoteToken();

        expect(result.created).toBe(false);
        expect(result.token).toBe('');
    });

    test('rotates token and clears clients', async () => {
        storage.set('pairedClients', JSON.stringify([{ clientId: 'old' }]));

        const service = createSyncAuthService({ storage });
        const result = await service.rotateRemoteToken();

        expect(result.token).toMatch(/^vrcx_rt_/);
        expect(storage.get('pairedClients')).toBe('[]');
    });

    test('pairs only when token and user id match', async () => {
        const service = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_owner',
                displayName: 'Owner'
            })
        });
        const { token } = await service.ensureRemoteToken();

        const paired = await service.pairClient({
            token,
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        expect(paired.clientId).toMatch(/^rsc_/);
        expect(paired.clientSecret).toMatch(/^vrcx_cs_/);
    });

    test('rejects account mismatch', async () => {
        const service = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_remote',
                displayName: 'Remote'
            })
        });
        const { token } = await service.ensureRemoteToken();

        await expect(
            service.pairClient({
                token,
                localUserId: 'usr_local',
                localDisplayName: 'Local'
            })
        ).rejects.toMatchObject({
            code: 'user_mismatch'
        });
    });
});
