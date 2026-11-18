### Fixes

- The synchronous bridge sends its request in the beacon's URL, sealed
  with the controller's codec as a route is, which
  Chrome does not count against the 64 KiB of beacons a document may have
  in flight: a page that wrote 24 or more ad frames in one task spent that
  quota on its frames' script copies before any frame ran, so the scripts
  written after were dropped and storage reads threw QuotaExceededError,
  where natively nothing has a quota to meet (written-frames-quota suite,
  compared with native Chrome). A request too long for a URL goes in the
  body, as before.
