# Headless Remote Sync Automated Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully automate confidence checks for headless remote sync pairing, token rotation, delta pull, idempotent import, mutable cache updates, and same-account enforcement without using live VRChat credentials.

**Architecture:** Add deterministic integration tests around the existing sync modules rather than live network/VRChat tests. Use fake in-memory storage, fake WebApi adapters, real local HTTP servers on ephemeral ports, and a SQLite test harness where possible. Keep tests feature-scoped so they can run in CI even while unrelated full-suite repo tests remain unstable.

**Tech Stack:** Vitest, Node HTTP/fetch, VRCX remote sync modules, fake WebApi adapters, SQLite service test harness or SQLite mock fallback.

---

## File Structure

Create:

- `src-headless/__tests__/headlessTokenLifecycle.test.js` - token creation, no reprint, rotation invalidation, old token rejection.
- `src-headless/__tests__/syncServer.integration.test.js` - real local HTTP server plus real desktop client against fake auth/exporter.
- `src/services/remoteSync/__tests__/importer.idempotency.test.js` - full no-duplicate importer scenarios using a SQLite-like harness.
- `src/services/remoteSync/__tests__/remoteSyncEndToEnd.test.js` - desktop client/store/importer flow against local sync server.
- `src-headless/__tests__/headlessLogin.fakeWebApi.test.js` - fake WebApi login/2FA request sequencing.

Modify:

- `package.json` - add a feature-scoped test script for remote sync automation.

Do not automate:

- Real VRChat login with real 2FA.
- Live VRChat API calls.
- Real user credentials.

## Task 1: Token Lifecycle Automation

**Files:**

- Create: `src-headless/__tests__/headlessTokenLifecycle.test.js`
- Uses existing: `src-headless/syncAuth.js`

- [ ] **Step 1: Write failing token lifecycle tests**

```js
import { beforeEach, describe, expect, test } from 'vitest';

import { createSyncAuthService } from '../syncAuth.js';

describe('headless remote token lifecycle', () => {
    let storage;

    beforeEach(() => {
        storage = new Map();
    });

    test('rotating remote token invalidates old token and paired clients', async () => {
        const service = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_owner',
                displayName: 'Owner'
            })
        });

        const first = await service.ensureRemoteToken();
        const paired = await service.pairClient({
            token: first.token,
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        await expect(
            service.validateClient({
                clientId: paired.clientId,
                clientSecret: paired.clientSecret
            })
        ).resolves.toBe(true);

        const rotated = await service.rotateRemoteToken();

        await expect(
            service.pairClient({
                token: first.token,
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        ).rejects.toMatchObject({
            code: 'invalid_token'
        });
        await expect(
            service.validateClient({
                clientId: paired.clientId,
                clientSecret: paired.clientSecret
            })
        ).resolves.toBe(false);
        await expect(
            service.pairClient({
                token: rotated.token,
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        ).resolves.toMatchObject({
            remoteUserId: 'usr_owner'
        });
    });
});
```

- [ ] **Step 2: Run test and verify it fails if behavior is missing**

Run:

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm test -- src-headless/__tests__/headlessTokenLifecycle.test.js
```

Expected: pass if current token lifecycle is already correct; otherwise fail on old token/client invalidation.

- [ ] **Step 3: Fix only `src-headless/syncAuth.js` if the test fails**

Required behavior:

- `rotateRemoteToken()` stores a new remote token hash.
- `rotateRemoteToken()` writes `pairedClients` as `[]`.
- `pairClient()` rejects the old token with `code: 'invalid_token'`.
- `validateClient()` returns `false` for clients paired before rotation.

- [ ] **Step 4: Commit**

```bash
git add src-headless/__tests__/headlessTokenLifecycle.test.js src-headless/syncAuth.js
git commit -m "test: cover headless token rotation lifecycle"
```

## Task 2: Local HTTP Pairing and Delta Integration

**Files:**

- Create: `src-headless/__tests__/syncServer.integration.test.js`
- Uses existing: `src-headless/syncServer.js`, `src-headless/syncAuth.js`, `src/services/remoteSync/client.js`

- [ ] **Step 1: Write failing local HTTP integration tests**

```js
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRemoteSyncClient } from '../../src/services/remoteSync/client.js';
import { createSyncAuthService } from '../syncAuth.js';
import { createSyncServer } from '../syncServer.js';

