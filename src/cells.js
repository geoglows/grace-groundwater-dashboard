import Polygon from "@arcgis/core/geometry/Polygon";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";

export function cellPolygonFromCenter({xCenter, yCenter, halfWidth}) {
  return new Polygon({
    spatialReference: SpatialReference.WGS84,
    rings: [[
      [xCenter - halfWidth, yCenter - halfWidth],
      [xCenter - halfWidth, yCenter + halfWidth],
      [xCenter + halfWidth, yCenter + halfWidth],
      [xCenter + halfWidth, yCenter - halfWidth],
      [xCenter - halfWidth, yCenter - halfWidth]
    ]]
  });
}