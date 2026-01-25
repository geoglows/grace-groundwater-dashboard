import "@arcgis/core/assets/esri/themes/light/main.css";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-zoom";
import "@arcgis/map-components/components/arcgis-layer-list";
import "@arcgis/map-components/components/arcgis-locate";
import "@arcgis/map-components/components/arcgis-scale-bar";
import "@arcgis/map-components/components/arcgis-expand";
import "@arcgis/map-components/components/arcgis-basemap-gallery";
import "@arcgis/map-components/components/arcgis-legend";

import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as geometryEngine from "@arcgis/core/geometry/geometryEngine.js";
import TimeSlider from "@arcgis/core/widgets/TimeSlider.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";

import Plotly from 'plotly.js/lib/core'
import Scatter from 'plotly.js/lib/scatter'
import {FetchStore, get, open} from "zarrita"

import {getOrFetchCoords} from "./db.js";

import "./style.css";

Plotly.register([Scatter]);

// const zarrUrl = "http://geoglows-v2.s3-us-west-2.amazonaws.com/groundwater/GRC_gw_anomaly.zarr3";
const zarrUrl = "https://d2grb3c773p1iz.cloudfront.net/groundwater/GRC_gw_anomaly.zarr3";

const coordsPromise = getOrFetchCoords({zarrUrl});
const mapElement = document.querySelector("arcgis-map");
const timeSlider = document.getElementById("timeSliderContainer");

