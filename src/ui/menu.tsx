import { Menu as BaseMenu } from "@base-ui/react/menu";

/**
 * Menu composition with portal positioning; callers supply visual styles.
 * For submenus, radio/checkbox items, and groups, use `@base-ui/react/menu`
 * directly — see https://base-ui.com/react/components/menu
 */
export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;

export function MenuPopup({
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
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <BaseMenu.Popup className={className}>{children}</BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export const MenuItem = BaseMenu.Item;
export const MenuSeparator = BaseMenu.Separator;
