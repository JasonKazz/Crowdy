import type { FloorPlan } from "./simulation";
import {validPlanRooms} from "./room-population.ts";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function named(value: unknown): value is Record<string, unknown> {
  return record(value) && typeof value.id === "string" && Boolean(value.id.trim());
}

function validNativeLayout(value: unknown): boolean {
  const number = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  const point = (item: unknown) => Array.isArray(item) && item.length === 2 && item.every(number);
  const polygon = (item: unknown) => Array.isArray(item) && item.length >= 3 && item.every(point);
  const regions = (items: unknown) => Array.isArray(items) && items.every(item => named(item) && polygon(item.polygon));
  if (!record(value) || !regions(value.walkable_areas) || !regions(value.furniture) ||
    !Array.isArray(value.walls) || !value.walls.every(wall => named(wall) &&
      point(wall.start) && point(wall.end) && number(wall.thickness)) ||
    !Array.isArray(value.doors) || !value.doors.every(door => named(door) &&
      typeof door.wall_id === "string" && number(door.offset) && number(door.width)) ||
    !Array.isArray(value.exits) || !value.exits.every(exit => named(exit) && ("polygon" in exit
      ? polygon(exit.polygon)
      : typeof exit.floor_id === "string" && number(exit.edge_index) &&
        number(exit.offset) && number(exit.width) && number(exit.landing_depth))) ||
    !record(value.agent_defaults) || !number(value.agent_defaults.radius))
    return false;
  const source = value.source_image;
  if (source !== undefined && source !== null && (!named(source) ||
    !number(source.width_px) || !number(source.height_px) || !number(source.meters_per_pixel) ||
    (source.calibration !== undefined && source.calibration !== null &&
      (!record(source.calibration) || typeof source.calibration.label !== "string"))))
    return false;
  return true;
}

export function validatePlan(value: unknown): FloorPlan {
  if (!record(value))
    throw new Error(
      "Choose a Crowdy JSON floor plan. Download the sample to see the format.",
    );
  const plan = value as FloorPlan;
  if (!validPlanRooms(plan.rooms)) throw new Error("Room outlines need unique IDs, valid types and polygons inside the canvas.");
  const finite = (...numbers: number[]) => numbers.every(Number.isFinite);
  if (typeof plan.id !== "string" || !plan.id.trim() || plan.id.length > 80)
    throw new Error("The floor plan needs an ID between 1 and 80 characters.");
  if (typeof plan.name !== "string" || !plan.name.trim() || plan.name.length > 80)
    throw new Error("The floor plan needs a name between 1 and 80 characters.");
  if (plan.width !== 900 || plan.height !== 600)
    throw new Error("The editor canvas must be 900 × 600. Building dimensions are stored separately in the floor plan geometry and scale.");
  if (!Number.isFinite(plan.area) || plan.area <= 0)
    throw new Error("Floor area must be a finite number greater than 0 m². Check the floor outline and image scale.");
  if (!Array.isArray(plan.items))
    throw new Error("The floor plan is missing its furniture list (items). Use an empty list if there is no furniture.");
  if (plan.items.length > 1200)
    throw new Error(`This plan has ${plan.items.length} furniture items; the editor supports up to 1,200.`);
  if (!Array.isArray(plan.walls))
    throw new Error("The floor plan is missing its walls list. Use an empty list if there are no wall segments.");
  if (plan.walls.length > 1200)
    throw new Error(`This plan has ${plan.walls.length} wall segments; the editor supports up to 1,200.`);
  if (!Array.isArray(plan.exits))
    throw new Error("The floor plan is missing its exits list. Add exterior exits before running a simulation.");
  if (!plan.native && plan.exits.length < 1)
    throw new Error("This floor plan has no exits. Add at least one exterior exit before running a simulation.");
  if (plan.exits.length > 30)
    throw new Error(`This plan has ${plan.exits.length} exits; the editor supports up to 30.`);
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
    if (!validNativeLayout(native.layout) || !transform || !finite(transform.pixels_per_metre,transform.offset_x,transform.offset_y) ||
      transform.pixels_per_metre <= 0 || !Array.isArray(native.floors) || !native.floors.every(validPoints) ||
      !Array.isArray(native.walls) || !native.walls.every(validPoints) || !Array.isArray(native.exit_zones) ||
      !native.exit_zones.every(zone => zone && typeof zone.id === "string" && validPoints(zone.polygon)) ||
      (native.issues !== undefined && (!Array.isArray(native.issues) || !native.issues.every(issue => typeof issue === "string"))))
      throw new Error("The imported layout is missing its geometry or scale. Import it again.");
  }
  return structuredClone(plan);
}
