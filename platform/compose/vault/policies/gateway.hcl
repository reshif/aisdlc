# The gateway reads the secrets of its own folder (the model providers' API keys) and nothing else.
path "aisdlc/data/gateway/*" {
  capabilities = ["read"]
}
