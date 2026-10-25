import type {Point} from "./simulation.ts";

const METERS_PER_UNIT: Record<string, number> = {m: 1, cm: .01, mm: .001, ft: .3048, in: .0254};

export type MeasurementCoordinates = {x: string; y: string};

/** Empty coordinate fields must remain incomplete, rather than becoming (0, 0). */
export function measurementPoint(coordinates: MeasurementCoordinates): Point | undefined {
  if (!coordinates.x.trim() || !coordinates.y.trim()) return undefined;
  return {x: Number(coordinates.x), y: Number(coordinates.y)};
}

type CalibrationPreview = {ok: true; width_m: number; height_m: number; meters_per_pixel: number} |
  {ok: false; reason: string};

/** Match the manual calibration limits before sending a reference to the service. */
export function calibrationPreview(
  image: {width_px: number; height_px: number},
  start: Point | undefined,
  end: Point | undefined,
  distance: number,
  unit: string,
): CalibrationPreview {
  if (![image.width_px, image.height_px].every(value => Number.isFinite(value) && value > 0))
    return {ok: false, reason: "The source image dimensions are unavailable."};
  if (!start || !end) return {ok: false, reason: "Mark both measurement endpoints, or enter all four pixel coordinates."};
  if ([start, end].some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
    point.x < 0 || point.x > image.width_px || point.y < 0 || point.y > image.height_px))
    return {ok: false, reason: "Place both measurement points inside the source image."};
  const pixels = Math.hypot(end.x - start.x, end.y - start.y);
  if (pixels < 5) return {ok: false, reason: "Choose points at least 5 pixels apart. Longer measurements are more accurate."};
  if (!Number.isFinite(distance) || distance <= 0)
    return {ok: false, reason: "Enter a positive, finite known distance."};
  if (!Object.prototype.hasOwnProperty.call(METERS_PER_UNIT, unit))
    return {ok: false, reason: "Choose meters, centimeters, millimeters, feet, or inches."};
  const metersPerPixel = distance * METERS_PER_UNIT[unit] / pixels;
  const width = image.width_px * metersPerPixel;
  const height = image.height_px * metersPerPixel;
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0 || metersPerPixel > 100)
    return {ok: false, reason: "This scale is outside the supported range. Check the endpoints, distance, and units."};
  if (!Number.isFinite(width) || !Number.isFinite(height) || Math.max(width, height) > 1000)
    return {ok: false, reason: "This measurement makes the image larger than 1,000 m. Check the endpoints, distance, and units."};
  return {ok: true, width_m: width, height_m: height, meters_per_pixel: metersPerPixel};
}
