export function parseHeadlessArgs(argv) {
    const args = {
        configDir: '',
        listenHost: '127.0.0.1',
        syncPort: 14590,
        login: false,
        newRemoteToken: false
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--config-dir') {
            args.configDir = argv[++index] || '';
        } else if (arg === '--sync-host') {
            args.listenHost = argv[++index] || args.listenHost;
        } else if (arg === '--sync-port') {
            args.syncPort = Number.parseInt(argv[++index], 10);
        } else if (arg === '--login') {
            args.login = true;
        } else if (arg === '--new-remote-token') {
            args.newRemoteToken = true;
        }
    }

    if (!Number.isInteger(args.syncPort) || args.syncPort <= 0) {
        throw new Error('--sync-port must be a positive integer');
    }

    return args;
}
