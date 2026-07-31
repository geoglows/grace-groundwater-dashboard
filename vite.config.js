import fs from 'node:fs';
import path from 'node:path';
import {defineConfig, loadEnv} from 'vite';
import tailwindcss from '@tailwindcss/vite';

const LOCAL_ZARR_PREFIX = '/local-zarr';

const serveLocalZarr = (dir) => ({
  name: 'serve-local-zarr',
  apply: 'serve', // dev only; a production build must point at a real URL
  configureServer(server) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root)) {
      server.config.logger.warn(`[local-zarr] LOCAL_ZARR_DIR does not exist: ${root}`);
      return;
    }
    server.config.logger.info(`[local-zarr] serving ${root} at ${LOCAL_ZARR_PREFIX}/`);
    server.middlewares.use(LOCAL_ZARR_PREFIX, (req, res, next) => {
      // The prefix is stripped by connect, so req.url is the store-relative path.
      const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      // Anything that escapes the configured directory is not ours to serve.
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (!stat.isFile()) return next();
      res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'no-store'); // rebuild the store, reload, see it
      fs.createReadStream(file).pipe(res);
    });
  },
});

const normalizeBase = (value) => {
  const trimmed = (value ?? '').trim();
  if (!trimmed || trimmed === '/') return '/';
  if (/^https?:\/\//i.test(trimmed)) return `${trimmed.replace(/\/+$/, '')}/`;
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
};

export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, '.', '');
  const targetEnv = env.VERCEL_TARGET_ENV || env.VERCEL_ENV;
  const servedAtRoot = env.VERCEL === '1' && targetEnv !== 'production' && targetEnv !== 'staging';
  const base = servedAtRoot ? '/' : normalizeBase(env.VITE_BASE_PATH);

  if (command === 'build') {
    console.log(
      `[vite] base=${base}  (VITE_BASE_PATH=${env.VITE_BASE_PATH ?? '<unset>'}, ` +
      `VERCEL_TARGET_ENV=${targetEnv ?? '<unset>'}, servedAtRoot=${servedAtRoot})\n` +
      `[vite] this build only works when served from ${base} — a mismatch 404/503s every asset.`,
    );
  }

  return {
    base,
    plugins: [tailwindcss(), env.LOCAL_ZARR_DIR ? serveLocalZarr(env.LOCAL_ZARR_DIR) : null],
    build: {
      // The ArcGIS SDK explodes into ~1300 tiny ES modules. Vite's default
      // behavior injects a <link rel="modulepreload"> for the entire entry
      // import graph (~465 tags), so the browser fires ~465 concurrent HTTP/2
      // requests at the CDN the instant it parses <head> — before the app even
      // runs. That synchronized avalanche over a single connection trips
      // CloudFront's per-connection concurrency limit, which answers 503 for a
      // large fraction of them (the browser reports net::ERR_ABORTED 503). The
      // same requests spread across separate connections never fail.
      //
      // Two mitigations, together:
      //  1. modulePreload.polyfill stays but we cap the preload avalanche by
      //     dropping the blanket preload — modules load as imports resolve.
      //  2. manualChunks consolidates vendor code into a handful of larger
      //     chunks so there are far fewer requests to begin with.
      modulePreload: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@arcgis') || id.includes('@esri')) return 'arcgis';
            if (id.includes('zarrita') || id.includes('numcodecs')) return 'zarr';
            if (id.includes('chart.js') || id.includes('date-fns')) return 'charts';
            return 'vendor';
          },
        },
      },
    },
    define: {
      global: 'globalThis',
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    // The global-frame loaders are ES module workers (see globalFramesClient.js);
    // building them as ESM keeps their import graph shared with the main bundle
    // instead of duplicating zarrita into an IIFE.
    worker: {
      format: 'es',
    },
    server: {
      watch: {
        ignored: [
          '**/data_processors/**',
        ],
      },
    },
  };
});
