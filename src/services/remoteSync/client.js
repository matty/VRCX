import webApiService from '../webapi.js';

function joinUrl(remoteUrl, path) {
    return `${remoteUrl.replace(/\/+$/, '')}${path}`;
}

function parseResponse(response) {
    const data = response.data ? JSON.parse(response.data) : {};
    if (response.status >= 200 && response.status < 300) {
        return data;
    }

    const error = new Error(data.code || `Remote sync HTTP ${response.status}`);
    Object.assign(error, data);
    throw error;
}

export function createRemoteSyncClient({
    execute = webApiService.execute
} = {}) {
    return {
        async status({ remoteUrl }) {
            return parseResponse(
                await execute({
                    url: joinUrl(remoteUrl, '/sync/status'),
                    method: 'GET'
                })
            );
        },

        async pair({ remoteUrl, token, localUserId, localDisplayName = '' }) {
            return parseResponse(
                await execute({
                    url: joinUrl(remoteUrl, '/sync/pair'),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8'
                    },
                    body: JSON.stringify({
                        token,
                        localUserId,
                        localDisplayName
                    })
                })
            );
        },

        async delta({
            remoteUrl,
            clientId,
            clientSecret,
            sinceByTable,
            limit
        }) {
            return parseResponse(
                await execute({
                    url: joinUrl(remoteUrl, '/sync/delta'),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8',
                        Authorization: `Bearer ${clientId}:${clientSecret}`
                    },
                    body: JSON.stringify({
                        sinceByTable,
                        limit
                    })
                })
            );
        }
    };
}

export const remoteSyncClient = createRemoteSyncClient();
