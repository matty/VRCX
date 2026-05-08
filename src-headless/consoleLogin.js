import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

async function hiddenQuestion(rl, prompt) {
    const originalWrite = output.write;
    output.write = function maskedWrite(chunk, encoding, callback) {
        if (typeof chunk === 'string' && chunk.includes(prompt)) {
            return originalWrite.call(this, chunk, encoding, callback);
        }

        return originalWrite.call(this, '*', encoding, callback);
    };

    try {
        return await rl.question(prompt);
    } finally {
        output.write = originalWrite;
        output.write('\n');
    }
}

export async function promptForCredentials() {
    const rl = readline.createInterface({ input, output });
    try {
        const username = await rl.question('VRChat username/email: ');
        const password = await hiddenQuestion(rl, 'VRChat password: ');
        return { username, password };
    } finally {
        rl.close();
    }
}

export async function promptForTwoFactorCode(method = '2FA') {
    const rl = readline.createInterface({ input, output });
    try {
        return await rl.question(`${method} code: `);
    } finally {
        rl.close();
    }
}
