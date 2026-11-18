### Performance

- Moving an element whose style was set through the CSSOM (React's and
  jQuery's style objects) no longer runs the style hook again when the style
  names nothing to route: 1,000 such style writes and keyed moves went from
  about 12 to 8 ms (0.5 natively), measure-hooks on Chrome 157.
