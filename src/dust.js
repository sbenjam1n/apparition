// Dust.
//
// Not a particle effect. In this game dust is *evidence*: §50 makes detection
// inferential — the building estimates you from anomalies rather than seeing you
// — so a cloud hanging in a room is something the BMS can reason about. And
// §38's accretion enemies are made of exactly this, so the dust has to be
// gatherable matter rather than a screen-space flourish.
//
// That argues for two representations, and this keeps both:
//
//   * A GPU instance pool for the look. One draw call, lit by the same rig as
//     everything else so a puff crossing a cove strip actually catches it.
//   * A coarse CPU density grid, ~2m cells, that accumulates and decays. That is
//     the half an occupancy map can read and an accretion enemy can eat. It costs
//     a few kilobytes and one array write per spawn.
//
// Puffs are scaled by the lambda that broke the joint, so the size of the cloud
// matches the force that made it rather than being a constant.

import * as THREE from 'three';
import { LIGHT_GLSL } from './lighting.js';

export class DustField {

	constructor( scene, rig, bounds, maxParticles = 900 ) {

		this.max = maxParticles;
		this.cursor = 0;
		this.live = 0;

		this.px = new Float32Array( maxParticles );
		this.py = new Float32Array( maxParticles );
		this.pz = new Float32Array( maxParticles );
		this.vx = new Float32Array( maxParticles );
		this.vy = new Float32Array( maxParticles );
		this.vz = new Float32Array( maxParticles );
		this.life = new Float32Array( maxParticles );
		this.decay = new Float32Array( maxParticles );
		this.size = new Float32Array( maxParticles );

		// Per-instance channels the shader reads.
		this.aLife = new Float32Array( maxParticles );
		this.aSize = new Float32Array( maxParticles );

		const geo = new THREE.PlaneGeometry( 1, 1 );
		this.lifeAttr = new THREE.InstancedBufferAttribute( this.aLife, 1 );
		this.sizeAttr = new THREE.InstancedBufferAttribute( this.aSize, 1 );
		this.lifeAttr.setUsage( THREE.DynamicDrawUsage );
		this.sizeAttr.setUsage( THREE.DynamicDrawUsage );
		geo.setAttribute( 'aLife', this.lifeAttr );
		geo.setAttribute( 'aSize', this.sizeAttr );

		this.material = new THREE.ShaderMaterial( {
			uniforms: Object.assign( {}, rig.uniforms, {
				uCamPos: rig.uniforms.uCamPos,
				uDustColor: { value: new THREE.Color( 0xb4aa9c ) },
				uOpacity: { value: 0.42 }
			} ),
			transparent: true,
			depthWrite: false,
			blending: THREE.NormalBlending,
			vertexShader: /* glsl */`
				attribute float aLife;
				attribute float aSize;
				varying float vLife;
				varying vec2 vLocal;
				varying vec3 vWorld;

				void main() {
					vLife = aLife;
					vLocal = position.xy;

					vec3 origin = vec3( instanceMatrix[ 3 ][ 0 ], instanceMatrix[ 3 ][ 1 ], instanceMatrix[ 3 ][ 2 ] );
					vWorld = origin;

					// Puff up on birth, shrink as it settles out. sin() over the
					// life span does both with one term.
					float scale = aSize * sin( clamp( vLife, 0.0, 1.0 ) * 3.14159 );

					// Camera-facing quad from the view matrix rows — no per-particle
					// orientation to store or update.
					vec3 right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
					vec3 up = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
					vec3 wp = origin + ( right * position.x + up * position.y ) * scale;

					gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
				}
			`,
			fragmentShader: LIGHT_GLSL + /* glsl */`
				varying float vLife;
				varying vec2 vLocal;
				varying vec3 vWorld;
				uniform vec3 uCamPos;
				uniform vec3 uDustColor;
				uniform float uOpacity;

				void main() {
					if ( vLife <= 0.0 ) discard;

					float d = length( vLocal ) * 2.0;
					float alpha = smoothstep( 1.0, 0.15, d );
					if ( alpha <= 0.003 ) discard;

					// Lit by the room, not flat-shaded: a puff crossing a cove
					// strip has to catch it or it reads as a decal.
					Surface s;
					s.pos = vWorld;
					s.normal = normalize( uCamPos - vWorld );
					s.albedo = uDustColor;
					s.gloss = 0.0;
					s.specular = 0.0;

					vec3 color = directLighting( s, uCamPos ) + causticLight( s );
					color = applyFog( color, uCamPos, vWorld );

					gl_FragColor = vec4( color, alpha * clamp( vLife, 0.0, 1.0 ) * uOpacity );
				}
			`
		} );

		this.mesh = new THREE.InstancedMesh( geo, this.material, maxParticles );
		this.mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
		this.mesh.frustumCulled = false;
		this.mesh.count = 0;
		this.mesh.renderOrder = 2;
		scene.add( this.mesh );

		this._m = new THREE.Matrix4();
		this._v = new THREE.Vector3();

		// --- the half that is not a visual --------------------------------
		this.cell = 2.0;
		this.origin = new THREE.Vector3( bounds.min.x, bounds.min.y, bounds.min.z );
		this.dim = new THREE.Vector3(
			Math.ceil( ( bounds.max.x - bounds.min.x ) / this.cell ),
			Math.ceil( ( bounds.max.y - bounds.min.y ) / this.cell ),
			Math.ceil( ( bounds.max.z - bounds.min.z ) / this.cell )
		);
		this.density = new Float32Array( this.dim.x * this.dim.y * this.dim.z );
		this.densityDecay = 0.22;   // per second; dust is slow evidence

	}

