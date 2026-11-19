### Fidelity

- A dedicated or shared worker's script, classic or module, goes out with
  `Priority: u=4, i` over HTTP/2 and HTTP/3, as Chrome sends it, and waits
  for an HTTP/1 connection at urgency 4. It went out with no Priority and
  waited at urgency 3. (worker-script-priority suite.)
