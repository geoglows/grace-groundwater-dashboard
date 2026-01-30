export function meanIgnoringNaN(data, shape, stride) {
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

export function createUncertaintyBand({x, yArray, uncertaintyArray, color, name}) {
  return {
    x: x.concat(x.slice().reverse()),
    y: Array.from(yArray).map((v, i) => v + uncertaintyArray[i])
      .concat(Array.from(yArray).map((v, i) => v - uncertaintyArray[i]).reverse()),
    fill: "toself",
    fillcolor: color,
    line: {color: "rgba(255,255,255,0)"},
    name: `${name} Uncertainty`,
    showlegend: false,
    legendgroup: name
  }
}

export function createLinePlot({x, y, color, name}) {
  return {
    x: x,
    y: Array.from(y),
    mode: "lines",
    name,
    line: {color},
    legendgroup: name
  }
}
