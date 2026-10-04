## Module

Name of the new module:

## Behavior

What particle properties does it read or write?

## API

```js
new MyModule({
  // options
});
```

## Documentation

- [ ] Added or updated the relevant section in `README.md`
- [ ] Added or updated the relevant section in `packages/rzmps/README.md`
- [ ] Documented constructor options and a short usage example

## Performance

- [ ] Avoids per-particle allocations in hot paths
- [ ] Uses `prepare()` for per-frame setup where appropriate
- [ ] Handles local/world simulation space if relevant

## Demo

- [ ] Added or updated a demo preset
- [ ] Added GUI controls when useful

## Verification

- [ ] `npm run build --workspace @rzmps/rzmps`
- [ ] `npm run build --workspace apps/demo`, if demo changed
