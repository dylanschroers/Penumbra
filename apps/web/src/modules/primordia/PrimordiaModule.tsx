// Primordia, a self-contained HTML game served from public/primordia.html and
// embedded whole. Same-origin, so no sandbox gymnastics; the frame owns its
// own input, storage, and render loop.
export function PrimordiaModule() {
  return (
    <iframe className="module-frame" src="/primordia.html" title="Primordia" />
  );
}
