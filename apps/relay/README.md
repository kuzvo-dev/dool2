# @dool2/relay

The Dool2 **relay**. It connects the phone and the PC even when they are on different networks, but it **only carries ciphertext envelopes**. It cannot see the contents ([ADR 0012](../../docs/decisions/0012-phone-link.md)).

```bash
pnpm build
pnpm --filter @dool2/relay start      # http://127.0.0.1:8787 (phone app: /app/)
```

| Environment variable | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `PORT`, `HOST`       | Default `8787`, `127.0.0.1`                                   |
| `DOOL2_PHONE_APP`    | Folder of the phone app (PWA) files (default: `apps/phone/dist`) |

## What it does

- On connect, the device first proves it is "this device" with an **Ed25519 signature**. The device id is the hash of the signing public key, so nobody can use someone else's id.
- An envelope's `from` must be the proven device. Otherwise the connection is closed.
- Each PC room connects one PC and several phones. A phone can only send to the PC in its own room.
- If the receiving side is off, envelopes are held **for up to 7 days, up to 500**, and delivered when it comes on. A single message can be up to 512 KB.
- It does not know which phones are paired. The PC decides that and discards the rest.
- Each connection can send at most 30 messages per second.

## What it can and cannot know

| What the relay knows                                            | What it does not know                                   |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| Device id, message size, time, envelope kind (`ask`, `reply`, and so on) | Request content, answers, approval content, screens |

## Official server (Cloudflare)

The official relay runs on **Cloudflare Workers + Durable Objects** (`src/worker.ts`). It uses `src/core.ts`, the same rules as the Node version.

- One Durable Object per PC room (PC id). The connection address is `wss://relay.dool2.com/link?room=<PC id>`.
- With WebSocket Hibernation, it sleeps when there are no messages (no charge).
- Envelopes for an offline device are kept in that room's SQLite **as ciphertext** for up to 7 days. They survive a server restart.
- It does not serve the phone app. The phone app is distributed only as a store app (so a server cannot swap the app code).

```bash
pnpm --filter @dool2/relay dev:cf                     # run in a Cloudflare environment on your computer
node apps/relay/scripts/smoke.mjs http://127.0.0.1:8787 # check delivery, queueing, and signatures
pnpm --filter @dool2/relay deploy                     # deploy (needs wrangler login)
node apps/relay/scripts/smoke.mjs https://relay.dool2.com
```

## Running it yourself (Node)

`src/main.ts` is for self-hosting and development. It uses the same protocol, so you only change the address in the desktop app settings. Queued envelopes are only in memory, so they are lost when the server restarts.
