### Fixes

- A proxied page's call with silence left out (Opus `usedtx=1`, as
  Discord's calls ask) sends the start of each silence as Chrome does: the
  one byte packet libopus makes of the first frame left out, which
  WebCodecs' encoder gives no output for. Without it the far end's jitter
  buffer took every silence for lost sound and concealed it (about 56,000
  samples a call against none natively); now about 500 to 900. A sender's
  encoded transform is handed the frames left out as empty frames, as
  Chrome's is, and an empty frame is not sent.
