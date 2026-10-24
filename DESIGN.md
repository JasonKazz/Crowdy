# Crowdy design philosophy

Crowdy helps people explore how a furnished space and its occupancy affect
evacuation. The interface should make it easy to bring in a floor plan, inspect
and edit the layout, define a scenario, simulate crowd movement, and compare a
proposed change with the original.

The floor plan is the center of the experience. Controls, animation, and results
should help the user answer concrete questions: Where does movement slow down?
What is obstructing a route? What changes when furniture moves or occupancy
changes? Every screen should make the next step toward an answer clear.

Use a restrained, practical visual language: clear hierarchy, compact controls,
and direct copy. Give the spatial view enough room to explain the simulation.
Crowdy should feel like a useful planning tool that supports exploration and
careful comparison.

These principles guide contributors and coding agents working on Crowdy. They
describe the intended product experience, not a list of features already
implemented. Explicit project requirements and user instructions take precedence.

## Design around the planning loop

Organize the experience around a clear sequence:

1. **Bring in a floor plan.** Make the starting action easy to find and explain
   supported inputs where the user chooses a file.
2. **Review the space.** Let the user understand and correct the layout before
   relying on it for a simulation.
3. **Set the scenario.** Make occupancy and the assumptions affecting crowd
   movement visible and editable.
4. **Run and inspect.** Show progress, then connect movement and congestion to
   specific locations on the plan.
5. **Change and compare.** Help the user test a layout or scenario change and
   understand its effect against a clear baseline.

Keep this loop easy to repeat. Users should be able to move from a bottleneck to
a layout edit and another run without losing their place or the original result.
Show which inputs are ready and what still needs attention before a run can start.

The working interface should lead with the current plan, scenario, and available
actions. Avoid welcome speeches, aspirational headlines, feature advertisements,
and repeated explanations between the user and their work.

## Keep the floor plan central

Give the plan the largest useful area of the workspace. Place layout tools,
scenario controls, and results around it in predictable locations. Use a side
panel or contextual controls for detail instead of breaking the spatial task
into unrelated dashboard cards.

Make walls, furniture, open space, exits, and simulated people visually distinct
where the model represents them. The user should be able to tell what can be
edited, what is selected, and what affects movement. Selection handles, labels,
and overlays must remain legible at useful zoom levels.

Keep the spatial frame stable when switching between editing, simulation, and
comparison. Preserve orientation and zoom where practical so the user can
recognize the same room or passage across states. Offer an obvious way to return
to the full plan after inspecting a detail.

Treat overlays as information layers. Routes, crowd density, and congestion
should help explain the space without hiding the geometry beneath them. Let
users inspect the underlying plan when an overlay obscures a detail.

## Make inputs and assumptions inspectable

A furnished floor plan is the basis of the analysis. If Crowdy interprets an
uploaded plan, make the interpreted geometry available for review and correction.
An uncertain boundary, missing exit, or misplaced obstacle should have a clear
path to correction before the user runs a scenario.

When scale or dimensions affect a run, show their units and how they were set.
Distinguish information supplied by the user from inferred or default values.
Do not hide an important assumption merely to make the setup look simpler.

Occupancy belongs to the scenario and should be understandable in the space.
Show the population count and any distribution settings the simulation supports.
When placement matters, connect those settings to visible people or regions on
the plan. Explain constraints at the control they affect.

Use defaults to reduce setup effort, while keeping them visible and adjustable.
Validation should identify the specific input needing attention and offer a
useful next action. Preserve valid work when one part of setup needs correction.

## Use simulation to explain movement

Crowd animation should reveal how people move through the layout and where
movement becomes constrained. Make the run state and simulated time easy to
find. Playback controls should use familiar labels and remain close to the view
they control.

Use motion purposefully. Moving people, changing density, and highlighted routes
can explain behavior; decorative transitions should not compete with them.
Support inspection through a paused view and readable results so understanding
does not depend on watching every moment of an animation.

Connect summary results to spatial evidence. A congestion value is more useful
when the user can locate the affected passage and inspect what happened there.
Keep legends, units, and the meaning of an overlay close enough to interpret it.

Explain what each reported measure represents. For example, if a run reports
evacuation time, make clear whether it describes the whole simulated population
or only those who reached an exit. People remaining in the space and incomplete
runs must remain visible in the result.

## Make comparisons fair and easy to read

Before-and-after comparison is central to Crowdy. Identify the baseline, the
proposed version, and what changed between them. Preserve the baseline while
the user explores an alternative.

Use consistent plan orientation, visual scales, legends, units, and playback
time when comparing results. A side-by-side view or an aligned toggle should
make it easy to inspect the same location in both versions. Do not make one
result appear better by changing the heatmap scale or hiding part of the plan.

When testing a layout change, keep occupancy and other scenario settings
consistent where possible. If both the layout and scenario change, make that
visible. Avoid attributing a difference to furniture placement when the runs
also used different populations or movement assumptions.

Show the original value, the new value, and a clearly labeled difference for
comparable measures. Pair numerical changes with the relevant spatial view.
If a measure is unavailable or two results cannot be compared meaningfully,
explain the reason instead of presenting a misleading improvement.

