import { Popover as BasePopover } from "@base-ui/react/popover";

/**
 * Popover composition with portal positioning; callers supply visual styles.
 * `PopoverTrigger` renders a real button; style it via className or replace
 * the element with the `render` prop. For arrows, titles, and controlled
 * positioning, use `@base-ui/react/popover` directly —
 * see https://base-ui.com/react/components/popover
 */
export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

export function PopoverContent({
  className,
  side = "bottom",
  align = "center",
  sideOffset = 6,
  children,
}: {
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  children: React.ReactNode;
}) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <BasePopover.Popup className={className}>{children}</BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
