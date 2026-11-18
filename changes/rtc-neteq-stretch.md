### Fixes

- A proxied page plays a call's sound through jitter and loss as Chrome
  does. The worker's jitter buffer now shortens and lengthens its sound a
  pitch period at a time where NetEq's decision logic would (accelerate
  and preemptive expand, on NetEq's filtered buffer level), so it comes
  back from a held-up burst within a second and stays put through loss;
  its target is set on NetEq's 10 ms ticks, so it is Chrome's at the edge
  of a bucket too; a packet that swaps places with the next on the way is
  played in its place, where the stack dropped it and the receiver made
  up its time; a lost packet's time is made up as NetEq's expand makes
  it up, not by libopus's concealment, which Chrome only runs behind a
  field trial.
