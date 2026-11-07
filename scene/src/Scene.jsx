import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment, Lightformer } from '@react-three/drei'
import { Model } from './Model.jsx'
import { CAMERA, ORBIT_TARGET, BACKGROUND, LIGHTS } from './sceneConfig.js'

function Lights() {
  const { ambient, directional, fill } = LIGHTS
  return (
    <>
      <ambientLight color={ambient.color} intensity={ambient.intensity} />
      <directionalLight
        color={directional.color}
        intensity={directional.intensity}
        position={directional.position}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={1}
        shadow-camera-far={250}
      />
      <directionalLight color={fill.color} intensity={fill.intensity} position={fill.position} />
      {/* A soft studio environment built in code (no HDRI download) for gentle reflections */}
      <Environment resolution={64}>
        <Lightformer intensity={1.2} position={[0, 10, 0]} rotation-x={Math.PI / 2} scale={[20, 20, 1]} />
        <Lightformer intensity={0.4} position={[-10, 2, 5]} rotation-y={Math.PI / 2} scale={[10, 10, 1]} />
      </Environment>
    </>
  )
}

export default function Scene() {
  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: CAMERA.position, fov: CAMERA.fov, near: CAMERA.near, far: CAMERA.far }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <Lights />
      <Suspense fallback={null}>
        <Model />
      </Suspense>
      <OrbitControls
        makeDefault
        target={ORBIT_TARGET}
        enableDamping
        dampingFactor={0.08}
        minDistance={10}
        maxDistance={300}
      />
    </Canvas>
  )
}
