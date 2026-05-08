import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';

import RemoteSyncTab from '../RemoteSyncTab.vue';

vi.mock('../../../../../stores/remoteSync.js', () => ({
    useRemoteSyncStore: () => ({
        remote: null,
        loading: false,
        lastError: '',
        lastResult: null,
        pair: vi.fn(),
        syncNow: vi.fn(),
        forgetRemote: vi.fn()
    })
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({ t: (key) => key })
}));

describe('RemoteSyncTab', () => {
    test('renders pairing fields', () => {
        const wrapper = mount(RemoteSyncTab);

        expect(wrapper.text()).toContain('view.settings.remote_sync.title');
        expect(wrapper.find('input[name="remoteUrl"]').exists()).toBe(true);
        expect(wrapper.find('input[name="remoteToken"]').exists()).toBe(true);
    });
});
