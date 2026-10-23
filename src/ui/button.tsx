import { cn } from "@/lib/utils";

/** Shared interaction states; visual styles belong to the calling surface. */
export function buttonClasses(className?: string): string {
  return cn(
    "focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50",
    className,
  );
}

export function Button({
  className,
  type = "button",
  ...props
}: React.ComponentProps<"button">) {
  return <button type={type} className={buttonClasses(className)} {...props} />;
}
