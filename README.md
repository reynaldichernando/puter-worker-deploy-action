# Puter Worker Deploy Action

Uploads a worker's source (a folder or single file) to Puter FS, then deploys (or updates) a [Puter Worker](https://docs.puter.com/) pointing at the entry file.

This action is bundled into `dist/index.cjs` and ships with:
- `@heyputer/puter.js`
- `@actions/core`

Runtime: GitHub Actions `node24`.

## Inputs

- `worker_name` (required): Worker to manage, such as `my-api` or `my-api.puter.work`
- `puter_path` (required): Destination directory in Puter FS for the source (for example `~/workers/my-api`)
- `puter_token` (required): Puter auth token, usually from `secrets`
- `source_path` (optional, default `.`): Repo-relative file/folder to deploy
- `entry_file` (optional, default `index.js`): Worker entry file relative to `source_path` (ignored when `source_path` is a single file)
- `include_hidden` (optional, default `false`): Include dotfiles/directories
- `concurrency` (optional, default `8`): Number of concurrent uploads

## Outputs

- `deployed_files`: Number of uploaded files
- `worker_url`: Deployed worker URL (typically `https://<worker_name>.puter.work`)
- `deploy_action`: `created` or `updated`

## What It Does

1. Initializes the Puter SDK from the bundled runtime (`@heyputer/puter.js/dist/puter.cjs`) and sets your auth token.
2. Ensures `puter_path` exists as a directory.
3. Uploads files from `source_path` using upsert behavior (`puter.fs.write(..., { overwrite: true, createMissingParents: true })`).
4. Resolves the entry file's remote path (`puter_path` + `entry_file`).
5. Deploys the worker with `puter.workers.create(worker_name, entryPath)`. If a worker with that name already exists it is re-deployed and reported as `updated`.

## Usage

```yaml
name: Deploy Worker To Puter

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy worker
        id: puter_worker
        uses: your-org/puter-worker-deploy-action@v1
        with:
          worker_name: my-api
          source_path: worker
          entry_file: index.js
          puter_path: ~/workers/my-api
          puter_token: ${{ secrets.PUTER_TOKEN }}

      - name: Print URL
        run: echo "Worker is live at ${{ steps.puter_worker.outputs.worker_url }}"
```

For a single-file worker, point `source_path` directly at the file (the `entry_file` input is ignored):

```yaml
      - name: Deploy worker
        uses: your-org/puter-worker-deploy-action@v1
        with:
          worker_name: my-api
          source_path: worker.js
          puter_path: ~/workers/my-api
          puter_token: ${{ secrets.PUTER_TOKEN }}
```

## Local Validation

```bash
npm install
npm run check
npm run build
```

Commit `dist/index.cjs` after building. GitHub Actions executes that committed bundle directly.

## Publish This Action

1. Push this repo to GitHub (public if you want broad reuse).
2. Create and push a release tag:

```bash
git add .
git commit -m "Release v1.0.0"
git tag v1.0.0
git push origin main --tags
```

3. Create a moving major tag so users can stay on `v1`:

```bash
git tag -f v1 v1.0.0
git push origin -f v1
```

4. In consumer repos, use:

```yaml
uses: your-org/puter-worker-deploy-action@v1
```

When you change `src/deploy.mjs`, rebuild before tagging:

```bash
npm run build:clean
git add src/deploy.mjs dist/index.cjs
git commit -m "Rebuild action bundle"
```

## Publish To GitHub Marketplace (Optional)

1. Open this repository on GitHub.
2. Create a release from your tag (for example `v1.0.0`).
3. On the release page, choose to publish the action to Marketplace and complete the listing form.
