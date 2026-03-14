# Deployment

## Docker Images

Images are built automatically by GitHub Actions on every push to `main` and published to GHCR:

- `ghcr.io/mrgarbonzo/idiostasis-protocol/guardian`
- `ghcr.io/mrgarbonzo/idiostasis-protocol/agent`

### Finding the digest

After a push to `main`, open the **Build & Push Docker Images** workflow run in the Actions tab. Each job prints the image digest in the final "Print digest" step, e.g.:

```
Guardian digest:sha256:abc123...
```

### Updating SecretVM compose files

1. Copy the digest from the workflow run.
2. Replace the `REPLACE_WITH_DIGEST_FROM_GITHUB_ACTIONS` placeholder (or the previous digest) in the relevant compose file:
   - `docker/docker-compose.secretvm-guardian.yml`
   - `docker/docker-compose.secretvm-agent.yml`
3. Deploy the updated compose file to the SecretVM.

### Why digests instead of tags?

SecretVM uses RTMR3 to measure the compose file content for remote attestation. If we used mutable tags like `latest`, the same compose file could resolve to different images over time, breaking the attestation chain. Pinning by digest ensures the measured compose content uniquely identifies the exact image binary.
