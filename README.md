# Deployment Documentation

## Raspberry Pi: NATS Service

`compendium-deploy-rpi.sh` and `compendium-deploy-rpi5.sh` now provision a local NATS server for inter-app communication.

### What the deploy scripts do

- Install `nats-server`.
- Select a free NATS port and avoid conflicts with HTTP/WebSocket ports.
- Write NATS config to `/etc/nats/nats-server.conf`.
- Ensure JetStream storage exists at `/var/lib/nats/jetstream`.
- Enable and restart `nats-server.service` (or `nats.service` depending on distro).
- Write app environment values:
  - `NATS_ENABLED=true`
  - `NATS_HOST=127.0.0.1`
  - `NATS_PORT=<selected-port>`
  - `NATS_URL=nats://127.0.0.1:<selected-port>`

### Service management on Pi

- Check status:
  - `sudo systemctl status nats-server.service || sudo systemctl status nats.service`
- Restart:
  - `sudo systemctl restart nats-server.service || sudo systemctl restart nats.service`
- Tail logs:
  - `sudo journalctl -u nats-server -f || sudo journalctl -u nats -f`

### Quick verification

- Confirm app env values in `.env` (inside app directory):
  - `NATS_ENABLED`
  - `NATS_HOST`
  - `NATS_PORT`
  - `NATS_URL`
- Confirm listener on configured port:
  - `ss -ltn | grep ":4222"`
  - If your script selected a different port, replace `4222` with that value from `.env`.
