import { describe, expect, test, vi } from 'vitest';

const promptForCredentials = vi.hoisted(() => vi.fn());
const promptForTwoFactorCode = vi.hoisted(() => vi.fn());

vi.mock('../consoleLogin.js', () => ({
    promptForCredentials,
    promptForTwoFactorCode
}));

import { loginHeadlessIfNeeded } from '../headlessLogin.js';

function createWebApi(responses) {
    return {
        ExecuteJson: vi.fn(async () => JSON.stringify(responses.shift()))
    };
}

describe('headless VRChat login', () => {
    test('uses existing authenticated user when login is not forced', async () => {
        const WebApi = createWebApi([
            {
                status: 200,
                message: JSON.stringify({
                    id: 'usr_owner',
                    displayName: 'Owner'
                })
            }
        ]);

        await expect(
            loginHeadlessIfNeeded({ WebApi, forceLogin: false })
        ).resolves.toMatchObject({
            id: 'usr_owner'
        });
        expect(promptForCredentials).not.toHaveBeenCalled();
    });

    test('prompts for credentials and completes totp challenge', async () => {
        promptForCredentials.mockResolvedValue({
            username: 'owner@example.com',
            password: 'secret'
        });
        promptForTwoFactorCode.mockResolvedValue('123456');
        const WebApi = createWebApi([
            {
                status: 200,
                message: JSON.stringify({
                    requiresTwoFactorAuth: ['totp']
                })
            },
            {
                status: 200,
                message: JSON.stringify({ ok: true })
            },
            {
                status: 200,
                message: JSON.stringify({
                    id: 'usr_owner',
                    displayName: 'Owner'
                })
            }
        ]);

        await expect(
            loginHeadlessIfNeeded({ WebApi, forceLogin: true })
        ).resolves.toMatchObject({
            id: 'usr_owner'
        });

        expect(promptForCredentials).toHaveBeenCalled();
        expect(promptForTwoFactorCode).toHaveBeenCalledWith('TOTP');
    });
});
