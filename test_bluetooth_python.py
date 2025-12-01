#!/usr/bin/env python3
import subprocess
import sys
import time
import re
from collections import OrderedDict

SCAN_DURATION_SECONDS = 15


DEVICE_LINE_RE = re.compile(r'^\[(NEW|CHG)\]\s+Device\s+([0-9A-Fa-f:]{17})\s+(.*)$')


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
            # Compute remaining time
            elapsed = time.time() - start_time
            remaining = duration - elapsed
            if remaining <= 0:
                break
            # Wait for a line with a timeout based on remaining time
            rlist, _, _ = select.select([proc.stdout], [], [], remaining)
            if not rlist:
                # No more data before timeout, stop scanning
                break
            line = proc.stdout.readline()
            if not line:
                # bluetoothctl exited unexpectedly
                break

            print("RAW:", repr(line))

            line = line.strip()
            match = DEVICE_LINE_RE.match(line)
            if match:
                _tag, addr, name = match.groups()
                name = name.strip() or "Unknown"
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
