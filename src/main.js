import "@arcgis/core/assets/esri/themes/light/main.css";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-zoom";
import "@arcgis/map-components/components/arcgis-layer-list";
import "@arcgis/map-components/components/arcgis-locate";
import "@arcgis/map-components/components/arcgis-scale-bar";
import "@arcgis/map-components/components/arcgis-expand";
import "@arcgis/map-components/components/arcgis-basemap-gallery";
import "@arcgis/map-components/components/arcgis-legend";
import "@arcgis/map-components/components/arcgis-sketch";
import "@arcgis/map-components/components/arcgis-time-slider";

import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as shapePreservingProjectOperator from "@arcgis/core/geometry/operators/shapePreservingProjectOperator.js";
import * as geometryEngine from "@arcgis/core/geometry/geometryEngine.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";

import {cellPolygonFromCenter} from "./cells.js";

import Plotly from "plotly.js/lib/core";
import Scatter from "plotly.js/lib/scatter";

import {FetchStore, get, open} from "zarrita";

import {getOrFetchCoords} from "./db.js";

import "./style.css";
import "./modal.css"

Plotly.register([Scatter]);

// const zarrUrl = "https://d2grb3c773p1iz.cloudfront.net/groundwater/GRC_gw_anomaly.zarr3";
const zarrUrl = "https://d2grb3c773p1iz.cloudfront.net/groundwater/grace025gwanomaly.zarr";

const arcgisMap = document.querySelector("arcgis-map");
const arcgisLayerList = document.querySelector("arcgis-layer-list");
const sketchTool = document.querySelector("arcgis-sketch");
const timeSlider = document.querySelector("arcgis-time-slider");
const appInstructions = document.getElementById("timeseries-plot").innerHTML;

// todo: start these fetches all async in the same bit
const coordsPromise = getOrFetchCoords({zarrUrl});
const lweStore = new FetchStore(zarrUrl + "/lwe_thickness_anomaly");
const lweNode = await open.v3(lweStore);
const uncStore = new FetchStore(zarrUrl + "/uncertainty");
const uncNode = await open.v3(uncStore);
const timeStore = new FetchStore(zarrUrl + "/time");
const timeNode = await open.v3(timeStore);
const timeIntegers = await get(timeNode, [null]);
const timeDates = Array.from(timeIntegers.data).map((t) => {
  const baseDate = new Date(Date.UTC(2002, 3, 1)); // April 1, 2002
  baseDate.setUTCDate(baseDate.getUTCDate() + Number(t));
  return baseDate;
});

const boundaryLayer = new GeoJSONLayer({
  title: "Aquifer Boundaries",
  url: "./aquifers.geojson",
  outFields: ["*"],
  definitionExpression: "1=1", // start with none selected
  renderer: {
    type: "simple",
    symbol: {
      type: "simple-fill",
      color: [255, 255, 255, 0],
      outline: {color: [0, 0, 0, 1], width: 2}
    }
  },
  popupTemplate: {
    title: "{n}",
    // overwriteActions: true,
    dockEnabled: false,
    dockOptions: {
      buttonEnabled: false,
      breakpoint: false
    },
    attributes: {
      id: {fieldName: "id"},
    },
    actions: [],
    content: () => {
      const div = document.createElement("div");
      div.innerHTML = `<div role="button" style="border: 1px solid black; padding: 8px; margin-top: 8px; text-align: center; font-weight: bold; background-color: #0079c1; color: white; cursor: pointer;">Analyze This Aquifer</div>`
      div.onclick = () => {
        analyzeGlobalAquifer({aquiferId: arcgisMap.view.popup.selectedFeature.attributes.id});
        arcgisMap.view.popup.close();
      }
      return div;
    }
  }
});

function meanIgnoringNaN(data, shape, stride) {
  const [T, Y, X] = shape;
  const [sT, sY, sX] = stride;

  const result = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let sum = 0;
    let count = 0;
    const tOffset = t * sT;
    for (let y = 0; y < Y; y++) {
      const yOffset = tOffset + y * sY;
      for (let x = 0; x < X; x++) {
        const v = data[yOffset + x * sX];
        if (!Number.isNaN(v)) {
          sum += v;
          count++;
        }
      }
    }
    result[t] = count > 0 ? sum / count : NaN;
  }
  return result;
}

const analyzeGlobalAquifer = async ({aquiferId}) => {
  // Load boundary layer + zoom
  await boundaryLayer.load();

  // Before adding to map (or after, either works)
  boundaryLayer.definitionExpression = `id='${aquiferId}'`;
  await boundaryLayer.refresh?.();
  const boundaryExtent = await boundaryLayer.queryExtent()
  const zoomPromise = arcgisMap.view.goTo(boundaryExtent.extent);

  // ---- Get the actual boundary polygon geometry ----
  const q = boundaryLayer.createQuery();
  q.where = `id='${aquiferId}'`;
  q.returnGeometry = true;
  q.outFields = [];

  const fs = await boundaryLayer.queryFeatures(q);
  if (!fs.features.length) throw new Error("No features found");
  const boundaryGeom = fs.features[0].geometry;

  await main({polygon: boundaryGeom, zoomPromise});
}

