### Performance

- The attribute hooks call the natives they hold with Reflect.apply
  instead of their `call` method, which the Reflection module hooks for
  the page: a hooked attribute write ran that hook before each of the
  several natives it calls.
