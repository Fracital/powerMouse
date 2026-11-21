### Demo and API

- vibeOS's emulator is no longer built into `dist/vibeos/` or served
  (`dist/vibeos/` goes from about 53 MB to 14 MB): the first time it
  opens, vibeOS fetches v86 0.5.473, its BIOS and the disk image the launch
  needs from pinned sources on jsDelivr through the proxy's transport
  (`vibeHost.fetch`), never from the page, runs each only when its SHA-256
  is the pinned one, and keeps it in Cache Storage, so a later launch makes
  no request (docs/vibeos.md, "The emulator").
