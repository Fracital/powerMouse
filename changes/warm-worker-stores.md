### Performance

- The service worker reads what a request reads once per worker start (the
  emulated service workers' registrations, the client hints' accepted
  hints and user agent values, the HTTP cache's store) when a controller
  registers, side by side, not one after another in the first navigation's
  way to the network: the worker's time from a navigation's fetch event to
  its request leaving went from 13.6 to 7.8 ms (median of 12, loopback).
