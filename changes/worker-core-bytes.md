### Performance

- A worker that has to fetch the core module itself (a shared worker, a
  worker of a window opened with noopener) reads the bytes as an
  ArrayBuffer instead of a string it unpacked a byte at a time: the
  request takes 3.0 ms instead of 11.4 on Chrome 157.
