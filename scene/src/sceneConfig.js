// Every look-and-feel value for the scene lives here, so matching it to Spline
// means editing this file only.
//
// Where the values come from:
//   CAMERA comes straight from the camera exported in the GLB (Spline units x 0.01).
//   Everything else is NOT in the GLB: Spline's exporter dropped the materials,
//   lights and background. Those values approximate Spline's default starter
//   scene. Copy the real ones from the Spline editor's right-hand panel to match exactly.

// Exported Spline camera: position (1610, 3253, 6981), 45 deg vertical FOV.
export const CAMERA = {
  position: [16.101, 32.526, 69.812],
  fov: 45,
  near: 0.7, // Spline near 70 / far 100000, scaled by 0.01
  far: 1000,
}

// Orbit pivot: the sphere's centre, which is also roughly the centre of the
// Path loop. The camera keeps Spline's exported position and aims here, so
// the composition sits centred and orbiting swings around the group.
export const ORBIT_TARGET = [-5.358, 5.872, 2.54]

export const BACKGROUND = '#f1f1f1'

export const LIGHTS = {
  ambient: { color: '#ffffff', intensity: 0.9 },
  // Key light: high up and to the right, like Spline's default directional light.
  directional: { color: '#ffffff', intensity: 2.2, position: [40, 80, 50] },
  // Cool fill light from the opposite side keeps the shadowed sides from going flat.
  fill: { color: '#dfe6ff', intensity: 0.6, position: [-60, 20, -30] },
}

export const MATERIALS = {
  Sphere: { color: '#e6e6ea', roughness: 0.55, metalness: 0 },
  Cube: { color: '#e6e6ea', roughness: 0.55, metalness: 0 },
  Path: { color: '#d4d4da', roughness: 0.6, metalness: 0 },
}
