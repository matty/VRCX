import http from 'node:http';

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }

    if (chunks.length === 0) {
        return {};
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
    });
    res.end(data);
}

function bearer(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) {
        return null;
    }

    const [clientId, clientSecret] = match[1].split(':');
    return { clientId, clientSecret };
}

export function createSyncServer({
    syncAuth,
    getStatus,
    exportDeltaBatch,
    getUserPrefix
}) {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');

            if (req.method === 'GET' && url.pathname === '/sync/status') {
                sendJson(res, 200, getStatus());
                return;
            }

            if (req.method === 'POST' && url.pathname === '/sync/pair') {
                const body = await readJson(req);
                try {
                    const result = await syncAuth.pairClient({
                        token: body.token,
                        localUserId: body.localUserId,
                        localDisplayName: body.localDisplayName || ''
                    });
                    sendJson(res, 200, result);
                } catch (error) {
                    if (error.code === 'user_mismatch') {
                        sendJson(res, 409, {
                            code: error.code,
                            remoteUserId: error.remoteUserId,
                            remoteDisplayName: error.remoteDisplayName || '',
                            localUserId: error.localUserId,
                            localDisplayName: error.localDisplayName || ''
                        });
                        return;
                    }

                    sendJson(res, 401, {
                        code: error.code || 'unauthorized'
                    });
                }
                return;
            }

            const auth = bearer(req);
            if (
                !auth ||
                !(await syncAuth.validateClient({
                    clientId: auth.clientId,
                    clientSecret: auth.clientSecret
                }))
            ) {
                sendJson(res, 401, { code: 'unauthorized' });
                return;
            }

            if (req.method === 'POST' && url.pathname === '/sync/delta') {
                const body = await readJson(req);
                const batch = await exportDeltaBatch({
                    userPrefix: getUserPrefix(),
                    sinceByTable: body.sinceByTable || {},
                    limit: body.limit || 500
                });
                sendJson(res, 200, batch);
                return;
            }

            sendJson(res, 404, { code: 'not_found' });
        } catch (error) {
            sendJson(res, 500, {
                code: 'server_error',
                message: error.message || String(error)
            });
        }
    });
}
