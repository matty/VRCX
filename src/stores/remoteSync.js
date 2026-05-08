import { defineStore } from 'pinia';
import { ref } from 'vue';

import configRepository from '../services/config.js';
import { dbVars } from '../services/database/index.js';
import { remoteSyncClient } from '../services/remoteSync/client.js';
import { importDeltaBatch } from '../services/remoteSync/importer.js';
import { useUserStore } from './user.js';

const CONFIG_KEY = 'VRCX_remoteSyncSource';

export const useRemoteSyncStore = defineStore('RemoteSync', () => {
    const remote = ref(null);
    const loading = ref(false);
    const lastError = ref('');
    const lastResult = ref(null);

    async function load() {
        const savedRemote = await configRepository.getObject(CONFIG_KEY, null);
        if (remote.value === null) {
            remote.value = savedRemote;
        }
    }

    async function saveRemote(value) {
        remote.value = value;
        await configRepository.setObject(CONFIG_KEY, value);
    }

    async function pair({ remoteUrl, token }) {
        const userStore = useUserStore();
        if (!userStore.currentUser?.id) {
            throw new Error('Remote sync requires a logged-in desktop user.');
        }

        loading.value = true;
        lastError.value = '';
        try {
            const result = await remoteSyncClient.pair({
                remoteUrl,
                token,
                localUserId: userStore.currentUser.id,
                localDisplayName: userStore.currentUser.displayName || ''
            });
            await saveRemote({
                remoteUrl,
                remoteUserId: result.remoteUserId,
                remoteDisplayName: result.remoteDisplayName || '',
                clientId: result.clientId,
                clientSecret: result.clientSecret,
                pairedAt: new Date().toJSON(),
                lastSyncAt: ''
            });
            return result;
        } catch (error) {
            lastError.value = error.code || error.message || String(error);
            throw error;
        } finally {
            loading.value = false;
        }
    }

    async function syncNow() {
        if (!remote.value) {
            throw new Error('No remote sync source is paired.');
        }

        loading.value = true;
        lastError.value = '';
        try {
            const batch = await remoteSyncClient.delta({
                remoteUrl: remote.value.remoteUrl,
                clientId: remote.value.clientId,
                clientSecret: remote.value.clientSecret,
                sinceByTable: {},
                limit: 500
            });
            const result = await importDeltaBatch({
                remoteId: remote.value.clientId,
                remoteOwnerUserId: remote.value.remoteUserId,
                userPrefix: dbVars.userPrefix,
                batch
            });
            lastResult.value = result;
            await saveRemote({
                ...remote.value,
                lastSyncAt: new Date().toJSON()
            });
            return result;
        } catch (error) {
            lastError.value = error.code || error.message || String(error);
            throw error;
        } finally {
            loading.value = false;
        }
    }

    async function forgetRemote() {
        remote.value = null;
        await configRepository.remove(CONFIG_KEY);
    }

    load();

    return {
        remote,
        loading,
        lastError,
        lastResult,
        load,
        pair,
        syncNow,
        forgetRemote
    };
});
