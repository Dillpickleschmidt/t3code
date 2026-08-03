/**
 * Pins the three.js contract that `CityScene`'s terrain picking depends on:
 * `InstancedMesh.raycast` culls against a bounding sphere it computes once, on
 * the first raycast, and never refreshes on its own.
 *
 * The bug this locks down: 3D Diff's opening frame can hold zero columns, so
 * the first hover cached an *empty* sphere (radius -1). Every later click on
 * a column was culled before the per-instance test and fell through to the
 * flat tile behind it — selecting the wrong file. The fix in `CityScene`'s
 * columns effect sets `terrain.boundingSphere = null` whenever the instance
 * matrices change, which is the invalidation these tests exercise.
 *
 * The scene itself needs a WebGL mount, so the call site can't be exercised
 * here; if a three upgrade changes this caching behaviour, these tests fail
 * and the invalidation in `CityScene` should be revisited alongside them.
 */
import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";

const COLUMN_H = 29;

/** A terrain-like instanced mesh: unit box, crest-heavy column at origin. */
function terrainWith(count: number): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0); // base at y=0, like the scene's columns
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), count);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    matrix.compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(4, COLUMN_H, 4),
    );
    mesh.setMatrixAt(i, matrix);
  }
  return mesh;
}

/** A horizontal ray aimed at the column's crest, well above any flat frame. */
function crestRaycaster(): THREE.Raycaster {
  const ray = new THREE.Raycaster();
  ray.set(new THREE.Vector3(0, COLUMN_H - 1, 50), new THREE.Vector3(0, 0, -1));
  return ray;
}

describe("instanced terrain picking", () => {
  it("caches an empty bounding sphere from a zero-instance raycast, which then culls real columns", () => {
    const mesh = terrainWith(1);
    // the opening frame: no columns on stage
    mesh.count = 0;
    crestRaycaster().intersectObject(mesh, false);
    expect(mesh.boundingSphere?.radius).toBe(-1);

    // columns grow; without invalidation the crest is unpickable
    mesh.count = 1;
    const hits: THREE.Intersection[] = [];
    crestRaycaster().intersectObject(mesh, false, hits);
    expect(hits).toHaveLength(0);
  });

  it("invalidating the sphere after matrix changes makes the crest pickable again", () => {
    const mesh = terrainWith(1);
    mesh.count = 0;
    crestRaycaster().intersectObject(mesh, false);

    mesh.count = 1;
    mesh.boundingSphere = null; // what CityScene's columns effect now does
    const hits: THREE.Intersection[] = [];
    crestRaycaster().intersectObject(mesh, false, hits);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.instanceId).toBe(0);
  });
});
