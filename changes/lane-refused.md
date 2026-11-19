### Fixes

- A relay that refuses one of the lanes it offered (`LANE_REFUSED`) no
  longer ends the WebTransport session. Until the relay answers on a
  lane, the client keeps what it sent there (up to 4 MiB). When the lane
  is refused, those Wisp streams move to the lanes the relay took and
  their packets are sent again in order, and the session goes on. Later
  sessions to that relay open only the lanes it took, and the console
  says so. Before this, every refusal ended the session and the next
  one opened the same lanes again, so a relay that offered more lanes
  than it took had the client reconnecting in a loop.