	_cellIndex( x, y, z ) {

		const i = Math.floor( ( x - this.origin.x ) / this.cell );
		const j = Math.floor( ( y - this.origin.y ) / this.cell );
		const k = Math.floor( ( z - this.origin.z ) / this.cell );
		if ( i < 0 || j < 0 || k < 0 || i >= this.dim.x || j >= this.dim.y || k >= this.dim.z ) return - 1;
		return ( k * this.dim.y + j ) * this.dim.x + i;

	}

	// How much dust is hanging at a point, 0..1-ish. This is the reading a
	// building management system would actually have (§50.2) — the occupancy
	// estimate should diffuse toward wherever this is nonzero.
	sample( x, y, z ) {

		const c = this._cellIndex( x, y, z );
		return c < 0 ? 0 : this.density[ c ];

	}

	// Total suspended dust — a single scalar for "how obvious have you been".
	get suspended() {

		let n = 0;
		for ( let i = 0; i < this.density.length; i ++ ) n += this.density[ i ];
		return n;

	}

	// `force` is the lambda that broke the joint, in newtons. The cloud scales
	// with it, so a joint that gave up quietly does not produce the same plume as
	// one that was torn out.
	puff( x, y, z, force, nx = 0, ny = 1, nz = 0 ) {

		const strength = Math.min( 1, force / 26000 );
		const count = Math.max( 2, Math.round( 3 + strength * 16 ) );
		const speed = 0.6 + strength * 3.4;

		for ( let n = 0; n < count; n ++ ) {

			const i = this.cursor;
			this.cursor = ( this.cursor + 1 ) % this.max;

			this.px[ i ] = x + ( Math.random() - 0.5 ) * 0.16;
			this.py[ i ] = y + ( Math.random() - 0.5 ) * 0.16;
			this.pz[ i ] = z + ( Math.random() - 0.5 ) * 0.16;

			// Biased along the fracture normal, with a spherical spread and a
			// slight upward lean so it billows instead of spraying.
			this.vx[ i ] = nx * speed * 0.5 + ( Math.random() - 0.5 ) * speed;
			this.vy[ i ] = ny * speed * 0.5 + ( Math.random() - 0.25 ) * speed * 0.8;
			this.vz[ i ] = nz * speed * 0.5 + ( Math.random() - 0.5 ) * speed;

			this.life[ i ] = 1.0;
			this.decay[ i ] = 0.11 + Math.random() * 0.16;
			this.size[ i ] = 0.16 + Math.random() * 0.3 + strength * 0.24;

		}

		const c = this._cellIndex( x, y, z );
		if ( c >= 0 ) this.density[ c ] = Math.min( 4, this.density[ c ] + strength * 0.9 );

	}

	// Player wake: moving through a cloud pushes it, which is both the cheapest
	// possible reactivity and a tell — §22.4, your own noise is your liability,
	// and disturbed dust is noise you can see.
	update( dt, viewPos, viewVel ) {

		const m = this._m, v = this._v;
		let slot = 0;
		let live = 0;

		const vlen = viewVel ? viewVel.length() : 0;

		for ( let i = 0; i < this.max; i ++ ) {

			if ( this.life[ i ] <= 0 ) continue;

			live ++;

			// Heavy drag: masonry dust hangs, it does not fly.
			const drag = Math.max( 0, 1 - 2.4 * dt );
			this.vx[ i ] *= drag; this.vy[ i ] *= drag; this.vz[ i ] *= drag;
			this.vy[ i ] -= 0.22 * dt;

			if ( vlen > 0.5 ) {

				const dx = this.px[ i ] - viewPos.x, dy = this.py[ i ] - viewPos.y, dz = this.pz[ i ] - viewPos.z;
				const d2 = dx * dx + dy * dy + dz * dz;

				if ( d2 < 2.25 ) {

					const push = ( 1 - Math.sqrt( d2 ) / 1.5 ) * dt * 2.2;
					this.vx[ i ] += viewVel.x * push;
					this.vy[ i ] += viewVel.y * push;
					this.vz[ i ] += viewVel.z * push;

				}

			}

			this.px[ i ] += this.vx[ i ] * dt;
			this.py[ i ] += this.vy[ i ] * dt;
			this.pz[ i ] += this.vz[ i ] * dt;

			this.life[ i ] -= this.decay[ i ] * dt;
			if ( this.life[ i ] <= 0 ) { this.life[ i ] = 0; continue; }

			v.set( this.px[ i ], this.py[ i ], this.pz[ i ] );
			m.makeTranslation( v.x, v.y, v.z );
			this.mesh.setMatrixAt( slot, m );
			this.aLife[ slot ] = this.life[ i ];
			this.aSize[ slot ] = this.size[ i ];
			slot ++;

		}

		this.mesh.count = slot;
		this.mesh.instanceMatrix.needsUpdate = true;
		this.lifeAttr.needsUpdate = true;
		this.sizeAttr.needsUpdate = true;
		this.live = live;

		const d = Math.max( 0, 1 - this.densityDecay * dt );
		for ( let i = 0; i < this.density.length; i ++ ) this.density[ i ] *= d;

	}

	clear() {

		this.life.fill( 0 );
		this.density.fill( 0 );
		this.mesh.count = 0;

	}

}
