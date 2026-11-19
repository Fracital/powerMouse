### Fidelity

- A WebRTC data channel written to while its path is down hands on as
  many messages as Chrome's (its window counts each chunk on the wire and
  falls to 1191 bytes after a timeout; measured on Chrome 157: 59 small
  messages) and keeps the rest, and `bufferedAmount` reads what it keeps,
  as Chrome's does. It handed on every message and read what was not
  acknowledged, so it grew from the first message of an outage
  (webrtc-net, the rtc crate's tests).
