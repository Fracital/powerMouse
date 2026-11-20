### Performance

- A popup that writes `document.cookie` no longer rereads the jar on the
  next turn just because the worker notified it of its own write. Other
  documents still see the change.
