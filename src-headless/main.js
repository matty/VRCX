import { parseHeadlessArgs } from './cliArgs.js';
import { startHeadlessRuntime } from './headlessRuntime.js';

export { parseHeadlessArgs, startHeadlessRuntime };

async function startFromGlobals() {
    const args = parseHeadlessArgs(process.argv.slice(2));

    await startHeadlessRuntime({
        args,
        dotnet: globalThis.VRCXDotNet,
        ownerUser: globalThis.VRCXHeadlessOwnerUser,
        loginIfNeeded: globalThis.VRCXHeadlessLogin
    });
}

if (globalThis.VRCXDotNet) {
    startFromGlobals().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
