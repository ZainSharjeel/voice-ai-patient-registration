import { cn } from "@/lib/utils";

const button =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors h-9 px-4 text-sm";

/**
 * The app's shared control classes; restyle the values to fit the design. The
 * managed sign-in code and installed modules use these keys, so keep them.
 */
export const controlStyles = {
  button,
  primaryButton: cn(
    button,
    "bg-primary text-primary-foreground hover:bg-primary/90",
  ),
  secondaryButton: cn(
    button,
    "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ),
  outlineButton: cn(
    button,
    "border hover:bg-accent hover:text-accent-foreground",
  ),
  quietButton: cn(button, "hover:bg-accent hover:text-accent-foreground"),
  destructiveButton: cn(
    button,
    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  ),
  input:
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs placeholder:text-muted-foreground",
};
