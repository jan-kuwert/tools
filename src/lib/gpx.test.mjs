// Run: node --test src/lib/gpx.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { climb, cut, findOutliers, flatten, haversine, merge, overlaps, parseGpx, removePauses, removePoints, removeSpikes, serializeGpx, simplify, stats, trim } from './gpx.ts';

const T0 = Date.parse('2026-05-01T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const pt = (lat, lon, ele, t, hr) =>
  `<trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele><time>${iso(t)}</time>` +
  (hr ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${hr}</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>` : '') +
  '</trkpt>';
const gpx = (body, version = '1.1') =>
  `<?xml version="1.0"?>\n<gpx version="${version}" creator="watch" xmlns="http://www.topografix.com/GPX/1/${version === '1.1' ? 1 : 0}" ` +
  `xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><metadata><name>Morning &amp; run</name></metadata>${body}</gpx>`;
/** A straight run north along lon 8, `n` points 1 s apart moving `step` degrees of latitude each. */
const line = (n, step = 0.0001, t0 = T0, lat0 = 47) => Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * step, lon: 8, time: t0 + i * 1000 }));
const track = (segs, name = 't') => ({ name, type: '', desc: '', route: false, segs });

test('parse → serialize → parse keeps points, extensions, metadata and namespaces', () => {
  const src = gpx(
    `<wpt lat="47.1" lon="8.1"><name>Water</name></wpt>` +
      `<trk><name>Lap</name><type>running</type><trkseg>${pt(47, 8, 400.5, T0, 120)}${pt(47.001, 8.001, 402, T0 + 5000, 131)}</trkseg>` +
      `<trkseg>${pt(47.002, 8.002, 401, T0 + 9000)}</trkseg></trk>` +
      `<rte><name>Plan</name><rtept lat="47.5" lon="8.5"/></rte>`,
  );
  const a = parseGpx(src);
  assert.equal(a.name, 'Morning & run');
  assert.deepEqual(a.ns, { gpxtpx: 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1' });
  const trk = a.tracks.find((t) => !t.route);
  assert.equal(trk.name, 'Lap');
  assert.equal(trk.type, 'running');
  assert.equal(trk.segs.length, 2);
  assert.equal(trk.segs[0][1].hr, 131);
  assert.equal(trk.segs[0][1].cad, 80);
  assert.equal(trk.segs[0][0].time, T0);
  assert.equal(a.tracks.find((t) => t.route).segs[0].length, 1);
  const out = serializeGpx(a);
  assert.match(out, /xmlns:gpxtpx="http:\/\/www\.garmin\.com\/xmlschemas\/TrackPointExtension\/v1"/);
  assert.match(out, /<gpxtpx:hr>131<\/gpxtpx:hr>/);
  assert.deepEqual(parseGpx(out), a);
});

test('GPX 1.0, prefixed elements and invalid input', () => {
  const v10 = `<gpx:gpx version="1.0" xmlns:gpx="http://www.topografix.com/GPX/1/0"><gpx:name>Old</gpx:name><gpx:trk><gpx:trkseg><gpx:trkpt lat="1" lon="2"><gpx:time>2020-01-01T00:00:00Z</gpx:time></gpx:trkpt></gpx:trkseg></gpx:trk></gpx:gpx>`;
  const g = parseGpx(v10);
  assert.equal(g.name, 'Old');
  assert.equal(g.tracks[0].segs[0][0].lon, 2);
  assert.throws(() => parseGpx('<html><body></body></html>'), /Not a GPX file/);
  assert.throws(() => parseGpx('<gpx><trk></gpx>'), /Not a valid XML/);
  assert.throws(() => parseGpx('hello'), /Not a valid XML/);
});

test('haversine distance and ascent with noise threshold', () => {
  near(haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111195, 1);
  near(haversine({ lat: 47, lon: 8 }, { lat: 47.01, lon: 8 }), 1111.95, 0.1);
  assert.deepEqual(climb([100, 110, 105, 120, 121, 119]), { ascent: 25, descent: 5 });
  const s = stats(track([line(11).map((p, i) => ({ ...p, ele: 100 + i * 5 }))]));
  near(s.distance, 111.195, 0.01);
  assert.equal(s.ascent, 50);
  assert.equal(s.elapsed, 10_000);
  near(s.avgSpeed, 11.1195, 0.001);
});

test('Douglas–Peucker keeps every point within tolerance', () => {
  // Zig-zag of ±1 m around a straight line, plus one 50 m detour.
  const pts = line(200).map((p, i) => ({ ...p, lon: 8 + (i % 2 ? 1 : -1) * 0.0000132 + (i === 100 ? 0.00066 : 0) }));
  const t = track([pts]);
  const s = simplify(t, 5);
  const kept = s.segs[0];
  assert.ok(kept.length < 10, `${kept.length} points left`);
  assert.ok(kept.includes(pts[100]), 'detour kept');
  // Every dropped point lies within 5 m of the simplified line (checked against the nearest kept neighbours).
  for (let i = 0, k = 0; i < pts.length; i++) {
    while (kept[k + 1] && pts.indexOf(kept[k + 1]) < i) k++;
    const a = kept[k];
    const b = kept[k + 1] ?? a;
    const f = (pts[i].lat - a.lat) / (b.lat - a.lat || 1);
    const onLine = { lat: pts[i].lat, lon: a.lon + (b.lon - a.lon) * f };
    assert.ok(haversine(pts[i], onLine) <= 5.01, `point ${i}`);
  }
  assert.equal(simplify(t, 0.01).segs[0].length, 200);
});

test('trim and cut by flat index across segments', () => {
  const a = line(5);
  const b = line(5, 0.0001, T0 + 10_000, 48);
  const t = track([a, b]);
  assert.deepEqual(trim(t, 3, 6).segs, [a.slice(3), b.slice(0, 2)]);
  assert.deepEqual(cut(t, 1, 2, true).segs, [[a[0], a[3], a[4]], b]);
  assert.deepEqual(cut(t, 1, 2, false).segs, [[a[0]], [a[3], a[4]], b]);
  // Cutting across the segment break never joins different segments.
  assert.deepEqual(cut(t, 4, 5, true).segs, [a.slice(0, 4), b.slice(1)]);
  assert.equal(flatten(trim(t, 0, 0)).pts.length, 1);
});

test('merge orders by start time and reports overlaps', () => {
  const late = track([line(3, 0.0001, T0 + 3_600_000)], 'late');
  const early = track([line(3)], 'early');
  const m = merge([late, early], true, true);
  assert.equal(m.name, 'early');
  assert.equal(m.segs.length, 1);
  assert.deepEqual(m.segs[0].map((p) => p.time), [...early.segs[0], ...late.segs[0]].map((p) => p.time));
  assert.equal(merge([late, early], false, false).segs[0], late.segs[0]);
  assert.equal(overlaps([late, early]).length, 0);
  assert.equal(overlaps([early, track([line(3, 0.0001, T0 + 1000)])]).length, 1);
});

test('remove spikes drops single jumps, including at the ends, but not steady fast movement', () => {
  const pts = line(10); // 11 m/s ≈ 40 km/h
  const jump = (p) => ({ ...p, lon: p.lon + 0.01 }); // ~760 m sideways in a second
  const noisy = [jump(pts[0]), ...pts.slice(1, 5), jump(pts[5]), ...pts.slice(6, 9), jump(pts[9])];
  assert.deepEqual(removeSpikes(track([noisy]), 100).segs[0], [...pts.slice(1, 5), ...pts.slice(6, 9)]);
  assert.equal(removeSpikes(track([pts]), 20).segs[0].length, 10);
});

test('distance outliers: far single points (also at segment ends and without times), not a regular track or a turn', () => {
  const pts = line(10).map(({ lat, lon }) => ({ lat, lon })); // ~11 m steps, no timestamps
  const jump = (p) => ({ ...p, lon: p.lon + 0.005 }); // ~380 m sideways
  const noisy = [jump(pts[0]), ...pts.slice(1, 5), jump(pts[5]), ...pts.slice(6)];
  const t = track([noisy.slice(0, 7), [...pts.slice(2, 8), jump(pts[8])]]);
  assert.deepEqual(findOutliers(t, 50), [0, 5, 13]);
  assert.deepEqual(removePoints(t, [0, 5, 13]).segs, [[...pts.slice(1, 5), pts[6]], pts.slice(2, 8)]);
  assert.deepEqual(findOutliers(track([pts]), 50), []);
  assert.deepEqual(findOutliers(t, 1000), [], 'below the threshold');
  // A sharp corner keeps both neighbours far apart, so it is not an outlier.
  const corner = [...pts.slice(0, 5), ...Array.from({ length: 5 }, (_, i) => ({ lat: pts[4].lat, lon: 8 + (i + 1) * 0.0015 }))];
  assert.deepEqual(findOutliers(track([corner]), 50), []);
  // Clusters: three stray points in a row in the middle, two at the end.
  const cl = [...pts.slice(0, 3), jump(pts[3]), jump(pts[4]), jump(pts[5]), ...pts.slice(6)];
  assert.deepEqual(findOutliers(track([cl]), 50), [], 'runs longer than maxRun are left alone');
  assert.deepEqual(findOutliers(track([cl]), 50, 2), []);
  assert.deepEqual(findOutliers(track([cl]), 50, 3), [3, 4, 5]);
  assert.deepEqual(findOutliers(track([cl]), 50, 10), [3, 4, 5], 'good points next to a cluster are kept');
  const tail = [...pts.slice(0, 8), jump(pts[8]), jump(pts[9])];
  assert.deepEqual(findOutliers(track([tail]), 50, 2), [8, 9]);
  assert.deepEqual(findOutliers(t, 50, 3), [0, 5, 13], 'single jumps are found the same way with a larger maxRun');
});

test('remove pauses keeps the pause ends and can close the time gap', () => {
  const run = line(10);
  const stop = Array.from({ length: 60 }, (_, i) => ({ lat: run[9].lat, lon: 8, time: T0 + (10 + i) * 1000 }));
  const more = line(10, 0.0001, T0 + 70_000, run[9].lat + 0.0001);
  const t = track([[...run, ...stop, ...more]]);
  const kept = removePauses(t, 1, 30, false).segs[0];
  assert.equal(kept.length, 10 + 1 + 10); // run (its last point starts the pause), last stopped point, more
  assert.equal(kept.at(-1).time, T0 + 79_000);
  const closed = removePauses(t, 1, 30, true).segs[0];
  assert.equal(closed.length, 21);
  assert.equal(closed.at(-1).time, T0 + 79_000 - 60_000);
  assert.equal(removePauses(t, 1, 120, false).segs[0].length, 80, 'short stops stay');
});

function near(actual, expected, tol) {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);
}
