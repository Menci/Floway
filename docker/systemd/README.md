# Podman Quadlet (systemd) configurations

Podman Quadlets allow you to manage containers as native systemd services. These configuration files allow you to deploy and auto-start Floway using systemd.

## Rootless installation

1. Install [Podman](https://podman.io).

   Podman should be preinstalled on Red Hat systems, and can be installed on-demand on other systems.

2. ```bash
   mkdir -p ~/.config/containers/systemd/
   cp floway-data.volume floway-server.container.example floway-web.container floway.pod ~/.config/containers/systemd/
   ```

3. Edit `~/.config/containers/systemd/floway-server.container.example` by replacing `<admin-secret>` with your desired admin key.

4. ```bash
   mv ~/.config/containers/systemd/floway-server.container.example ~/.config/containers/systemd/floway-server.container
   loginctl enable-linger
   systemctl --user daemon-reload
   systemctl --user restart floway-server floway-web
   ```

5. Floway should be available at `http://localhost:18088`.

## Root installation

1. Install [Podman](https://podman.io).

   Podman should be preinstalled on Red Hat systems, and can be installed on-demand on other systems.

2. ```bash
   sudo mkdir -p /etc/containers/systemd/
   sudo cp floway-data.volume floway-server.container.example floway-web.container floway.pod /etc/containers/systemd/
   ```

3. Edit `/etc/containers/systemd/floway-server.container.example` by replacing `<admin-secret>` with your desired admin key.

4. ```bash
   sudo mv /etc/containers/systemd/floway-server.container.example /etc/containers/systemd/floway-server.container
   sudo systemctl daemon-reload
   sudo systemctl restart floway-server floway-web
   ```

5. Floway should be available at `http://localhost:18088`.
