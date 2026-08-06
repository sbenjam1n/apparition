# APPARITION — feel test 01

A ground-up 6DOF prototype under MIT. Flight, telekinesis, authored destruction,
AVBD debris, and a reactive light rig, in one tiled liminal room with nothing
else running.

This exists to answer one question, which the design index calls **the killing
test** (§29, Phase 0):

> Is flying, grabbing and throwing heavy objects with Newtonian recoil delightful
> in an empty room — no enemies, no economy, no dilation? Answer this in week two,
> not month eight.

Everything else in the index is superstructure over that, so this build runs
exactly that experiment and adds only what is needed to judge it honestly.

## Running it

No build step, no install. Serve the directory and open it:

```
python3 -m http.server 8080     # or: npx http-server -p 8080
open http://localhost:8080
```

Three.js and lil-gui load from jsDelivr via an import map, so the only
requirement is a browser with WebGL2. Click to lock the pointer.

| | |
|---|---|
| `W A S D` | thrust / strafe |
| `Space` / `Ctrl` | thrust up / down |
| `Q` `E` | roll |
| mouse | pitch / yaw |
| `Shift` | burn — more thrust, more heat |
| `LMB` | grab and hold; objects orbit you |
| `RMB` | throw the orbit (recoil applies) |
| `R` | release the orbit gently |
| `F` | probe — reads mass, material, structural weakness |
| wheel | dilation dial |
| `G` | reset position |
| `Tab` | tuning panel |

**Open the tuning panel.** Feel cannot be judged from someone else's numbers, and
the panel is the actual instrument here — the rest of the build is apparatus
around it. Flight, camera, telekinesis, solver and lighting are all live.

## What is in it

**Flight** (`flight.js`) — Descent's model kept deliberately intact: fixed 1/64s
substeps, one drag coefficient on both linear and angular velocity, thrust as a
per-substep delta-v rather than an acceleration, sinusoidal wiggle, turn-induced
banking, softened auto-level. Constants come from Descent's `PLAYER_SHIP` entry
by way of mrdoob's three.js port. Two things are not Descent's: thrust is scaled
down hard (its terminal velocity crosses this 28m room in half a second), and the
camera trails the player's transform on a spring that gets heavier as you carry
more. A viewpoint that lags input has mass, and mass reads as embodiment (§47.2)
— it is the only body this character gets.

**Telekinesis** (`telekinesis.js`) — probe, grab, hold, throw. Held objects orbit
you and do five jobs at once (§47.3): frame of reference, inventory, cover,
self-readout, and liability. Cost is mass × acceleration (§8.3), so matching
something's existing motion is nearly free and launching from rest is not. Each
throw draws on a fixed impulse budget, which is the single number that makes the
economy work: a 10kg paver takes the full speed and shoves you 2.5 m/s, while the
430kg bench eats the whole budget, barely moves, and launches *you* at 13 m/s.

**Destruction** (`destruct.js`) — three authored weak panels, three discrete
states each, fixed chunk sets, no runtime fracture (§7.4). Damage is 3% of impact
kinetic energy and only counts the component travelling into the panel, so three
thrown pavers stress one and an 85kg drum at speed does it alone. The instrument
is the keycard (§7.3).

**Debris** (`avbd.js`, `debris.js`) — see below. One `InstancedMesh` over the
whole solver; no per-chunk `Object3D`.

**Light** (`lighting.js`, `materials.js`) — a small forward model whose primitive
is a *line*, not a point, because that is what both references are lit with. Tube
irradiance via the representative-point approximation, analytic tile grout,
animated caustics, height fog with a three-tap in-scatter. Architecture, debris
and water all read the same rig, so a chunk tumbling through a cove strip picks up
the rake exactly as the wall it came out of does. Fixtures can be overvolted until
they burst and never come back (§35.2–35.3).

**Post** (`fx.js`) — bloom → afterimage → chroma/scan/grain/vignette → ACES,
adapted from the pen (see Credits). Bloom breathes with draw rather than on a
timer. One deliberate departure from the pen below.

**Audio** (`audio.js`) — fully synthesised impacts, no assets. Filtered noise
burst plus a pitched ring, character from material and impulse. Tile rings high
and dies fast, concrete is broadband and dull, glass is bright and inharmonic,
steel rings long. §51.8 flags audio as mis-filed as art direction when it is the
primary feedback channel for an invisible protagonist in an unlit room, so it is a
system here rather than a polish pass — a small one, but a system.

## "Fake 6DOF particles with AVBD"

AVBD (Giles, Diaz & Yuksel, SIGGRAPH 2025) is a primal-dual position-based
solver. Each iteration does a *block* descent step per body — solve one small SPD
system for that body's own degrees of freedom, holding its neighbours fixed —
then a dual update that raises a per-constraint penalty and accumulates a
Lagrange multiplier. That buys unconditional stability at very low iteration
counts, which is the only reason a few hundred tumbling chunks are affordable in
JavaScript.

The **fake is in the collision layer, not the solver**:

