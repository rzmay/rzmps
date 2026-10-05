# Release Flow

RZMPS publishes packages from the `release` branch.

1. Update package versions in the publishable package manifests.
2. Update user-facing docs and migration notes for breaking changes.
3. Run the local release checks:

```bash
npm test
npm run build:modules
npm run build --workspace demo
npm run benchmark:run
```

4. Push the release branch.
5. The release workflow syncs demo package references, runs tests, builds the
   packages, and stages unpublished package versions with npm.
6. Approve the staged packages in npm to complete publication.

The workflow intentionally stages packages instead of publishing immediately so
a maintainer can make the final npm approval after CI has prepared the release.
