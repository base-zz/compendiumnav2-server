#!/usr/bin/env python3
import subprocess
import sys
import time
import re
from collections import OrderedDict

SCAN_DURATION_SECONDS = 15


# Match "Device <MAC> <rest of line>", ignoring any [NEW]/[CHG] tag or colours.
DEVICE_LINE_RE = re.compile(r"Device\s+([0-9A-Fa-f:]{17})\b(?:\s+(.+))?$")

# Strip ANSI escape sequences like \x1b[0;94m and similar.
ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def run_bluetoothctl(commands, timeout=5):
    """Run a short bluetoothctl command sequence and return its output lines."""
    cmd = ["bluetoothctl"]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    try:
        for line in commands:
            proc.stdin.write(line + "\n")
            proc.stdin.flush()
        proc.stdin.write("quit\n")
        proc.stdin.flush()
    except BrokenPipeError:
        pass

    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        output, _ = proc.communicate()

    return output.splitlines()


def scan_devices(duration=SCAN_DURATION_SECONDS):
    """Use bluetoothctl scan on for a fixed duration and capture devices."""
    cmd = ["bluetoothctl"]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    devices = OrderedDict()  # address -> name

    start_time = time.time()

    try:
        # Start scanning
        proc.stdin.write("scan on\n")
        proc.stdin.flush()

        print(f"Starting scan for {duration} seconds...\n")

        import select
        while True:
            # Compute remaining time and stop if we've exceeded duration
            elapsed = time.time() - start_time
            if elapsed >= duration:
                break

            # Wait for data on stdout up to the remaining time
            remaining = max(0.0, duration - elapsed)
            rlist, _, _ = select.select([proc.stdout], [], [], remaining)
            if not rlist:
                # No data before timeout; end the scan loop
                break

            line = proc.stdout.readline()
            if not line:
                # bluetoothctl exited unexpectedly
                break

            print("RAW:", repr(line))

            # Clean ANSI escape sequences and simple control chars that
            # bluetoothctl uses around the prompt / tags.
            cleaned = ANSI_ESCAPE_RE.sub("", line)
            cleaned = cleaned.replace("\x01", "").replace("\x02", "")
            cleaned = cleaned.strip()

            match = DEVICE_LINE_RE.search(cleaned)
            if match:
                addr, name = match.groups()
                name = (name or "").strip() or "Unknown"
                if addr not in devices:
                    devices[addr] = name
                    print(f"Found device: {addr}  {name}")

    finally:
        try:
            proc.stdin.write("scan off\n")
            proc.stdin.flush()
        except Exception:
            pass

        try:
            proc.stdin.write("quit\n")
            proc.stdin.flush()
        except Exception:
            pass

        # Give bluetoothctl a moment to exit cleanly
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

    return devices


def main():
    # Quick sanity check that controller is powered
    print("Checking Bluetooth controller status...\n")
    status_lines = run_bluetoothctl(["show"])
    for line in status_lines:
        print(line)
    print("\n")

    if not any("Powered: yes" in line for line in status_lines):
        print("WARNING: Controller is not powered on. "
              "Try `bluetoothctl power on` and rerun.\n")

    devices = scan_devices()

    print("\n=== Scan complete ===")
    if not devices:
        print("No devices found.")
        sys.exit(0)

    print(f"\nTotal devices found: {len(devices)}\n")
    for addr, name in devices.items():
        print(f"{addr}  {name}")


if __name__ == "__main__":
    main()
