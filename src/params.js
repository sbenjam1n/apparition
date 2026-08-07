// The parameter table.
//
// One declaration per tunable, in one place, read by everything that needs to
// know about it: the panel builds its sliders from this, the modulation system
// builds its destination list from this, and the clamp that stops a route
// driving a parameter somewhere it cannot come back from is this table's `max`.
//
// It exists because the previous arrangement violated open/closed in the way
// that actually costs you. Ranges were literals inside gui.add() calls, the
// routable set was a hand-picked list somewhere else, and adding a parameter
// meant editing both and remembering a third thing — the safe range — that was
// written down nowhere at all. So a route could sum past a limit that only
// existed in a comment.
//
// Concretely, and this is the bug that prompted the rewrite: HYDRA.feedback sat
// at 0.70, one route added up to 0.16 and another up to 0.25, and at 1.11 the
// feedback loop multiplies by more than one every pass and fills the frame.
// Nothing clamped it because nothing knew 1.0 was a wall, and nothing showed the
// sum because the contributions were never separable. Both of those are
// properties of the table, not of the routes.
//
// Nothing here clamps anything. That was the first draft and it was the wrong
// instinct: I cannot see the screen, so limits I invent are guesses dressed up
// as safety, and a limit that silently swallows a route is worse to debug than
// the runaway it was hiding. `warnAbove` is diagnostic only — it makes the panel
// and the readout say "this is past the point where the loop stops contracting",
// and then gets out of the way. Deliberately breaking it is a legitimate thing
// to want, and the whole reason for the readout is so that it is obvious when
// you have.

// p( path, min, max, step, label, opts )
const p = ( path, min, max, step, label, opts = {} ) =>
	Object.assign( { path, min, max, step, label }, opts );

