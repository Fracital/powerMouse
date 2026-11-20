### Fixes

- The first site opened after a deploy arrives instead of hanging on
  "Loading..." until a full reload. Chrome stops the old service worker as
  it activates the new one, and a navigation the old worker was handed in
  that moment was never answered, nor sent to the network or the new
  worker: the frame kept its old document for good. The host's frame now
  sends such a navigation again once the new worker takes over (by way of
  about:blank, as Chrome drops a second navigation to the URL a frame on
  its first document is already on its way to), in both modes. The new
  worker's revive window now also starts at its activation, not when it
  installed, so what the pages ask before their controller has shaken
  hands with it waits for that handshake instead of reaching the host's
  server (a frame's whoami, its scripts, its storage calls), and a
  navigation's event lasts until the worker has written the document's
  body, so Chrome no longer stops the old worker in the middle of one
  (deploy-handover).
