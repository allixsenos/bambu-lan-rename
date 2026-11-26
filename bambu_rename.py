#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["paho-mqtt>=2.0"]
# ///
"""Rename a Bambu Lab printer that is in LAN-only mode, without the Bambu cloud.

The official apps rename a printer through a cloud HTTP call, so they cannot
rename a printer that is in LAN-only mode. The printer firmware itself accepts
the new name as a message on its local MQTT broker:

    topic    device/<serial>/request
    payload  {"update": {"sequence_id": "<id>", "name": "<new name>"}}

The printer answers on ``device/<serial>/report`` with the same ``update``
object plus ``"result": "success"``, and then announces the new name in its
SSDP discovery broadcasts.

This command is not documented by Bambu Lab. It was found by experiment and
tested on a P2S with firmware 01.02.00.00 and 01.03.00.00.

Usage:
    bambu_rename.py list
    bambu_rename.py rename --host <ip> "<new name>"
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import select
import socket
import ssl
import struct
import sys
import threading
import time

# The local MQTT broker on the printer: TLS on port 8883, fixed user name,
# and the access code from the printer screen as the password.
MQTT_PORT = 8883
MQTT_USER = "bblp"

# Bambu printers announce themselves with SSDP on these UDP ports, not on the
# standard SSDP port 1900.
SSDP_GROUP = "239.255.255.250"
SSDP_PORTS = (1990, 2021)
SSDP_SEARCH = (
    "M-SEARCH * HTTP/1.1\r\n"
    f"HOST: {SSDP_GROUP}:1990\r\n"
    'MAN: "ssdp:discover"\r\n'
    "MX: 3\r\n"
    "ST: urn:bambulab-com:device:3dprinter:1\r\n"
    "\r\n"
).encode()


def parse_ssdp(packet: bytes) -> dict[str, str]:
    """Return the headers of an SSDP packet as a dict with lowercase keys."""
    headers = {}
    for line in packet.decode("utf-8", errors="replace").split("\r\n")[1:]:
        key, sep, value = line.partition(":")
        if sep:
            headers[key.strip().lower()] = value.strip()
    return headers


def discover(timeout: float, only_host: str | None = None) -> dict[str, dict[str, str]]:
    """Find Bambu printers on the local network.

    Listens for the periodic SSDP broadcasts and also sends a search request,
    because a printer broadcasts only every few seconds.

    Returns a dict that maps each printer IP address to ``name``, ``serial``,
    ``model`` and ``firmware``. If ``only_host`` is set, the search stops as
    soon as that printer answers.
    """
    sockets = []
    membership = struct.pack("4sl", socket.inet_aton(SSDP_GROUP), socket.INADDR_ANY)
    for port in SSDP_PORTS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        try:
            sock.bind(("", port))
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
        except OSError:
            # Another program (Bambu Studio, for example) owns the port.
            # The other port and the search request below still work.
            sock.close()
            continue
        sockets.append(sock)

    # The printer sends its answer to a search request back to this socket.
    search = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sockets.append(search)
    for port in SSDP_PORTS:
        for target in filter(None, (SSDP_GROUP, only_host)):
            try:
                search.sendto(SSDP_SEARCH, (target, port))
            except OSError:
                pass

    printers: dict[str, dict[str, str]] = {}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readable, _, _ = select.select(sockets, [], [], 0.5)
        for sock in readable:
            packet, (address, _) = sock.recvfrom(4096)
            headers = parse_ssdp(packet)
            if "devname.bambu.com" not in headers:
                continue  # an SSDP packet from some other kind of device
            printers[address] = {
                "name": headers["devname.bambu.com"],
                "serial": headers.get("usn", ""),
                "model": headers.get("devmodel.bambu.com", ""),
                "firmware": headers.get("devversion.bambu.com", ""),
            }
        if only_host in printers:
            break
    for sock in sockets:
        sock.close()
    return printers


def rename(host: str, serial: str, access_code: str, name: str, timeout: float) -> dict:
    """Send the rename command and return the ``update`` object of the answer.

    Raises ``TimeoutError`` if the printer does not answer in ``timeout``
    seconds, and ``ConnectionError`` if the broker refuses the connection
    (a wrong access code, for example).
    """
    import paho.mqtt.client as mqtt

    # A sequence id of our own lets us find the answer among the status
    # reports that the printer sends all the time.
    sequence_id = str(int(time.time()))
    request = {"update": {"sequence_id": sequence_id, "name": name}}
    answer: dict = {}
    refused: list[str] = []
    done = threading.Event()

    def on_connect(client, userdata, flags, reason_code, properties=None):
        if reason_code.is_failure:
            refused.append(str(reason_code))
            done.set()
            return
        client.subscribe(f"device/{serial}/report")
        client.publish(f"device/{serial}/request", json.dumps(request))

    def on_message(client, userdata, message):
        try:
            update = json.loads(message.payload).get("update")
        except (ValueError, AttributeError):
            return
        if isinstance(update, dict) and update.get("sequence_id") == sequence_id:
            answer.update(update)
            done.set()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(MQTT_USER, access_code)
    # The printer uses a certificate that Bambu Lab's private CA signed, for
    # its serial number and not for its IP address. A normal check always
    # fails, so the check is off. Use this only on a network that you trust.
    client.tls_set(cert_reqs=ssl.CERT_NONE)
    client.tls_insecure_set(True)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(host, MQTT_PORT, keepalive=30)
    client.loop_start()
    try:
        answered = done.wait(timeout)
    finally:
        client.loop_stop()
        client.disconnect()

    if refused:
        raise ConnectionError(f"The printer refused the connection: {refused[0]}")
    if not answered:
        raise TimeoutError("The printer did not answer the rename command.")
    return answer


def cmd_list(args: argparse.Namespace) -> int:
    printers = discover(args.timeout)
    if not printers:
        print("No printers found.", file=sys.stderr)
        return 1
    for address, info in sorted(printers.items()):
        print(f"{address}\t{info['serial']}\t{info['model']}\t{info['firmware']}\t{info['name']}")
    return 0


def cmd_rename(args: argparse.Namespace) -> int:
    serial = args.serial
    if not serial:
        # The MQTT topic contains the serial number. Get it from discovery so
        # the user only has to supply the IP address.
        serial = discover(args.timeout, only_host=args.host).get(args.host, {}).get("serial")
        if not serial:
            print("Could not find the serial number. Supply it with --serial.", file=sys.stderr)
            return 1

    # Never take the access code as an argument: arguments are visible in the
    # process list and in the shell history.
    access_code = os.environ.get("BAMBU_ACCESS_CODE") or getpass.getpass("Access code: ")

    try:
        answer = rename(args.host, serial, access_code, args.name, args.timeout)
    except (OSError, TimeoutError) as error:
        print(f"Rename failed: {error}", file=sys.stderr)
        return 1
    if answer.get("result") != "success":
        print(f"Rename failed: {answer.get('reason', answer)}", file=sys.stderr)
        return 1

    # The MQTT answer only says that the printer accepted the command. The
    # name in the discovery broadcast is what other programs see.
    announced = discover(args.timeout, only_host=args.host).get(args.host, {}).get("name")
    if announced == args.name:
        print(f"{args.host} is now {announced}")
    else:
        print(f"{args.host} accepted the name, but discovery shows: {announced!r}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Rename a Bambu Lab printer in LAN-only mode.")
    parser.add_argument("--timeout", type=float, default=10, help="seconds to wait for the printer (default: 10)")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("list", help="show the printers on the local network").set_defaults(run=cmd_list)

    rename_parser = commands.add_parser("rename", help="give a printer a new name")
    rename_parser.add_argument("--host", required=True, help="IP address of the printer")
    rename_parser.add_argument("--serial", help="serial number of the printer (default: from discovery)")
    rename_parser.add_argument("name", help="the new name")
    rename_parser.set_defaults(run=cmd_rename)

    args = parser.parse_args()
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