const analyzeDrawnPolygon = async ({polygon}) => {
  const zoomPromise = arcgisMap.view.goTo(polygon.extent);
  // convert the drawn polygon to WGS84 if needed
  if (polygon.spatialReference.wkid !== 4326) {
    await shapePreservingProjectOperator.load()
    polygon = shapePreservingProjectOperator.execute(polygon, SpatialReference.WGS84);
  }
  await main({polygon, zoomPromise});
}

const main = async ({polygon, zoomPromise}) => {
  const {lat, lon} = await coordsPromise;
  await arcgisMap.map.when();
  await arcgisMap.view.when();
  const cellSize = lat.data[1] - lat.data[0]; // ~0.25
  const HALF = cellSize / 2;

  // ---- Identify cells in the bounding box of the polygon to read zarr values for and start the async reads which we can wait for later
  const filteredLats = lat.data.filter((y) => y >= polygon.extent.ymin - 2 * cellSize && y <= polygon.extent.ymax + 2 * cellSize);
  const filteredLons = lon.data.filter((x) => x >= polygon.extent.xmin - 2 * cellSize && x <= polygon.extent.xmax + 2 * cellSize);
  const yStart = lat.data.indexOf(filteredLats[0]);
  const yStop = lat.data.indexOf(filteredLats[filteredLats.length - 1]) + 1;
  const xStart = lon.data.indexOf(filteredLons[0]);
  const xStop = lon.data.indexOf(filteredLons[filteredLons.length - 1]) + 1;
  let lweValues = get(lweNode, [null, {start: yStart, stop: yStop}, {start: xStart, stop: xStop}]);
  let uncValues = get(uncNode, [null, {start: yStart, stop: yStop}, {start: xStart, stop: xStop}]);

  // ---- Find the overlapping areas of the cells with the polygon ----
  intersectionOperator.accelerateGeometry(polygon);
  const intersectingCells = [];
  for (const y of filteredLats) {
    for (const x of filteredLons) {
      const cell = cellPolygonFromCenter({xCenter: x, yCenter: y, halfWidth: HALF});
      const cellArea = geometryEngine.geodesicArea(cell);

      const intersectsGeom = intersectionOperator.execute(polygon, cell);
      const intersectArea = intersectsGeom ? geometryEngine.geodesicArea(intersectsGeom) : 0;
      const frac = intersectArea / cellArea;

      intersectingCells.push({lon: x, lat: y, frac, cell, intersects: !!intersectsGeom});
    }
  }

  // ---- Resolve zarr reads and compute averages
  lweValues = await lweValues;
  uncValues = await uncValues;
  const lweMeanTimeSeries = meanIgnoringNaN(lweValues.data, lweValues.shape, lweValues.stride);
  const uncMeanTimeSeries = meanIgnoringNaN(uncValues.data, uncValues.shape, uncValues.stride);

  // create a plotly plot
  Plotly.newPlot(
    "timeseries-plot",
    // traces
    [
      {
        x: timeDates.concat(timeDates.slice().reverse()),
        y: Array.from(lweMeanTimeSeries).map((v, i) => v + uncMeanTimeSeries[i])
          .concat(Array.from(lweMeanTimeSeries).map((v, i) => v - uncMeanTimeSeries[i]).reverse()),
        fill: "toself",
        fillcolor: "rgba(0,197,255,0.45)",
        line: {color: "rgba(255,255,255,0)"},
        name: "Uncertainty Range",
        showlegend: true
      },
      {
        x: timeDates,
        y: Array.from(lweMeanTimeSeries),
        mode: "lines",
        name: "LWE Anomaly",
        line: {color: "black"}
      }
    ],
    // layout
    {
      title: "Mean LWE Anomaly Time Series with Uncertainty",
      xaxis: {title: "Time"},
      yaxis: {title: "LWE Anomaly (cm)"},
      legend: {orientation: "v"},
    },
    // config
    {
      responsive: true,
    }
  );

  const cellSource = intersectingCells
    .map(({lon, lat, frac, cell, intersects}, idx) => {
      if (!intersects || frac < 0.35) return null;
      return new Graphic({
        geometry: cell, // polygon
        attributes: {
          oid: idx,      // object id
          idx,
          lon,
          lat,
          frac,
          value: 0
        }
      });
    })
    .filter(Boolean);

  const selectedCellsLayer = new FeatureLayer({
    title: "GW Anomaly Cells",
    source: cellSource,
    objectIdField: "oid",
    fields: [
      {name: "oid", type: "oid"},
      {name: "idx", type: "integer"},
      {name: "lon", type: "double"},
      {name: "lat", type: "double"},
      {name: "frac", type: "double"},
      {name: "value", type: "double"}
    ],
    geometryType: "polygon",
    spatialReference: SpatialReference.WGS84,
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-fill",
        outline: {color: [0, 0, 0, 1], width: 0.5}
      },
      visualVariables: [{
        type: "color",
        field: "value",
        stops: [
          {value: -30, color: "#ff004e", label: "-30"},
          {value: 0, color: "#ffffff", label: "0"},
          {value: 30, color: "#1c6eec", label: "30"}
        ]
      }]
    }
  });

  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GW Anomaly Cells");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  await zoomPromise; // ensure view is zoomed before plotting
  arcgisMap.map.layers.add(selectedCellsLayer, 0); // add to bottom of stack

