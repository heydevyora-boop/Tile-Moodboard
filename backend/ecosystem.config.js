/**
 * PM2 config for deployments that don't use Docker (a plain VM/VPS).
 * Inside Docker, the container's own process (backed by `docker-entrypoint.sh`)
 * is the process manager instead — don't run PM2 inside a container as well.
 *
 * IMPORTANT — single instance only, not cluster mode:
 * The catalog extraction queue (src/services/extractionQueue.service.ts)
 * and the generic job queue (src/services/jobQueue.service.ts) both hold
 * in-process state and claim work with a plain findFirst-then-update, not
 * an atomic compare-and-swap. Two Node processes racing on the same
 * PENDING job could both pick it up — one wasted duplicate run rather
 * than data corruption, but still not the intended behavior. Until that's
 * hardened with real row-level locking, this app should run as exactly
 * one process. Scale by giving that process more resources, not by
 * clustering it.
 */
module.exports = {
  apps: [
    {
      name: 'casa-de-aurum-api',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      kill_timeout: 10000,
      wait_ready: false,
    },
  ],
};
