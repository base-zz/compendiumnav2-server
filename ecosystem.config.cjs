module.exports = {
  apps: [
    {
      name: "compendiumnav2-server",
      script: "src/mainServer.js",
      node_args: ["-r", "module-alias/register"],
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 2000,
      kill_timeout: 10000,
      time: true,
    },
  ],
};
