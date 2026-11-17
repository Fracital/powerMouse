# Changelog fragments

A change that `CHANGELOG.md` should mention adds a file here instead of
editing `CHANGELOG.md`, so landings never conflict on it. At release time
`npm run changelog` moves every fragment into `CHANGELOG.md` and deletes it.

One file per change, named by its topic in lower case with hyphens
(`worker-csp.md`, `uptime-check.md`). It holds one or more sections: a
`### <Section>` heading, a blank line, and the entries, written as
`CHANGELOG.md`'s are (`- ` list items, continuation lines indented by two
spaces, no blank lines inside the list):

```md
### Fixes

- A worker's fetches are judged by the worker's own policy, as natively:
  ... (what changed, what a page sees, which suites cover it).
```

The sections are Build, Performance, Transport, Demo and API, CI,
Deployment, Dependencies, Security, Fidelity, Fixes, Origin isolation, Docs
and Known limitations. `npm run check:prose` (CI runs it) fails on a fragment
that is not well formed: an unknown section, an entry that is not a list
item, a blank line inside a list, an em dash.

Releasing: `npm run changelog` folds the fragments into the first release
heading of `CHANGELOG.md` (the `## ` nearest the top), each entry at the top
of its section, newest fragment first, and a section the release lacks is
made in the order above. `npm run changelog -- --release <version>` folds
them into `## <version>` instead, made above the others when it is missing;
the version is whoever cuts the release's call. `-- --dry-run` says what
would go where. Review the result with `git diff` and commit it with the
release.
