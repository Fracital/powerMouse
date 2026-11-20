### Fixes

- The service worker's memory cache lets go of an entry no document asked
  for in 5 minutes. It kept every fresh image, script, stylesheet and font
  a site loaded until its 96 MB budget pushed one out, where Chrome's
  renderer keeps a resource only while something holds it (an image taken
  out of the DOM, or what a document that navigated away loaded, is gone at
  the next collection and comes from the HTTP cache next time). A live
  Twitch channel left open kept the directory's thumbnails and scripts and
  every chat emote it showed: 20 to 28 MB of Blobs in the browser process
  for the whole hour, where Chrome keeps none. Now they are gone by the
  tenth minute and the browser process is 58 MB instead of 80 to 85. A
  document that asks again within 5 minutes still gets the kept copy, per
  site, as before (memory-cache-unit).