let server;

afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
});

describe('headless sync server over local HTTP', () => {
    let storage;
    let syncAuth;
    let client;

    beforeEach(() => {
        storage = new Map();
        syncAuth = createSyncAuthService({
            storage,
            getOwnerUser: () => ({
                id: 'usr_owner',
                displayName: 'Owner'
            })
        });
        client = createRemoteSyncClient({
            execute: async ({ url, method, headers, body }) => {
                const response = await fetch(url, { method, headers, body });
                return {
                    status: response.status,
                    data: await response.text()
                };
            }
        });
    });

    test('pairs same account and rejects mismatched account over HTTP', async () => {
        server = createSyncServer({
            syncAuth,
            getStatus: () => ({ loggedIn: true, ownerUserId: 'usr_owner' }),
            exportDeltaBatch: vi.fn(),
            getUserPrefix: () => 'usrowner'
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const remoteUrl = `http://127.0.0.1:${server.address().port}`;
        const { token } = await syncAuth.ensureRemoteToken();

        await expect(
            client.pair({
                remoteUrl,
                token,
                localUserId: 'usr_other',
                localDisplayName: 'Other'
            })
        ).rejects.toMatchObject({
            code: 'user_mismatch'
        });

        await expect(
            client.pair({
                remoteUrl,
                token,
                localUserId: 'usr_owner',
                localDisplayName: 'Owner'
            })
        ).resolves.toMatchObject({
            remoteUserId: 'usr_owner',
            clientId: expect.stringMatching(/^rsc_/),
            clientSecret: expect.stringMatching(/^vrcx_cs_/)
        });
    });

    test('requires paired client bearer credentials for delta', async () => {
        const exportDeltaBatch = vi.fn(async () => ({
            schemaVersion: 1,
            tables: {}
        }));
        server = createSyncServer({
            syncAuth,
            getStatus: () => ({ loggedIn: true, ownerUserId: 'usr_owner' }),
            exportDeltaBatch,
            getUserPrefix: () => 'usrowner'
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const remoteUrl = `http://127.0.0.1:${server.address().port}`;
        const { token } = await syncAuth.ensureRemoteToken();
        const paired = await client.pair({
            remoteUrl,
            token,
            localUserId: 'usr_owner',
            localDisplayName: 'Owner'
        });

        await expect(
            client.delta({
                remoteUrl,
                clientId: paired.clientId,
                clientSecret: 'wrong',
                sinceByTable: {},
                limit: 500
            })
        ).rejects.toMatchObject({
            code: 'unauthorized'
        });

        await expect(
            client.delta({
                remoteUrl,
                clientId: paired.clientId,
                clientSecret: paired.clientSecret,
                sinceByTable: { feed_online_offline: '2026-05-07T12:00:00.000Z' },
                limit: 123
            })
        ).resolves.toMatchObject({
            schemaVersion: 1
        });
        expect(exportDeltaBatch).toHaveBeenCalledWith({
            userPrefix: 'usrowner',
            sinceByTable: { feed_online_offline: '2026-05-07T12:00:00.000Z' },
            limit: 123
        });
    });
});
```

- [ ] **Step 2: Run test and verify it passes or exposes protocol gaps**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm test -- src-headless/__tests__/syncServer.integration.test.js
```

Expected: pass when client/server protocol is compatible.

- [ ] **Step 3: Fix only client/server protocol if needed**

Allowed files:

- `src-headless/syncServer.js`
- `src/services/remoteSync/client.js`

- [ ] **Step 4: Commit**

```bash
git add src-headless/__tests__/syncServer.integration.test.js src-headless/syncServer.js src/services/remoteSync/client.js
git commit -m "test: cover remote sync HTTP pairing and delta"
```

## Task 3: SQLite-Backed Idempotency Harness

**Files:**

- Create: `src/services/remoteSync/__tests__/importer.idempotency.test.js`
- Prefer real SQLite if the repo exposes a practical test adapter.
- If real SQLite is not practical, use the existing sqlite mock but make it stateful enough to enforce table row counts and provenance uniqueness.

- [ ] **Step 1: Write stateful idempotency tests**

The test must prove these cases:

- Same feed row imported twice results in one local feed row and one provenance row.
- Same cache row imported twice with same hash results in one cache row and one provenance row.
- Same cache ID with newer `updated_at` and different `source_row_hash` updates the cache row and creates a second provenance version.

Required test names:

```js
test('does not duplicate immutable feed rows across repeated imports', async () => {});
test('does not re-import identical cache versions', async () => {});
test('imports newer cache version without duplicating local cache row', async () => {});
```

Implementation guidance:

- Reuse `importDeltaBatch()` from `src/services/remoteSync/importer.js`.
- Build batches with `schemaVersion: 1`.
- Assert local row counts and `remote_sync_items` counts after each import.
- Assert `remote_sync_batches` contains success rows.

- [ ] **Step 2: Run test and verify failure before harness/importer support**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm test -- src/services/remoteSync/__tests__/importer.idempotency.test.js
```

Expected: fail if the harness is not implemented yet, or pass if existing importer behavior already satisfies the stateful assertions.

- [ ] **Step 3: Implement minimal test harness**

If using a mock, implement these state maps inside the test mock:

```js
const tables = {
    usrowner_feed_online_offline: [],
    cache_world: new Map(),
    remote_sync_items: new Map(),
    remote_sync_batches: new Map()
};
```

The mock must:

- Insert immutable feed rows only when no existing row has the same projected key.
- Upsert `cache_world` by `id`.
- Track provenance by `remote_id|source_table|source_row_key`.
- Track batch state by `batch_id`.

- [ ] **Step 4: Run idempotency tests**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm test -- src/services/remoteSync/__tests__/importer.idempotency.test.js src/services/remoteSync/__tests__/importer.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/remoteSync/__tests__/importer.idempotency.test.js src/services/remoteSync/importer.js src/services/remoteSync/provenance.js
git commit -m "test: cover remote sync import idempotency"
```

## Task 4: Store-to-Server End-to-End Test

**Files:**

- Create: `src/services/remoteSync/__tests__/remoteSyncEndToEnd.test.js`
- Uses existing: desktop client, local sync server, sync auth, importer/store mocks.

- [ ] **Step 1: Write end-to-end desktop pull test**

```js
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { createSyncAuthService } from '../../../src-headless/syncAuth.js';
import { createSyncServer } from '../../../src-headless/syncServer.js';

const configRepository = vi.hoisted(() => ({
    getObject: vi.fn(async () => null),
    setObject: vi.fn(),
    remove: vi.fn()
}));
const importDeltaBatch = vi.hoisted(() => vi.fn());

vi.mock('../importer.js', () => ({ importDeltaBatch }));
vi.mock('../../config.js', () => ({ default: configRepository }));
vi.mock('../../database/index.js', () => ({
    dbVars: { userPrefix: 'usrowner' }
}));
vi.mock('../../../stores/user.js', () => ({
    useUserStore: () => ({
        currentUser: { id: 'usr_owner', displayName: 'Owner' }
    })
}));

import { useRemoteSyncStore } from '../../../stores/remoteSync.js';

let server;

afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
});

describe('desktop sync from headless remote end-to-end', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    test('pairs and syncs a remote batch through local HTTP server', async () => {
        const syncAuth = createSyncAuthService({
            storage: new Map(),
            getOwnerUser: () => ({ id: 'usr_owner', displayName: 'Owner' })
        });
        const batch = {
            schemaVersion: 1,
            tables: {
                feed_online_offline: {
                    rows: [
                        {
                            id: 1,
                            created_at: '2026-05-08T10:00:00.000Z',
                            user_id: 'usr_friend',
                            display_name: 'Friend',
                            type: 'Online',
                            location: 'wrld_1:123',
                            world_name: 'World',
                            time: '10:00',
                            group_name: '',
                            source_row_key:
                                '["2026-05-08T10:00:00.000Z","usr_friend","Online","wrld_1:123","World"]',
                            source_row_hash: 'hash-online'
                        }
                    ]
                }
            }
        };
        server = createSyncServer({
            syncAuth,
            getStatus: () => ({ loggedIn: true, ownerUserId: 'usr_owner' }),
            exportDeltaBatch: vi.fn(async () => batch),
            getUserPrefix: () => 'usrowner'
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const remoteUrl = `http://127.0.0.1:${server.address().port}`;
        const { token } = await syncAuth.ensureRemoteToken();
        importDeltaBatch.mockResolvedValue({
            batchId: 'rsb_test',
            rowsReceived: 1,
            rowsImported: 1,
            rowsSkipped: 0
        });

        const store = useRemoteSyncStore();
        await store.pair({ remoteUrl, token });
        await store.syncNow();

        expect(importDeltaBatch).toHaveBeenCalledWith(
            expect.objectContaining({
                remoteOwnerUserId: 'usr_owner',
                userPrefix: 'usrowner',
                batch
            })
        );
        expect(store.lastResult).toMatchObject({
            rowsImported: 1
        });
    });
});
```

- [ ] **Step 2: Run test**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm test -- src/services/remoteSync/__tests__/remoteSyncEndToEnd.test.js
```

