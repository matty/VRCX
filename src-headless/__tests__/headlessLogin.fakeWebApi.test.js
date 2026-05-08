import { beforeEach, describe, expect, test, vi } from 'vitest';

const promptForCredentials = vi.hoisted(() => vi.fn());
const promptForTwoFactorCode = vi.hoisted(() => vi.fn());

vi.mock('../consoleLogin.js', () => ({
    promptForCredentials,
    promptForTwoFactorCode
}));

import { loginHeadlessIfNeeded } from '../headlessLogin.js';

function response(status, body) {
    return {
        status,
        message: typeof body === 'string' ? body : JSON.stringify(body)
    };
}

function createFakeWebApi(responses) {
    const requests = [];
    return {
        requests,
        ExecuteJson: async (payload) => {
            requests.push(JSON.parse(payload));
            return JSON.stringify(responses.shift());
        }
    };
}

describe('headless login with fake WebApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('uses existing authenticated user without prompting', async () => {
        const WebApi = createFakeWebApi([
            response(200, {
                id: 'usr_owner',
                displayName: 'Owner'
            })
        ]);

        await expect(
            loginHeadlessIfNeeded({ WebApi, forceLogin: false })
        ).resolves.toMatchObject({
            id: 'usr_owner'
        });
        expect(promptForCredentials).not.toHaveBeenCalled();
        expect(WebApi.requests).toHaveLength(1);
        expect(WebApi.requests[0]).toMatchObject({
            url: 'https://api.vrchat.cloud/api/1/auth/user',
            method: 'GET'
        });
    });

    test('forced login sends basic auth and returns current user', async () => {
        promptForCredentials.mockResolvedValue({
            username: 'owner@example.com',
            password: 'secret'
        });
        const WebApi = createFakeWebApi([
            response(200, {
                id: 'usr_owner',
                displayName: 'Owner'
            })
        ]);

        await expect(
            loginHeadlessIfNeeded({ WebApi, forceLogin: true })
        ).resolves.toMatchObject({
            id: 'usr_owner'
        });
        expect(WebApi.requests[0]).toMatchObject({
            url: 'https://api.vrchat.cloud/api/1/auth/user',
            method: 'GET'
        });
        expect(WebApi.requests[0].headers.Authorization).toMatch(/^Basic /);
    });

    test('totp challenge posts to totp verify endpoint', async () => {
        promptForCredentials.mockResolvedValue({
            username: 'owner@example.com',
            password: 'secret'
        });
        promptForTwoFactorCode.mockResolvedValue('123456');
        const WebApi = createFakeWebApi([
            response(200, {
                requiresTwoFactorAuth: ['totp']
            }),
            response(200, { ok: true }),
            response(200, {
                id: 'usr_owner',
                displayName: 'Owner'
            })
        ]);

        await loginHeadlessIfNeeded({ WebApi, forceLogin: true });

        expect(promptForTwoFactorCode).toHaveBeenCalledWith('TOTP');
        expect(WebApi.requests[1]).toMatchObject({
            url: 'https://api.vrchat.cloud/api/1/auth/twofactorauth/totp/verify',
            method: 'POST',
            body: JSON.stringify({ code: '123456' })
        });
    });

    test('email otp challenge posts to emailotp verify endpoint', async () => {
        promptForCredentials.mockResolvedValue({
            username: 'owner@example.com',
            password: 'secret'
        });
        promptForTwoFactorCode.mockResolvedValue('654321');
        const WebApi = createFakeWebApi([
            response(200, {
                requiresTwoFactorAuth: ['emailotp']
            }),
            response(200, { ok: true }),
            response(200, {
                id: 'usr_owner',
                displayName: 'Owner'
            })
        ]);

        await loginHeadlessIfNeeded({ WebApi, forceLogin: true });

        expect(promptForTwoFactorCode).toHaveBeenCalledWith('EMAILOTP');
        expect(WebApi.requests[1]).toMatchObject({
            url: 'https://api.vrchat.cloud/api/1/auth/twofactorauth/emailotp/verify',
            method: 'POST',
            body: JSON.stringify({ code: '654321' })
        });
    });

    test('failed API response throws', async () => {
        const WebApi = createFakeWebApi([
            response(401, 'Unauthorized'),
            response(401, 'Unauthorized')
        ]);
        promptForCredentials.mockResolvedValue({
            username: 'owner@example.com',
            password: 'secret'
        });

        await expect(
            loginHeadlessIfNeeded({ WebApi, forceLogin: false })
        ).rejects.toThrow('Unauthorized');
    });
});
