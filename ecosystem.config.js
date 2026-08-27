/** PM2 config — alternative deploy without Docker (see README) */
module.exports = {
  apps: [
    {
      name: "storage-by-afr",
      script: "node_modules/.bin/next",
      args: "start",
      cwd: __dirname,
      env: { PORT: 3000, NODE_ENV: "production" },
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1G",
    },
    {
      name: "storage-worker",
      script: "node_modules/.bin/tsx",
      args: "workers/index.ts",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      max_memory_restart: "512M",
    },
  ],
};
