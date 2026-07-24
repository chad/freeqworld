# How this is actually deployed

Read this before touching production. The topology has one genuine trap
(the auth broker) that has already burned us once.

## The pieces

```
world.freeq.at              PRODUCTION world — miren app `freeqworld` on the `freeq`
                            cluster (Hetzner 87.99.152.98), fronted by an nginx vhost
world.freeq.at/id           the FreeqWorld ID / PFP microapp (served by the town server)
freeqworld.boxd.sh          301 → world.freeq.at (boxd VM, freeqworld-redirect.service).
                            The VM still runs the NPC agents — see below.
irc.freeq.at                160.202.129.155 (tech.blueyard.com) — freeq-server via systemd
auth.freeq.at               Hetzner 87.99.152.98 — freeq-auth-broker in Docker  ⚠ see below
pfp.freeq.at                SAME Hetzner box — nginx STATIC vhost of the PFP app (root base)
```

> Moved 2026-07-24: the world used to be served from `freeqworld.boxd.sh`
> directly. It now lives at **world.freeq.at**; the boxd URL is a permanent
> redirect. `irc.freeq.at` also no longer lives on the Hetzner box — it moved
> to tech.blueyard.com (160.202.129.155).

## pfp.freeq.at (the PFP microapp, vanity domain)

The FreeqWorld ID app is served two ways from ONE source (`pfp/`):

- **freeqworld.boxd.sh/id** — the town server serves `pfp/dist` (built with
  base `/id/`) at `/id`. Deploy with the client:
  `boxd exec freeqworld -- 'cd freeqworld && git pull && npx vite build pfp'`
  then restart `freeqworld` if the server route changed.
- **pfp.freeq.at** — a **static nginx vhost on the Hetzner box** (NOT boxd;
  boxd only does `*.boxd.sh`). DNS is a DNSimple A record `pfp → 87.99.152.98`
  (account 109, creds at `~/.config/dnsimple/auth.txt` locally,
  `/root/.secrets/dnsimple.ini` on the box). Files live at `/var/www/pfp`;
  vhost `/etc/nginx/sites-enabled/pfp.freeq.at` (SPA `try_files … /index.html`);
  TLS via `certbot --nginx -d pfp.freeq.at`. **Redeploy:**
  ```sh
  npx vite build pfp --base=/ --outDir=dist-root
  rsync -az --delete pfp/dist-root/ root@87.99.152.98:/var/www/pfp/
  ```
  The reveal + app-password paths are fully client-side (Bluesky APIs direct),
  so this vhost has no backend. The **one-tap** path additionally calls the auth
  broker (below).

### One-tap avatar writes (broker `/api/pfp/set-avatar`)

The PFP “continue with Bluesky” button uses OAuth via the broker, which then
writes the avatar on the user's behalf — the browser never holds a credential.
This lives in the freeq repo's `freeq-auth-broker` (a narrow sibling of
`/api/graph/*`; no scope/consent change). To change it, edit `lib.rs` and
**redeploy the broker** (see the auth.freeq.at section below — same Docker
procedure). `pfp.freeq.at` and `freeqworld.boxd.sh` are in the broker's CORS
list, `ALLOWED_ORIGINS`, and `is_valid_return_to`; landed on `main` @ `c87a348`.

## world.freeq.at — the world (miren app `freeqworld`)

A miren app on the **`freeq`** cluster. Config lives in `.miren/app.toml`:
`onbuild` builds both clients (`vite build client`, `vite build pfp`) inside the
image, then the town server runs through **vite-node** on port 8787. Town B
("Neon Wharf", 8788) is server-to-server peering only and is deliberately not
routed publicly — same as the old boxd deployment.

**Deploy:**

```sh
cd freeqworld            # this repo
miren deploy -C freeq    # ALWAYS pin the cluster
miren logs -C freeq --last 5m | grep -v '\[build\]'   # confirm "FreeqWorld up"
```

Route + TLS are already in place; you only touch these when adding a host:

```sh
miren route set world.freeq.at freeqworld -C freeq
# nginx owns :80/:443 on the box, so miren needs a vhost in front that proxies
# to the miren router on 127.0.0.1:8090 and passes WebSocket upgrades
# (the town server speaks WS at /ws and /fed):
#   /etc/nginx/sites-available/world.freeq.at   (see that file for the pattern)
# then: certbot --nginx -d world.freeq.at
```

⚠ **`vite` and `vite-node` are runtime `dependencies`, not devDependencies.**
The town server is TypeScript executed by vite-node in production. vite-node
was previously only a transitive dev dep of vitest, so a production install
dropped the runtime entirely and the app crash-looped. Do not "tidy" them back
into devDependencies.

