"""
Trace the native 3 degree JPL MASCON boundaries out of the 0.5 degree GRACE grid

The GRACE product distributed by PO.DAAC is sampled on a 0.5 degree lat/lon grid but it is not a 0.5 degree
measurement. The underlying solution is 4551 equal area 3 degree spherical caps whose edges always fall on 0.5 degree
parallels and meridians, which is why the 0.5 degree cells nest inside them exactly. The GRCTellus netcdf carries the
placement of those caps in its mascon_ID variable, so the 3 degree boundaries are simply the edges where mascon_ID
changes value. No separate placement file or shapefile has to be downloaded.

This script dissolves the 0.5 degree cells by mascon_ID and writes GeoJSON polygons, one feature per mascon, for
drawing the true footprint of a GRACE measurement on top of the 0.5 degree dashboard layers.

The rings are traced on the grid itself rather than by unioning geometry so the output vertices land exactly on the
0.5 degree graticule with no floating point slivers and no geometry dependency. Longitudes are rolled to -180..180
before tracing, which means a mascon spanning the antimeridian comes out as a MultiPolygon with one part on each side
instead of a polygon that smears across the whole map.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import xarray as xr

GRACE_RESOLUTION = 0.5

# Traversal keeps the mascon interior on the left, so each cell contributes its free edges counterclockwise. Nodes are
# integer grid corners, (column, row), which keeps the ring stitching free of float keys.
CELL_EDGES = (
    ((0, 0), (1, 0)),  # south
    ((1, 0), (1, 1)),  # east
    ((1, 1), (0, 1)),  # north
    ((0, 1), (0, 0)),  # west
)


def free_edges(mask: np.ndarray) -> dict:
    """
    Directed boundary edges of a boolean cell mask, keyed by their start node

    A cell edge is on the boundary when the neighbor across it is outside the mask. Off grid counts as outside, which
    is what closes the rings at the poles and at the antimeridian.
    """
    padded = np.pad(mask, 1)
    exposed = (
        mask & ~padded[:-2, 1:-1],  # south neighbor outside
        mask & ~padded[1:-1, 2:],  # east neighbor outside
        mask & ~padded[2:, 1:-1],  # north neighbor outside
        mask & ~padded[1:-1, :-2],  # west neighbor outside
    )
    edges = {}
    for exposure, ((sj, si), (ej, ei)) in zip(exposed, CELL_EDGES):
        for row, col in zip(*np.nonzero(exposure)):
            edges.setdefault((col + sj, row + si), []).append((col + ej, row + ei))
    return edges


def turn_priority(incoming: tuple) -> list:
    """
    Outgoing directions ordered rightmost turn first

    Only matters where a mascon pinches to a single shared corner. Taking the rightmost turn keeps the interior on the
    left through the pinch instead of cutting the ring in two.
    """
    dj, di = incoming
    return [(di, -dj), (dj, di), (-di, dj), (-dj, -di)]


def stitch_rings(edges: dict) -> list:
    """
    Walk the directed edges into closed rings of grid nodes
    """
    rings = []
    while edges:
        start = next(iter(edges))
        ring = [start]
        node = start
        incoming = None
        while True:
            options = edges.get(node)
            if not options:
                break
            if len(options) == 1 or incoming is None:
                nxt = options[0]
            else:
                headings = {(o[0] - node[0], o[1] - node[1]): o for o in options}
                nxt = next(headings[t] for t in turn_priority(incoming) if t in headings)
            options.remove(nxt)
            if not options:
                del edges[node]
            incoming = (nxt[0] - node[0], nxt[1] - node[1])
            node = nxt
            if node == start:
                break
            ring.append(node)
        ring.append(ring[0])
        rings.append(ring)
    return rings


def drop_collinear(ring: list) -> list:
    """
    Remove the interior vertices of every straight run so a 6x6 block is 5 points instead of 25
    """
    kept = []
    for idx in range(len(ring) - 1):
        prv = ring[idx - 1] if idx else ring[-2]
        cur = ring[idx]
        nxt = ring[idx + 1]
        if (cur[0] - prv[0]) * (nxt[1] - cur[1]) != (cur[1] - prv[1]) * (nxt[0] - cur[0]):
            kept.append(cur)
    kept.append(kept[0])
    return kept


def signed_area(ring: list) -> float:
    """
    Twice the signed area in node units, positive when counterclockwise
    """
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring[:-1], ring[1:]))


def bbox_contains(outer: list, inner: list) -> bool:
    ox = [n[0] for n in outer]
    oy = [n[1] for n in outer]
    ix = [n[0] for n in inner]
    iy = [n[1] for n in inner]
    return min(ox) <= min(ix) and max(ox) >= max(ix) and min(oy) <= min(iy) and max(oy) >= max(iy)


def mascon_geometry(mask: np.ndarray, lon_edges: np.ndarray, lat_edges: np.ndarray) -> dict:
    """
    Dissolve one mascon's cells into a GeoJSON Polygon or MultiPolygon
    """
    rings = [drop_collinear(r) for r in stitch_rings(free_edges(mask))]
    shells = [r for r in rings if signed_area(r) > 0]
    holes = [r for r in rings if signed_area(r) < 0]

    polygons = [[shell] for shell in shells]
    for hole in holes:
        for polygon in polygons:
            if bbox_contains(polygon[0], hole):
                polygon.append(hole)
                break

    def to_coords(ring):
        return [[round(float(lon_edges[j]), 2), round(float(lat_edges[i]), 2)] for j, i in ring]

    polygons = [[to_coords(ring) for ring in polygon] for polygon in polygons]
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def main():
    parser = argparse.ArgumentParser(description="Trace 3 degree JPL MASCON boundaries from the 0.5 degree GRACE grid")
    parser.add_argument('--root', type=str, required=True, help='Path to a data directory containing GRACE')
    parser.add_argument('--output', type=str, required=True, help='Directory to write the GeoJSON files into')
    parser.add_argument('--include-ocean', action='store_true',
                        help='Also write grace-mascons.geojson with all 4551 mascons, open ocean included')
    args = parser.parse_args()

    root = Path(args.root)
    output_directory = Path(args.output)
    output_directory.mkdir(parents=True, exist_ok=True)
    grace_mascon = list(root.glob('GRCTellus*.nc')).pop(0)

    print(f"Opening GRACE MASCON dataset {grace_mascon.name}")
    grace = xr.open_dataset(grace_mascon)[['mascon_ID', 'land_mask']]
    # GRACE lons are 0..360 and need to match the -180..180 convention of the dashboard. Rolling before tracing also
    # puts the array seam on the antimeridian, so mascons crossing it split into two parts instead of wrapping.
    grace = grace.assign_coords(lon=(grace.lon + 180) % 360 - 180).sortby('lon')

    mascon_ids = grace['mascon_ID'].values.astype(np.int32)
    land = grace['land_mask'].values > 0

    lats = grace['lat'].values
    lons = grace['lon'].values
    half = GRACE_RESOLUTION / 2
    lat_edges = np.append(lats - half, lats[-1] + half)
    lon_edges = np.append(lons - half, lons[-1] + half)

    unique_ids = np.unique(mascon_ids)
    print(f"Tracing boundaries for {len(unique_ids)} mascons on a {mascon_ids.shape[1]}x{mascon_ids.shape[0]} grid")

    features = []
    for count, mascon_id in enumerate(unique_ids, start=1):
        mask = mascon_ids == mascon_id
        cells = int(mask.sum())
        land_cells = int((mask & land).sum())
        features.append({
            "type": "Feature",
            "id": int(mascon_id),
            "properties": {
                "mascon_id": int(mascon_id),
                "cells": cells,
                "land_cells": land_cells,
                "land_fraction": round(land_cells / cells, 3),
            },
            "geometry": mascon_geometry(mask, lon_edges, lat_edges),
        })
        if count % 500 == 0:
            print(f"  traced {count}/{len(unique_ids)}")

    # The dashboard only ever draws the mascons that touch land: the rest are open ocean, irrelevant to groundwater,
    # and more than half the file size. The full set stays behind a flag for anyone checking the global tiling.
    on_land = [f for f in features if f['properties']['land_cells'] > 0]
    write_geojson(output_directory / 'grace-mascons-land.geojson', on_land)
    if args.include_ocean:
        write_geojson(output_directory / 'grace-mascons.geojson', features)


def write_geojson(path: Path, features: list) -> None:
    collection = {"type": "FeatureCollection", "features": features}
    with open(path, 'w') as f:
        json.dump(collection, f, separators=(',', ':'))
    print(f"Wrote {len(features)} mascons to {path} ({path.stat().st_size / 1e6:.1f} MB)")


if __name__ == '__main__':
    main()
