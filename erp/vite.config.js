import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* The ERP prototype is a self-contained app. It shares nothing with the
   Casa De Aurum website at build time -- no imports across the folder
   boundary, no shared config -- so lifting this directory into its own
   repository later is a move, not a refactor. */
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, host: '127.0.0.1' },
});
