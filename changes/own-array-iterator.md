### Performance

- The inject's own loops, spreads and destructuring over an array step it
  by index, as the native array iterator does, instead of calling the
  native iterator's next for every element through a wrapper of their
  own.
