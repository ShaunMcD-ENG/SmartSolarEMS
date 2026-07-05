/**
 * Chart color constants — must mirror the CSS custom properties in styles.css
 * exactly (recharts needs real hex, not `var(...)`, for its SVG props).
 *
 * The four categorical roles were validated as a set with the dataviz skill's
 * palette validator against dark surface #141c25 in this exact legend order
 * (solar, load, battery, grid) — worst adjacent CVD deltaE 96.7, all >=3:1
 * contrast. Keep the order fixed; don't reassign hues to other series.
 */
export const COLORS = {
  solar: "#c98500",
  load: "#3987e5",
  battery: "#008300",
  grid: "#9085e9",

  bandCharge: "#0ca30c",
  bandDischarge: "#d95926",
  bandSelfConsume: "#64748b",

  statusGood: "#0ca30c",
  statusWarning: "#fab219",
  statusCritical: "#d03b3b",

  gridLine: "#2a3746",
  axisText: "#7a8794",
  surface: "#141c25",
} as const;
