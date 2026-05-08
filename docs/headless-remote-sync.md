# Headless Remote Sync

Headless Remote Sync runs VRCX on a server so it can collect VRChat API and WebSocket presence history while desktop VRCX is offline.

The first version syncs presence, status, location, avatar, bio, friend-history, world-cache, and avatar-cache data. It does not sync game logs, notifications, settings, credentials, memos, favorites, registry backups, or local UI state.

## Start Headless

```bash
vrcx-headless --config-dir /var/lib/vrcx-headless
```

On first login, the process prompts for VRChat credentials and 2FA if required. If no remote token exists, it prints one token that can be used once from desktop VRCX.

## Rotate Token

```bash
vrcx-headless --config-dir /var/lib/vrcx-headless --new-remote-token
```

Token rotation invalidates existing desktop pairings. Pair desktop VRCX again with the new token.

## Pair Desktop

Open Settings, Remote Sync, enter the remote URL and token, then pair. Pairing succeeds only when desktop and headless VRCX are logged into the same VRChat account.

## Sync

Click Sync from remote. Running sync repeatedly with unchanged remote data does not duplicate data.
