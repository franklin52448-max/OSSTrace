// pm2 config for the Explorer's background indexer (packages/features/explorer/src/indexer.ts),
// run as a long-lived process instead of a terminal session. The pm2 equivalent of
// osstrace-indexer.service next to this file. Use one or the other, not both.
//
//   npm install -g pm2
//   pm2 start packages/features/explorer/deploy/ecosystem.config.cjs   # from anywhere
//   pm2 logs osstrace-indexer
//   pm2 save && pm2 startup    # optional: bring it back after a reboot
//
// `.cjs` because the repo's package.json is `"type": "module"` and pm2 loads this with require().
//
// Configuration comes from the repo root .env. The indexer reads that file itself on startup
// (loadRootEnv in src/bootstrap.ts), so nothing is duplicated here. It only does useful work when
// REDIS_URL there points at the same Redis the API server uses. Run exactly one indexer per Redis.

const path = require("node:path");

// deploy/ → explorer/ → features/ → packages/ → repo root.
const repoRoot = path.resolve(__dirname, "../../../..");

module.exports = {
  apps: [
    {
      name: "osstrace-indexer",
      cwd: repoRoot,
      // The repo's own script (root package.json: "dev:indexer" runs exactly this). Needs Node 24+.
      script: "npm",
      args: "run indexer --workspace packages/features/explorer",
      interpreter: "none",
      // Restart when it crashes, not after a clean exit: the same policy as systemd's Restart=on-failure.
      autorestart: true,
      stop_exit_codes: [0],
      restart_delay: 5000,
      // npm starts node as a child process; kill the whole tree on stop/restart, not just npm.
      treekill: true,
      // A single process: two indexers on one Redis would double RPC load and duplicate every push.
      instances: 1,
      exec_mode: "fork",
      env: {
        npm_config_update_notifier: "false",
      },
    },
  ],
};
