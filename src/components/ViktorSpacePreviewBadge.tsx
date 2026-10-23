import { TriangleAlert } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/utils";
import { getViktorSpaceIsPreviewDeployment } from "@/lib/viktor-spaces-access/config";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui";

export const PREVIEW_BADGE_LABEL = "Viktor Space preview";

export const PREVIEW_BADGE_WARNING =
  "Do not put real or private information here. Use the live app for that.";

export const PREVIEW_BADGE_DETAILS = [
  "This is a preview, not the live app.",
  "A Viktor Space is an app Viktor built and hosts for your workspace. The " +
    "preview lets you try changes before they go live. It keeps its own " +
    "database and its own access settings.",
  PREVIEW_BADGE_WARNING,
] as const;

/**
 * Corner pill that marks a deployed Viktor Space preview.
 *
 * Styled after the "Made with Viktor" badge on published Viktor Pages
 * (`backend/viktor/coworker/page_badge.py`): white, bottom-right, 12px
 * semibold, Viktor mark at 15px. Keep the two in step when either changes.
 *
 * A popover rather than a tooltip because a phone has no hover, and the
 * warning is the point of the badge: a tap must open it too.
 */
export function ViktorSpacePreviewBadge() {
  if (!getViktorSpaceIsPreviewDeployment()) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${PREVIEW_BADGE_LABEL}. ${PREVIEW_BADGE_WARNING}`}
        className={cn(
          "fixed right-4 bottom-4 z-50 inline-flex items-center gap-1.5 rounded-md",
          "border border-[#150079]/15 bg-white px-2.5 py-1.5 shadow-md",
          "text-xs font-semibold tracking-tight whitespace-nowrap text-[#1B182A]",
          "opacity-95 transition hover:opacity-100 hover:shadow-lg",
          "focus-visible:opacity-100 focus-visible:shadow-lg focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-[#150079]/40 print:hidden",
        )}
      >
        <ViktorMark className="size-[15px]" />
        {PREVIEW_BADGE_LABEL}
        <TriangleAlert aria-hidden="true" className="size-3.5 text-amber-700" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none transition-all duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0 space-y-2 text-xs leading-relaxed [&>p:first-child]:font-semibold"
      >
        {PREVIEW_BADGE_DETAILS.map(line => (
          <p key={line}>{line}</p>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** `viktor-icon-color.svg` from the brand kit, as a component. */
function ViktorMark({ className }: { className?: string }) {
  // The gradient, blur and clip are referenced by id. A per-instance id keeps
  // them clear of whatever ids the surrounding app uses; stripped to
  // alphanumerics so it is safe inside `url(#…)`.
  const id = useId().replace(/\W/g, "");
  const gradientId = `${id}-gradient`;
  const blurId = `${id}-blur`;
  const clipId = `${id}-clip`;

  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <g clipPath={`url(#${clipId})`}>
        <rect width="120" height="120" rx="32" fill={`url(#${gradientId})`} />
        <g filter={`url(#${blurId})`}>
          <ellipse cx="60" cy="-13.2422" rx="60" ry="13.9453" fill="#FDE3AA" />
        </g>
        <path
          d="M27.6562 21.3281H51.5625C52.2657 21.3281 52.7343 21.7969 52.7343 22.5V72.422H56.7981C63.8294 72.422 67.2657 68.6719 67.2657 61.1719V22.5C67.2657 21.7969 67.7343 21.3281 68.4375 21.3281H92.3437C93.0469 21.3281 93.5156 21.7969 93.5156 22.5V67.9688C93.5156 84.6093 76.8749 97.5 54.8438 97.5H27.6562C26.9531 97.5 26.4844 97.0312 26.4844 96.3282V22.5C26.4844 21.7969 26.9531 21.3281 27.6562 21.3281Z"
          fill="white"
        />
      </g>
      <defs>
        <filter
          id={blurId}
          x="-26.4141"
          y="-53.6016"
          width="172.828"
          height="80.7188"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="13.207" />
        </filter>
        <radialGradient
          id={gradientId}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(54.6094 -10.3906) rotate(73.0866) scale(132.121 184.617)"
        >
          <stop stopColor="#FFBD9E" />
          <stop offset="0.0642857" stopColor="#FDBCA0" />
          <stop offset="0.507143" stopColor="#947FFF" />
          <stop offset="0.803571" stopColor="#6748FD" />
          <stop offset="1" stopColor="#150079" />
        </radialGradient>
        <clipPath id={clipId}>
          <rect width="120" height="120" rx="32" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}
