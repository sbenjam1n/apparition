# APPARITION — feel test 02

A ground-up 6DOF prototype under MIT. Flight, an accretion funnel, authored
destruction, AVBD debris, and a reactive light rig, in one tiled liminal room
with nothing else running.

This exists to answer one question, which the design index calls **the killing
test** (§29, Phase 0):

> Is flying, grabbing and throwing heavy objects with Newtonian recoil delightful
> in an empty room — no enemies, no economy, no dilation? Answer this in week two,
> not month eight.

Feel test 02 changes what "grabbing" means. The apparition is not a point that
carries objects around itself; it is a tornado with an event horizon. Matter
inside the funnel is drawn in and spun, matter that crosses the horizon is
consumed into a per-material pool, and the pool is fired back out as debris. The
question the change is meant to answer is narrower than the one above and it is
the only reason the funnel exists yet: **does holding something at the lip feel
like a skill, and does eating it feel like a decision?**

Everything else in the index is superstructure over that, so this build runs
exactly that experiment and adds only what is needed to judge it honestly.

## Playing it

**<https://sbenjam1n.github.io/apparition/>** once Pages is switched on — see
[Deploying](#deploying) for the one setting that needs flipping.

Locally, no build step and no install:

```
python3 -m http.server 8080     # or: npx http-server -p 8080
open http://localhost:8080
```

Three.js and lil-gui load from jsDelivr via an import map, so the only
requirement is a browser with WebGL2. Click to lock the pointer.

| | |
|---|---|
| `W A S D` | thrust / strafe |
| `Space` / `Shift` | thrust up / down |
| `Q` `E` | roll |
| mouse | pitch / yaw |
| arrow keys | pitch / yaw — held and exact |
| `Ctrl` | burn — extra thrust |
| `LMB` | intake — hold the funnel open |
| `RMB` | fire the selected material (recoil applies) |
| wheel | switch material |
| `R` | vent — dump the load; the mass is gone |
| `F` | probe — reads mass, material, structural weakness |
| alt + wheel | dilation dial |
| `G` | reset position |
| `P` | copy current tuning to the clipboard |
| `Tab` | show / hide the tuning panel |
| `Esc` | release the cursor — the scene keeps running and the panel stays live |

**Open the tuning panel.** Feel cannot be judged from someone else's numbers, and
the panel is the actual instrument here — the rest of the build is apparatus
around it. Flight, camera, accretion, solver and lighting are all live.

**`P` copies what you dialled.** It writes the diff against the build defaults to
the clipboard as pasteable assignments, and prints the same thing to the console
in case the browser refuses the clipboard. With nothing changed it emits the full
snapshot instead. A tuning pass is worth nothing if it does not survive the tab
being closed.

```
// APPARITION tuning — 3 changed from build defaults
TUNING.thrustScale             = 0.62;
POST.grain                     = 0.09;
rig.uniforms.uFogColor.value.set( '#123456' );
```

## What is in it

**Flight** (`flight.js`) — Descent's model kept deliberately intact: fixed 1/64s
substeps, one drag coefficient on both linear and angular velocity, thrust as a
per-substep delta-v rather than an acceleration, sinusoidal wiggle, turn-induced
banking, softened auto-level. Constants come from Descent's `PLAYER_SHIP` entry
by way of mrdoob's three.js port. Two things are not Descent's: thrust is scaled
down (Descent's own terminal velocity crosses this 28m room in half a second), and
the camera trails the player's transform on a spring that gets heavier as you carry
more. A viewpoint that lags input has mass, and mass reads as embodiment (§47.2)
— it is the only body this character gets.

**Accretion** (`accretion.js`) — probe, intake, consume, fire, vent. This
supersedes the held-object orbit §47.3 built the body out of, and the reason is
that deflect-versus-consume becomes *spatial* instead of a button. Three things
fall out of that:

- **The horizon is always live.** A sphere around the viewpoint; anything inside
  it is consumed, whether or not you meant it. Fly into your own wreckage and it
  goes. It is also the only garbage collector this build has — consumed bodies
  leave the solver instead of piling up against its cap.
- **The funnel is directional and lagged.** A cone opening from the horizon along
  the look axis, with pull falling off toward the lip and toward the mouth.
  Squaring the radial term is what gives the lip its softness, and the lip is
  where holding happens. Gravity is deliberately *not* cancelled inside it, so
  heavy things sag out of the edge on their own.
- **Swirl is not decoration.** Most of the pull is spent tangentially. Tangential
  speed is angular momentum and angular momentum is what keeps matter *out* of
  the horizon, so holding something at the lip is holding its orbit up.

Cost is still §8.3 — mass × acceleration — discounted by how much of the motion
you did not have to originate (§10.2). Pulling from rest is full price; steering
something already doing 9 m/s your way is free. A body you pull halfway in and
then let go of keeps every joule you gave it, which is the whole reason not to
eat everything.

Firing drains the pool along the axis. The material decides the *shape* of the
shot rather than its recoil: the same 25 kg leaves as one concrete slug carrying
400 N·s or as thirteen glass shards carrying 29 N·s each. Recoil is momentum
conservation either way (§3.4) and it is a real shove.

Structure is not food — a chunk still welded into a wall is refused, because
hoovering it out of the lattice would route around the entire destruction model.
Walls come apart under force, not under suction. Holding the funnel on a live
panel still breaks welds; it just cannot skip the step.

Measured at the shipped numbers, on a 78 kg block:

| | |
|---|---|
| slingshot, 0.2 / 0.4 / 0.6 s hold | 5.9 / 10.3 / 14.0 m/s — 462 / 811 / 1102 N·s |
| hold past 0.8 s | eaten instead |
| cost at 0 / 6 / 12 m/s already inbound | 307 / 162 / 18 W |
| capture inside the cone | ~68%; the misses are the lip and the mouth |
| funnel held on a live panel, 4 s | 28 welds broken, 4 loose chunks eaten, 33 still welded and untouched |
| solver, 107 loose bodies → after eating 84 | 0.27 → 0.21 ms/step, 21 → 3 contacts |
| one shot of 25 kg | tile 3 pieces @ 130 N·s, concrete 1 @ 409, glass 13 @ 29, steel 1 @ 216 |

The slingshot curve is the whole mechanic in one row: a 0.6 s hold releases more
momentum than a fired shot carries, and a 0.8 s hold releases nothing because you
ate it. That is the decision the horizon was added to create.

**Destruction** (`destruct.js`) — authored chunk sets welded together by a joint
graph, so panels hole where you hit them instead of detaching all at once. See
[Bonds](#bonds-the-joint-graph) below.

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

## Bonds: the joint graph

A panel is a fixed grid of authored chunks — still discrete, still no runtime
fracture (§7.4) — welded to each other and to the frame by six-row joints: three
linear rows holding a pair of anchors coincident, three angular rows holding a
relative orientation. Hit it and only the welds near the impact exceed their
fracture load, so three chunks drop out and leave a ragged hole with the rest
still standing. Hit it somewhere else and you get a different hole. Roughly 93
constraints for a 42-chunk panel, against the ~5,000 a particle lattice at the
same resolution would need.

**Fracture reads λ, not stretch.** λ is the Lagrange multiplier — the force the
constraint is actually carrying, in newtons — so "this weld shears at 9kN"
survives every change to stiffness, iteration count and timestep. A stretch
threshold has to be re-tuned when any of those move. Measured: a 42-chunk panel
weighs 12,361 N and its frame welds carry 640 N each at rest, against a predicted
562 N. Fracture thresholds sit 14× above that.

**Collapse is connectivity, not simulation.** §32.3, Siege's rule: a piece that
loses its path to the frame falls, anything still attached stays. Union-find over
the surviving welds, microseconds, no structural solver. Orphaned chunks are
woken explicitly — gravity only integrates for awake bodies, and breaking a weld
only wakes its own two ends, so a chunk three hops away can be orphaned without
ever being touched.

**Welds creep before they let go** (§45.5, the delayed shred). Above a yield
fraction of the break load a joint accumulates damage that permanently shrinks
its effective strength, so an overloaded panel sags and drops seconds later
rather than popping. Under dilation those seconds are a very long time.

**§31.3 survives, because the enumerable thing is aperture topology.** The
verifier does not care which of 2^93 weld subsets survived — it cares whether
there is a hole the player fits through. Three states per panel (INTACT /
BREACHED / OPEN) stay exhaustively checkable with the lattice as cosmetic detail
underneath, and the player's own collision runs against the same open-cell grid
the aperture test reads, so what the verifier proves and what the controls permit
cannot drift apart. The partition panel in the middle of the room is there to
make that concrete: blowing it open produces a route, not a readout.

Material character comes from the weld parameters rather than from one strength
number. Horizontal bed joints are weaker than vertical head joints, so failure
tends to run in courses; perimeter welds are stronger than field welds, so a
panel prefers to hole in the middle rather than fall out whole. The three test
panels are tuned to fail visibly differently: coursed block, water-damaged, and
well-tied-and-stiff.

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

Contacts are generated at the *predicted* end-of-step position and their penalty
is seeded from `M/dt²`, so a constraint is competitive with inertia on its first
iteration. Seeded at the default floor instead, a contact produces about a newton
on iteration one and a fast body sails straight through a wall before the ramp
catches up. The step also subdivides adaptively — at 60Hz, 20 m/s is 0.33 m per
step against a 0.28 m panel, so nothing is allowed to travel more than 0.14 m at
a time. Costs nothing at rest, because the substep count is 1 unless something is
actually moving.

**Measured**: 473 bodies with no joints cost **1.37 ms per solver step**. The
worst case built here — 440 bodies, 3 live panels, 238 welds, 900 dust particles,
3 substeps — costs **5.4 ms per step**, or 1.8 ms per substep. Numbers from a
headless container CPU, so treat them as an order of magnitude, not a promise.

One thing worth flagging for the design index: §10.8 claims large object counts
are affordable *because* the fight is slow. That is not hand-waving — low relative
velocity is exactly the regime where a position-based solver converges in one or
two iterations. Dilation genuinely is the cheap case here. Wind the wheel and
watch the contact count against frame time.

### Things that were wrong, recorded so they are not re-attempted

- **Bounding spheres for pair contacts.** Phantom-collides anything elongated: a
  1.8m bench has a 0.94m bounding sphere, so it collided with objects a metre
  away and the penalty ramp launched both bodies at 22 m/s.
- **Testing only same-cell pairs in the uniform grid.** Silently drops every
  contact that straddles a cell boundary — roughly half of them — and the failure
  looks exactly like objects randomly passing through each other.
- **Leaving sleeping bodies out of the broadphase.** Makes every settled object a
  ghost. Easy to mistake for correct behaviour, because settled things are
  usually not being hit.
- **Low-pass filtering λ to reject fracture noise.** Wrong direction: the settle
  transient is slow and an impact is two frames, so no low-pass separates them.
  Fixed the cause instead — seeding the weld penalty so there is no transient.
- **Recomputing panel state only on fracture events.** Chunks fall out for
  seconds after the last weld goes, so the aperture never registered.

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
The watt meter exists only because destruction and the funnel need some cost to
feel weighted, and because a feel test that cannot show you its cost curve cannot
be tuned. There is no funnel *visual* at all yet, on purpose: the funnel is a rule
that either feels like a skill or does not, and set dressing over an unproven rule
only makes it harder to tell. Nor is there an artifact slot — everything
consumable is currently consumed. The HUD is a development instrument, not interface design; §26
and §47.3 conclude the shipping game has no HUD at all.

Known rough edges: player-vs-world collision is a 4-iteration push-out rather than
a swept test (fine at these speeds, would tunnel at Descent speeds); pair contacts
degrade under deep interpenetration; and the input budget flagged in §51.7 has now
actually run out — material select and the dilation dial both want the wheel, and
alt is standing in for a resolution that does not exist yet.

## Deploying

The site is static — `index.html` plus ES modules, no build step, no bundler —
and every internal path is relative, so it works from the `/apparition/` project
subpath unchanged. `.nojekyll` sits at the root so files are served verbatim.

**Use branch-based Pages.** One setting, no CI:

> **Settings → Pages → Build and deployment → Source: Deploy from a branch →
> `main` → `/ (root)`**

That publishes through GitHub's own Pages builder. Nothing else is needed.

`.github/workflows/pages.yml` is the Actions-based alternative, for if Pages is
set to "GitHub Actions" as its source instead. It is **manual-dispatch only** on
purpose: an Actions-source deploy that cannot get a runner sits in `queued`
indefinitely rather than failing, and firing it on every push just accumulates
stuck runs. Trigger it from the Actions tab if you want that route.

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
