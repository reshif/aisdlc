# gate-relay reads the secrets of its own folder (its own App's key) and nothing else.
path "aisdlc/data/gate-relay/*" {
  capabilities = ["read"]
}