Expected: pass when client, server, auth, and store wiring are compatible.

- [ ] **Step 3: Commit**

```bash
git add src/services/remoteSync/__tests__/remoteSyncEndToEnd.test.js
git commit -m "test: cover desktop sync from headless remote"
```

## Task 5: Fake WebApi Headless Login Automation

**Files:**

- Create: `src-headless/__tests__/headlessLogin.fakeWebApi.test.js`
- Uses existing: `src-headless/headlessLogin.js`, `src-headless/consoleLogin.js`

- [ ] **Step 1: Write fake WebApi login tests**

Required cases:

- Existing cookie/session returns current user without prompting.
- Forced login sends Basic auth and returns current user.
- TOTP challenge posts to `auth/twofactorauth/totp/verify`.
- Email OTP challenge posts to `auth/twofactorauth/emailotp/verify`.
- Failed API response throws.

- [ ] **Step 2: Use a fake `WebApi.ExecuteJson` adapter**

The fake adapter must record parsed request payloads:

```js
function createFakeWebApi(responses) {
    const requests = [];
    return {
        requests,
        ExecuteJson: async (payload) => {
            requests.push(JSON.parse(payload));
            return JSON.stringify(responses.shift());
        }
    };
}
```

- [ ] **Step 3: Run test**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm test -- src-headless/__tests__/headlessLogin.fakeWebApi.test.js
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src-headless/__tests__/headlessLogin.fakeWebApi.test.js src-headless/headlessLogin.js
git commit -m "test: cover headless login with fake WebApi"
```

## Task 6: CI-Friendly Test Script

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add script**

Add:

```json
"test:remote-sync": "vitest run src/services/remoteSync src-headless src/stores/__tests__/remoteSync.test.js src/views/Settings/components/Tabs/__tests__/RemoteSyncTab.test.js"
```

- [ ] **Step 2: Run script**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm run test:remote-sync
```

Expected: all remote-sync automated tests pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: add remote sync test script"
```

## Task 7: Final Verification

- [ ] **Step 1: Run feature tests**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm run test:remote-sync
```

Expected: pass.

- [ ] **Step 2: Run feature lint and format**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npx oxfmt --check src/services/remoteSync src-headless src/stores/remoteSync.js src/stores/__tests__/remoteSync.test.js src/views/Settings/components/Tabs/RemoteSyncTab.vue src/views/Settings/components/Tabs/__tests__/RemoteSyncTab.test.js
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npx eslint src/services/remoteSync src-headless src/stores/remoteSync.js src/views/Settings/components/Tabs/RemoteSyncTab.vue
```

Expected: pass.

- [ ] **Step 3: Run headless build**

```bash
PATH=/tmp/vrcx-node/node-v24.10.0-linux-x64/bin:$PATH npm run build-headless
```

Expected: pass.

- [ ] **Step 4: Document what remains manual**

Manual-only validation remains:

- Real VRChat username/password prompt.
- Real 2FA delivery and entry.
- Live VRChat API session behavior.
- Actual long-running server collection over hours/days.

Everything else in pairing, token lifecycle, user mismatch, delta sync, duplicate prevention, and cache update behavior should be automated.
