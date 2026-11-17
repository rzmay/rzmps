export async function runSceneDepthVisibility(gpu) {
  const { SpriteRenderer, VolumeRenderer } = await import('@rzmps/rzmps');
  const { volume, red, renderer, scene, camera, system, THREE } = window.volumeFixture;
  camera.position.set(0, 0, 4); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
  red.density.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  red.density.data.fill(0.8); red.density.version++;
  red.color = undefined;
  Object.assign(volume, { tags: ['red'], color: new THREE.Color('white'), generateChildren: false,
    dynamicResolution: false, densityNoiseStrength: 0, densityMapping: 'Linear', opacity: 0.9,
    jitterStrength: 0, steps: 128, softParticles: false });
  const spriteTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  spriteTexture.needsUpdate = true;
  const sprite = new SpriteRenderer(spriteTexture, { softParticleDistance: 1 });
  const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
  const context = canvas.getContext('2d');
  const material = new THREE.MeshBasicMaterial({ colorWrite: false });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), material);
  plane.position.z = 2; plane.renderOrder = -100; scene.add(plane);
  const depthSample = async () => {
    const depth = gpu ? sprite.getWebGPUSceneDepth(renderer, scene, camera)
      : sprite.getSceneDepth(renderer, scene, camera);
    let value;
    if (gpu) {
      const { StorageBufferAttribute } = await import('three/webgpu');
      const { Fn, storage, texture, ivec2, vec4 } = await import('three/tsl');
      const output = new StorageBufferAttribute(new Float32Array(4), 4), target = storage(output, 'vec4', 1);
      const node = Fn(() => target.element(0).assign(vec4(texture(depth).load(ivec2(240, 160)).r)))().compute(1);
      renderer.compute(node);
      value = new Float32Array(await renderer.getArrayBufferAsync(output))[0];
      // textureLoad returns raw depth; ordinary sampled depth nodes normalize reversed depth for shading.
      if (renderer.reversedDepthBuffer) value = 1 - value;
      node.dispose(); output.dispose();
    } else {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
      const shader = new THREE.ShaderMaterial({ uniforms: { depth: { value: depth } },
        vertexShader: 'void main(){gl_Position=vec4(position,1.);}',
        fragmentShader: 'uniform sampler2D depth;void main(){gl_FragColor=vec4(texture2D(depth,vec2(.5)).r);}' });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shader), readScene = new THREE.Scene();
      readScene.add(quad);
      const old = renderer.getRenderTarget(); renderer.setRenderTarget(target);
      renderer.render(readScene, new THREE.Camera());
      const data = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, data);
      value = data[0]; renderer.setRenderTarget(old);
      target.dispose(); shader.dispose(); quad.geometry.dispose();
    }
    return camera.near * camera.far / ((camera.far - camera.near) * value - camera.far);
  };
  const capture = async divisor => {
    volume.downsample = divisor; volume.update([], system, 0);
    if (gpu) await renderer.renderAsync(scene, camera); else renderer.render(scene, camera);
    context.drawImage(renderer.domElement, 0, 0);
    return context.getImageData(240, 160, 1, 1).data[0];
  };
  const rows = [];
  for (const [name, side, rotated, visible, transparent] of [
    ['front', THREE.FrontSide, false, true, false],
    ['culled-back', THREE.FrontSide, true, true, false],
    ['back-only-culled-front', THREE.BackSide, false, true, false],
    ['back-only-visible', THREE.BackSide, true, true, false],
    ['double-sided-back', THREE.DoubleSide, true, true, false],
    ['invisible', THREE.FrontSide, false, false, false],
    ['transparent-writes-depth', THREE.FrontSide, false, true, true],
    ['transparent-no-depth', THREE.FrontSide, false, true, true],
    ['transparent-culled-back', THREE.FrontSide, true, true, true],
  ]) {
    plane.visible = visible; plane.rotation.y = rotated ? Math.PI : 0;
    Object.assign(material, { side, transparent, opacity: transparent ? 0.5 : 1, depthWrite: true });
    if (name === 'transparent-no-depth') material.depthWrite = false;
    material.needsUpdate = true;
    const full = await capture(1), reduced = gpu ? await capture(2) : undefined;
    const depth = await depthSample();
    rows.push({ name, full, reduced, depth, restored: plane.material === material && material.side === side });
  }
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const back = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
  plane.visible = true; plane.rotation.y = 0;
  plane.geometry.clearGroups(); plane.geometry.addGroup(0, 3, 0); plane.geometry.addGroup(3, 3, 1);
  plane.material = [hidden, back];
  const grouped = { full: await capture(1), reduced: gpu ? await capture(2) : undefined,
    depth: await depthSample(), restored: Array.isArray(plane.material) && plane.material[0] === hidden };
  plane.material = material; plane.geometry.clearGroups(); hidden.dispose(); back.dispose();

  const glass = new THREE.MeshPhysicalMaterial({ transmission: 1, colorWrite: false });
  plane.material = glass;
  const transmission = gpu ? { full: await capture(1), reduced: await capture(2), depth: await depthSample() } : null;
  plane.material = material; glass.dispose();
  // Alpha cutouts must retain their holes in both native opaque depth and soft-particle depth.
  plane.visible = true; plane.rotation.y = 0;
  const cutout = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
  cutout.needsUpdate = true;
  Object.assign(material, { side: THREE.FrontSide, transparent: false, map: cutout, alphaTest: 0.5 });
  material.needsUpdate = true;
  const alphaHole = { full: await capture(1), reduced: gpu ? await capture(2) : undefined,
    depth: await depthSample() };
  material.transparent = true; material.alphaTest = 0; material.needsUpdate = true;
  await capture(1);
  const transparentHole = await depthSample();
  material.map = null; material.opacity = 0; material.needsUpdate = true;
  await capture(1);
  const zeroOpacity = await depthSample();

  // Full soft depth includes glass in front of opaque geometry; volume clipping ignores it.
  material.map = null; material.alphaTest = 0; material.transparent = true; material.opacity = 0.5;
  material.needsUpdate = true;
  const opaque = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial({ colorWrite: false }));
  scene.add(opaque);
  const layered = { full: await capture(1), reduced: gpu ? await capture(2) : undefined,
    depth: await depthSample() };
  scene.remove(plane, opaque); volume.downsample = 1;
  const baseline = await capture(1);

  let renders = 0, copies = 0;
  const render = renderer.render, copy = renderer.copyFramebufferToTexture;
  renderer.render = function (...args) { renders++; return render.apply(this, args); };
  renderer.copyFramebufferToTexture = function (...args) { copies++; return copy.apply(this, args); };
  await capture(1); const fullPasses = { renders, copies };
  renders = copies = 0;
  if (gpu) await capture(2);
  const reducedPasses = { renders, copies };
  renderer.render = render; renderer.copyFramebufferToTexture = copy;
  let coldNoDepth;
  if (gpu) {
    const cold = new VolumeRenderer({ tags: ['red'], generateChildren: false, color: 'white',
      opacity: 0.9, densityMapping: 'Linear', jitterStrength: 0, steps: 128,
      dynamicResolution: false, downsample: 2, depthTest: false });
    system.addRenderer(cold); volume.mesh.visible = false;
    cold.update([], system, 0);
    await renderer.renderAsync(scene, camera);
    context.drawImage(renderer.domElement, 0, 0);
    coldNoDepth = context.getImageData(240, 160, 1, 1).data[0];
    system.removeRenderer(cold); volume.mesh.visible = true;
  }
  material.dispose(); cutout.dispose(); plane.geometry.dispose();
  opaque.material.dispose(); opaque.geometry.dispose(); sprite.destroy(); spriteTexture.dispose();
  return { rows, alphaHole, transparentHole, zeroOpacity, layered, grouped, transmission,
    coldNoDepth, baseline, fullPasses, reducedPasses };
}
