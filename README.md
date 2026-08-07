# APPARITION — feel test 02

A ground-up 6DOF prototype under MIT. Flight, an accretion funnel, AVBD debris,
and a reactive light rig, in one room rendered as a **scan** — a quarter of a
million points derived from the collision geometry, eroded rather than fractured.
Nothing else is running.

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
- **The funnel is directional and lagged.** An 11m cone opening from the horizon
  along the look axis, with pull falling off toward the lip and toward the mouth.
  The falloff curve is what makes the lip soft without making the outer cone
  dead, and the lip is where holding happens. Gravity is deliberately *not*
  cancelled inside it, so heavy things sag out of the edge on their own.
- **The pull pulls back.** §3.4 already governs the recoil of a throw and the
  intake is not exempt: hauling on 430kg of bench hauls you toward it at 4 m/s.
  The reaction is clamped rather than scaled — the raw figure near the apex is
  tens of kN and would fire you across the room — and it is most of what
  separates a force from a field.
- **Swirl is not decoration.** Most of the pull is spent tangentially. Tangential
  speed is angular momentum and angular momentum is what keeps matter *out* of
  the horizon, so holding something at the lip is holding its orbit up.

Cost is still §8.3 — mass × acceleration — discounted by how much of the motion
you did not have to originate (§10.2). Pulling from rest is full price; steering
something already doing 9 m/s your way is free. A body you pull halfway in and
then let go of keeps every joule you gave it, which is the whole reason not to
eat everything.

