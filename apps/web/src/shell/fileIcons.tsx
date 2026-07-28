// Line icons for the file sidebar. Stroked with `currentColor` and no fill, so
// they take on the row's text colour (muted for files, brighter on hover) and
// sit with the app theme far better than the emoji the first pass used. All are
// a 16×16 viewBox at a consistent 1.5 stroke weight.

interface IconProps {
  /** Pixel size; defaults to 16. */
  size?: number;
  className?: string;
}

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };
}

// These icons are decorative — every icon button carries its own aria-label, so
// `aria-hidden` is declared on each <svg> directly (the linter can't see it
// through the spread helper).

/** Disclosure chevron; the sidebar rotates it 90° via CSS when expanded. */
export function ChevronIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} aria-hidden="true">
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function FolderIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} aria-hidden="true">
      <path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h2.3a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3h4.3A1.5 1.5 0 0 1 14 6.6v5.4A1.5 1.5 0 0 1 12.5 13.5h-9A1.5 1.5 0 0 1 2 12z" />
    </svg>
  );
}

export function FileIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} aria-hidden="true">
      <path d="M4 2.5h4.5L12 6v7a0.5 0.5 0 0 1-.5.5h-7A0.5 0.5 0 0 1 4 13z" />
      <path d="M8.5 2.5V6H12" />
    </svg>
  );
}

export function PlusIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
