Benches for the parked splice printer (see this branch's first commit).

- diff.ts: the AST differential. Rewrites each corpus script with escodegen
  output and with splice output, parses both and compares the ASTs, ignoring
  ranges, raw text and comments.
- mod.ts: per-mode modifyJS timing over the corpus.

Build: NODE_PATH=<checkout>/node_modules npx esbuild <file> --bundle
--platform=node --format=esm. The corpus (46 MB of real scripts from Discord,
CNN and Google Docs) is not committed; it was saved as text under
/tmp/stomp-speed on the machine that measured it.
