### Deployment

- CI deploys to terp as the unprivileged `deploy` user instead of root. The
  gate runs git, npm and rsync as `deploy`, which owns the checkouts but cannot
  read `.env`; root does only `stomp-deploy-root`'s fixed steps (re-owning the
  trees, restarting the pm2 app, printing its logs) through sudo.
