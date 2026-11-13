# HashiCorp Vault for the local-prod stack (portal v2: the secrets a person pastes into the portal). One server, file
# storage on the named volume `vault-data`, plain http on the internal Vault networks only (no published port).
# LOCAL PROD ONLY: no TLS, a single unseal key share kept on the owner's disk (secrets/vault/), unsealed by the
# container itself. Production is AWS Secrets Manager behind the same SecretStorePort.
storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr      = "http://vault:8200"
# the container runs as the factory uid with no capabilities: no mlock (the host's swap is the owner's to manage)
disable_mlock = true
ui            = false
log_level     = "warn"
