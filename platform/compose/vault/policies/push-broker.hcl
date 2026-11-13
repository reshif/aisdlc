# The Push Broker reads the secrets of its own folder (its App key) and nothing else.
path "aisdlc/data/push-broker/*" {
  capabilities = ["read"]
}
