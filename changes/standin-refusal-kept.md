### Performance

- A read of another origin's window through `top` (every one from a frame
  of another slot, with the site pool on) no longer throws and catches an
  exception on every read: 5,000 reads of `window.parent.top` took 64 to
  72 ms with the pool on and now take 15.5 to 17 ms (2 to 3 ms natively).
