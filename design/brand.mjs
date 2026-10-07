export const COLORS = Object.freeze({ shell: "#243d2e", core: "#d6df9a", paper: "#f7f6f0" });
export const MARK = Object.freeze({ size: 32, radius: 8, inset: 4, coreRadius: 4, cut: 26 });

export function markElements(animated = false) {
  const { size, radius, inset, coreRadius, cut } = MARK;
  const start = cut - inset;
  const end = size - inset;
  const arc = `a${coreRadius} ${coreRadius} 0 0 1`;
  const path = `M${start} ${inset}h${end - coreRadius - start}${arc} ${coreRadius} ${coreRadius}v${size - 2 * (inset + coreRadius)}${arc}-${coreRadius} ${coreRadius}H${inset + coreRadius}${arc}-${coreRadius}-${coreRadius}v${start - end + coreRadius}Z`;
  return `<rect width="${size}" height="${size}" rx="${radius}" fill="${COLORS.shell}"/><path${animated ? ' class="rind-core"' : ""} d="${path}" fill="${COLORS.core}"/>`;
}

export function logoSvg(animated = false) {
  const motion = animated ? `<style>
    .rind-core { animation: rind-open 3.6s cubic-bezier(.4, 0, .2, 1) infinite; }
    @keyframes rind-open {
      0%, 12%, 68%, 100% { transform: translate(0, 0); }
      36% { transform: translate(1px, 1px); }
    }
    @media (prefers-reduced-motion: reduce) { .rind-core { animation: none; } }
  </style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK.size} ${MARK.size}" role="img" aria-label="Rind">${motion}${markElements(animated)}</svg>\n`;
}