// ---- precompute lookup from feature idx -> oid (same in your case, but keep explicit) ----
  const oids = cellSource.map(g => g.attributes.oid);
  const idxs = cellSource.map(g => g.attributes.idx);

// ---- make updates serial so slider scrubbing doesn't overlap edits ----
  let editsInFlight = Promise.resolve();

  const updateMapToTimeStep = (timeStep) => {
    editsInFlight = editsInFlight.then(async () => {
      const nLon = lweValues.shape[2];
      const nLat = lweValues.shape[1];
      const base = timeStep * nLat * nLon;

      // update ONLY attributes via applyEdits (no geometry recompute)
      const updateFeatures = new Array(cellSource.length);
      for (let i = 0; i < cellSource.length; i++) {
        const idx = idxs[i];
        updateFeatures[i] = new Graphic({
          attributes: {
            oid: oids[i],
            value: lweValues.data[base + idx]
          }
        });
      }

      await selectedCellsLayer.applyEdits({updateFeatures});

      Plotly.relayout("timeseries-plot",
        {
          shapes: [{
            type: "line",
            x0: timeDates[timeStep],
            x1: timeDates[timeStep],
            y0: 0,
            y1: 1,
            yref: "paper",
            line: {color: "red", width: 2, dash: "dot"}
          }],
        },
        {
          title: `Mean LWE Anomaly Time Series`,
        }
      );
    }).catch(console.error);
  };

  // update the timeSlider web component
  timeSlider.mode = "instant";
  timeSlider.fullTimeExtent = {
    start: timeDates[0],
    end: timeDates[timeDates.length - 1]
  };
  timeSlider.stops = {dates: timeDates};
  timeSlider.timeExtent = {
    start: timeDates[0],
    end: timeDates[0]
  };
  timeSlider.labelsVisible = true;

  reactiveUtils.watch(
    () => timeSlider.widget.timeExtent,
    (te) => {
      const current = te?.start;
      if (!current) return;
      const idx = timeDates.findIndex((d) => d.getTime() === current.getTime());
      if (idx >= 0) updateMapToTimeStep(idx);
    }
  );

  // initial draw
  updateMapToTimeStep(0);
}

const resetLayers = () => {
  sketchTool.layer.removeAll();
  boundaryLayer.definitionExpression = "1=1"; // reset to none selected
  arcgisMap.view.goTo(boundaryLayer.fullExtent);
  timeSlider.widget.stop();
  document.getElementById("timeseries-plot").innerHTML = appInstructions;
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GW Anomaly Cells");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
}

arcgisMap.addEventListener("arcgisViewReadyChange", async () => {
  await arcgisMap.map.when();
  await arcgisMap.view.when()
  arcgisMap.map.addMany([boundaryLayer])

  sketchTool.availableCreateTools = ["polygon"];
  sketchTool.layer.title = "User drawn polygons";
  sketchTool.addEventListener("arcgisCreate", (e) => {
    if (e.detail.state === "start") {
      sketchTool.layer.removeAll();
    }
    if (e.detail.state === "complete") {
      const polygon = e.detail.graphic.geometry;
      analyzeDrawnPolygon({polygon});
    }
  })

  arcgisLayerList.listItemCreatedFunction = (event) => {
    const item = event.item;
    if (item.layer.title === "Aquifer Boundaries") {
      item.actionsSections = [[
        {
          title: "Zoom to Full Extent",
          id: "full-extent-aquifers",
          icon: "zoom-out-fixed"
        }
      ]];
    } else if (item.layer.title === "GW Anomaly Cells") {
      item.actionsSections = [[
        {
          title: "Zoom to Full Extent",
          id: "full-extent-gwcells",
          icon: "zoom-out-fixed"
        },
      ]];
    }
  }

  arcgisLayerList.addEventListener("arcgisTriggerAction", (event) => {
    if (event.detail.action.id === "full-extent-aquifers") {
      arcgisMap.view.goTo(boundaryLayer.fullExtent);
    } else if (event.detail.action.id === "full-extent-gwcells") {
      const gwCellsLayer = arcgisMap.map.layers.find(l => l.title === "GW Anomaly Cells");
      if (gwCellsLayer) {
        arcgisMap.view.goTo(gwCellsLayer.fullExtent);
      }
    } else if (event.detail.action.id === "reset-selections") {
      resetLayers();
    }
  })

  document
    .querySelector("calcite-action#refresh-layers")
    .addEventListener("click", async () => resetLayers())

});
