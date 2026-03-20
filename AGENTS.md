# Repository Instructions

## Scalability Requirement

- Every implementation in this repository must be evaluated against a workload of at least `500` markdown files being synced to Notion.
- When adding or changing code, explicitly consider:
  - request batching when the target API supports multiple items per request
  - safe parallelism for independent requests
  - backoff and pacing to avoid rate limits
  - avoiding repeated per-file external calls when equivalent work can be shared, cached, or precomputed
- Prefer designs that keep the number of external API requests close to the number of files that actually changed, not the total number of files in the repository.