**The world** (`scan.js`) — architecture is a point cloud, and it is the room
rather than a skin over it. The reference is the *House of Cards* video (Frost /
Koblin, 2008), shot [without a single camera or light](https://www.aaronkoblin.com/project/house-of-cards/):
Geometric Informatics structured light for the close work, and a **Velodyne
HDL-64E** — 64 lasers on a head spinning at 900rpm — for everything
environmental. `SCAN`'s numbers are that sensor's: a 26.8° vertical fan running
+2° to −24.8°, and a horizontal step the hardware sets at 0.08°.

The thing that took a rewrite to understand is that **a point cloud is a property
of the sensor, not of the world**. The first version walked every collider face
on a Cartesian grid, which gives a point-ified mesh — evenly dense everywhere, no
voids, no rings, identical density at one metre and at forty. None of that is
fixable by tuning. The points are cast now, from four registered stations, which
buys three things in order of how much they matter:

1. **Occlusion shadows.** A return exists only where a beam reached, so every
   pier throws a wedge of absent points behind it. This is the most recognisable
   thing about the reference and no amount of surface sampling produces it.
2. **Rings.** A fixed vertical fan on a spinning head paints conic sections —
   arcs across a floor, curves up a wall — never a grid aligned to the walls.
3. **Angular density.** Points diverge with range, which is most of how a scan
   conveys depth.

Plus the small authentic failures: range noise lives along the ray and nowhere
else, and returns thin out and then fail at grazing incidence, which is why a
real scan frays across a floor instead of ending at a clean edge.

The one deliberate deviation is the beam count — 32 rather than 64. What you see
is the *ratio* of vertical to horizontal spacing, not the beam count, and 64
rings inside a fixed point budget forces the azimuth step up to meet them, lands
at about one-to-one, and turns the scan back into static. Halving the fan buys
the anisotropy back (3.8:1 against the hardware's 5:1) and spends the saving on
stations, which is what makes the room readable. Every point is generated from `solver.planes`,
`solver.boxes` and the weak panels, so the thing you see cannot disagree with the
thing you hit. The height ramp is a LIDAR convention rather than a lighting
model, and it is doing real work: a point cloud is worst at telling you where you
are, and colour-by-height answers that instantly.

The reason to do this is not that points are prettier. It is that **a point has
no interior**. Carving a mesh means CSG, cap generation and unshaded backfaces;
carving a point set means not drawing some points. So destruction stops being
authored — `destruct.js` needs a hand-built chunk grid and a tuned weld lattice
per panel, which is why this build has three destructible surfaces rather than
three hundred, and the scan erodes everywhere by default.

And erosion is not cosmetic. Each cell of a one-metre grid tracks how many of its
samples survive; below `breachAt` it stops being a surface, and `flight.js` reads
exactly that number when resolving collisions. **You fly through the hole you
cut, and you cannot cut a hole you cannot fly through**, because there is one
occupancy fact underneath both. Measured: 183 points erased opens a passage the
player crosses at speed, while the same wall 3m higher still stops them dead.

Damage is a *field*, which retires a state machine. INTACT/BREACHED/OPEN exists
because a mesh has to be told which discrete configuration it is in; `intact()`
returns a continuous density and an aperture is a place where it is low.

Light fixtures stay solid — a lamp is the source doing the sensing, not
architecture being sensed — and so does loose debris. That second one is a
position rather than a compromise: solidity marks what you can touch, which is
most of what keeps a point-cloud world readable.

**Feedback** (`hydra.js`) — a chain in the shape of Olivia Jack's
[hydra](https://github.com/hydra-synth/hydra), which is a live-coded video synth
built on WebGL framebuffers. One capability is borrowed and it is the one that
makes it: `src(o0)`, sampling an output's *previous frame* and feeding it back
into itself. Hydra does that with a
[ping-pong pair of framebuffers per output](https://github.com/geikha/hyper-hydra/blob/main/doc/hydra-outputs.md)
— two textures alternating read and write roles, because you cannot read and
write one texture in a pass — and exposes more via `setBufferCount()` precisely
to stop coupled feedback period-doubling into a strobe. Same structure here.

The live-coding half is deliberately not borrowed: hydra evaluates JS at runtime,
this compiles one fixed chain with a uniform per stage. The vocabulary is the
subset that produces the look — `src(o0)`, `modulate` (warp one thing's sampling
coordinates by another's brightness, which is *the* operator), `rotate`, `scale`,
`colorama`, `diff`.

**And it is not only a screen filter.** The accumulated buffer is handed back to
`scan.js`, and every point samples it at its own *previous-frame screen position*
to displace and recolour itself. So the geometry is warped by the after-image of
the geometry — output becomes input at the world level, not just the frame. A
point off screen last frame reads black, which is correct: an unseen thing has no
after-image.

The defaults sit below runaway on purpose. A screen blend has a fixed point at
`p = 1 − (1 − feedback·p)(1 − live)`, and the first pass at 0.88 / 0.62 landed
around 0.93 — the loop filled the frame with rolling colour in two seconds and
the room vanished inside its own trail. That is a real hydra behaviour and worth
reaching on the sliders; it cannot be the resting state of a world you fly
through.

**The patch bay** (`modulation.js`) — hydra's syntax is
["inspired by analog modular synthesis, in which chaining or patching a set of
transformations together generates a visual result"](https://github.com/hydra-synth/hydra).
The half that metaphor implies and a slider panel does not is *routing*.

Every number the look is made of is a destination — the feedback chain, the
scan's density and ramp, the post grade. Everything the game knows about itself
is a source: speed, how full the disc is, power drawn, thermal debt, funnel open,
channelling, impact, mass just eaten, how badly the room *near you* has been
eroded, light remaining, dilation, height, proximity. Routes are data, so a look
is a list rather than a branch in the render loop.

| state | drives | measured |
|---|---|---|
| full disc | `kaleid` | 0 → 3.6 sides; the frame folds under load |
| speed + burn | `feedback` | 0.70 → 0.84; the loop drags |
| funnel open | `rotate` | 0.021 → 0.076; the field turns into the intake |
| wrecked ground | `pixelate` | 0 → 121; standing in your own damage |

Three properties this has that hard-wiring does not. Routes are **additive around
the sliders**, so tuning by hand and modulating by state do not fight. Every
source has its own **attack and release** — a hit is two frames, and a raw route
on it clicks where separate rise and fall times make it swell and decay. And
**zones are the same mechanism with a different address**: a region carries
parameter *offsets* and a feather distance, so crossing a boundary cross-fades,
and overlapping zones sum into somewhere neither describes alone.

**Metasurfaces** (`metasurface.js`) — Ross Bencina's
[Metasurface](https://www.researchgate.net/publication/221165071_The_Metasurface_Applying_Natural_Neighbour_Interpolation_to_Two-to-Many_Mapping)
(NIME 2005) is an interface for designing two-to-many mappings by *placing
parameter snapshots on a plane* and interpolating between them as a cursor moves
across it. His argument is the choice of interpolation: natural neighbour is
local and Voronoi-based, and he contrasts it against global field methods on
exactly the grounds that matter here — predictability, and holding detail at
several scales on one surface without a preset across the room quietly
influencing this corner of it.

It replaces the zones, which were spheres with a radius and a feather: two
hand-tuned numbers per region, overlaps summing to more than one and gaps to
less. A metasurface has no radius. Presets are dropped where they belong and
every point gets a blend whose weights sum to one by construction — **placement
is the authoring**.

Sibson's weights are area-stealing: insert the query into the Voronoi diagram and
each natural neighbour's weight is the fraction of its cell that was taken. Doing
that exactly means real computational geometry, so this uses the standard
[discrete form](https://en.wikipedia.org/wiki/Natural_neighbor_interpolation) —
scatter samples around the query, find each one's nearest preset, and credit a
steal wherever the query is closer than that preset is. Verified against the
properties that make it worth using:

| | |
|---|---|
| exact at a preset | standing on one gives it weight 1.000 and the value back unchanged |
| partition of unity | weights sum to exactly 1.0 at every point tested |
| local | at 8m from one preset it takes 75%, the two far ones 13% each |
| continuous | a walk across the surface moves `kaleid` 0 → 2.3 → 6.0 → 8.7 → 12 |
| outside the hull | degrades to the nearest pair rather than failing |

**Layers**: three surfaces — `look` (the hydra chain), `world` (the scan), `feel`
(the funnel) — each owning a disjoint set of parameters, because the topology of
where the look changes has no reason to match where the mechanics do. Presets
carry a height and a band, so a building is a stack of two-dimensional surfaces
rather than one three-dimensional one, which is both cheaper and how buildings
actually are.

**The editor is one gesture**: dial the look on the panel, fly to where it
belongs, press `K`. Capture reads the *base* — what the sliders say — not the
live composite, so a preset describes a place rather than whatever cue happened
to be up as you flew through. `bake` writes the whole set to the clipboard as
pasteable source, same as the tuning export, because a level that lives in a blob
nobody can read is a level nobody edits.

**Cues** (`modulation.js`) — above the routes sit scenes, and the right prior art
is a lighting desk cue rather than a VJ bank: a named set of *absolute* levels, a
fade-in time, a fade-out time, and a condition that fires it. **Two ramps rather
than one is the whole point** — a swell that decays at the speed it arrived reads
as a switch, and all the interesting behaviour is in the asymmetry between how
fast something arrives and how long it takes to let go.

Triggers return 0..1 rather than true/false, and `all` is multiplicative, so
"channelling near the pool" comes up *half way* when you are half way into the
pool. A cue is a gradient in two dimensions at once — how true its condition is,
and how far along its ramp it has got.

Measured on `channelling in the pool` (1.5 s in, 3.4 s out):

| | 0 s | 1 s | 2 s | 3.5 s |
|---|---|---|---|---|
| holding fire | sat 1.31, kaleid 0.1 | 1.79 / 3.9 | 2.04 / 5.9 | 2.20 / 7.2 |
| released | sat 2.23, kaleid 7.4 | 2.08 / 6.2 | 1.88 / 4.6 | 1.67 / 3.0 |

`hold` is what makes a one-frame trigger usable: an impact is true for a single
frame, and without a latch the ramp reverses before it has arrived. With it, a
hit takes `invert` to 0.93 in a third of a second and spends two more seconds
coming back.

The layering, in order, because the order is what makes it predictable:

```
base     the sliders, re-read every frame
scenes   blended toward — absolute, weighted by each cue's ramp
zones    added — spatial offsets, feathered, and they sum
routes   added — source × amount, optionally gated by a zone
```

Scenes are absolute and blend; zones and routes are relative and add. A cue says
*here is the look*; a zone and a route say *and lean it this way*.

Cross-modulation between areas falls out of one line: every zone publishes its
weight as a source named `zone:<name>`, and a route takes an optional `via`. So
"speed drives kaleid, but only among the piers" is a patch (measured: kaleid 1.3
elsewhere, 8.8 at the piers), and one region driving a parameter another region
owns is a route from one zone's weight.

**Shards** (`shred.js`) — the ammunition is not rigid bodies. It cannot be: the
solver caps at 640 with a contact graph behind each one, so "more debris" bought
more cost and never bought the feeling of something being torn apart. Eight
cuboids is a brick-throwing simulator however fast the bricks go.

The split the wind-engineering literature already draws is the one to use. Debris
is classed as compact, plate or rod and rated by the **Tachikawa number** — the
ratio of aerodynamic force to weight, so area over mass. A brick has a terrible
ratio and flies ballistically; a splinter has an enormous one and goes wherever
the air goes. The large-eddy tornado studies find the same split from the other
side: heavy debris is thrown out of the vortex by its own inertia while light
debris stays trapped circulating in the core, and it is the fine material in the
corner flow that actually alters the wind field.

So there are two representations, split where the physics splits them. Rigid
bodies stay the compact class — few, heavy, ballistic, colliding properly.
Shards are the plate class: thousands of them, no pairwise anything, tested only
against static planes, room colliders and the three weak panels. They are what
the funnel carries and what a jet is made of, and they are drawn as
**velocity-aligned stretched needles**, which is the single largest lever on
whether fast debris reads as sharp or as boxes drifting past.

Eating something no longer makes it vanish. It **bursts** — 13 shards for a 5 kg
paver, 90 for a 430 kg bench, carrying the velocity the body arrived with and
then spiralling in like everything else in the funnel. And what the disc carries
is visible: bound shards orbit a ring set out in front of the viewpoint, filling
as you eat and thinning as you spend.

Firing drains the pool along the axis at 62 m/s as a **held stream**, not a
click. A jet is a rate, so recoil is a continuous burn rather than a kick. The grain decides everything about the
shot except its recoil: the same 16 kg/s leaves as 1140 glass needles a second or
as 60 steel grains, identical mass flow and identical push, sandblasting versus
punching. Shard strikes are billed in the same currency as a thrown chunk —
joules — so a jet and a slug are comparable rather than each being a special
case.

Structure is not food — a chunk still welded into a wall is refused, because
hoovering it out of the lattice would route around the entire destruction model.
Walls come apart under force, not under suction. Holding the funnel on a live
panel still breaks welds; it just cannot skip the step.

Measured at the shipped numbers, on a 78 kg block released from 7m:

| | |
|---|---|
| slingshot, 0.1 / 0.2 / 0.3 / 0.4 s hold | 7.8 / 14.4 / 20.6 / 25.7 m/s — 616 / 1135 / 1620 / 2020 N·s |
| hold past 0.5 s | eaten instead |
| a 430 kg bench, from resting on the floor | lifted and eaten in 0.30 s, peaking at 17 m/s; you get hauled to 4.1 m/s |
| cost at 0 / 6 / 12 m/s already inbound | 377 / 199 / 21 W |
| capture inside the cone | ~45% over the full 11m volume, mean 0.36 s; the misses are the lip and the mouth |
| funnel held on a live panel, 4 s | 43 welds broken, 3 loose chunks eaten, 34 still welded and untouched |
| solver, 107 loose bodies → after eating 85 | 0.33 → 0.21 ms/step, 21 → 3 contacts |
| eating a 5 / 80 / 430 kg body | bursts into 13 / 40 / 90 shards |
| the stream, at 16 kg/s | tile 240/s, concrete 180/s, glass 1140/s, steel 60/s — same mass, same 14 m/s of recoil |
| cutting an intact partition open | steel 0.5 s to bite and 1.4 s to breach, glass 0.6 / 1.9, concrete 0.9 / 2.1 |
| 1527 shards | 0.103 ms/frame, against 0.41 ms/step for 120 rigid bodies |
| the scan | 193,732 points from 202,460 cast beams, built in 236 ms |
| `carve()` / `passable()` | 8 µs / under 0.1 µs |
| cutting a passage | 183 points erased; the player crosses at 9 m/s where 3m higher still stops them |
| LOD | a `drawRange` over a shuffled set — any prefix is an unbiased sample of the room, so thinning to 42% costs nothing and is spatially even |

The slingshot curve is the whole mechanic in one row: a 0.4 s hold releases 2020
N·s and 26 kJ — well over twice what a fired shot carries — and a 0.5 s hold
releases nothing, because you ate it. That is the decision the horizon was added
to create, and it is why redirecting mass stays better than originating it
(§10.2). The window narrows as things get closer: from 5m it is 0.1 to 0.3 s.

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
be tuned. There is no artifact slot yet — everything consumable is
currently consumed, and the "held object in peripheral vision" half of the
inventory does not exist. The disc renders as orbiting shards rather than as
occlusion at the frame edge, so the "mud on the lens" register is still to come. The HUD is a development instrument, not interface design; §26
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