export const PARAMS = [

	// --- hydra ---------------------------------------------------------------
	p( 'HYDRA.feedback', 0, 1.4, 0.005, 'src(o0) survives', { folder: 'Hydra', warnAbove: 1 } ),
	p( 'HYDRA.live', 0, 1.5, 0.02, 'live injection', { folder: 'Hydra' } ),
	p( 'HYDRA.decay', 0, 0.05, 0.001, 'bleed to black', { folder: 'Hydra' } ),
	p( 'HYDRA.modAmount', 0, 0.06, 0.0005, 'modulate', { folder: 'Hydra' } ),
	p( 'HYDRA.modScale', 0.2, 14, 0.1, 'modulate scale', { folder: 'Hydra' } ),
	p( 'HYDRA.modSpeed', 0, 2, 0.01, 'modulate speed', { folder: 'Hydra' } ),
	p( 'HYDRA.selfModulate', 0, 3, 0.05, 'self-modulate', { folder: 'Hydra' } ),
	p( 'HYDRA.fieldMix', 0, 1, 0.02, 'osc <-> voronoi', { folder: 'Hydra' } ),
	p( 'HYDRA.modScaleAmount', - 0.1, 0.1, 0.002, 'modulateScale', { folder: 'Hydra' } ),
	p( 'HYDRA.modRotateAmount', - 0.4, 0.4, 0.005, 'modulateRotate', { folder: 'Hydra' } ),
	p( 'HYDRA.kaleid', 0, 16, 1, 'kaleid (sides)', { folder: 'Hydra' } ),
	p( 'HYDRA.repeatX', 0, 12, 1, 'repeat x', { folder: 'Hydra' } ),
	p( 'HYDRA.repeatY', 0, 12, 1, 'repeat y', { folder: 'Hydra' } ),
	p( 'HYDRA.rotate', - 0.4, 0.4, 0.005, 'rotate / pass', { folder: 'Hydra' } ),
	// Above one, every bright pixel is pushed outward on every pass and a single
	// lit point becomes the whole frame given enough seconds. Which is how
	// tunnels are made, so it is not a mistake — it just needs to be visible.
	p( 'HYDRA.zoom', 0.94, 1.06, 0.001, 'zoom / pass', { folder: 'Hydra', warnAbove: 1 } ),
	p( 'HYDRA.drift', - 0.2, 0.2, 0.002, 'drift along look axis', { folder: 'Hydra' } ),
	p( 'HYDRA.colorama', - 0.15, 0.15, 0.002, 'colorama', { folder: 'Hydra' } ),
	p( 'HYDRA.saturate', 0, 3, 0.02, 'saturate', { folder: 'Hydra' } ),
	p( 'HYDRA.chromaSplit', 0, 0.01, 0.0002, 'chroma split', { folder: 'Hydra' } ),
	p( 'HYDRA.pixelate', 0, 400, 2, 'pixelate', { folder: 'Hydra' } ),
	p( 'HYDRA.posterize', 0, 24, 1, 'posterize', { folder: 'Hydra' } ),
	p( 'HYDRA.thresh', 0, 1, 0.01, 'thresh', { folder: 'Hydra' } ),
	p( 'HYDRA.threshTol', 0.01, 0.5, 0.01, 'thresh tolerance', { folder: 'Hydra' } ),
	p( 'HYDRA.invert', 0, 1, 0.02, 'invert', { folder: 'Hydra' } ),
	p( 'HYDRA.shiftR', - 0.1, 0.1, 0.002, 'shift r', { folder: 'Hydra' } ),
	p( 'HYDRA.shiftG', - 0.1, 0.1, 0.002, 'shift g', { folder: 'Hydra' } ),
	p( 'HYDRA.shiftB', - 0.1, 0.1, 0.002, 'shift b', { folder: 'Hydra' } ),
	// The other half of the runaway pair. The loop is contractive only while the
	// product of feedback and gain stays under one, which the readout reports.
	p( 'HYDRA.gain', 0.6, 1.6, 0.01, 'gain', { folder: 'Hydra', warnAbove: 1 } ),
	p( 'HYDRA.worldDisplace', 0, 3, 0.02, 'world displace (m)', { folder: 'Hydra' } ),
	p( 'HYDRA.worldTint', 0, 2, 0.02, 'world tint', { folder: 'Hydra' } ),

	// --- the scan ------------------------------------------------------------
	p( 'SCAN.pointSize', 0.5, 8, 0.1, 'point size (px @ 1m)', { folder: 'Scan' } ),
	p( 'SCAN.sizeFalloff', 0, 1.2, 0.02, 'size falloff', { folder: 'Scan' } ),
	p( 'SCAN.maxPixels', 1, 12, 0.5, 'max px', { folder: 'Scan' } ),
	p( 'SCAN.lit', 0, 1, 0.02, 'ramp <-> rig', { folder: 'Scan' } ),
	p( 'SCAN.glow', 0, 3, 0.05, 'return glow', { folder: 'Scan' } ),
	p( 'SCAN.fogMix', 0, 1, 0.02, 'atmosphere on scan', { folder: 'Scan' } ),
	p( 'SCAN.sparkle', 0, 1, 0.02, 'shimmer', { folder: 'Scan' } ),
	p( 'SCAN.rampFloor', - 4, 4, 0.1, 'ramp floor (m)', { folder: 'Scan' } ),
	p( 'SCAN.rampCeil', 2, 14, 0.1, 'ramp ceiling (m)', { folder: 'Scan' } ),
	p( 'SCAN.loosen', 0, 2, 0.02, 'loosen before drop', { folder: 'Scan' } ),
	p( 'SCAN.breachAt', 0.02, 0.9, 0.01, 'breach threshold', { folder: 'Scan' } ),

	// --- the funnel ----------------------------------------------------------
	p( 'ACC.reach', 2, 24, 0.5, 'reach (m)', { folder: 'Accretion' } ),
	p( 'ACC.mouthAngle', 0.1, 1.3, 0.01, 'mouth half-angle', { folder: 'Accretion' } ),
	p( 'ACC.horizon', 0.3, 4, 0.05, 'event horizon (m)', { folder: 'Accretion' } ),
	p( 'ACC.intake', 0, 500, 5, 'pull (m/s2)', { folder: 'Accretion' } ),
	p( 'ACC.reaction', 0, 2, 0.05, 'reaction', { folder: 'Accretion' } ),
	p( 'ACC.reactionCeiling', 0, 4000, 50, 'reaction cap (N)', { folder: 'Accretion' } ),
	p( 'ACC.swirl', 0, 0.95, 0.01, 'swirl', { folder: 'Accretion' } ),
	p( 'ACC.viscosity', 0, 20, 0.1, 'viscosity (1/s)', { folder: 'Accretion' } ),
	p( 'ACC.axisLag', 0, 0.5, 0.005, 'axis lag (s)', { folder: 'Accretion' } ),
	p( 'ACC.freeSpeed', 1, 30, 0.5, 'free speed', { folder: 'Accretion' } ),
	p( 'ACC.capacity', 100, 4000, 25, 'capacity (kg)', { folder: 'Accretion' } ),
	p( 'ACC.fireSpeed', 5, 140, 1, 'muzzle (m/s)', { folder: 'Accretion' } ),
	p( 'ACC.channelRate', 2, 200, 1, 'kg/s channelled', { folder: 'Accretion' } ),
	p( 'ACC.streamDensity', 0.1, 4, 0.05, 'stream density', { folder: 'Accretion' } ),
	p( 'ACC.channelSpread', 0, 0.6, 0.01, 'jet spread', { folder: 'Accretion' } ),
	p( 'ACC.jetSwirl', 0, 1, 0.01, 'jet swirl', { folder: 'Accretion' } ),
	p( 'ACC.jetTwist', 0, 120, 1, 'jet twist (rad/s)', { folder: 'Accretion' } ),
	p( 'ACC.discOffset', 0, 6, 0.05, 'disc distance', { folder: 'Accretion' } ),
	p( 'ACC.discRadius', 0.4, 5, 0.05, 'disc radius', { folder: 'Accretion' } ),
	p( 'ACC.discSpin', 0, 16, 0.1, 'disc spin', { folder: 'Accretion' } ),
	p( 'ACC.discShards', 0, 1600, 10, 'disc shards', { folder: 'Accretion' } ),
	p( 'ACC.carryWattsPerKg', 0, 0.2, 0.002, 'W per kg carried', { folder: 'Accretion' } ),
	p( 'ACC.intakeWattsPerKg', 0, 0.6, 0.005, 'W per kg.a', { folder: 'Accretion' } ),

	// --- shards --------------------------------------------------------------
	// These four are shader uniforms. They are declared here like everything else
	// and pushed to the GPU once a frame by shred.js, rather than by an onChange
	// hook on a slider — a route has to move them too, and a route never touches
	// the panel.
	p( 'SHRED.stretch', 0, 0.08, 0.001, 'stretch (m per m/s)', { folder: 'Shards' } ),
	p( 'SHRED.maxLength', 0.05, 2, 0.01, 'max length', { folder: 'Shards' } ),
	p( 'SHRED.width', 0.002, 0.14, 0.001, 'width', { folder: 'Shards' } ),
	p( 'SHRED.minAngular', 0, 0.012, 0.0002, 'min angular width', { folder: 'Shards' } ),
	p( 'SHRED.drag', 0, 4, 0.05, 'drag (1/s)', { folder: 'Shards' } ),
	p( 'SHRED.lifeMax', 0.3, 8, 0.1, 'life (s)', { folder: 'Shards' } ),
	p( 'SHRED.strikeScale', 0, 0.3, 0.005, 'cut rate', { folder: 'Shards' } ),
	p( 'SHRED.bounce', 0, 0.9, 0.02, 'bounce', { folder: 'Shards' } ),

	// --- post ----------------------------------------------------------------
	p( 'POST.bloomStrength', 0, 3, 0.02, 'bloom strength', { folder: 'Post' } ),
	p( 'POST.bloomRadius', 0, 1.5, 0.02, 'bloom radius', { folder: 'Post' } ),
	p( 'POST.bloomThreshold', 0, 1.2, 0.01, 'bloom threshold', { folder: 'Post' } ),
	p( 'POST.grain', 0, 0.2, 0.002, 'grain', { folder: 'Post' } ),
	p( 'POST.vignette', 0, 2, 0.02, 'vignette', { folder: 'Post' } ),
	p( 'POST.scanline', 0, 0.1, 0.001, 'scanline', { folder: 'Post' } ),
	p( 'POST.exposure', 0.2, 2.5, 0.02, 'exposure', { folder: 'Post' } ),
	p( 'POST.chromaticShift', 0, 0.02, 0.0005, 'chromatic shift', { folder: 'Post' } ),

	// --- flight --------------------------------------------------------------
	p( 'TUNING.thrustScale', 0.05, 2, 0.01, 'thrust', { folder: 'Flight' } ),
	p( 'TUNING.burnMultiplier', 1, 4, 0.05, 'burn multiplier', { folder: 'Flight' } ),
	p( 'TUNING.drag', 0.005, 0.12, 0.001, 'drag', { folder: 'Flight' } ),
	p( 'TUNING.recoilMass', 10, 300, 5, 'recoil mass (kg)', { folder: 'Flight' } ),
	p( 'TUNING.mouseSensitivity', 0.02, 2, 0.01, 'mouse', { folder: 'Flight' } ),
	p( 'TUNING.keyRotScale', 0.2, 6, 0.05, 'arrow rate', { folder: 'Flight' } ),
	p( 'TUNING.rollThrustScale', 0.2, 4, 0.05, 'roll', { folder: 'Flight' } ),
	p( 'TUNING.autoLevelRate', 0, 3, 0.05, 'auto-level rate', { folder: 'Flight' } ),
	p( 'TUNING.wiggle', 0, 3, 0.05, 'wiggle', { folder: 'Flight' } ),
	p( 'TUNING.cameraLag', 0, 0.2, 0.002, 'position lag', { folder: 'Flight' } ),
	p( 'TUNING.cameraLagPerKg', 0, 0.01, 0.0002, 'lag per kg', { folder: 'Flight' } ),
	p( 'TUNING.rotationLag', 0, 0.2, 0.002, 'rotation lag', { folder: 'Flight' } ),
	p( 'TUNING.swayAmount', 0, 3, 0.05, 'sway', { folder: 'Flight' } ),
	p( 'TUNING.bankScale', 0, 0.4, 0.002, 'bank scale', { folder: 'Flight' } ),
	p( 'TUNING.bankMaxDeg', 0, 45, 0.5, 'bank cap (deg)', { folder: 'Flight' } )

];

export const BY_PATH = new Map( PARAMS.map( q => [ q.path, q ] ) );

export const FOLDERS = [ ...new Set( PARAMS.map( q => q.folder ) ) ];

export function paramsIn( folder ) {

	return PARAMS.filter( q => q.folder === folder );

}

// Diagnostic only. Returns the threshold past which this parameter is known to
// misbehave, or null. Nothing acts on it except the readout.
export function warnLevel( path ) {

	const q = BY_PATH.get( path );
	return q && q.warnAbove !== undefined ? q.warnAbove : null;

}
