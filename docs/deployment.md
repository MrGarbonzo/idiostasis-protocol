# Deployment

## Docker Images

Images are built automatically by GitHub Actions on every push to `main` and published to GHCR:

- `ghcr.io/mrgarbonzo/idiostasis-protocol/guardian`
- `ghcr.io/mrgarbonzo/idiostasis-protocol/agent`

### Finding the SHA tag

After a push to `main`, open the **Build & Push Docker Images** workflow run in the Actions tab. Each image is tagged with the short commit SHA, e.g. `sha-abc1234`.

### Updating SecretVM compose files

1. Copy the SHA tag from the workflow run (e.g. `sha-abc1234`).
2. Replace `REPLACE_WITH_TAG` (or the previous SHA tag) in the relevant compose file:
   - `docker/docker-compose.secretvm-guardian.yml`
   - `docker/docker-compose.secretvm-agent.yml`
3. Deploy the updated compose file to the SecretVM.
