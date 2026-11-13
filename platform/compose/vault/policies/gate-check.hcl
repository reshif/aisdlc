# gate-check reads the secrets of its own folder (its own App's key) and nothing else.
path "aisdlc/data/gate-check/*" {
  capabilities = ["read"]
}
