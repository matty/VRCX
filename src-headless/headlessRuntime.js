import { database } from '../src/services/database/index.js';
import { exportDeltaBatch } from '../src/services/remoteSync/exporter.js';
import { createSyncAuthService } from './syncAuth.js';
import { createSyncServer } from './syncServer.js';

function storageAdapter(VRCXStorage) {
    return {
        get(key) {
            return VRCXStorage.Get(`RemoteSync_${key}`);
        },
        set(key, value) {
            VRCXStorage.Set(`RemoteSync_${key}`, value);
            VRCXStorage.Save();
        }
    };
}

function userPrefixFromUserId(userId) {
    let prefix = userId.replaceAll('-', '').replaceAll('_', '');
    if (/^\d/.test(prefix)) {
        prefix = `_${prefix}`;
    }

    return prefix;
}

export async function startHeadlessRuntime({
    args,
    dotnet,
    ownerUser,
    loginIfNeeded,
    log = console.log
}) {
    dotnet.VRCXStorage.Load();
    dotnet.SQLite.Init();
    dotnet.WebApi.Init();

    const currentUser = await loginIfNeeded({ forceLogin: args.login });
    ownerUser.current = currentUser;
    await database.initTables();
    await database.initUserTables(currentUser.id);

    const storage = storageAdapter(dotnet.VRCXStorage);
    const syncAuth = createSyncAuthService({
        storage,
        getOwnerUser: () => ownerUser.current
    });

    if (args.newRemoteToken) {
        const { token } = await syncAuth.rotateRemoteToken();
        log('Remote sync token rotated.');
        log('Use this token once from desktop VRCX to pair:');
        log(token);
    } else {
        const { created, token } = await syncAuth.ensureRemoteToken();
        if (created) {
            log('Remote sync token created.');
            log('Use this token once from desktop VRCX to pair:');
            log(token);
        }
    }

    const server = createSyncServer({
        syncAuth,
        getStatus: () => ({
            loggedIn: Boolean(ownerUser.current?.id),
            ownerUserId: ownerUser.current?.id || ''
        }),
        exportDeltaBatch,
        getUserPrefix: () => userPrefixFromUserId(ownerUser.current.id)
    });

    await new Promise((resolve) =>
        server.listen(args.syncPort, args.listenHost, resolve)
    );
    log(
        `VRCX headless sync server listening on ${args.listenHost}:${args.syncPort}`
    );

    return { server };
}

export { storageAdapter, userPrefixFromUserId };