mapElement.addEventListener('arcgisViewReadyChange', async () => {
    const {lat, lon} = await coordsPromise;
    const cellSize = lat.data[1] - lat.data[0]; // should be 0.25
    const HALF = cellSize / 2;
    const map = mapElement.map;
    const view = mapElement.view;

// --- Boundary layer (GeoJSON) ---
    const boundaryLayer = new GeoJSONLayer({
      title: "Boundary",
      url: "./boundary.geojson",
      renderer: {
        type: "simple",
        symbol: {
          type: "simple-fill",
          color: [255, 255, 255, 0],
          outline: {color: [0, 0, 0, 1], width: 2}
        }
      }
    });
    const selectedCellsLayer = new GraphicsLayer({title: "GW Anomaly Cells"});
    map.layers.addMany([selectedCellsLayer, boundaryLayer]);

// Load boundary layer + zoom
    await boundaryLayer.load();
    const boundaryExtent = boundaryLayer.fullExtent;
    await view.when();
    await view.goTo(boundaryExtent.expand(1.2));

// ---- Get the actual boundary polygon geometry ----
    const q = boundaryLayer.createQuery();
    q.returnGeometry = true;
    q.outFields = [];
    q.where = "1=1";

    const fs = await boundaryLayer.queryFeatures(q);
    if (!fs.features.length) {
      throw new Error("No features found in boundary.geojson");
    }

    const boundaryGeom = fs.features[0].geometry;

    // ---- Candidate cell centers limited by boundary extent ----
    const filteredLats = lat.data.filter(lat => lat >= boundaryExtent.ymin - HALF && lat <= boundaryExtent.ymax + HALF);
    const filteredLons = lon.data.filter(lon => lon >= boundaryExtent.xmin - HALF && lon <= boundaryExtent.xmax + HALF);

    const lweStore = new FetchStore(zarrUrl + "/lwe_thickness_anomaly");
    const lweNode = await open.v3(lweStore);
    let lweValues = get(lweNode, [null, {start: lat.data.indexOf(filteredLats[0]), stop: lat.data.indexOf(filteredLats[filteredLats.length - 1]) + 1}, {
      start: lon.data.indexOf(filteredLons[0]),
      stop: lon.data.indexOf(filteredLons[filteredLons.length - 1]) + 1
    }]);
    const uncStore = new FetchStore(zarrUrl + "/uncertainty");
    const uncNode = await open.v3(uncStore);
    let uncValues = get(uncNode, [null, {start: lat.data.indexOf(filteredLats[0]), stop: lat.data.indexOf(filteredLats[filteredLats.length - 1]) + 1}, {
      start: lon.data.indexOf(filteredLons[0]),
      stop: lon.data.indexOf(filteredLons[filteredLons.length - 1]) + 1
    }]);
    const timeStore = new FetchStore(zarrUrl + "/time");
    const timeNode = await open.v3(timeStore);
    let timeValues = get(timeNode, [null]);

    // ---- Helper: build a 0.25° cell polygon from center ----
    function cellPolygonFromCenter(lon, lat) {
      return new Polygon({
        spatialReference: SpatialReference.WGS84,
        rings: [[
          [lon - HALF, lat - HALF],
          [lon - HALF, lat + HALF],
          [lon + HALF, lat + HALF],
          [lon + HALF, lat - HALF],
          [lon - HALF, lat - HALF],
        ]]
      });
    }

    // ---- Find selected cells (>50% contained) ----
    intersectionOperator.accelerateGeometry(boundaryGeom);
    const intersectingCells = [];
    for (const lat of filteredLats) {
      for (const lon of filteredLons) {
        // make a square grid cell
        const cell = cellPolygonFromCenter(lon, lat);
        const cellArea = geometryEngine.geodesicArea(cell);
        // compute the intersection of the cell with the boundary
        const intersects = intersectionOperator.execute(boundaryGeom, cell);
        // if there is an intersection, lets determine the percentage so that its handy for math later
        // const intersectArea = intersects ? geometryEngine.geodesicArea(intersects) : 0;
        // const frac = intersectArea / cellArea;
        // the returned object should have the lat, lon, fraction, intersected geometry, and a boolean for if it is intersecting at all (boolean of intersects)
        intersectingCells.push({lon, lat, frac: 1, cell, intersects: !!intersects});
      }
    }

// ---- Visualize selected cells ----
    // now we make the graphic layer for all cells that are >50% contained.
    // We previously queries the square bounding box based on the extent.
    // We also have the intersection geometries pre-computed on the same bounding box.
    // We should be able to now iterate over both at the same time since the ordering is the same.
    lweValues = await lweValues;
    uncValues = await uncValues;
    timeValues = await timeValues;
    // convert times from BigInt in units of days since 2002-04-01
    const timeDates = Array.from(timeValues.data).map(t => {
      const baseDate = new Date(Date.UTC(2002, 3, 1)); // months are 0-indexed
      baseDate.setUTCDate(baseDate.getUTCDate() + Number(t));
      return baseDate;
    })

    // now we need to compute the average value per times step for both the lweValues and uncValues
    // then compute the lwe + unc and lwe - unc for each cell so we can plot 3 time series
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

    const lweMeanTimeSeries = meanIgnoringNaN(lweValues.data, lweValues.shape, lweValues.stride);
    const uncMeanTimeSeries = meanIgnoringNaN(uncValues.data, uncValues.shape, uncValues.stride);

    // use plotly to make a time series plot of the mean values
    const xValues = timeDates;
    const trace1 = {
      x: xValues,
      y: Array.from(lweMeanTimeSeries),
      mode: 'lines+markers',
      name: 'LWE Anomaly',
      line: {color: 'black'}
    };
    const trace2 = {
      x: xValues.concat(xValues.slice().reverse()),
      y: Array.from(lweMeanTimeSeries).map((v, i) => v + uncMeanTimeSeries[i])
        .concat(Array.from(lweMeanTimeSeries).map((v, i) => v - uncMeanTimeSeries[i]).reverse()),
      fill: 'toself',
      fillcolor: 'rgba(0,197,255,0.45)',
      line: {color: 'rgba(255,255,255,0)'},
      name: 'Uncertainty Range',
      showlegend: true
    };
    const data = [trace2, trace1];
    const layout = {
      title: 'Mean LWE Anomaly Time Series with Uncertainty',
      xaxis: {title: 'Time Step'},
      yaxis: {title: 'LWE Anomaly (mm)'},
      legend: {orientation: 'h', y: -0.2}
    };
    Plotly.newPlot('timeseries-plot', data, layout, {responsive: true});

    // the color scale is red to white to blue for -50 to 50
    // make a function to turn the value into a color
    const RED_WHITE_BLUE_21 = [
      {"r": 103, "g": 0, "b": 31, "a": 0.6},
      {"r": 142, "g": 1, "b": 82, "a": 0.6},
      {"r": 178, "g": 24, "b": 43, "a": 0.6},
      {"r": 214, "g": 96, "b": 77, "a": 0.6},
      {"r": 244, "g": 165, "b": 130, "a": 0.6},
      {"r": 253, "g": 219, "b": 199, "a": 0.6},
      {"r": 254, "g": 224, "b": 210, "a": 0.6},
      {"r": 253, "g": 224, "b": 221, "a": 0.6},
      {"r": 255, "g": 240, "b": 245, "a": 0.6},
      {"r": 255, "g": 247, "b": 251, "a": 0.6},
      {"r": 255, "g": 255, "b": 255, "a": 0.6},
      {"r": 247, "g": 251, "b": 255, "a": 0.6},
      {"r": 222, "g": 235, "b": 247, "a": 0.6},
      {"r": 198, "g": 219, "b": 239, "a": 0.6},
      {"r": 158, "g": 202, "b": 225, "a": 0.6},
      {"r": 107, "g": 174, "b": 214, "a": 0.6},
      {"r": 66, "g": 146, "b": 198, "a": 0.6},
      {"r": 33, "g": 113, "b": 181, "a": 0.6},
      {"r": 8, "g": 81, "b": 156, "a": 0.6},
      {"r": 8, "g": 48, "b": 107, "a": 0.6},
      {"r": 4, "g": 24, "b": 54, "a": 0.6},
    ]
    const valueLimits = [-25, -22.5, -20, -17.5, -15, -12.5, -10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25];
    const valueToColor = (value) => {
      return valueLimits.reduce((acc, limit, idx) => {
        if (value >= limit) {
          return RED_WHITE_BLUE_21[idx];
        }
        return acc;
      }, RED_WHITE_BLUE_21[0]);
    }
    // create a legend for the map based on the 21

    // declare a function that changes the map to the time step given
    const updateMapToTimeStep = (timeStep) => {
      selectedCellsLayer.removeAll()
      selectedCellsLayer.addMany(
        intersectingCells
          .map(({lon, lat, frac, cell, intersects}, idx) => {
            if (!intersects || frac < 0.5) return null
            return new Graphic({
              geometry: cell,
              attributes: {lon, lat, frac},
              symbol: {
                type: "simple-fill",
                color: valueToColor(lweValues.data[timeStep * lweValues.shape[1] * lweValues.shape[2] + idx]),
                outline: {color: [0, 0, 0, 1], width: 0.5}
              },
            })
          })
          .filter(g => g !== null)
      )
      Plotly.relayout('timeseries-plot', {
          shapes: [
            {
              type: 'line',
              x0: timeDates[timeStep],
              x1: timeDates[timeStep],
              y0: 0,
              y1: 1,
              yref: 'paper',
              line: {
                color: 'red',
                width: 2,
                dash: 'dot'
              }
            }
          ]
        });
    }

    const slider = new TimeSlider({
      container: timeSlider,
      mode: "instant",
      playRate: 500,
      fullTimeExtent: {
        start: timeDates[0],
        end: timeDates[timeDates.length - 1]
      },
      stops: {dates: timeDates},
      timeExtent: {
        start: timeDates[0],
        end: timeDates[0]
      },
      labelsVisible: true
    });
    reactiveUtils.watch(
      () => slider.timeExtent,
      (te) => {
        const current = te?.start;
        if (!current) return;
        const idx = timeDates.findIndex(d => d.getTime() === current.getTime());
        if (idx >= 0) updateMapToTimeStep(idx);
      }
    );
    updateMapToTimeStep(0)
  }
)
