### Performance

- A frame no longer holds SpeechRecognition and Notification behind
  accessors until the page names them: both interfaces were made in every
  frame anyway, so the accessors only added to them (about 1.6 KB a frame).
