# Spline scene (Vite + React + react-three-fiber)

A standalone 3D viewer for the Spline export `spline_3_d_starter_file.glb`.
It is separate from the Nestly app in the repo root: it has its own
`package.json`, and nothing in `../server`, `../public` or `../vercel.json`
references it.

## Commands

Run these from `scene/`:

- `npm install`: install dependencies
- `npm run dev`: start the Vite dev server on http://localhost:5173 (also bound to the network)
- `npm run build`: production build into `dist/` (git-ignored)
- `npm run preview`: serve the production build

Stack: React 19, three 0.187, @react-three/fiber 9, @react-three/drei 10, Vite 8.

## Files

```
scene/
├── spline_3_d_starter_file.glb          Original Spline export (source of truth, ~370 KB)
├── public/
│   ├── spline_3_d_starter_file-transformed.glb   Optimized, Draco-compressed copy the app loads (~43 KB)
│   └── draco/                           Draco decoder copied from three/examples/jsm/libs/draco/gltf
├── index.html                           Vite entry, mounts #root
├── vite.config.js                       React plugin; dev server host: true, port 5173
└── src/
    ├── main.jsx                         createRoot, renders <Scene/>
    ├── index.css                        Full-viewport canvas, no scroll
    ├── Scene.jsx                        <Canvas>, background, lights, environment, OrbitControls, <Model/>
    ├── Model.jsx                        gltfjsx output plus a few hand edits (see below)
    └── sceneConfig.js                   All tunable values: camera, orbit target, background, lights, materials
```

## Scene graph

```
<Canvas shadows="percentage" camera={CAMERA}>
├── <color attach="background">          BACKGROUND (#f1f1f1)
├── <Lights>
│   ├── ambientLight                     LIGHTS.ambient
│   ├── directionalLight (key, shadows)  LIGHTS.directional, upper right, 2048² shadow map
│   ├── directionalLight (fill)          LIGHTS.fill, cool light from the opposite side
│   └── <Environment>                    Two Lightformers for soft reflections (built in code, no HDRI fetch)
├── <Suspense>
│   └── <Model>                          "Welcome to Spline" contents
│       ├── mesh "Path"                  Closed extruded path (16-sided tube) looping around the sphere
│       ├── mesh "Sphere"                Radius ≈ 5.87, centre (-5.36, 5.87, 2.54); the loop's centre too
│       └── mesh "Cube"                  ≈ 5.1 units, rounded corners, sits on the loop at (-31.2, -1.05, -7.37)
└── <OrbitControls makeDefault>          Target ORBIT_TARGET (sphere centre), damping, distance 10–300
```

Units: Spline works in units about 100× larger than three.js. The export wraps
everything in a node scaled by 0.01. gltfjsx flattens that hierarchy and puts
`scale={0.01}` on each mesh, so positions in `Model.jsx` are already in scene
units.

## What came from the GLB, and what was recreated

From the GLB:
- The three meshes and their transforms.
- The camera: position `(16.1, 32.5, 69.8)`, 45° vertical FOV, near/far 0.7/1000
  after scaling. These values are in `CAMERA`.

Not in the GLB (Spline's exporter drops them), so they are recreated in code:
- **Materials.** The meshes have none, so `MATERIALS` sets a
  `meshStandardMaterial` for each.
- **Lights.** The only light in the export is an empty "Default Ambient Light"
  node.
- **Background.**

The recreated values approximate Spline's default starter look. To match the
Spline file exactly, copy colours and intensities from the Spline editor into
`sceneConfig.js`.

The orbit target isn't in the export either. It is set to the sphere's centre,
so the initial view stays centred on the group. The camera position is
Spline's.

## Regenerating Model.jsx

```
npx gltfjsx spline_3_d_starter_file.glb --transform --keepmeshes --keepnames
```

- `--keepmeshes` is required. None of the meshes has a material, so plain
  `--transform` treats them as compatible and joins Path, Sphere and Cube into
  one mesh, and they can no longer be styled separately.
- The command writes `Spline_3_d_starter_file.jsx` and
  `spline_3_d_starter_file-transformed.glb` next to the source. Move the GLB
  into `public/` and the JSX over `src/Model.jsx`.
- Then reapply the hand edits listed in the header of `Model.jsx`:
  1. Pass `'/draco/'` as the second argument to `useGLTF`.
  2. Give each mesh a `<meshStandardMaterial {...MATERIALS.X} />` child.
  3. Add `castShadow receiveShadow` to each mesh.
  4. Remove the generated `<PerspectiveCamera>` (its values live in `CAMERA`).

## Conventions

- Put look-and-feel tweaks in `sceneConfig.js`. Keep `Scene.jsx` and
  `Model.jsx` free of magic numbers where possible.
- Assets load from absolute `/...` paths, so anything the app loads goes in
  `public/`.
