# prism

A React port of [Helium Prism](https://github.com/imputnet/helium-prism), the Svelte UI library
behind Helium's web interfaces. It's vendored here rather than installed from npm because the
upstream package only ships Svelte components.

- `components.tsx`: `Button`, `CardLink`, `Checkbox`, `CopyIcon`, `Dropdown`, `Input`, `Link`,
  `SearchBar`, `Skeleton`, `Spinner`, `Text`, `Toggle` and `Tooltip`. Props match the Svelte
  originals, except that Svelte's two-way `bind:` props become `value`/`checked` plus an
  `onValueChange`/`onCheckedChange` callback. `CopyButton` is a small addition that combines
  `Button` and `CopyIcon`.
- `icons.tsx`: the Tabler icons Prism ships (MIT, © Paweł Kuna).
- `prism.css`: Prism's tokens and styles, with the Svelte component-scoped styles flattened into
  plain classes. They're placed in Tailwind's `base`/`components` layers, so utilities still
  override them. The dark palette is the default.

Not ported, on purpose: `GradientShimmer` (the WebGL hero effect) and the Helium logos.

## License

Helium Prism is GPL-3.0-only. OSSTrace is AGPL-3.0-only, and GPLv3 §13 explicitly allows
combining the two. The ported code keeps its upstream attribution.
