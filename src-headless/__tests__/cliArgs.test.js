import { describe, expect, test } from 'vitest';

import { parseHeadlessArgs } from '../cliArgs.js';

describe('headless cli args', () => {
    test('uses safe defaults', () => {
        expect(parseHeadlessArgs([])).toMatchObject({
            listenHost: '127.0.0.1',
            syncPort: 14590,
            login: false,
            newRemoteToken: false
        });
    });

    test('parses config, login, token rotation, and host', () => {
        expect(
            parseHeadlessArgs([
                '--config-dir',
                '/tmp/vrcx',
                '--sync-host',
                '0.0.0.0',
                '--sync-port',
                '16000',
                '--login',
                '--new-remote-token'
            ])
        ).toMatchObject({
            configDir: '/tmp/vrcx',
            listenHost: '0.0.0.0',
            syncPort: 16000,
            login: true,
            newRemoteToken: true
        });
    });
});
