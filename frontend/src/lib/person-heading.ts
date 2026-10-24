import type { AgentPath } from "./simulation";

type HeadingSample = {time: number; angle: number};
const tracks = new WeakMap<AgentPath, HeadingSample[]>();
const turnDifference = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Visual heading only: never modifies measured positions or collision bodies.
 * Cache by immutable run agent, so seeking and reverse playback are deterministic.
 */
function headingTrack(agent: AgentPath): HeadingSample[] {
  const cached = tracks.get(agent);
  if (cached) return cached;
  const samples = agent.samples?.length ? agent.samples : agent.points.map((point, index) => ({
    point, time: agent.delay + index * (agent.travelTime ?? Math.max(.1, agent.duration - agent.delay)) / Math.max(1, agent.points.length - 1),
  }));
  let angle = 0;
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i].point.x - samples[i-1].point.x;
    const dy = samples[i].point.y - samples[i-1].point.y;
    if (Math.hypot(dx,dy) > .02) {angle = Math.atan2(dy,dx); break;}
  }
  const track = samples.map((sample, i) => {
    if (i > 0) {
      const previous = samples[i-1];
      const dx = sample.point.x - previous.point.x;
      const dy = sample.point.y - previous.point.y;
      const dt = sample.time - previous.time;
      if (dt > 0 && Math.hypot(dx,dy) > .02) {
        const change = turnDifference(Math.atan2(dy,dx) - angle) * (1 - Math.exp(-dt / .16));
        angle += Math.max(-Math.PI * dt, Math.min(Math.PI * dt, change));
      }
    }
    return {time: sample.time, angle};
  });
  tracks.set(agent,track);
  return track;
}

/** Radians in canvas coordinates; shoulder width is perpendicular to this. */
export function headingAt(agent: AgentPath, time: number): number {
  const track = headingTrack(agent);
  if (!track.length) return 0;
  if (time <= track[0].time) return track[0].angle;
  let low = 0, high = track.length - 1;
  while (low < high) {
    const middle = Math.ceil((low+high)/2);
    if (track[middle].time <= time) low = middle; else high = middle-1;
  }
  const start = track[low], end = track[low+1];
  return end ? start.angle + (end.angle-start.angle) * (time-start.time)/(end.time-start.time) : start.angle;
}
