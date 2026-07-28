// The Penumbra mark: an outer ring with a smaller filled disc inside it — an
// eclipse/penumbra motif — ringed by eight compass spikes. The four cardinal
// spikes (N/E/S/W) reach further than the four diagonal spikes (NE/SE/SW/NW),
// giving the compass-rose read. Pure SVG, themed via the --primary token so it
// tracks light/dark automatically. Sized by a single `size` prop.
//
// The viewBox is padded past 0–100 so the spikes have room outside the ring;
// the ring and disc stay centred at 50,50 at their original radii, so their
// geometry (and the hold-to-launcher swell below) is unchanged.
export function Logo({ size = 96 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-24 -24 148 148"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="logo"
    >
      {/* Eight spikes rooted on the ring's outer edge (r≈46), tips pointing out:
          cardinals to r=72, diagonals to r=62. One path, one triangle each. */}
      <path
        d="M45.19 4.25 L50 -22 L54.81 4.25 Z
           M95.75 45.19 L122 50 L95.75 54.81 Z
           M54.81 95.75 L50 122 L45.19 95.75 Z
           M4.25 54.81 L-22 50 L4.25 45.19 Z
           M78.95 14.25 L93.84 6.16 L85.75 21.05 Z
           M85.75 78.95 L93.84 93.84 L78.95 85.75 Z
           M21.05 85.75 L6.16 93.84 L14.25 78.95 Z
           M14.25 21.05 L6.16 6.16 L21.05 14.25 Z"
        fill="var(--primary)"
        className="logo__spikes"
      />
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
