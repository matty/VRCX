import { parseHeadlessArgs } from './cliArgs.js';
import { loginHeadlessIfNeeded } from './headlessLogin.js';
import { startHeadlessRuntime } from './headlessRuntime.js';

export { loginHeadlessIfNeeded, parseHeadlessArgs, startHeadlessRuntime };

async function startFromGlobals() {
    const args = parseHeadlessArgs(process.argv.slice(2));

    await startHeadlessRuntime({
        args,
        dotnet: globalThis.VRCXDotNet,
        ownerUser: globalThis.VRCXHeadlessOwnerUser,
        loginIfNeeded:
            globalThis.VRCXHeadlessLogin ||
            (({ forceLogin }) =>
                loginHeadlessIfNeeded({
                    WebApi: globalThis.VRCXDotNet.WebApi,
                    forceLogin
                }))
    });
}

if (globalThis.VRCXDotNet) {
    startFromGlobals().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
