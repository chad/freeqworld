# How this is actually deployed

Read this before touching production. The topology has one genuine trap
(the auth broker) that has already burned us once.

## The pieces

```
freeqworld.boxd.sh          boxd VM "freeqworld" — static client + demo towns + NPC agents
irc.freeq.at                Hetzner box (87.99.152.98) — freeq-server in Docker + nginx
auth.freeq.at               SAME Hetzner box — freeq-auth-broker in Docker  ⚠ see below
```

## freeqworld.boxd.sh (this repo)

A boxd VM named `freeqworld` (auto-suspend disabled — the agents hold live
IRC connections). Two systemd services, both `Restart=always`:

- **`freeqworld.service`** — `FIMP_START=1 npx vite-node server/src/main.ts`
  in `/home/boxd/freeqworld`, port 8787 behind the boxd proxy. Serves the
  built client (`client/dist`) and the two local demo towns.
- **`freeqworld-agents.service`** — `node scripts/world-agents.mjs`. NPC
  identity seeds and the persistent quest ledger live in `.agents/`
  (gitignored — copy seeds if you rebuild the VM, or the agents get new
  faces). Service logs append to `/tmp/agents-svc.log` (no persistent
  journald on the VM). Note: node lives at `/usr/local/bin/node` on this VM,
  and the unit files reference that path explicitly.

**To deploy client or agent changes:**

```sh
boxd exec freeqworld -- 'cd freeqworld && git pull && npx vite build client'
# client changes: done (served per-request from client/dist)
# agent/server changes additionally need:
boxd exec freeqworld -- 'sudo systemctl restart freeqworld-agents'   # or freeqworld
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
  `freeqworld.boxd.sh` was added 2026-07-21 (freeq commit `68324e9`).
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
