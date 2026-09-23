# Podman Quadlet (systemd) configurations

Podman Quadlets allow you to manage containers as native systemd services. These configuration files allow you to deploy and auto-start Floway using systemd.

## Upgrade notice: Container image merging

This release merges the separate `floway-server` and `floway-web` container
images into a single container named `floway`. Thus the separate `floway-web`
image is no longer published and the `floway-pod` Pod is no longer necessary.

Before updating an existing Quadlet deployment, stop and remove the old units
`floway-{server,web}.container` and the old Pod `floway.pod`, then reload
systemd and restart `floway`:

```bash
systemctl --user stop floway-{pod,server,web}
rm ~/.config/containers/systemd/floway-{server,web}.container
rm ~/.config/containers/systemd/floway.pod
systemctl --user daemon-reload
systemctl --user restart floway
```

For a root-managed deployment, replace the path and commands with their `sudo`
equivalents under `/etc/containers/systemd/`.

The HTTP listen address has changed to a single port at `0.0.0.0:8788`.

## Rootless installation

1. Install [Podman](https://podman.io).

   Podman should be preinstalled on Red Hat systems, and can be installed on-demand on other systems.

   On Debian, the Podman package might be missing a `catatonit` dependency. Install it, or Pods might not start.

2. ```bash
   mkdir -p ~/.config/containers/systemd/
   cp floway-data.volume floway.container.example ~/.config/containers/systemd/
   ```

3. Edit `~/.config/containers/systemd/floway.container.example` by replacing `<admin-secret>` with your desired admin secret.

4. ```bash
   mv ~/.config/containers/systemd/floway.container.example ~/.config/containers/systemd/floway.container
   loginctl enable-linger
   systemctl --user daemon-reload
   systemctl --user restart floway
   ```

5. Floway should be available at `http://localhost:8788`.

## Root installation

1. Install [Podman](https://podman.io).

   Podman should be preinstalled on Red Hat systems, and can be installed on-demand on other systems.

   On Debian, the Podman package might be missing a `catatonit` dependency. Install it, or Pods might not start.

2. ```bash
   sudo mkdir -p /etc/containers/systemd/
   sudo cp floway-data.volume floway.container.example /etc/containers/systemd/
   ```

3. Edit `/etc/containers/systemd/floway.container.example` by replacing `<admin-secret>` with your desired admin secret.

4. ```bash
   sudo mv /etc/containers/systemd/floway.container.example /etc/containers/systemd/floway.container
   sudo systemctl daemon-reload
   sudo systemctl restart floway
   ```

5. Floway should be available at `http://localhost:8788`.
