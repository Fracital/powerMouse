### Fixes

- A document that cannot have the deferred parts (a frame under a top of
  another build whose rewriter library file is gone) loads again. The
  device-id part, the configured user-agent identity and the
  anti-fingerprinting module are deferred parts a document applies as it
  starts, so since they were deferred such a document stopped there and
  ran none of its page. Where the device-id part cannot be had, what it
  shows refuses instead: enumerateDevices, a track's settings,
  capabilities, constraints and applyConstraints, setSinkId, a device's
  ids and label, and an AudioContext made with a sinkId reject or throw
  with the part's error, a sinkId reads only what every site reads, and
  no devicechange reaches the page. Where the identity cannot be had,
  Navigator's userAgent, appVersion and platform are still the configured
  agent's and userAgentData is gone, as Chrome gives none to an insecure
  context, so the page never reads the browser's own agent while the
  requests carry the configured one. Where the anti-fingerprinting module
  cannot be had, its surfaces read as natively. deferred-refusals passes
  again (61 of its checks had failed), and deferred-refusals-identity runs
  it under a configured user agent with a fingerprinting surface on, as
  the public demo is.