## freeqworld.boxd.sh — redirect + NPC agents

The boxd VM named `freeqworld` (auto-suspend disabled — the agents hold live
IRC connections) no longer serves the world. It runs two `Restart=always`
systemd services:

- **`freeqworld-redirect.service`** — `/home/boxd/redirect-to-world.mjs`, a
  dependency-free node server on 8787 that 301s every path to
  `https://world.freeq.at`, keeping old links and OG cards alive.
- **`freeqworld-agents.service`** — `node scripts/world-agents.mjs`. NPC
  identity seeds and the persistent quest ledger live in `.agents/`
  (gitignored — copy seeds if you rebuild the VM, or the agents get new
  faces). Service logs append to `/tmp/agents-svc.log` (no persistent
  journald on the VM). Note: node lives at `/usr/local/bin/node` on this VM,
  and the unit files reference that path explicitly.

`freeqworld.service` (the old town server) is **stopped and disabled**. The
agents are plain IRC clients pointed at `wss://irc.freeq.at/irc` — they have no
dependency on the town server, which is why they can keep running here while
the world is served from miren.

**To deploy agent changes:**

```sh
boxd exec freeqworld -- 'cd freeqworld && git pull'
boxd exec freeqworld -- 'sudo systemctl restart freeqworld-agents'
```

Do NOT run long-lived processes on the VM via `nohup … &` under `boxd exec`
— they die silently when the exec session is reaped. That's why the systemd
units exist.

## auth.freeq.at — ⚠ the trap

**The production auth broker is a hand-run Docker container on the Hetzner
box.** It is *not* the miren app.

There IS a miren app named `freeq-auth-broker` — it routes to
`auth-broker.local`, an internal-only route. Deploying it succeeds, reports
"traffic moved", and **changes nothing that the public sees**. We lost ~30
minutes to this on 2026-07-21. If `https://auth.freeq.at/health` doesn't
show your new `git_commit`, you deployed the decoy.

**Real broker deploy** (from the freeq repo, on the box):

```sh
ssh root@87.99.152.98
cd /root/freeq && git pull --ff-only     # box checkout often has local edits — stash first
docker tag freeq-auth-broker:new freeq-auth-broker:prev   # rollback point
docker build -f freeq-auth-broker/Dockerfile -t freeq-auth-broker:new .   # build from REPO ROOT
docker stop freeq-auth-broker && docker rm freeq-auth-broker
docker run -d --name freeq-auth-broker --restart unless-stopped \
  -p 127.0.0.1:8081:8081 -v freeq-broker-data:/data \
  --env-file /root/freeq-broker.env \
  -e GIT_HASH=$(git rev-parse --short HEAD) \
  freeq-auth-broker:new
curl -s https://auth.freeq.at/health     # confirm git_commit matches
```

Broker facts that matter to FreeqWorld:

- The OAuth origin allowlists (`ALLOWED_ORIGINS` and `is_valid_return_to`
  in `freeq-auth-broker/src/lib.rs`) are **compiled in**. Serving FreeqWorld
  from a new domain means a broker code change + redeploy, or Bluesky
  sign-in shows users a raw "Invalid return_to URL" error.
  `freeqworld.boxd.sh` was added 2026-07-21 (freeq commit `68324e9`), and
  **`world.freeq.at` on 2026-07-24 (freeq commit `77d6645`)** — three sites in
  `lib.rs`: the CORS `AllowOrigin` list, `ALLOWED_ORIGINS`, and
  `is_valid_return_to`. Verify with:
  `curl -sD- -o/dev/null -H 'Origin: https://world.freeq.at' -X OPTIONS https://auth.freeq.at/api/pfp/set-avatar | grep -i allow-origin`
- Broker sessions persist in the `freeq-broker-data` volume; container
  restarts don't log users out.
- Rollback: `docker stop freeq-auth-broker && docker rm freeq-auth-broker`
  then re-run with image `freeq-auth-broker:prev`.

## irc.freeq.at

The freeq server itself, Docker on the same Hetzner box, nginx in front
(`deploy/` in the freeq repo). FreeqWorld only talks to it as a client —
nothing here to deploy for FreeqWorld changes.

## Rules of thumb

1. **Verify at the public URL, not the deploy tool's success message.**
   `/health` endpoints report `git_commit` for exactly this reason.
2. The freeq repo (`~/src/freeq`) is actively worked by other sessions —
   branch, don't squat on main; expect the box checkout to be dirty.
3. Anything FreeqWorld needs from freeq production (allowlists, channel
   policy, agent actor-class) is a change to *that* repo and *that* box —
   plan it as a cross-repo deploy, not a fimp push.
