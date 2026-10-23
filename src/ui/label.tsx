export function Label(props: React.ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: association is supplied by htmlFor or nesting at the call site
  return <label {...props} />;
}
