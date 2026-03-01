module.exports = {
  apps: [
    {
      name: "wa-agent",
      script: "index.js",
      node_args: "--max-old-space-size=256",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000, // 5 seconds between restarts
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/error.log",
      out_file: "./logs/output.log",
      merge_logs: true,
      max_memory_restart: "400M", // restart if memory exceeds 400MB
    },
  ],
};
