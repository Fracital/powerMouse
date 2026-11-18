### Performance

- The ad blocker queues an element once until it reads it, and reads its
  queue in order without moving it: a page that changed one element's
  class 20,000 times queued it 20,000 times, and taking each entry off
  the front of the queue made draining it quadratic.
