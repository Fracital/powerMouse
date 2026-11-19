### Fidelity

- A FedCM request calls nothing of the page's Math or timers, as Chrome's
  own does. Its random delay before a failure is told, its three second
  token hold and its read of each step now use the browser's
  `Math.random`, `setTimeout` and `Date.now` taken before any page script
  ran, and no other member of `Math`. A page that replaced `Math.random`,
  `setTimeout` or `Date.now` used to see STomp call them during a sign-in
  (and could choose the delay: a `Math.random` answering NaN made it none).
  (fedcm suite, natively and through the proxy, with and without the
  delays.)
