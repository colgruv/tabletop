import * as ec2 from "aws-cdk-lib/aws-ec2";

export const NODE_VERSION = "v24.14.0";

/**
 * First-boot setup for Amazon Linux 2023 (arm64): Node, a service user, a
 * systemd unit, and `tabletop-update`, which pulls main and restarts.
 * Later deploys only run `tabletop-update` (via SSM), never this script.
 */
export function serverUserData(opts: { repoUrl: string; port: number; allowedOrigins: string[] }): ec2.UserData {
  const ud = ec2.UserData.forLinux();
  ud.addCommands(
    "set -euxo pipefail",
    "dnf install -y git",

    // Node from nodejs.org, checksum-verified.
    `NODE_VERSION=${NODE_VERSION}`,
    'NODE_TAR="node-${NODE_VERSION}-linux-arm64.tar.xz"',
    "cd /tmp",
    'curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"',
    'curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" | grep " ${NODE_TAR}$" | sha256sum -c -',
    'tar -xJf "${NODE_TAR}" -C /usr/local --strip-components=1',
    'rm -f "${NODE_TAR}"',

    // 1 GB of swap so npm ci doesn't run out of memory on a 1 GB instance.
    "if [ ! -f /swapfile ]; then dd if=/dev/zero of=/swapfile bs=1M count=1024; chmod 600 /swapfile; mkswap /swapfile; echo '/swapfile swap swap defaults 0 0' >> /etc/fstab; fi",
    "swapon -a",

    "id tabletop || useradd --system --create-home --home-dir /opt/tabletop --shell /sbin/nologin tabletop",
    "install -d -o tabletop -g tabletop -m 750 /var/lib/tabletop",

    `cat > /usr/local/bin/tabletop-update <<'EOF'
#!/bin/bash
# Pull the latest main, install runtime deps, restart. Safe to re-run.
set -euo pipefail
APP=/opt/tabletop/app
as_app() { sudo -u tabletop -H env PATH=/usr/local/bin:/usr/bin "$@"; }
if [ ! -d "$APP/.git" ]; then
  as_app git clone --depth 1 --branch main ${opts.repoUrl} "$APP"
else
  as_app git -C "$APP" fetch --depth 1 origin main
  as_app git -C "$APP" reset --hard origin/main
fi
cd "$APP"
as_app npm ci --omit=dev --no-audit --no-fund
systemctl restart tabletop
sleep 2
systemctl is-active tabletop
as_app git -C "$APP" log -1 --format='deployed %h %s'
EOF`,
    "chmod 755 /usr/local/bin/tabletop-update",

    `cat > /etc/systemd/system/tabletop.service <<'EOF'
[Unit]
Description=Tabletop server
After=network-online.target
Wants=network-online.target

[Service]
User=tabletop
WorkingDirectory=/opt/tabletop/app/server
Environment=NODE_ENV=production
Environment=PORT=${opts.port}
Environment=TABLETOP_DB=/var/lib/tabletop/tabletop.db
Environment=TRUST_PROXY=1
Environment=ALLOWED_ORIGINS=${opts.allowedOrigins.join(",")}
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning --import tsx src/index.ts
Restart=always
RestartSec=2
MemoryMax=700M
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/tabletop
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF`,
    "systemctl daemon-reload",
    "systemctl enable tabletop",
    // If the repo isn't reachable yet, the instance still comes up; re-run via `npm run update-server`.
    "/usr/local/bin/tabletop-update || echo 'tabletop-update failed; re-run it once the repo is public'",
  );
  return ud;
}
