# cli-smoke

End-to-end smoke test for the bq-analytics SDK. Sends a representative mix of `track / identify / group / log` calls directly to BigQuery (via Application Default Credentials), then reads them back.

## Run

```sh
gcloud auth application-default login   # one-time
pnpm smoke                              # sends events, prints run_id
pnpm smoke:query <run_id>               # verifies the rows landed
```

Override target project / datasets:

```sh
GCP_PROJECT_ID=my-project \
BQ_EVENTS_DATASET=events \
BQ_LOGS_DATASET=logs \
pnpm smoke
```

## What it sends

- 1 `identify(user, traits)` with `plan`, `signup_country`, etc.
- 1 `group("household", id, traits, userId)` with `size`, `features`
- 5 `track()` calls: 2 pageviews, 2 translation events, 1 checkout
- 1 `log("info", ...)` summary line

Every payload includes a `run_id` so you can scope verification queries to one run without leaking across previous test data.
