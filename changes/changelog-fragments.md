### CI

- `CHANGELOG.md` is written through fragments: a change adds
  `changes/<topic>.md` (one or more `### <Section>` headings, each with its
  list of entries) instead of editing `CHANGELOG.md`, so two landings no
  longer conflict on it. `npm run changelog` (`scripts/changelog.mjs fold`,
  `--release <version>` for a new heading, `--dry-run`) moves them to the
  top of their sections in the first release when a release is cut, and
  `npm run check:prose` fails on a fragment that is not well formed.
  `changes/README.md` has the format.
