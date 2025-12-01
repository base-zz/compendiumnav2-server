#!/usr/bin/env python3
"""
Simple BlueZ D-Bus BLE scanner for Linux.

- Connects to the system bus and BlueZ (org.bluez).
- Starts discovery on hci0 via org.bluez.Adapter1.
- Listens for InterfacesAdded / PropertiesChanged signals to detect devices.
- Runs for SCAN_DURATION_SECONDS then stops discovery and exits.

This is a standalone test tool; it does not talk to your Node app.
"""

import sys
import time

SCAN_DURATION_SECONDS = 15

try:
    import dbus
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib
except ImportError as e:
    print("Missing Python D-Bus dependencies.")
    print("You likely need to install: python3-dbus python3-gi gir1.2-glib-2.0")
    print("Error:", e)
    sys.exit(1)


BLUEZ_SERVICE_NAME = "org.bluez"
ADAPTER_INTERFACE = "org.bluez.Adapter1"
DEVICE_INTERFACE = "org.bluez.Device1"


def get_adapter(bus, adapter_name="hci0"):
    """Get the D-Bus object path for the given adapter (e.g. hci0)."""
    obj = bus.get_object(BLUEZ_SERVICE_NAME, "/")
    mgr = dbus.Interface(obj, "org.freedesktop.DBus.ObjectManager")
    objects = mgr.GetManagedObjects()

    for path, interfaces in objects.items():
        adapter = interfaces.get(ADAPTER_INTERFACE)
        if adapter is not None:
            if path.endswith(adapter_name):
                return path
    return None


class DeviceTracker:
    def __init__(self):
        self.devices = {}

    def handle_device(self, path, props):
        if DEVICE_INTERFACE not in props:
            return

        dev_props = props[DEVICE_INTERFACE]

        addr = str(dev_props.get("Address", ""))
        name = str(dev_props.get("Name", dev_props.get("Alias", "Unknown")))
        rssi = dev_props.get("RSSI")
        mdata = dev_props.get("ManufacturerData", {})

        # ManufacturerData is a dict: {uint16: variant(byte array)}
        mfr_strs = []
        for m_id, payload in mdata.items():
            try:
                # payload is a dbus Array of bytes
                raw = bytes(payload)
                hex_str = raw.hex().upper()
                mfr_strs.append(f"0x{int(m_id):04X}:{hex_str}")
            except Exception:
                mfr_strs.append(f"0x{int(m_id):04X}:(unreadable)")

        key = addr or path
        first_seen = key not in self.devices
        if first_seen:
            # First time seeing this device: store full info
            self.devices[key] = {
                "path": path,
                "address": addr,
                "name": name,
                "rssi": rssi,
                "manufacturer": mfr_strs,
            }
        else:
            # Update existing entry, preserving previously known address/name
            entry = self.devices[key]
            entry["path"] = path
            entry["address"] = addr or entry.get("address", "")
            entry["name"] = name or entry.get("name", "Unknown")
            if rssi is not None:
                entry["rssi"] = rssi
            if mfr_strs:
                entry["manufacturer"] = mfr_strs

        if first_seen:
            print("Found device:")
        else:
            print("Updated device:")

        print(f"  Path: {path}")
        print(f"  Address: {addr or 'Unknown'}")
        print(f"  Name: {name}")
        print(f"  RSSI: {rssi if rssi is not None else 'N/A'}")
        if mfr_strs:
            print("  ManufacturerData:")
            for entry in mfr_strs:
                print(f"    {entry}")
        print("")


def interfaces_added_handler(path, interfaces, tracker):
    print("[HANDLER] InterfacesAdded for", path, "keys=", list(interfaces.keys()))
    tracker.handle_device(path, interfaces)


def properties_changed_handler(bus, interface, changed, invalidated, path, tracker):
    if interface != DEVICE_INTERFACE:
        return
    print("[HANDLER] PropertiesChanged for", path, "keys=", list(changed.keys()))

    # Fetch full current Device1 properties so we always have Address/Name/etc.
    try:
        obj = bus.get_object(BLUEZ_SERVICE_NAME, path)
        props_iface = dbus.Interface(obj, "org.freedesktop.DBus.Properties")
        full_dev_props = props_iface.GetAll(DEVICE_INTERFACE)
    except dbus.DBusException as e:
        print("[HANDLER] Failed to GetAll for", path, "error=", e)
        full_dev_props = {}

    merged = dict(full_dev_props)
    merged.update(dict(changed))
    props = {DEVICE_INTERFACE: merged}
    tracker.handle_device(path, props)


def main():
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    print("Connecting to BlueZ over D-Bus...\n")

    # Debug: log any signals we see from BlueZ so we can verify subscription
    def debug_signal_handler(*args, **kwargs):
        path = kwargs.get("path")
        print("[DEBUG] Signal from BlueZ:", path, "args=", args)

    bus.add_signal_receiver(
        debug_signal_handler,
        dbus_interface=None,
        signal_name=None,
        bus_name=BLUEZ_SERVICE_NAME,
        path_keyword="path",
    )

    adapter_path = get_adapter(bus, "hci0")
    if not adapter_path:
        print("Could not find Bluetooth adapter hci0 via D-Bus.")
        sys.exit(1)

    print(f"Using adapter: {adapter_path}\n")

    adapter_obj = bus.get_object(BLUEZ_SERVICE_NAME, adapter_path)
    adapter = dbus.Interface(adapter_obj, ADAPTER_INTERFACE)

    tracker = DeviceTracker()

    # Connect signal handlers
    obj = bus.get_object(BLUEZ_SERVICE_NAME, "/")
    mgr = dbus.Interface(obj, "org.freedesktop.DBus.ObjectManager")

    bus.add_signal_receiver(
        lambda path, interfaces: interfaces_added_handler(path, interfaces, tracker),
        dbus_interface="org.freedesktop.DBus.ObjectManager",
        signal_name="InterfacesAdded",
        arg0=None,
    )

    bus.add_signal_receiver(
        lambda interface, changed, invalidated, path: properties_changed_handler(
            bus, interface, changed, invalidated, path, tracker
        ),
        dbus_interface="org.freedesktop.DBus.Properties",
        signal_name="PropertiesChanged",
        arg0=DEVICE_INTERFACE,
        path_keyword="path",
    )

    # Start discovery
    try:
        print("Starting discovery (BLE + classic)...")
        adapter.StartDiscovery()
    except dbus.DBusException as e:
        print("Failed to start discovery:", e)
        sys.exit(1)

    loop = GLib.MainLoop()

    def stop_scan():
        print("\nStopping discovery and exiting...\n")
        try:
            adapter.StopDiscovery()
        except dbus.DBusException as e:
            print("Error stopping discovery:", e)
        loop.quit()
        return False  # do not reschedule

    # Schedule stop after SCAN_DURATION_SECONDS
    GLib.timeout_add_seconds(SCAN_DURATION_SECONDS, stop_scan)

    print(f"Scanning for {SCAN_DURATION_SECONDS} seconds...\n")
    start = time.time()
    try:
        loop.run()
    except KeyboardInterrupt:
        stop_scan()

    elapsed = time.time() - start
    print(f"Scan duration: {elapsed:.1f}s")

    if not tracker.devices:
        print("No devices discovered.")
    else:
        print(f"\nTotal unique devices discovered: {len(tracker.devices)}\n")
        for info in tracker.devices.values():
            print(f"{info['address'] or info['path']}: {info['name']} (RSSI={info['rssi']})")


if __name__ == "__main__":
    main()
