import type { FloorPlan } from "./simulation";

export function validatePlan(value: unknown): FloorPlan {
  if (!value || typeof value !== "object")
    throw new Error(
      "Choose a Crowdy JSON floor plan. Download the sample to see the format.",
    );
  const plan = value as FloorPlan;
  const finite = (...numbers: number[]) => numbers.every(Number.isFinite);
  if (
    typeof plan.id !== "string" ||
    !plan.id.trim() ||
    plan.id.length > 80 ||
    typeof plan.name !== "string" ||
    !plan.name.trim() ||
    plan.name.length > 80 ||
    plan.width !== 900 ||
    plan.height !== 600 ||
    !Number.isFinite(plan.area) ||
    plan.area <= 0 ||
    plan.area > 10000 ||
    !Array.isArray(plan.items) ||
    plan.items.length > 100 ||
    !Array.isArray(plan.walls) ||
    plan.walls.length > 100 ||
    !Array.isArray(plan.exits) ||
    (!plan.native && plan.exits.length < 1) ||
    plan.exits.length > 12
  )
    throw new Error(
      "This plan needs a name, a 900 × 600 canvas, valid area, and at least one exit. Use the sample JSON as a template.",
    );
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 128 ||
      ids.has(item.id) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      item.label.length > 80 ||
      !["desk", "table", "shelf", "sofa", "plant", "obstacle"].includes(
        item.kind,
      ) ||
      !finite(item.x, item.y, item.width, item.height) ||
      item.width < (plan.native ? 0.001 : 8) ||
      item.height < (plan.native ? 0.001 : 8) ||
      item.x < 0 ||
      item.y < 0 ||
      item.x + item.width > 900 ||
      item.y + item.height > 600
    )
      throw new Error(
        "An object has invalid dimensions or a duplicate ID. Check its coordinates in the JSON and upload again.",
      );
    ids.add(item.id);
    if (item.polygon && (!Array.isArray(item.polygon) || item.polygon.length < 3 || item.polygon.length > 300 ||
      item.polygon.some(p => !p || !finite(p.x,p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)))
      throw new Error("Furniture polygon coordinates must be inside its bounding box.");
  }
  for (const wall of plan.walls)
    if (
      !wall ||
      !finite(wall.x1, wall.y1, wall.x2, wall.y2) ||
      Math.min(wall.x1, wall.x2) < 0 ||
      Math.max(wall.x1, wall.x2) > 900 ||
      Math.min(wall.y1, wall.y2) < 0 ||
      Math.max(wall.y1, wall.y2) > 600
    )
      throw new Error(
        "A wall is outside the 900 × 600 canvas. Correct its coordinates and upload again.",
      );
  const exitIds = new Set<string>();
  for (const exit of plan.exits) {
    if (
      !exit ||
      typeof exit.id !== "string" ||
      exit.id.length > 128 ||
      !exit.id.trim() ||
      exitIds.has(exit.id) ||
      typeof exit.label !== "string" ||
      !exit.label.trim() ||
      exit.label.length > 80 ||
      !finite(exit.x, exit.y) ||
      exit.x < 0 ||
      exit.x > 900 ||
      exit.y < 0 ||
      exit.y > 600
    )
      throw new Error(
        "An exit has invalid coordinates or a duplicate ID. Correct it and upload again.",
      );
    exitIds.add(exit.id);
  }
  if (plan.native) {
    const native = plan.native, transform = native.transform;
    const validPoints = (points: unknown): boolean => Array.isArray(points) && points.length >= 3 && points.length <= 300 &&
      points.every(p => p && finite(p.x, p.y));
    if (!native.layout || !transform || !finite(transform.pixels_per_metre,transform.offset_x,transform.offset_y) ||
      transform.pixels_per_metre <= 0 || !Array.isArray(native.floors) || !native.floors.every(validPoints) ||
      !Array.isArray(native.walls) || !native.walls.every(validPoints) || !Array.isArray(native.exit_zones) ||
      !native.exit_zones.every(zone => typeof zone.id === "string" && validPoints(zone.polygon)))
      throw new Error("The imported layout is missing its geometry or scale. Import it again.");
  }
  return structuredClone(plan);
}
