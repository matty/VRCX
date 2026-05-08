import { Buffer } from 'node:buffer';
import {
    promptForCredentials,
    promptForTwoFactorCode
} from './consoleLogin.js';

async function requestJson(WebApi, endpoint, options = {}) {
    const url = `https://api.vrchat.cloud/api/1/${endpoint}`;
    const responseJson = await WebApi.ExecuteJson(
        JSON.stringify({
            url,
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json;charset=utf-8'
            },
            body: options.body ? JSON.stringify(options.body) : undefined
        })
    );
    const response = JSON.parse(responseJson);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(response.message || `VRChat API ${response.status}`);
    }

    return JSON.parse(response.message);
}

async function loginWithPassword(WebApi) {
    const credentials = await promptForCredentials();
    const basic = Buffer.from(
        `${credentials.username}:${credentials.password}`
    ).toString('base64');
    const responseJson = await WebApi.ExecuteJson(
        JSON.stringify({
            url: 'https://api.vrchat.cloud/api/1/auth/user',
            method: 'GET',
            headers: {
                Authorization: `Basic ${basic}`
            }
        })
    );
    const response = JSON.parse(responseJson);
    if (response.status < 200 || response.status >= 300) {
        throw new Error(response.message || `VRChat API ${response.status}`);
    }

    return JSON.parse(response.message);
}

async function completeTwoFactor(WebApi, currentUserResponse) {
    const methods = currentUserResponse.requiresTwoFactorAuth || [];
    if (!methods.length) {
        return currentUserResponse;
    }

    const method = methods.includes('totp')
        ? 'totp'
        : methods.includes('otp')
          ? 'otp'
          : 'emailotp';
    const code = await promptForTwoFactorCode(method.toUpperCase());
    const endpoint =
        method === 'emailotp'
            ? 'auth/twofactorauth/emailotp/verify'
            : `auth/twofactorauth/${method}/verify`;
    await requestJson(WebApi, endpoint, {
        method: 'POST',
        body: { code }
    });

    return requestJson(WebApi, 'auth/user');
}

export async function loginHeadlessIfNeeded({ WebApi, forceLogin }) {
    if (!forceLogin) {
        try {
            const current = await requestJson(WebApi, 'auth/user');
            if (current?.id) {
                return current;
            }
        } catch {
            // Fall through to console login.
        }
    }

    const loginResponse = await loginWithPassword(WebApi);
    return completeTwoFactor(WebApi, loginResponse);
}

export { completeTwoFactor, requestJson };
