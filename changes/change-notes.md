### Performance

- The service worker's notes of a change of the jar and of storage go to
  the windows whose documents the change is for (by the real host or origin
  a window's route stands for), and to any window no route names
  (about:srcdoc, blob:, the host's own page), not to every window. An
  ad-heavy page keeps a hundred frames of the ad networks' cookie syncs,
  each setting its own network's cookies, and every change was a message to
  every frame: on apnews.com 2,620 changes made 290,000 messages in 36 s,
  each a task of the page's thread (about 24 us each in plain Chrome) and a
  hop through the browser process; the top document now hears 125 of them
  and a cookie sync frame none. (change-notes suite.)
