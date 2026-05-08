import { webcrypto } from 'node:crypto';

const encoder = new TextEncoder();

async function sha256(input) {
    const digest = await webcrypto.subtle.digest(
        'SHA-256',
        encoder.encode(input)
    );
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function randomToken(prefix) {
    const bytes = new Uint8Array(32);
    webcrypto.getRandomValues(bytes);
    return `${prefix}_${Buffer.from(bytes).toString('base64url')}`;
}

function readClients(storage) {
    try {
        return JSON.parse(storage.get('pairedClients') || '[]');
    } catch {
        return [];
    }
}

function writeClients(storage, clients) {
    storage.set('pairedClients', JSON.stringify(clients));
}

function syncAuthError(message, code, extra = {}) {
    return Object.assign(new Error(message), {
        code,
        ...extra
    });
}

export async function hashSecretForTest(secret) {
    return sha256(secret);
}

export function createSyncAuthService({ storage, getOwnerUser = () => null }) {
    return {
        async ensureRemoteToken() {
            if (storage.get('remoteTokenHash')) {
                return { created: false, token: '' };
            }

            const token = randomToken('vrcx_rt');
            storage.set('remoteTokenHash', await sha256(token));
            return { created: true, token };
        },

        async rotateRemoteToken() {
            const token = randomToken('vrcx_rt');
            storage.set('remoteTokenHash', await sha256(token));
            writeClients(storage, []);
            return { token };
        },

        async pairClient({ token, localUserId, localDisplayName }) {
            const tokenHash = storage.get('remoteTokenHash');
            if (!tokenHash || (await sha256(token)) !== tokenHash) {
                throw syncAuthError('Invalid remote token', 'invalid_token');
            }

            const owner = getOwnerUser();
            if (!owner?.id) {
                throw syncAuthError(
                    'Remote is not logged in',
                    'remote_not_logged_in'
                );
            }

            if (owner.id !== localUserId) {
                throw syncAuthError(
                    'Remote account mismatch',
                    'user_mismatch',
                    {
                        remoteUserId: owner.id,
                        remoteDisplayName: owner.displayName || '',
                        localUserId,
                        localDisplayName: localDisplayName || ''
                    }
                );
            }

            const clientId = randomToken('rsc');
            const clientSecret = randomToken('vrcx_cs');
            const clients = readClients(storage);
            clients.push({
                clientId,
                clientSecretHash: await sha256(clientSecret),
                localDisplayName: localDisplayName || '',
                pairedAt: new Date().toJSON()
            });
            writeClients(storage, clients);

            return {
                remoteUserId: owner.id,
                remoteDisplayName: owner.displayName || '',
                clientId,
                clientSecret
            };
        },

        async validateClient({ clientId, clientSecret }) {
            const client = readClients(storage).find(
                (item) => item.clientId === clientId
            );
            if (!client) {
                return false;
            }

            return (await sha256(clientSecret)) === client.clientSecretHash;
        }
    };
}