## Keep results tied to the inputs that produced them

A result belongs to a particular layout and scenario. Keep that relationship
visible while users inspect results or prepare another run.

Editing the plan or occupancy after a run should make it clear that the displayed
result describes an earlier configuration. Provide a direct way to run the
updated configuration. Never silently relabel an old result as the outcome of
new inputs.

Distinguish setup, queued, running, complete, cancelled, and failed states when
those states exist. A progress indicator should describe the operation in
progress. Failed or partial runs should retain enough context for the user to
understand what happened and recover.

Present outcomes as simulated behavior under the shown assumptions. Use factual
labels such as "Simulated evacuation time" and "Congestion in this scenario."
Avoid unsupported claims that a layout is safe, certified, or guaranteed to
evacuate within a given time. Put relevant model limitations beside the results
they qualify, using concise language that helps interpretation.

## Write direct interface copy

Use familiar nouns for destinations and specific verbs for actions. Prefer
Floor plan, Layout, Scenario, Simulation, Results, Upload floor plan, Run
simulation, and Compare runs. Use the same term for the same concept throughout
Crowdy; keep the distinction between the physical layout and its occupancy
scenario clear.

A view normally needs a descriptive title. Add helper text when it answers a
likely question or explains a consequence that the controls cannot communicate.
Do not make an eyebrow, headline, subtitle, and explanatory paragraph the
default for every panel.

| Avoid | Prefer | Reason |
| --- | --- | --- |
| "Unlock safer spaces with intelligent insights" | "Upload floor plan" | Gives a concrete starting action. |
| "Your crowd intelligence command center" | The current plan and scenario controls | Makes the work immediately available. |
| "Experience the flow" | "Run simulation" | Names the action directly. |
| An isolated "120" | "120 people" | Keeps the quantity and unit together. |
| "Optimized!" | Baseline and proposed results with labeled differences | Shows what changed and by how much. |
| "This layout is safe" | Results tied to the simulated scenario | Keeps the claim within what the run shows. |
| "Something went wrong" | A specific problem and a recovery action | Helps the user continue. |

Keep necessary explanations close to the relevant action. A warning about
discarding edits, a missing scale, or changed inputs deserves space. A sentence
repeating that Crowdy simulates crowds usually does not.

## Keep the visual treatment clear and purposeful

Use neutral surfaces, legible text, modest corner radii, and consistent controls
for navigation and forms. Establish hierarchy through alignment, spacing,
typography, and subtle borders. Keep related controls together and the primary
action easy to locate.

Reserve strong color for meaningful distinctions such as selection, exits,
crowd density, congestion, errors, and comparison changes. Define consistent
meanings and pair color with labels, patterns, or symbols. Legends must explain
what the user is seeing without relying on color alone.

Spatial visualization can be expressive when it improves understanding. Avoid
decorative gradients, ornamental icons, heavy shadows, and large hero sections
that compete with the plan or delay access to controls.

Choose density for the task. A scenario panel can use compact controls; a plan
needs room for precise inspection; a comparison needs enough space to read both
results. Do not shrink text or controls merely to fit everything on one screen.

## Preserve control, accessibility, and recovery

Layout edits should have clear selection and editing states. Make it possible
to correct mistakes without restarting the workflow. Explain actions that
discard edits, replace a plan, or remove a comparison baseline before the user
commits to them.

If saving or persistence is available, show whether changes are saved, pending,
or failed. Preserve the distinction between a stored setup and a completed run.
Do not imply that work is saved or synchronized before that operation succeeds.

On narrow screens, keep the plan and essential run state accessible. Panels
may stack or collapse, but occupancy, run controls, legends, and result context
must remain discoverable. Contain panning and zooming within the spatial view
instead of allowing accidental page overflow.

Preserve keyboard navigation, visible focus, form labels, accessible control
names, readable contrast, and reduced-motion preferences. Provide usable
alternatives to drag-only editing and hover-only information. Pair visual
results with readable summaries so the animation is not the only source of
meaning.

## Review changes against Crowdy's purpose

Before changing a screen, identify the planning task, spatial information,
scenario settings, and result context that must remain available. Remove
redundant copy and decoration without removing the information needed to
understand a run or compare alternatives.

Use this checklist for new screens and interface changes:

- [ ] The current plan, scenario, and next action are clear.
- [ ] The spatial view has enough room for the task.
- [ ] Important geometry, units, occupancy, and assumptions are inspectable.
- [ ] Layout tools and simulation states are easy to distinguish.
- [ ] Animation and overlays explain movement without hiding the plan.
- [ ] Results identify the inputs that produced them, including after edits.
- [ ] Comparisons identify the baseline, changed inputs, and consistent scales.
- [ ] Metrics have clear definitions and units; incomplete runs remain visible.
- [ ] Copy describes simulated outcomes without unsupported safety claims.
- [ ] Errors, empty states, and destructive actions offer clear recovery paths.
- [ ] Keyboard, touch, narrow layouts, and reduced motion remain usable.

For functional interface changes, inspect real screens and run the existing
checks appropriate to the change. Walk through the affected planning loop,
including relevant empty, error, and edited-after-run states. A visual cleanup
should preserve the user's ability to understand the space and test a change.
