import {defineConfig} from 'vite';

export default defineConfig({
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
  server: {
    watch: {
      ignored: [
        '**/data_processors/**',
      ],
    },
  },
});
