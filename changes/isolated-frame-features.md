### Fixes

- In the demo's isolation mode a proxied page may use every feature a top
  may: fullscreen, autoplay, encrypted media, the motion sensors, payment,
  passkeys, WebXR and the rest. The proxied frame is of another origin than
  the demo page there, and its `allow` attribute named only the powerful
  features STomp asks the user about, so the page lost 41 of the 78 Chrome
  157 lets a top have: a video player's fullscreen button did nothing,
  Spotify's DRM check reported a permissions policy violation, and x.com and
  TikTok reported one for the accelerometer. The demo's frames now name
  every feature the demo page itself may use. (frame-features suite.)
