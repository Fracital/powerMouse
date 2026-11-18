### Fidelity

- A WebRTC data channel sends again within 3 s of its path coming back
  after an outage, as Chrome's does: the SCTP association backs its
  retransmission timer off to 3 s at most, as Chrome's dcSCTP does
  (measured on Chrome 157, retransmissions 3.0 s apart through an outage),
  where it doubled the wait up to a minute: a message sent into a 30 s
  outage arrived 15 s after it ended (the rtc crate's tests).
