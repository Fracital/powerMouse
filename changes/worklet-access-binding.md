### Fidelity

- A worklet's global scope (audio, paint, layout, animation) reads as
  natively: its Number.prototype has only its own keys. A worklet holds no
  inject, so its rewritten module defined the access API there itself, as
  a property no hook hid from Object.getOwnPropertyNames, Reflect.ownKeys,
  a descriptor or the order of the prototype's keys. The module now
  declares it as a function of its own scope, which its rewrite calls
  (`$name().get2(...)`): the wasm rewriter takes the expression from the
  host (an `api` line, revision 17), and the lead is a function
  declaration, so a module of an import cycle called before it ran finds
  it, as natively. realm-surface compares every worklet with no fact left
  out (the OPEN entry for the audio and paint worklets is gone), and walks
  the layout and animation worklets in a browser with their blink features
  on, reading the animation worklet's record from its DevTools target;
  workers runs an audio worklet's import cycle against native Chrome.
