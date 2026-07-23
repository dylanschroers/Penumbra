// The Penumbra mark: an outer ring with a smaller filled disc inside it — an
// eclipse/penumbra motif. Pure SVG, themed via the --primary token so it tracks
// light/dark automatically. Sized by a single `size` prop.
export function Logo({ size = 96 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="logo"
    >
      <circle
        cx="50"
        cy="50"
        r="44"
        fill="none"
        stroke="var(--primary)"
        strokeWidth="5"
      />
      <circle
        cx="50"
        cy="50"
        r="17"
        fill="var(--primary)"
        className="logo__core"
      />
    </svg>
  );
}
