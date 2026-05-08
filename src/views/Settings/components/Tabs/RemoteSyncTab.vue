<template>
    <div class="flex flex-col gap-10 py-2">
        <SettingsGroup :title="t('view.settings.remote_sync.title')">
            <SettingsItem :label="t('view.settings.remote_sync.remote_url')">
                <Input
                    v-model="remoteUrl"
                    name="remoteUrl"
                    :disabled="store.loading || Boolean(store.remote)"
                    class="w-80" />
            </SettingsItem>
            <SettingsItem v-if="!store.remote" :label="t('view.settings.remote_sync.remote_token')">
                <Input
                    v-model="remoteToken"
                    name="remoteToken"
                    type="password"
                    :disabled="store.loading"
                    class="w-80" />
            </SettingsItem>
            <div class="flex gap-2">
                <Button v-if="!store.remote" :disabled="store.loading || !remoteUrl || !remoteToken" @click="pair">
                    {{ t('view.settings.remote_sync.pair') }}
                </Button>
                <Button v-if="store.remote" :disabled="store.loading" @click="syncNow">
                    {{ t('view.settings.remote_sync.sync_now') }}
                </Button>
                <Button v-if="store.remote" variant="outline" :disabled="store.loading" @click="forgetRemote">
                    {{ t('view.settings.remote_sync.forget') }}
                </Button>
            </div>
            <p v-if="store.remote" class="text-sm text-muted-foreground">
                {{ t('view.settings.remote_sync.paired') }}
                {{ store.remote.remoteDisplayName || store.remote.remoteUserId }}
            </p>
            <p v-if="store.lastError" class="text-sm text-destructive">
                {{ store.lastError }}
            </p>
            <p v-if="store.lastResult" class="text-sm text-muted-foreground">
                {{
                    t('view.settings.remote_sync.last_result', {
                        imported: store.lastResult.rowsImported,
                        skipped: store.lastResult.rowsSkipped
                    })
                }}
            </p>
        </SettingsGroup>
    </div>
</template>

<script setup>
    import { ref, watchEffect } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Button } from '@/components/ui/button';
    import { Input } from '@/components/ui/input';
    import { useRemoteSyncStore } from '../../../../stores/remoteSync.js';
    import SettingsGroup from '../SettingsGroup.vue';
    import SettingsItem from '../SettingsItem.vue';

    const { t } = useI18n();
    const store = useRemoteSyncStore();
    const remoteUrl = ref('');
    const remoteToken = ref('');

    watchEffect(() => {
        if (store.remote?.remoteUrl) {
            remoteUrl.value = store.remote.remoteUrl;
        }
    });

    async function pair() {
        await store.pair({
            remoteUrl: remoteUrl.value,
            token: remoteToken.value
        });
        remoteToken.value = '';
    }

    async function syncNow() {
        await store.syncNow();
    }

    async function forgetRemote() {
        await store.forgetRemote();
        remoteUrl.value = '';
        remoteToken.value = '';
    }
</script>
