Deployment address files (`<chainId>.json`, written by `DeployBNB.s.sol`) are gitignored. `deploy.sh` turns them into
`.env.<network>` (also gitignored, chmod 600) with `PORW_*` variables; the relayer reads those from the environment
(`source .env.<network>` or `--env .env.<network>`). Keep the env files in your secret store; nothing here goes to git.