- A chunk is a box, but against static geometry it only ever collides through its
  8 corners against half-spaces and slabs. Corner-vs-plane gives an exact lever
  arm `r × n`, which is all tumbling actually needs — it is what makes debris read
  as rigid rather than as points.
- Chunk-vs-chunk skips SAT and uses two rounds of alternating closest-point
  queries between the two boxes.
- The 6×6 block is split into two decoupled 3×3 blocks (linear, angular). Dropping
  the off-diagonal coupling costs a little convergence per iteration and saves
  most of the cost of the solve.
- Static contacts are warm-started across steps (Eq. 19); pair contacts are not,
  because debris pairs rarely persist long enough to pay for the bookkeeping.
- Bodies sleep after 500ms at rest, which lines up with §23.6's "correct behaviour
  for roughly 500ms" and is the largest single saving in the field.

**Measured**: 473 live bodies, 447 of them awake and in contact, cost **1.37ms per
solver step** — about 8% of a 60fps frame. The solver is not the bottleneck;
rendering is. Numbers from a headless container CPU, so treat them as an order of
magnitude, not a promise.

One thing worth flagging for the design index: §10.8 claims large object counts
are affordable *because* the fight is slow. That is not hand-waving — low relative
velocity is exactly the regime where a position-based solver converges in one or
two iterations. Dilation genuinely is the cheap case here. Wind the wheel and
watch the contact count against frame time.

**Bounding spheres do not work for this.** The first pass used sphere-vs-sphere
for pair contacts, which phantom-collides anything elongated: a 1.8m bench has a
0.94m bounding sphere, so it collided with objects a metre away and the penalty
ramp launched both bodies at 22 m/s. Recorded here so it is not re-attempted.

## Running on a 2019 MacBook

That machine is anything from an Iris Plus 645 to a Radeon Pro 5500M — roughly a
6× range — so the build starts optimistic and steps down on sustained frame time
rather than targeting the floor. Steps are ordered cheapest-look-cost first:
volumetric taps, then resolution, then solver iterations, then bloom. It measures
the 90th percentile of frame time, not the mean, because a stutter every ten
frames is what makes 6DOF feel bad and an average hides it completely. Integrated
Intel parts are detected and start two tiers down. `Tab` → Performance to pin a
tier manually.

Other things done for that target: no antialias, DPR capped at 1, one instanced
draw call for all debris, no shadow maps, no per-frame allocation in the solver
(all structure-of-arrays typed buffers), sleeping bodies skipped entirely.

## Deliberate departures

**Chroma is reserved.** The pen runs chromatic aberration as a constant baseline
look. §44.9 reserves chroma bleed absolutely, for erasure and nothing else — "the
moment it becomes a look, it stops being a wound." The uniform is wired and
reactive but sits at zero; `post.erase()` is the only thing that opens it. Panel
destruction pokes it briefly so the reserved register is testable.

**Two masses for the player.** Descent's `PLAYER_SHIP` mass is a coefficient in
Descent's own units, not a weight — it only ever appears as `thrust/mass`. Recoil
needs a real inertia in kilograms. Conflating them makes a thrown paver launch you
across the room at 40 m/s, so they are separate numbers (`mass`, `recoilMass`).

## Not in this build

No enemies, objectives, annexation, containment, humans, lattice, coffins, or
economy — anything that would let a bad flight model hide behind a good system.
The watt and heat meters exist only because destruction and telekinesis need some
cost to feel weighted, and because a feel test that cannot show you its cost curve
cannot be tuned. The HUD is a development instrument, not interface design; §26
and §47.3 conclude the shipping game has no HUD at all.

Known rough edges: player-vs-world collision is a 4-iteration push-out rather than
a swept test (fine at these speeds, would tunnel at Descent speeds); pair contacts
degrade under deep interpenetration; the input budget flagged in §51.7 is
unresolved and deliberately left visible rather than papered over with modifiers.

## Credits and licensing

This repository is MIT. It is a ground-up rebuild — no Descent game data, no
`.hog`, no `.pig`, nothing but code.

- **Flight model** — constants and substep structure from Descent's `PLAYER_SHIP`,
  via [mrdoob/three-descent](https://github.com/mrdoob/three-descent) (MIT).
  Original game by Parallax Software.
- **AVBD** — [Augmented Vertex Block Descent](https://graphics.cs.utah.edu/research/projects/avbd/),
  Giles, Diaz & Yuksel, ACM TOG 44(4), SIGGRAPH 2025. Reference implementation
  [savant117/avbd-demo2d](https://github.com/savant117/avbd-demo2d) (MIT,
  © 2025 Chris Giles).
- **Post-processing stack and final-pass shader** — adapted from the
  "Fly in Particles City" pen (MIT, © 2026 Sabo Sugi).
- **Tube lighting** — representative-point approximation, Karis, *Real Shading in
  Unreal Engine 4*, SIGGRAPH 2013.
- **three.js** (MIT), **lil-gui** (MIT).

Section references (§n) point at the POLTERGEIST design index v1.4.
