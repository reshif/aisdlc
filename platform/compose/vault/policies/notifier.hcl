# The notifier reads the secrets of its own folder (Slack webhook URLs, the SMTP password) and nothing else.
path "aisdlc/data/notifier/*" {
  capabilities = ["read"]
}
