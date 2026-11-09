# ADR-0002: The sandbox is container-class, behind allow-list Docker proxies (AR10 allowed difference)

Status: accepted for local-prod, 2026-11-09 (PLAN M13.2). Whether repository code may run in it is NOT decided here: that is DEC-18(b), decided after the SEC-OB-3 evidence (`docs/evidence/sec-ob-3.md`).

## Context

Agents and a repository's own test commands run in a sandbox (`SandboxPort`). The cloud target buys a micro-VM provider. Local-prod has Docker. D40 says the `docker-sandbox` is not VM-class, and the runtime review (§3.4) names the one real risk of "dockers of dockers": a container that holds the raw Docker socket is root on the host, and the coding worker processes model output.

## Decision

1. **Container-class isolation is a declared local-prod difference (AR10, "local-prod stubs only the declared trust anchors").** It is acceptable because the sole operator runs it against their own testbed, and because nothing here claims VM-class isolation. A kernel or runtime escape is out of scope for any container. Until DEC-18(b) is taken, real repositories' code does not run in it (the probe stays `pending`, Light unreachable: fails closed).
2. **No container mounts `/var/run/docker.sock` except two allow-list proxies** (`services/docker-proxy`): `docker-proxy-cvw` (narrow: network-less sandboxes only) and `docker-proxy-coding` (adds the per-session internal networks and the attach of the gateway and the package mirror). The proxies allow create, start, wait, logs, inspect, kill and delete of containers that carry the sandbox label, and (coding only) create, connect, disconnect and delete of labelled internal session networks. They refuse everything else: exec, build, image pull, volumes, events, swarm, plugins, commit, attach, update. `kill`, `inspect` and `disconnect` are the only verbs beyond the list in the plan: the time limit needs a kill, the driver verifies what the daemon made, and a network cannot be removed while a peer is attached. Archive get and put are implemented and OFF by default (empty path lists): the driver ships the repo as a read-only bind and `/out` through the log stream.
3. **A create body is validated key by key against an allow-list** (exact-case names, so Go's case-insensitive decoding cannot smuggle `privileged`) and re-serialised: no Privileged, no host network, PID, IPC or UTS, no CapAdd, CapDrop exactly ALL, ReadonlyRootfs, no device, no mounts except tmpfs `/out` `/work` `/tmp` (sized) and one bind `<scratch>/<session>/repo:/repo:ro`, no Docker socket, the default seccomp profile (unconfined refused), no-new-privileges, user 10002:10002, memory (no swap), pids and cpu limits required and at most the class ceiling, a bounded json-file log (an unbounded one fills the host disk), required labels, an allow-listed image and entrypoint, and no credential-shaped environment name.
4. **Per-session network:** a class with a network gets an `--internal` bridge of its own, whose only peers are the gateway (classes with a per-Unit key) and the package mirror (classes that may install), under fixed aliases and only if the peer container carries the compose label `aisdlc.sandbox.peer`. Class K has no NIC. K-exec has the mirror only and no key.
5. **Concurrency:** one coding (`W`) session at a time, counted in the driver and, across processes, by the proxy from the daemon; at most four sandboxes in all. Everything has a memory limit.
6. **Output is untrusted:** `/out` is a size-capped tmpfs shipped as one tar through the log stream, read by a strict reader (regular files only; links skipped; names that could leave the tree refused; caps on files and bytes), scanned with the shared secret ruleset including the factory canary rule (a canary withholds `/out`).

## Consequences

- +3 small containers in the `sandbox` compose profile (about 64 MiB each).
- The allow-list must grow when the driver gains a verb; a test per verb and per refused body key keeps it honest.
- Residual risk, stated: a runtime or kernel escape from the container. The mitigation is the human gate on DEC-18(b) and, in the cloud, a micro-VM provider behind the same `SandboxPort`.
