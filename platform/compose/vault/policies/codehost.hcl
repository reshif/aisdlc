# The codehost reads the secrets of its own folder (the factory App's and the issues App's keys) and nothing else.
path "aisdlc/data/codehost/*" {
  capabilities = ["read"]
}
