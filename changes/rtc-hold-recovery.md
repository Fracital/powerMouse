### Fixes

- A proxied call's sound comes back from a network hold-up as gradually
  as Chrome's: once the target falls (4.5 s after a 300 ms hold-up) the
  worker takes out a pitch period each 10 ms, 580 to 872 samples of a
  660 Hz tone each 50 ms over 400 ms, as Chrome takes out 581 to 872
  over 350 to 500 ms, where it took out four periods at a time, 2,324 to
  2,904 each 50 ms over 150 ms. Chrome runs NetEq's fast accelerate as
  its plain accelerate, and with 30 ms in its sync buffer stretches that
  without decoding the next packet; the worker now does both.
