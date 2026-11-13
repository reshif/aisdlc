# core is the ONE writer: the portal's write-only secret API (PUT /v1/secrets/:name, allow-listed names, PDP
# config.propose). It creates and updates values under the service folders, reads metadata (set, version, when) and
# destroys a secret's versions. It has NO read of a value: what a person pasted cannot be read back through core.
path "aisdlc/data/gateway/*" { capabilities = ["create", "update"] }
path "aisdlc/data/codehost/*" { capabilities = ["create", "update"] }
path "aisdlc/data/push-broker/*" { capabilities = ["create", "update"] }
path "aisdlc/data/gate-check/*" { capabilities = ["create", "update"] }
path "aisdlc/data/gate-relay/*" { capabilities = ["create", "update"] }
path "aisdlc/data/notifier/*" { capabilities = ["create", "update"] }
path "aisdlc/metadata/gateway/*" { capabilities = ["read", "delete"] }
path "aisdlc/metadata/codehost/*" { capabilities = ["read", "delete"] }
path "aisdlc/metadata/push-broker/*" { capabilities = ["read", "delete"] }
path "aisdlc/metadata/gate-check/*" { capabilities = ["read", "delete"] }
path "aisdlc/metadata/gate-relay/*" { capabilities = ["read", "delete"] }
path "aisdlc/metadata/notifier/*" { capabilities = ["read", "delete"] }
